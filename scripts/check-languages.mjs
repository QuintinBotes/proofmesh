// pnpm check:languages (FR218): every language docs/proofmesh/languages.md lists as supported for a tier has a section for that tier
// in fixtures/rosetta/<language>/expected.json, every section accounts for each row of the contract, and the support table is the one
// the expected files give. Usage: node scripts/check-languages.mjs [root]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const read = (root, ...p) => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8'))
const TABLE_HEAD = /^\| Language \| Tier \|/

export const contractOf = (root) => read(root, 'fixtures', 'rosetta', 'contract.json')
export const languagesOf = (root) => fs.readdirSync(path.join(root, 'fixtures', 'rosetta'), { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(root, 'fixtures', 'rosetta', d.name, 'expected.json'))).map((d) => d.name).sort()

/** One cell of the support table: the contract rows a tier gives out of those a complete answer holds, and the rows beyond them. */
const cell = (call, section) => {
  const given = section.calls[call].rows.filter((r) => r.role).length
  const extra = section.calls[call].rows.filter((r) => r.extra).length
  return `${given}/${section.contract[call].roles.length}${extra ? `+${extra}` : ''}`
}

/** The support table the expected files give, one row per language and tier, in the order of the files. */
export function rosettaTable(root) {
  const contract = contractOf(root)
  const calls = Object.keys(contract.calls)
  const lines = [`| Language | Tier | ${calls.join(' | ')} |`, `|---|---|${calls.map(() => '---').join('|')}|`]
  for (const lang of languagesOf(root)) {
    const expected = read(root, 'fixtures', 'rosetta', lang, 'expected.json')
    for (const [tier, section] of Object.entries(expected.tiers)) lines.push(`| \`${lang}\` | ${tier} | ${calls.map((c) => cell(c, { ...section, contract: contract.calls })).join(' | ')} |`)
  }
  return lines.join('\n')
}

/** What is wrong with one tier section: a call missing, a role neither given nor stated as a gap, one both given and stated, a gap with no reason, an extra row with none. */
export function sectionProblems(contract, section, where) {
  const out = []
  for (const [call, spec] of Object.entries(contract.calls)) {
    const got = section.calls?.[call]
    if (!got) { out.push(`${where}: no answer for ${call}`); continue }
    const given = got.rows.filter((r) => r.role).map((r) => r.role)
    const gaps = (got.not_at_tier ?? []).map((g) => g.role)
    for (const r of spec.roles) {
      if (!given.includes(r) && !gaps.includes(r)) out.push(`${where}: ${call}: row ${r} is neither given nor listed under not_at_tier`)
      if (given.includes(r) && gaps.includes(r)) out.push(`${where}: ${call}: row ${r} is both given and listed under not_at_tier`)
    }
    for (const r of [...given, ...gaps]) if (!spec.roles.includes(r)) out.push(`${where}: ${call}: ${r} is no row of the contract`)
    for (const g of got.not_at_tier ?? []) if (!g.reason) out.push(`${where}: ${call}: gap ${g.role} states no reason`)
    for (const r of got.rows) if (!r.role && !r.extra) out.push(`${where}: ${call}: row "${r.row}" is neither a contract role nor an extra with a reason`)
  }
  return out
}

/** Every problem the check finds under root; none means the suite and the documentation agree. */
export function problems(root) {
  const out = []
  const contract = contractOf(root)
  const doc = fs.readFileSync(path.join(root, 'docs', 'proofmesh', 'languages.md'), 'utf8').split('\n')
  const head = doc.findIndex((l) => TABLE_HEAD.test(l))
  if (head < 0) return ['docs/proofmesh/languages.md has no Rosetta support table (a row starting "| Language | Tier |")']
  let end = head
  while (end < doc.length && doc[end].startsWith('|')) end++
  const supported = doc.slice(head + 2, end).map((l) => l.split('|').map((c) => c.trim()).filter(Boolean)).map(([lang, tier]) => ({ lang: lang.replace(/`/g, ''), tier }))
  for (const { lang, tier } of supported) {
    const file = path.join(root, 'fixtures', 'rosetta', lang, 'expected.json')
    if (!fs.existsSync(file)) { out.push(`${lang} is listed as supported for tier ${tier} but fixtures/rosetta/${lang}/expected.json does not exist`); continue }
    const section = read(root, 'fixtures', 'rosetta', lang, 'expected.json').tiers?.[tier]
    if (!section) out.push(`${lang} is listed as supported for tier ${tier} but fixtures/rosetta/${lang}/expected.json has no section for it`)
  }
  for (const lang of languagesOf(root)) {
    for (const [tier, section] of Object.entries(read(root, 'fixtures', 'rosetta', lang, 'expected.json').tiers)) {
      out.push(...sectionProblems(contract, section, `fixtures/rosetta/${lang}/expected.json ${tier}`))
      if (!supported.some((s) => s.lang === lang && s.tier === tier)) out.push(`fixtures/rosetta/${lang}/expected.json has a section for tier ${tier} that docs/proofmesh/languages.md does not list`)
    }
  }
  const table = doc.slice(head, end).join('\n')
  if (!out.length && table !== rosettaTable(root)) out.push('the Rosetta support table in docs/proofmesh/languages.md is not the one the expected files give; replace it with:\n' + rosettaTable(root))
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
  const found = problems(root)
  if (found.length) { console.error(`FR218 languages: ${found.length} problems\n${found.join('\n')}`); process.exit(1) }
  const n = languagesOf(root).length
  console.log(`FR218 languages ok: ${n} languages, every tier the documentation lists has its Rosetta section and the support table matches`)
}
