import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTool } from '../src/query/tools.js'
import { expectedFor, fixtureRepo, indexedDataDir, ROOT, tmpDir, withSnapshot } from './helpers.js'

type Expected = {
  census: { language: string; tier: string }
  files: Record<string, string>
  symbols: Array<[string, string, string, number, number]>
  facts: Array<[string, number, string, string, string | null, string, string | null, string | null]>
  callers: string[]
  tests: string[]
}

/** Every fact the fixture's expected.json lists, read from the snapshot in the same shape. */
async function read(fixture: string) {
  const repo = tmpDir(`pm-${fixture}-`)
  fs.cpSync(fixtureRepo(fixture), repo, { recursive: true })
  const { dataDir } = await indexedDataDir(repo)
  const got = withSnapshot(dataDir, (db) => ({
    files: Object.fromEntries((db.prepare("select path, disposition, disposition_detail as detail, capabilities from file where path like '%.vue' or path like '%.svelte' order by path").all() as Array<{ path: string; disposition: string; detail: string | null; capabilities: string }>)
      .map((f) => [f.path, `${f.disposition} ${JSON.parse(f.capabilities).tier}${f.detail ? ` ${f.detail}` : ''}`])),
    symbols: (db.prepare("select f.path, s.kind, s.qualified_name, s.start_line, s.end_line from symbol s join file f on f.id = s.file_id where (f.path like '%.vue' or f.path like '%.svelte') and s.kind <> 'module' order by f.path, s.start_byte, s.qualified_name").all() as Array<Record<string, string | number>>)
      .map((s) => [s.path, s.kind, s.qualified_name, s.start_line, s.end_line]),
    facts: (db.prepare(`
      select f.path, ev.start_line as line, a.type, coalesce(s.qualified_name, sf.path) as src, coalesce(t.qualified_name, tf.path, x.module || ':' || x.name) as dst, a.resolution, a.reason, a.detail
      from assertion a left join symbol s on s.id = a.source_id left join file sf on sf.id = a.source_id left join symbol t on t.id = a.target_id left join file tf on tf.id = a.target_id left join external_symbol x on x.id = a.target_id
      join assertion_evidence ae on ae.assertion_id = a.id join evidence ev on ev.id = ae.evidence_id join file f on f.id = ev.file_id
      where a.type in ('calls', 'renders', 'references', 'imports') and (f.path like '%.vue' or f.path like '%.svelte' or f.path like '%.test.ts')
      order by f.path, ev.start_byte, a.type, src, dst`).all() as Array<Record<string, string | number | null>>)
      .map((r) => { const d = r.detail ? JSON.parse(String(r.detail)) : {}; return [r.path, r.line, r.type, r.src, r.dst, r.resolution, r.reason, d.why ?? d.rule ?? d.kind ?? null] }),
    // The bytes a script symbol's range names in the file as stored, which has a multi-byte character before the script in ts-vue.
    press: (() => { const r = db.prepare("select f.path, s.start_byte, s.end_byte from symbol s join file f on f.id = s.file_id where s.qualified_name = 'src/Button:press'").get() as { path: string; start_byte: number; end_byte: number }; return fs.readFileSync(path.join(repo, r.path)).subarray(r.start_byte, r.end_byte).toString('utf8') })(),
  }))
  const cart = (runTool(dataDir, 'find_symbols', { text: 'useCart' }).data.symbols as Array<{ id: string; path: string }>).find((s) => s.path === 'src/cart.ts')!
  const callers = runTool(dataDir, 'get_relationships', { subject_id: cart.id, direction: 'in', types: ['calls'], envelope: 'lean' }).text!.split('\n').slice(1)
  const bases = (runTool(dataDir, 'get_relationships', { subject_id: cart.id, direction: 'in', types: ['calls'] }).data.relationships as Array<{ basis: string }>).map((r) => r.basis)
  const tests = (runTool(dataDir, 'find_tests', { subject_ids: [cart.id] }).data.tests as Array<{ name: string; evidence: string; chain: Array<{ name: string; path: string; line: number }> }>)
    .map((t) => `${t.name} ${t.evidence}: ${t.chain.map((c) => `${c.name} ${c.path}:${c.line}`).join(' > ')}`)
  const census = (runTool(dataDir, 'workspace_status', {}).data.languages as Array<{ language: string; tier: string }>).find((r) => r.language === expectedFor(fixture).census.language)
  return { ...got, callers, bases, tests, census: census && { language: census.language, tier: census.tier } }
}

describe('FR2280 to FR2285 Vue and Svelte single-file components are part of the TypeScript graph', () => {
  for (const fixture of ['ts-vue', 'ts-svelte']) {
    it(`FR2280 FR2281 FR2282 FR2283 FR2284 FR2285 ${fixture}: every fact of expected.json, at the component file's own lines`, async () => {
      const got = await read(fixture)
      const want = expectedFor(fixture) as Expected
      expect(got.census).toEqual(want.census)
      expect(got.files).toEqual(want.files)
      expect(got.symbols).toEqual(want.symbols)
      expect(got.facts).toEqual(want.facts)
      expect(got.callers).toEqual(want.callers)
      expect(got.bases).toEqual(['observed', 'observed'])
      expect(got.press).toMatch(/^function press\(\) \{\n\s+cart\.add\('apple'\)\n\s*\}$/)
      expect(got.tests).toEqual(want.tests)
    }, 120000)
  }
})

describe('FR2287 each requirement of #252 is traced and specified', () => {
  it('FR2287 FR2280 to FR2286 each have a traceability entry naming a test and a MUST line in the specification', () => {
    const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'policy', 'traceability.json'), 'utf8')).items as Record<string, string[]>
    const spec = fs.readFileSync(path.join(ROOT, 'specs', '001-proofmesh-foundation', 'spec.md'), 'utf8')
    for (let n = 2280; n <= 2286; n++) {
      expect(items[`FR${n}`]?.length, `FR${n}`).toBeGreaterThan(0)
      expect(spec, `FR${n}`).toMatch(new RegExp(`^- FR${n}: MUST `, 'm'))
    }
  })
})
