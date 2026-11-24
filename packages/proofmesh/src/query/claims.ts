import type Database from 'better-sqlite3'
import type { EvidenceStore } from '../evidence/store.js'
import { SqliteEdges, trace } from '../meshstore/traversal.js'
import { resolveRef } from './notes.js'

/** A structured proposition about the graph; the claim's prose statement is kept but never checked (FR033). */
export type Proposition =
  | { type: 'relationship'; source: string; relationship: string; target: string }
  | { type: 'path'; source: string; target: string; relationships?: string[]; max_depth?: number }
  | { type: 'no_path'; source: string; target: string; relationships?: string[]; max_depth?: number }

export type Outcome = 'pass' | 'fail' | 'not_run' | 'unsupported' | 'inconclusive' | 'unavailable'
export type Layer = { name: 'scope' | 'resolution' | 'semantic' | 'integrity' | 'replay' | 'independent' | 'execution'; outcome: Outcome; detail: string }
export type Verdict = 'supported' | 'refuted' | 'inconclusive' | 'invalid'

const resolve = (db: Database.Database, ref: string) => (ref.startsWith('sym_') ? ((db.prepare('select id from symbol where id = ?').get(ref) as { id: string } | undefined)?.id ?? null) : resolveRef(db, ref))

/**
 * Checks a proposition layer by layer and aggregates a scoped verdict by a fixed policy: a subject outside the snapshot makes it
 * inconclusive; evidence that fails its integrity check makes the claim invalid whatever the graph says; otherwise the semantic layer decides.
 */
