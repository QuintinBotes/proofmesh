import type Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { evidenceSlice, expectedFor, fixtureRepo, indexedDataDir, tool, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('cs-references')
const qn = (db: Database.Database, id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name
const order = (a: { from: string; to: string }, b: { from: string; to: string }) => (`${a.from}|${a.to}` < `${b.from}|${b.to}` ? -1 : 1)

describe('C# references (fixtures/cs-references)', () => {
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('cs-references')))
  })
  const site = (db: Database.Database, assertionId: string) => {
    const e = db.prepare('select ae.evidence_id as id, e.start_line as line, e.source_kind as kind from assertion_evidence ae join evidence e on e.id = ae.evidence_id where ae.assertion_id = ? order by e.start_byte limit 1').get(assertionId) as { id: string; line: number; kind: string }
    return { line: e.line, text: evidenceSlice(dataDir, db, e.id), kind: e.kind }
  }

  it('A31 every reference to a repository declaration equals the oracle: one per user and target, at its first site, with its uses', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select id, source_id, target_id, resolution, detail from assertion where type = 'references'").all() as Array<{ id: string; source_id: string; target_id: string; resolution: string; detail: string }>
      const actual = rows.map((r) => {
        const s = site(db, r.id)
        expect(r.resolution).toBe('resolved')
        expect(s.kind).toBe('reference_site')
        return { from: qn(db, r.source_id), to: qn(db, r.target_id), use: (JSON.parse(r.detail) as { use: string }).use, line: s.line, site_text: s.text }
      })
      expect(actual.sort(order)).toEqual([...EXPECTED.references].sort(order))
    })
  })

  it('A31 enum members are field symbols', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select kind, qualified_name, start_line, end_line from symbol where qualified_name like 'Shop.OrderState.%' order by qualified_name").all() as Array<{ kind: string; qualified_name: string; start_line: number; end_line: number }>
      expect(rows.map((r) => ({ kind: r.kind, qualified_name: r.qualified_name, lines: [r.start_line, r.end_line] }))).toEqual(EXPECTED.enum_members)
    })
  })

  it('A3 nameof is not a call', () => {
    withSnapshot(dataDir, (db) => {
      const calls = db.prepare("select id from assertion where type = 'calls'").all() as Array<{ id: string }>
      expect(calls.map((c) => site(db, c.id).text).filter((t) => t.startsWith(EXPECTED.no_call_site_starts_with))).toEqual([])
    })
  })

  it('A3 a call that does not bind names its callee, its argument count and the compiler error', () => {
    withSnapshot(dataDir, (db) => {
      const want = EXPECTED.unbound_call
      const rows = db.prepare("select id, source_id, resolution, reason, detail from assertion where type = 'calls' and resolution = 'unresolved'").all() as Array<{ id: string; source_id: string; resolution: string; reason: string; detail: string }>
      const found = rows.map((r) => ({ r, s: site(db, r.id) })).filter(({ s }) => s.text === want.site_text)
      expect(found).toHaveLength(1)
      const { r, s } = found[0]!
      const detail = JSON.parse(r.detail) as Record<string, string>
      expect({ from: qn(db, r.source_id), line: s.line, site_text: s.text, resolution: r.resolution, reason: r.reason, detail: { callee: detail.callee, arity: detail.arity, compiler_code: detail.compiler?.split(':')[0] } }).toEqual(want)
    })
  })

  it('FR012 external call sites count per type, closed generics folded, with files and projects', () => {
    type G = { key: string; module: string; call_sites: number; files: number; projects: number; external_ids: number; sample_sites: unknown[] }
    const r = tool(dataDir, 'get_external_usage', { group_by: 'type' })
    const groups = (r.data as { groups: G[]; totals: { call_sites: number } }).groups
    const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : 1)
    expect(groups.map(({ sample_sites: _s, ...g }) => g).sort(byKey)).toEqual(EXPECTED.external_usage_by_type)
    expect((r.data as { totals: { call_sites: number } }).totals.call_sites).toBe(4)
    const members = (tool(dataDir, 'get_external_usage', { group_by: 'member', fold_generics: false }).data as { groups: G[] }).groups.map((g) => g.key).sort()
    expect(members).toEqual(EXPECTED.external_usage_unfolded_members)
  })

  it('FR014 impact from an external symbol starts at the code that calls it', () => {
    const ext = withSnapshot(dataDir, (db) => (db.prepare('select id from external_symbol where name = ?').get(EXPECTED.impact_of_external.external) as { id: string }).id)
    const r = tool(dataDir, 'analyze_impact', { subject_ids: [ext] })
    expect((r.data as { dependents: Array<{ qualified_name: string }> }).dependents.map((d) => d.qualified_name).sort()).toEqual(EXPECTED.impact_of_external.dependents)
  })
})
