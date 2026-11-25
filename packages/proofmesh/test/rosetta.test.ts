import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { ProofmeshError } from '../src/core/errors.js'
import { runTool } from '../src/query/tools.js'
import { indexedDataDir, ROOT, tmpDir } from './helpers.js'

// Issue 20: one program in every language, the same eight calls, and the rows each tier gives or states it cannot.
const ROSETTA = path.join(ROOT, 'fixtures', 'rosetta')
const LANGUAGES = ['cpp', 'csharp', 'go', 'java', 'kotlin', 'php', 'python', 'ruby', 'rust', 'typescript']
const PRECISE = ['csharp', 'python', 'typescript']
const SYNTAX = LANGUAGES.filter((l) => !PRECISE.includes(l))

type Row = { role?: string; extra?: string; known_defect?: string; row: string }
type Gap = { role: string; reason: string }
type CallExpect = { error?: string; rows: Row[]; not_at_tier?: Gap[] }
type Section = { subjects: Record<string, { name: string; path: string }>; calls: Record<string, CallExpect> }
type Expected = { language: string; census_language: string; tiers: Record<string, Section> }
type Contract = { calls: Record<string, { tool: string; input: Record<string, unknown>; order: 'set' | 'exact'; roles: string[]; grammar: string[] }> }
type Answer = { error?: string; header?: string; rows: string[]; basis: string[]; keys: string[] }
type Checker = { problems: (root: string) => string[]; sectionProblems: (c: Contract, s: Section, where: string) => string[]; rosettaTable: (root: string) => string }

const readJson = <T>(...p: string[]): T => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8')) as T
const CONTRACT = readJson<Contract>('fixtures', 'rosetta', 'contract.json')
const CALLS = Object.keys(CONTRACT.calls)
const expectedOf = (lang: string) => readJson<Expected>('fixtures', 'rosetta', lang, 'expected.json')
const checker = async (): Promise<Checker> => (await import(pathToFileURL(path.join(ROOT, 'scripts', 'check-languages.mjs')).href)) as Checker

const HEADER = /^# (find_symbols|get_relationships|analyze_impact|find_tests|trace_paths) · \d+ rows? · snap_[0-9a-z]+ current$/

/** Every `basis` the answer's data names, wherever it sits. */
const basesOf = (x: unknown): string[] => (Array.isArray(x) ? x.flatMap(basesOf) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => (k === 'basis' && typeof v === 'string' ? [v] : basesOf(v))) : [])

const subjectsIn = (input: unknown, subjects: Section['subjects']): unknown => {
  if (typeof input === 'string' && input.startsWith('$')) return subjects[input]
  if (Array.isArray(input)) return input.map((i) => subjectsIn(i, subjects))
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, subjectsIn(v, subjects)]))
  return input
}

const tierOf = (dataDir: string, census: string): string => {
  const rows = runTool(dataDir, 'workspace_status', {}).data.languages as Array<{ language: string; tier: string }>
  const tier = rows.find((r) => r.language === census)?.tier ?? 'none'
  return tier.startsWith('precise:') ? 'precise' : tier.startsWith('scip:') ? 'scip' : tier
}

/** Ask one call of an indexed fixture, in the lean envelope and in JSON; a refused call is its error code. */
function ask(dataDir: string, section: Section, call: string): Answer {
  const spec = CONTRACT.calls[call]!
  const input = subjectsIn(spec.input, section.subjects) as Record<string, unknown>
  try {
    const text = runTool(dataDir, spec.tool, { ...input, envelope: 'lean' }).text!
    const [header, ...rest] = text.split('\n')
    const data = runTool(dataDir, spec.tool, { ...input, envelope: 'full' }).data
    return { header, rows: rest.filter((l) => !l.startsWith('# ')), basis: basesOf(data), keys: Object.keys(data).sort() }
  } catch (e) {
    if (e instanceof ProofmeshError) return { error: e.code, rows: [], basis: [], keys: [] }
    throw e
  }
}

