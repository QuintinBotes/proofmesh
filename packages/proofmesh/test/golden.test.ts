import { beforeAll, describe, expect, it } from 'vitest'
import { EXPECTED, evidenceSlice, expectedFor, fixtureRepo, indexedDataDir, withSnapshot } from './helpers.js'

let dataDir: string
beforeAll(async () => {
  ;({ dataDir } = await indexedDataDir())
})

const slice = (db: import('better-sqlite3').Database, evidenceId: string): string => evidenceSlice(dataDir, db, evidenceId)

describe('golden facts for fixtures/ts-invoicing', () => {
  it('AC02 FR001 SC001 dispositions and details equal the oracle', () => {
    const rows = withSnapshot(dataDir, (db) => db.prepare('select path, disposition, disposition_detail from file order by path').all() as Array<{ path: string; disposition: string; disposition_detail: string | null }>)
    expect(Object.fromEntries(rows.map((r) => [r.path, [r.disposition, r.disposition_detail]]))).toEqual(EXPECTED.dispositions)
  })

  it('AC03 symbols equal the oracle, each with its declaration as evidence', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare('select kind, qualified_name, start_line, end_line, signature, evidence_id from symbol order by qualified_name, kind').all() as Array<{ kind: string; qualified_name: string; start_line: number; end_line: number; signature: string | null; evidence_id: string }>
      const actual = rows.map((r) => ({ kind: r.kind, qualified_name: r.qualified_name, lines: [r.start_line, r.end_line], signature: r.signature }))
      const order = (a: any, b: any) => (a.qualified_name < b.qualified_name ? -1 : a.qualified_name > b.qualified_name ? 1 : a.kind < b.kind ? -1 : 1)
      expect([...actual].sort(order)).toEqual([...EXPECTED.symbols].sort(order))
      for (const r of rows) {
        const ev = db.prepare('select source_kind from evidence where id = ?').get(r.evidence_id) as { source_kind: string }
        expect(ev.source_kind).toBe('declaration')
        // A property's declaration is its member line, which starts with its name.
        if (r.kind === 'property') expect(slice(db, r.evidence_id)).toMatch(new RegExp(`^${r.qualified_name.split('.').pop()}\\b`))
        else if (r.kind !== 'module') expect(slice(db, r.evidence_id)).toMatch(new RegExp(`^(export )?(function|interface|const|class|type) `))
      }
    })
  })

  it('AC04 SC003 calls equal the oracle, closed world', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare(`select a.resolution, a.reason, s.qualified_name as from_qn, a.target_kind, a.target_id, ae.evidence_id
        from assertion a join symbol s on s.id = a.source_id join assertion_evidence ae on ae.assertion_id = a.id where a.type = 'calls'`).all() as Array<any>
      const actual = rows.map((r) => {
        const ev = db.prepare('select start_line from evidence where id = ?').get(r.evidence_id) as { start_line: number }
        const base: any = { from: r.from_qn, line: ev.start_line, site_text: slice(db, r.evidence_id), resolution: r.resolution }
        if (r.resolution === 'resolved') base.to = (db.prepare('select qualified_name from symbol where id = ?').get(r.target_id) as any).qualified_name
        if (r.resolution === 'resolved_external') base.external = db.prepare('select module, name from external_symbol where id = ?').get(r.target_id)
        if (r.reason) base.reason = r.reason
        return base
      })
      const key = (c: any) => `${c.from}:${c.line}`
      expect(actual.sort((a, b) => (key(a) < key(b) ? -1 : 1))).toEqual([...EXPECTED.calls].sort((a: any, b: any) => (key(a) < key(b) ? -1 : 1)))
    })
  })

  it('AC05 imports equal the oracle, one assertion per file pair with one evidence record per statement', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare(`select a.id, fs.path as from_path, ft.path as to_path from assertion a join file fs on fs.id = a.source_id join file ft on ft.id = a.target_id where a.type = 'imports'`).all() as Array<any>
      const actual = rows.map((r) => ({
        from: r.from_path, to: r.to_path,
        statement_lines: (db.prepare('select e.start_line from assertion_evidence ae join evidence e on e.id = ae.evidence_id where ae.assertion_id = ? order by e.start_line').all(r.id) as Array<{ start_line: number }>).map((x) => x.start_line),
      }))
      const key = (c: any) => c.from
      expect(actual.sort((a, b) => (key(a) < key(b) ? -1 : 1))).toEqual([...EXPECTED.imports].sort((a: any, b: any) => (key(a) < key(b) ? -1 : 1)))
      expect(db.prepare("select count(*) n from assertion where type = 'imports'").get()).toEqual({ n: EXPECTED.imports.length })
    })
  })

  it('AC06 FR023 the same-named decoy acquires no inbound resolved edge', () => {
    withSnapshot(dataDir, (db) => {
      const decoy = db.prepare("select id from symbol where qualified_name = 'packages/legacy/src/format:formatAmount'").get() as { id: string }
      expect(db.prepare('select count(*) n from edge where dst = ?').get(decoy.id)).toEqual({ n: 0 })
    })
  })

  it('AC07 byte offsets are UTF-8: the slice after U+202E is exact', () => {
    withSnapshot(dataDir, (db) => {
      const row = db.prepare("select ae.evidence_id from assertion a join symbol s on s.id = a.source_id join assertion_evidence ae on ae.assertion_id = a.id where s.qualified_name = 'packages/legacy/src/format:formatAmount'").get() as { evidence_id: string }
      expect(slice(db, row.evidence_id)).toBe('value.toString()')
    })
  })
})

describe('A5 golden facts for fixtures/ts-module', () => {
  const MODULE = expectedFor('ts-module')
  let d: string
  beforeAll(async () => {
    ;({ dataDir: d } = await indexedDataDir(fixtureRepo('ts-module')))
  })

  it('A5 a function-valued const is a function, and the top-level call belongs to the file\'s module symbol', () => {
    withSnapshot(d, (db) => {
      const files = db.prepare('select path, disposition, disposition_detail from file order by path').all() as Array<{ path: string; disposition: string; disposition_detail: string | null }>
      expect(Object.fromEntries(files.map((f) => [f.path, [f.disposition, f.disposition_detail]]))).toEqual(MODULE.dispositions)
      const symbols = db.prepare('select kind, qualified_name, start_line, end_line, signature from symbol').all() as Array<{ kind: string; qualified_name: string; start_line: number; end_line: number; signature: string | null }>
      const byName = (a: { qualified_name: string }, b: { qualified_name: string }) => (a.qualified_name < b.qualified_name ? -1 : 1)
      expect(symbols.map((r) => ({ kind: r.kind, qualified_name: r.qualified_name, lines: [r.start_line, r.end_line], signature: r.signature })).sort(byName)).toEqual([...MODULE.symbols].sort(byName))
      const calls = db.prepare(`select s.qualified_name as from_qn, a.resolution, t.qualified_name as to_qn, e.start_line, e.id as evidence_id from assertion a
        join symbol s on s.id = a.source_id left join symbol t on t.id = a.target_id join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id
        where a.type = 'calls'`).all() as Array<{ from_qn: string; resolution: string; to_qn: string | null; start_line: number; evidence_id: string }>
      expect(calls.map((c) => ({ from: c.from_qn, line: c.start_line, site_text: evidenceSlice(d, db, c.evidence_id), resolution: c.resolution, to: c.to_qn }))).toEqual(MODULE.calls)
    })
  })
})
