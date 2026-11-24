import type Database from 'better-sqlite3'
import type { Envelope } from '../core/generated.js'

export const CAPS = ['text', 'syntax', 'symbols', 'imports', 'references', 'resolved_calls', 'framework'] as const
export const UNRESOLVED_REASONS = new Set(['dynamic_element_access', 'untyped_receiver', 'unknown_name', 'chained_callee', 'import_unresolved', 'dynamic_specifier', 'not_indexed', 'dependency_missing', 'configuration_error', 'outside_capability'])

/** Snapshot-wide facts every envelope reports. A sealed snapshot never changes, so they are computed once. */
export type SnapshotSummary = {
  files_discovered: number
  dispositions: NonNullable<Envelope['coverage']>['dispositions']
  capabilities: NonNullable<Envelope['coverage']>['capabilities']
  unresolved: { count: number; sample: Envelope['unresolved']['sample']; by_reason: Record<string, number> }
  /** Unresolved calls have unknown targets, so every one of them could reach any symbol. */
  unresolved_calls: { count: number; by_reason: Record<string, number>; dependency_missing_by_package: Record<string, number> }
  /** External inputs the adapters needed but could not find, such as packages missing from the NuGet cache (A2). */
  missing_inputs: string[]
  call_sites: number
  hubs: Array<{ id: string; kind: string; name: string; qualified_name: string; path: string; inbound: number }>
}

export function computeSummary(db: Database.Database): SnapshotSummary {
  const files = db.prepare('select disposition, capabilities from file').all() as Array<{ disposition: string; capabilities: string }>
  const dispositions = { indexed: 0, excluded_by_rule: 0, unsupported: 0, failed: 0, pending: 0 }
  for (const f of files) dispositions[f.disposition as keyof typeof dispositions]++
  const indexedCaps = files.filter((f) => f.disposition === 'indexed').map((f) => JSON.parse(f.capabilities) as Record<string, string>)
  const capabilities = Object.fromEntries(CAPS.map((k) => {
    const values = indexedCaps.map((c) => c[k]).filter((v): v is string => !!v)
    if (!values.length || values.every((v) => v === 'unsupported')) return [k, 'unsupported']
    if (values.every((v) => v === 'complete' || v === 'unsupported')) return [k, values.includes('complete') ? 'complete' : 'unsupported']
    if (values.every((v) => v === 'failed')) return [k, 'failed']
    return [k, 'partial']
  })) as SnapshotSummary['capabilities']
  const by_reason = Object.fromEntries((db.prepare("select reason, count(*) as n from assertion where resolution = 'unresolved' group by reason order by reason").all() as Array<{ reason: string; n: number }>).map((r) => [r.reason, r.n]))
  const sample = (db.prepare(`select a.id as assertion_id, a.reason, f.path as file, e.start_line as line from assertion a
    join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id
    where a.resolution = 'unresolved' group by a.id order by f.path, e.start_byte limit 20`).all() as SnapshotSummary['unresolved']['sample'])
  const hubs = (db.prepare(`select e.dst as id, s.kind, s.name, s.qualified_name, f.path, count(*) as inbound from edge e
    join symbol s on s.id = e.dst join file f on f.id = s.file_id where e.resolution = 'resolved'
    group by e.dst order by inbound desc, e.dst limit 12`).all() as SnapshotSummary['hubs'])
  const calls = Object.fromEntries((db.prepare("select reason, count(*) as n from assertion where resolution = 'unresolved' and type = 'calls' group by reason order by reason").all() as Array<{ reason: string; n: number }>).map((r) => [r.reason, r.n]))
  // Which missing packages the dependency_missing sites are blamed on, from the detail the adapter attached.
  // A site names every package its project lacks; it counts once under each, so the counts say what restoring one package could fix.
  const perPackage = new Map<string, number>()
  for (const r of db.prepare("select coalesce(json_extract(detail, '$.packages'), '(unnamed)') as p, count(*) as n from assertion where resolution = 'unresolved' and reason = 'dependency_missing' group by p").all() as Array<{ p: string; n: number }>)
    for (const pkg of r.p.split(', ').filter((x) => x && !x.startsWith('…'))) perPackage.set(pkg, (perPackage.get(pkg) ?? 0) + r.n)
  const byPackage = Object.fromEntries([...perPackage].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 20))
  const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
  const adapters = JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string } | undefined)?.value ?? '[]') as Array<{ external_inputs?: string[] }>
  const missing_inputs = adapters.flatMap((a) => (a.external_inputs ?? []).filter((i) => i.endsWith(' missing'))).sort()
  return { files_discovered: files.length, dispositions, capabilities, unresolved: { count: total(by_reason), sample, by_reason }, unresolved_calls: { count: total(calls), by_reason: calls, dependency_missing_by_package: byPackage }, missing_inputs, call_sites: (db.prepare("select count(*) as n from assertion where type = 'calls'").get() as { n: number }).n, hubs }
}

const memo = new Map<string, SnapshotSummary>()

/** The summary stored in the snapshot at index time; snapshots published before it existed compute it once per process. */
export function snapshotSummary(db: Database.Database, snapshotId: string): SnapshotSummary {
  const hit = memo.get(snapshotId)
  if (hit) return hit
  const stored = db.prepare("select value from meta where key = 'summary'").get() as { value: string } | undefined
  const parsed = stored ? (JSON.parse(stored.value) as SnapshotSummary) : undefined
  const summary = parsed?.unresolved_calls && parsed.missing_inputs && parsed.call_sites !== undefined ? parsed : computeSummary(db)
  memo.set(snapshotId, summary)
  return summary
}
