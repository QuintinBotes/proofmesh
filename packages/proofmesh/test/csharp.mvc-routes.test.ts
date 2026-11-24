import { beforeAll, describe, expect, it } from 'vitest'
import { evidenceSlice, expectedFor, fixtureRepo, indexedDataDir, withSnapshot } from './helpers.js'

type Fact = { type: string; from: string; to?: string; reason?: string | null; detail: Record<string, string>; line: number; site_text: string }
const EXPECTED = expectedFor('cs-mvc-routes') as { symbols: unknown[]; relationships: Fact[] }
const key = (f: Fact) => JSON.stringify([f.type, f.from, f.to ?? '', f.line, f.site_text, f.detail.route ?? ''])
const order = (a: Fact, b: Fact) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)

describe('ASP.NET Core conventional routes on fixtures/cs-mvc-routes', () => {
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('cs-mvc-routes')))
  })

  it('FR016 each conventional template reaches the actions of its own application, declared where the template is registered', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select s.kind, s.qualified_name, s.name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind = 'endpoint'").all()
      const byName = (a: any, b: any) => (a.qualified_name < b.qualified_name ? -1 : 1)
      expect(rows.sort(byName)).toEqual([...EXPECTED.symbols].sort(byName))
    })
  })

  it('FR016 FR018 exposes facts equal the oracle: defaults select, areas and other applications are not reached, a computed template stays open', () => {
    const facts = withSnapshot(dataDir, (db) => {
      const ref = (id: string) => {
        const s = db.prepare('select kind, qualified_name from symbol where id = ?').get(id) as { kind: string; qualified_name: string }
        return `${s.kind} ${s.qualified_name}`
      }
      const rows = db.prepare("select a.type, a.source_id, a.target_id, a.resolution, a.reason, a.detail, ae.evidence_id from assertion a join assertion_evidence ae on ae.assertion_id = a.id where a.origin = 'framework_adapter' and a.type = 'exposes'").all() as Array<{ type: string; source_id: string; target_id: string | null; resolution: string; reason: string | null; detail: string; evidence_id: string }>
      return rows.map((r) => ({
        type: r.type, from: ref(r.source_id),
        ...(r.resolution === 'resolved' ? { to: ref(r.target_id!) } : { reason: r.reason }),
        detail: JSON.parse(r.detail),
        line: (db.prepare('select start_line from evidence where id = ?').get(r.evidence_id) as { start_line: number }).start_line,
        site_text: evidenceSlice(dataDir, db, r.evidence_id),
      }))
    })
    expect(facts.sort(order)).toEqual([...EXPECTED.relationships].sort(order))
  })
})
