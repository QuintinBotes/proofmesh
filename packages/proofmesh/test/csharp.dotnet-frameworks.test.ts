import { beforeAll, describe, expect, it } from 'vitest'
import { evidenceSlice, expectedFor, fixtureRepo, indexedDataDir, withSnapshot } from './helpers.js'

type Fact = { type: string; from: string; to?: string; reason?: string | null; resolution?: string; detail: Record<string, string>; line: number; site_text: string }

const EXPECTED = expectedFor('cs-frameworks') as { symbols: unknown[]; relationships: Record<string, Fact[]> }
const RULES: Array<[string, string]> = [
  ['dependency_injection', 'Microsoft.Extensions.DependencyInjection registrations and constructor injections'],
  ['aspnet_core', 'ASP.NET Core controller and minimal API endpoints'],
  ['refit', 'Refit outbound calls'],
  ['mediatr', 'MediatR handlers and dispatches'],
  ['hosted_services', 'hosted service jobs'],
  ['configuration', 'configuration reads'],
  ['kafka', 'Confluent.Kafka publishes and subscriptions'],
]
const TYPE_RULE: Record<string, string> = {
  registered_as: 'dependency_injection', injects: 'dependency_injection', exposes: 'aspnet_core', handles: 'mediatr',
  runs: 'hosted_services', reads_config: 'configuration', publishes: 'kafka', consumes: 'kafka',
}
const ruleOf = (f: Fact) => TYPE_RULE[f.type] ?? (f.type === 'dispatches_to' ? (f.detail.direction === 'outbound' ? 'refit' : 'mediatr') : f.type)
const key = (f: Fact) => JSON.stringify([f.type, f.from, f.to ?? '', f.line, f.site_text])
const order = (a: Fact, b: Fact) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)

describe('built-in .NET framework rules on fixtures/cs-frameworks', () => {
  let dataDir: string
  let facts: Fact[]
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('cs-frameworks')))
    facts = withSnapshot(dataDir, (db) => {
      const ref = (id: string) => {
        const s = db.prepare('select kind, qualified_name from symbol where id = ?').get(id) as { kind: string; qualified_name: string }
        return `${s.kind} ${s.qualified_name}`
      }
      const rows = db.prepare("select a.type, a.source_id, a.target_id, a.resolution, a.reason, a.detail, ae.evidence_id from assertion a join assertion_evidence ae on ae.assertion_id = a.id where a.origin = 'framework_adapter'").all() as Array<{ type: string; source_id: string; target_id: string | null; resolution: string; reason: string | null; detail: string; evidence_id: string }>
      return rows.map((r) => ({
        type: r.type,
        from: ref(r.source_id),
        ...(r.resolution === 'resolved' ? { to: ref(r.target_id!) } : r.resolution === 'unresolved' ? { reason: r.reason } : { resolution: r.resolution }),
        detail: JSON.parse(r.detail),
        line: (db.prepare('select start_line from evidence where id = ?').get(r.evidence_id) as { start_line: number }).start_line,
        site_text: evidenceSlice(dataDir, db, r.evidence_id),
      }))
    })
  })

  it('FR016 FR077 endpoints, jobs, configuration keys, and channels equal the oracle, each declared at its first site', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select s.kind, s.qualified_name, s.name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind in ('endpoint', 'job', 'config_key', 'channel', 'team')").all()
      const byName = (a: any, b: any) => (`${a.kind} ${a.qualified_name}` < `${b.kind} ${b.qualified_name}` ? -1 : 1)
      expect(rows.sort(byName)).toEqual([...EXPECTED.symbols].sort(byName))
    })
  })

  for (const [rule, title] of RULES) {
    it(`FR016 FR077 ${title} equal the oracle, each citing its rule and site`, () => {
      expect(facts.filter((f) => ruleOf(f) === rule).sort(order)).toEqual([...EXPECTED.relationships[rule]!].sort(order))
    })
  }

  it('FR016 the oracle accounts for every framework fact: decoy types in other namespaces produce none', () => {
    expect(facts.sort(order)).toEqual(Object.values(EXPECTED.relationships).flat().sort(order))
  })
})