export function verify(db: Database.Database, store: EvidenceStore, p: Proposition, limits: { maxDepth: number; maxRows: number; deadline: number }, scope: { snapshot: string; current: string | null }): { layers: Layer[]; verdict: Verdict; dependencies: { assertions: string[]; evidence: string[] }; limitations: string[] } {
  const limitations = ['The statement text is not checked; only the structured proposition is.']
  // IDs name one node of one snapshot (A16): an external symbol, or a symbol ID of another snapshot or repository, is outside this one.
  const outside = [p.source, p.target].filter((ref) => ref.startsWith('ext_') || (ref.startsWith('sym_') && !db.prepare('select 1 from symbol where id = ?').get(ref)))
  if (outside.length) {
    const layers: Layer[] = [{ name: 'scope', outcome: 'fail', detail: `Outside snapshot ${scope.snapshot}: ${outside.join(', ')}` }]
    return finish(layers, 'inconclusive', { assertions: [], evidence: [] }, [...limitations, 'A claim is checked within one repository snapshot. An external symbol, or a symbol ID of another snapshot, is outside it; name a symbol as kind:qualified_name to check it in another snapshot.'])
  }
  const superseded = scope.current !== scope.snapshot
  const layers: Layer[] = [{ name: 'scope', outcome: 'pass', detail: superseded ? `Checked against snapshot ${scope.snapshot}, which is not the repository's current snapshot.` : `Checked against snapshot ${scope.snapshot}, the repository's current snapshot.` }]
  if (superseded) limitations.push(`Snapshot ${scope.snapshot} is not the repository's current snapshot${scope.current ? ` (${scope.current} is)` : ''}: the verdict holds for that snapshot, not for the code as it is now.`)
  const source = resolve(db, p.source), target = resolve(db, p.target)
  const missing = [...(source ? [] : [p.source]), ...(target ? [] : [p.target])]
  if (missing.length) {
    layers.push({ name: 'resolution', outcome: 'fail', detail: `Not in this snapshot: ${missing.join(', ')}` })
    return finish(layers, 'inconclusive', { assertions: [], evidence: [] }, [...limitations, 'A referenced symbol does not exist in this snapshot.'])
  }
  layers.push({ name: 'resolution', outcome: 'pass', detail: 'Every reference resolves to a symbol.' })
  let semantic: Outcome, detail: string, assertions: string[] = []
  if (p.type === 'relationship') {
    const rows = db.prepare("select id from assertion where source_id = ? and type = ? and target_id = ? and resolution = 'resolved'").all(source, p.relationship, target) as Array<{ id: string }>
    const open = (db.prepare("select count(*) as n from assertion where source_id = ? and type = ? and resolution in ('unresolved', 'candidate', 'ambiguous')").get(source, p.relationship) as { n: number }).n
    assertions = rows.map((r) => r.id)
    ;[semantic, detail] = rows.length ? ['pass', `${rows.length} resolved ${p.relationship} assertion(s).`]
      : open ? ['inconclusive', `No resolved ${p.relationship} assertion, but ${open} unresolved site(s) of the source could be it.`]
      : ['fail', `No ${p.relationship} assertion from the source to the target, and none unresolved.`]
  } else {
    const t = trace(new SqliteEdges(db), { source: source!, target: target!, types: p.relationships ?? ['calls'], resolutions: ['resolved'], maxDepth: Math.min(p.max_depth ?? limits.maxDepth, 12), maxRows: limits.maxRows, deadline: limits.deadline })
    const open = t.expanded.length ? (db.prepare(`select count(*) as n from assertion where source_id in (${t.expanded.map(() => '?').join(',')}) and type in (${(p.relationships ?? ['calls']).map(() => '?').join(',')}) and resolution in ('unresolved', 'candidate', 'ambiguous')`).get(...t.expanded, ...(p.relationships ?? ['calls'])) as { n: number }).n : 0
    const found = t.paths.length > 0, exhaustive = !found && !t.stopped_by && open === 0
    if ((p.relationships ?? ['calls']).some((x) => x === 'implements' || x === 'overrides')) limitations.push('implements and overrides hops run both ways: a call to an interface or virtual member may dispatch to any implementation.')
    else limitations.push('Paths were followed along calls only; name implements and overrides among the relationships to reach implementations through interfaces and virtual members.')
    assertions = found ? t.paths[0]!.assertions : []
    if (p.type === 'path') [semantic, detail] = found ? ['pass', `A path of ${t.paths[0]!.assertions.length} step(s).`] : exhaustive ? ['fail', 'No path exists within the declared relationship types.'] : ['inconclusive', t.stopped_by ? `No path within the ${t.stopped_by} limit.` : `No resolved path; ${open} unresolved site(s) in reach could lead there.`]
    else [semantic, detail] = found ? ['fail', `A path of ${t.paths[0]!.assertions.length} step(s) exists.`] : exhaustive ? ['pass', 'The search exhausted the resolved graph with no unresolved site in reach.'] : ['inconclusive', t.stopped_by ? `The search stopped at the ${t.stopped_by} limit.` : `${open} unresolved site(s) in reach could lead to the target.`]
    if (p.type === 'no_path') limitations.push('An absence holds only for the declared relationship types and resolutions, and only for code the adapters analysed.')
  }
  layers.push({ name: 'semantic', outcome: semantic, detail })
  const evidence = assertions.length ? (db.prepare(`select evidence_id from assertion_evidence where assertion_id in (${assertions.map(() => '?').join(',')}) order by evidence_id`).all(...assertions) as Array<{ evidence_id: string }>).map((r) => r.evidence_id) : []
  const bad: string[] = [], unavailable: string[] = []
  for (const id of evidence) {
    const e = db.prepare('select object_hash, start_byte, end_byte from evidence where id = ?').get(id) as { object_hash: string; start_byte: number; end_byte: number }
    const v = store.verify(e.object_hash)
    if (v.integrity.status === 'failed') bad.push(id)
    else if (v.integrity.status === 'unavailable' || (v.content && v.content.length < e.end_byte)) unavailable.push(id)
  }
  layers.push({ name: 'integrity', outcome: !evidence.length ? 'not_run' : bad.length ? 'fail' : unavailable.length ? 'unavailable' : 'pass', detail: !evidence.length ? 'The verdict rests on no evidence record.' : bad.length ? `${bad.length} evidence object(s) do not match their recorded hash.` : unavailable.length ? `${unavailable.length} evidence object(s) are missing.` : `${evidence.length} evidence record(s) match their hashes.` })
  layers.push({ name: 'replay', outcome: 'unsupported', detail: 'Adapters do not replay extraction in this version.' })
  layers.push({ name: 'independent', outcome: 'not_run', detail: 'No independent corroboration is configured.' })
  layers.push({ name: 'execution', outcome: 'not_run', detail: 'Approved execution is not available in this version.' })
  const verdict: Verdict = bad.length ? 'invalid' : unavailable.length ? 'inconclusive' : semantic === 'pass' ? 'supported' : semantic === 'fail' ? 'refuted' : 'inconclusive'
  return finish(layers, verdict, { assertions, evidence }, limitations)
}

const finish = (layers: Layer[], verdict: Verdict, dependencies: { assertions: string[]; evidence: string[] }, limitations: string[]) => {
  const names: Layer['name'][] = ['scope', 'resolution', 'semantic', 'integrity', 'replay', 'independent', 'execution']
  for (const name of names) if (!layers.some((l) => l.name === name)) layers.push({ name, outcome: 'not_run', detail: 'Not reached: an earlier layer decided the verdict.' })
  return { layers, verdict, dependencies, limitations }
}