/** What differs between an answer and the rows a section expects, as sentences; nothing when they agree. */
function differences(section: Section, call: string, got: Answer): string[] {
  const want = section.calls[call]!
  if (want.error || got.error) return want.error === got.error ? [] : [`${call}: expected ${want.error ?? 'an answer'}, got ${got.error ?? 'an answer'}`]
  const expectRows = want.rows.map((r) => r.row)
  const order = CONTRACT.calls[call]!.order
  const [a, b] = order === 'set' ? [[...got.rows].sort(), [...expectRows].sort()] : [got.rows, expectRows]
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${call}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`]
}

type Indexed = { dataDir: string; tier: string; expected: Expected; section: Section | undefined; answers: Record<string, Answer> }
const indexed = new Map<string, Indexed>()
beforeAll(async () => {
  for (const lang of LANGUAGES) {
    const expected = expectedOf(lang)
    const { dataDir } = await indexedDataDir(path.join(ROSETTA, lang, 'repo'))
    const tier = tierOf(dataDir, expected.census_language)
    const section = expected.tiers[tier]
    indexed.set(lang, { dataDir, tier, expected, section, answers: section ? Object.fromEntries(CALLS.map((c) => [c, ask(dataDir, section, c)])) : {} })
  }
}, 900000)
const of = (lang: string): Indexed => indexed.get(lang)!

describe('FR211 FR212 one program per language, project-authored, with the expected rows written beside it', () => {
  it('FR211 the suite holds exactly the ten languages, each with a repo, a PROVENANCE.md naming Apache-2.0 and the expected file', () => {
    const dirs = fs.readdirSync(ROSETTA, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    expect(dirs).toEqual(LANGUAGES)
    for (const lang of LANGUAGES) {
      expect(fs.existsSync(path.join(ROSETTA, lang, 'repo')), lang).toBe(true)
      expect(fs.readFileSync(path.join(ROSETTA, lang, 'PROVENANCE.md'), 'utf8'), lang).toMatch(/^Project-authored for Proofmesh[\s\S]*Apache-2\.0/m)
    }
    expect(fs.readFileSync(path.join(ROSETTA, 'PROVENANCE.md'), 'utf8')).toMatch(/hand|by hand/i)
  })

  it.each(LANGUAGES)('FR212 %s: the program has the shapes, the total, the direct call, a report file and a test', (lang) => {
    const files: string[] = []
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))))
    walk(path.join(ROSETTA, lang, 'repo'))
    const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    for (const part of [/area/i, /circle/i, /square/i, /total/i, /circle_?area/i]) expect(text, `${lang} ${part}`).toMatch(part)
    expect(files.some((f) => /report/i.test(path.basename(f))), `${lang} has a report file`).toBe(true)
    expect(text, `${lang} has the test of two shapes`).toMatch(/total_?of_?two|totals two/i)
  })
})

describe('FR213 each language answers the eight calls with the rows its expected file holds for the tier that analysed it', () => {
  it.each(LANGUAGES)('FR213 scenario 1: %s', (lang) => {
    const { tier, expected, section, answers } = of(lang)
    expect(section, `${lang} was analysed at tier ${tier}; expected.json has sections for ${Object.keys(expected.tiers).join(', ')}`).toBeDefined()
    expect(CALLS.flatMap((c) => differences(section!, c, answers[c]!))).toEqual([])
  })

  it('FR213 the tier is the one the census names: precise for TypeScript, Python and C#, syntax for the other seven', () => {
    for (const lang of LANGUAGES) expect(of(lang).tier, lang).toBe(PRECISE.includes(lang) ? 'precise' : 'syntax')
  })

  it('FR213 an answer that differs from its expected rows is found: a moved row, an added row and a changed error are each a difference', () => {
    const { section, answers } = of('go')
    const copy = structuredClone(section!)
    copy.calls.imports!.rows = [{ role: 'report', row: 'report/report.go:7 candidate inferred' }]
    expect(differences(copy, 'imports', answers.imports!)).toHaveLength(1)
    copy.calls.find_tests!.rows.push({ extra: 'x', row: 'Other shapes/other.go:1 depth=1 inferred' })
    expect(differences(copy, 'find_tests', answers.find_tests!)).toHaveLength(1)
    copy.calls.trace_paths!.error = 'INVALID_ARGUMENT'
    expect(differences(copy, 'trace_paths', answers.trace_paths!)).toHaveLength(1)
  })
})

describe('FR214 the precise tiers answer observed, and say where they fall short', () => {
  it.each(PRECISE)('FR214 scenario 2: %s gives no row but an observed one', (lang) => {
    const { answers } = of(lang)
    for (const c of CALLS) {
      expect(answers[c]!.basis.filter((b) => b !== 'observed'), `${lang} ${c}`).toEqual([])
      expect(answers[c]!.rows.filter((r) => /\binferred$/.test(r)), `${lang} ${c}`).toEqual([])
    }
    expect(CALLS.flatMap((c) => answers[c]!.basis).length, `${lang} has relationship rows to be observed`).toBeGreaterThan(0)
  })

  it.each(['csharp', 'typescript'])('FR214 scenario 2: %s lists the callers of Circle.area as circleArea, direct, and total, by dispatch through Shape.area', (lang) => {
    const rows = of(lang).answers.calls_circle_area!.rows
    expect(rows).toHaveLength(2)
    const [viaShape, direct] = lang === 'csharp' ? ['Total', 'CircleArea'] : ['total', 'circleArea']
    const last = (r: string) => r.split(' ')[0]!.split('.').pop()
    expect(rows.filter((r) => /dispatch$/.test(r)).map(last)).toEqual([viaShape])
    expect(rows.filter((r) => !/dispatch$/.test(r)).map(last)).toEqual([direct])
  })

  it('FR214 scenario 2 is NOT met for Python: it gives no dispatch row, so total is missing from the callers of Circle.area; the file records it as a known defect', () => {
    const section = of('python').section!
    for (const [call, roles] of [['calls_circle_area', ['total']], ['impact', ['total', 'report', 'totalOfTwo']]] as const) {
      expect(section.calls[call]!.not_at_tier!.map((g) => g.role)).toEqual(roles)
      for (const g of section.calls[call]!.not_at_tier!) expect(g.reason).toMatch(/^known defect/)
    }
    expect(of('python').answers.calls_circle_area!.rows).toHaveLength(1)
  })

  it('FR224 FR225: no expected file records the test importer or the sibling implementation as a known defect any more', () => {
    for (const lang of ['typescript', 'python', 'csharp']) {
      const rows = Object.values(of(lang).section!.calls).flatMap((c) => c.rows)
      expect(rows.filter((r) => r.known_defect && !/Python gives/.test(r.known_defect)), lang).toEqual([])
    }
  })
})

describe('FR215 the syntax tier answers inferred, states each row it cannot give, and gives no other', () => {
  it.each(SYNTAX)('FR215 scenario 3: %s gives only inferred relationship rows', (lang) => {
    const { answers } = of(lang)
    for (const c of CALLS) {
      expect(answers[c]!.basis.filter((b) => b !== 'inferred'), `${lang} ${c}`).toEqual([])
      if (c !== 'find_symbols') expect(answers[c]!.rows.filter((r) => !/\binferred$/.test(r)), `${lang} ${c}`).toEqual([])
    }
  })

  it.each(LANGUAGES)('FR215 scenario 3: %s accounts for every row of the contract, given or stated with a reason', async (lang) => {
    const { sectionProblems } = await checker()
    for (const [tier, section] of Object.entries(expectedOf(lang).tiers)) expect(sectionProblems(CONTRACT, section, `${lang} ${tier}`)).toEqual([])
  })

  it.each([
    ['a row neither given nor stated', (s: Section) => { s.calls.find_tests!.rows = []; delete s.calls.find_tests!.not_at_tier }],
    ['a row both given and stated', (s: Section) => { s.calls.imports!.not_at_tier = [{ role: 'report', reason: 'x' }] }],
    ['a gap with no reason', (s: Section) => { s.calls.calls_circle_area!.not_at_tier = [{ role: 'total', reason: '' }] }],
    ['a row that is no part of the contract', (s: Section) => { s.calls.find_symbols!.rows.push({ role: 'Triangle.area', row: 'Triangle.area a.go:1 method' }) }],
    ['an extra row with no reason', (s: Section) => { s.calls.find_symbols!.rows.push({ row: 'Odd a.go:1 method' }) }],
    ['a known defect with no reason', (s: Section) => { s.calls.find_symbols!.rows.push({ known_defect: '', row: 'Odd a.go:1 method' }) }],
  ])('FR215 the accounting finds %s', async (_name, mutate) => {
    const { sectionProblems } = await checker()
    const copy = structuredClone(expectedOf('go').tiers.syntax!)
    mutate(copy)
    expect(sectionProblems(CONTRACT, copy, 'go syntax').length).toBeGreaterThan(0)
  })

  it('FR215 where a language is not at a tier at all, the call is refused with the code its file states, not answered empty', () => {
    expect(of('go').answers.calls_shape_area!.error).toBe('NOT_FOUND')
    expect(of('rust').answers.trace_paths!.error).toBe('NOT_FOUND')
    expect(of('cpp').answers.impact!.error).toBe('INVALID_ARGUMENT')
  })
})

describe('FR216 the lean answer has one form in every language', () => {
  const normal = (call: string, row: string): string => {
    let name: string | null = null
    let rest = row
    if (row.startsWith('"')) { const m = /^"(?:[^"\\]|\\.)*" /.exec(row)!; name = 'N'; rest = row.slice(m[0].length) } else if (!/^\S+:\d+( |$)/.test(row)) { name = 'N'; rest = row.slice(row.indexOf(' ') + 1) }
    const [where, ...tags] = rest.split(' ')
    expect(where, row).toMatch(/^\S+:\d+$/)
    const mapped = tags.map((t, i) => (/^depth=\d+$/.test(t) ? 'depth=n' : call === 'find_symbols' && i === 0 ? 'K' : call === 'impact' && i === 1 ? 'R' : t))
    return [name, 'P', ...mapped].filter(Boolean).join(' ')
  }

  it.each(LANGUAGES)('FR216 scenario 4: %s answers each call with the one header and the rows of the call\'s grammar', (lang) => {
    const { answers } = of(lang)
    for (const c of CALLS) {
      const a = answers[c]!
      if (a.error) continue
      expect(a.header, `${lang} ${c}`).toMatch(HEADER)
      expect(a.header).toContain(` · ${a.rows.length} row${a.rows.length === 1 ? '' : 's'} · `)
      for (const row of a.rows) expect(CONTRACT.calls[c]!.grammar, `${lang} ${c}: ${row}`).toContain(normal(c, row))
    }
  })

  it('FR216 scenario 4: every language that answers a call gives the same fields, in the same names', () => {
    for (const c of CALLS) {
      const sets = LANGUAGES.filter((l) => !of(l).answers[c]!.error).map((l) => [l, of(l).answers[c]!.keys.join(',')])
      expect(new Set(sets.map((s) => s[1])).size, `${c}: ${JSON.stringify(sets)}`).toBe(1)
    }
  })

  it('FR216 impact rows come nearest first in every language, and a path lists its hops from the test to the target', () => {
    for (const lang of LANGUAGES) {
      const depths = of(lang).answers.impact!.rows.map((r) => Number(/depth=(\d+)/.exec(r)![1]))
      expect(depths, lang).toEqual([...depths].sort((a, b) => a - b))
    }
    for (const lang of ['csharp', 'python', 'typescript']) {
      const hops = of(lang).answers.trace_paths!.rows.map((r) => r.split(' ')[0]!.split('.').pop()!.toLowerCase())
      expect(hops.length, lang).toBe(3)
      expect(hops[2], lang).toBe('area')
    }
  })
})

describe('FR217 a stated gap is a promise: a language that gains an answer changes its expected file in the same change', () => {
  it('FR217 every gap in every file names a reason of at least a sentence fragment, and no gap is both stated and given', async () => {
    const { sectionProblems } = await checker()
    let gaps = 0
    for (const lang of LANGUAGES) for (const section of Object.values(expectedOf(lang).tiers)) for (const c of CALLS) {
      for (const g of section.calls[c]!.not_at_tier ?? []) { gaps++; expect(g.reason.length, `${lang} ${c} ${g.role}`).toBeGreaterThan(20) }
      expect(sectionProblems(CONTRACT, section, lang)).toEqual([])
    }
    expect(gaps).toBeGreaterThan(40)
  })

  it('FR217 a closed gap is a failure: a row a section lists as not given that the answer does give is a difference', () => {
    const { section, answers } = of('java')
    const copy = structuredClone(section!)
    copy.calls.find_tests!.rows = []
    copy.calls.find_tests!.not_at_tier = [{ role: 'totalOfTwo', reason: 'the tier does not bind a qualified call' }]
    expect(differences(copy, 'find_tests', answers.find_tests!)).toHaveLength(1)
  })

  it('FR217 the support table the expected files give is what languages.md prints, so the gaps are visible to a reader', async () => {
    const { rosettaTable } = await checker()
    const table = rosettaTable(ROOT)
    expect(fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'languages.md'), 'utf8')).toContain(table)
    expect(table.split('\n')).toHaveLength(2 + LANGUAGES.length)
    expect(table).toContain('| `go` | syntax | 3/4 | 0/2 | 0/1 | 0/2 | 1/1 | 0/4 | 1/1 | 0/3 |')
    expect(table).toContain('| `python` | precise | 4/4 | 0/2 | 1/1 | 1/2 | 1/1 | 1/4 | 1/1 | 3/3 |')
  })
})

describe('FR218 a language listed as supported for a tier has its Rosetta section', () => {
  // The programs are left out by their place under the fixture root, not by a name anywhere in the absolute path.
  const copyDocs = (extraRow?: string, from = ROSETTA, into = tmpDir('pm-rosetta-')): string => {
    const root = into
    fs.cpSync(from, path.join(root, 'fixtures', 'rosetta'), { recursive: true, filter: (s) => !path.relative(from, s).split(path.sep).includes('repo') })
    fs.mkdirSync(path.join(root, 'docs', 'proofmesh'), { recursive: true })
    let doc = fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'languages.md'), 'utf8')
    if (extraRow) doc = doc.replace(/(\| `typescript` \| precise \|.*\n)/, `$1${extraRow}\n`)
    fs.writeFileSync(path.join(root, 'docs', 'proofmesh', 'languages.md'), doc)
    return root
  }
  const run = (root: string) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-languages.mjs'), root], { encoding: 'utf8' })

  it('FR218 the copy leaves out the programs and keeps the expected files when the fixtures sit under a directory named repo-x, or repo', () => {
    for (const dir of ['repo-x', 'repo', 'repos']) {
      const home = path.join(tmpDir('pm-home-'), dir)
      fs.mkdirSync(home)
      fs.cpSync(ROSETTA, path.join(home, 'rosetta'), { recursive: true })
      const root = copyDocs(undefined, path.join(home, 'rosetta'), path.join(home, 'out'))
      expect(fs.existsSync(path.join(root, 'fixtures', 'rosetta', 'go', 'expected.json')), dir).toBe(true)
      expect(fs.existsSync(path.join(root, 'fixtures', 'rosetta', 'go', 'repo')), dir).toBe(false)
      expect(run(root).status, dir).toBe(0)
    }
  })

  it('FR218 scenario 5: on the repository the check passes', () => {
    const r = run(ROOT)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('FR218 scenario 5: a tier listed for a language whose file has no section for it fails the check, naming both', () => {
    const r = run(copyDocs('| `go` | scip | 0/4 | 0/2 | 0/1 | 0/2 | 0/1 | 0/4 | 0/1 | 0/3 |'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('go is listed as supported for tier scip but fixtures/rosetta/go/expected.json has no section for it')
  })

  it('FR218 scenario 5: a language with no expected file at all fails the check', () => {
    const r = run(copyDocs('| `lua` | syntax | 0/4 | 0/2 | 0/1 | 0/2 | 0/1 | 0/4 | 0/1 | 0/3 |'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('lua is listed as supported for tier syntax but fixtures/rosetta/lua/expected.json does not exist')
  })

  it('FR218 a section the documentation does not list, and a table that is not the one the files give, fail the check', () => {
    const root = copyDocs()
    const file = path.join(root, 'docs', 'proofmesh', 'languages.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\| `go` \| syntax \|.*\n/, ''))
    expect(run(root).stderr).toContain('has a section for tier syntax that docs/proofmesh/languages.md does not list')
    const other = copyDocs()
    const f2 = path.join(other, 'docs', 'proofmesh', 'languages.md')
    fs.writeFileSync(f2, fs.readFileSync(f2, 'utf8').replace('| `go` | syntax | 3/4 |', '| `go` | syntax | 4/4 |'))
    expect(run(other).stderr).toContain('is not the one the expected files give')
  })
})

describe('FR219 pnpm verify runs the suite, C# included', () => {
  it('FR219 pnpm test runs this file, check:languages is a script and verify runs it, and the C# program is one of the ten', () => {
    const pkg = readJson<{ scripts: Record<string, string> }>('package.json')
    expect(pkg.scripts['check:languages']).toBe('node scripts/check-languages.mjs')
    expect(pkg.scripts.verify).toContain('pnpm check:languages')
    expect(pkg.scripts.test).toBe('vitest run')
    expect(LANGUAGES).toContain('csharp')
    expect(of('csharp').tier).toBe('precise')
  })
})

describe('FR220 the suite names which slice changed a row', () => {
  it('FR220 PROVENANCE.md says how the expected files were made and that a change to a row names the slice behind it', () => {
    const text = fs.readFileSync(path.join(ROSETTA, 'PROVENANCE.md'), 'utf8')
    expect(text).toMatch(/hand/i)
    expect(text).toMatch(/never generated|not generated|never copied/i)
    expect(text).toMatch(/slice/i)
    for (const lang of LANGUAGES) expect(fs.readFileSync(path.join(ROSETTA, lang, 'PROVENANCE.md'), 'utf8'), lang).toMatch(/hand/i)
  })
})
