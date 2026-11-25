import type Database from 'better-sqlite3'
import { type Basis, inferredSql } from './basis.js'
import { areaOf } from './galaxy.js'
import { candidatesTo, sitesNaming } from './inferred.js'

/** Relationship types along which a change travels from a symbol to the code that depends on it. */
export const IMPACT_TYPES = ['calls', 'inherits', 'implements', 'overrides', 'injects', 'registered_as', 'handles', 'dispatches_to', 'evaluates_flag', 'maps_to', 'exposes', 'consumes', 'reads_config', 'runs', 'calls_service', 'renders', 'uses_hook', 'provides_context', 'uses_context'] as const

export type Impact = {
  dependents: Array<{ id: string; kind: string; name: string; qualified_name: string; path: string; project: string | null; depth: number; basis: Basis; site?: { path: string; start_line: number } }>
  totals: { dependents: number; by_basis: Record<Basis, number>; by_depth: Record<string, number>; by_project: Array<{ name: string; count: number }>; by_area: Array<{ name: string; count: number }>; by_team: Array<{ name: string; count: number }> }
  stopped_by: 'max_depth' | 'node_budget' | null
  subject_members: number
  /** The assertion that first reached each node, whose site is a lean impact row's line (FR097); a peer reached through dispatch has none. */
  reached_by: Map<string, string>
  /** The candidate sites naming code the walk reached: those it could follow, and those it never does for their cap (FR202, FR209). */
  sites: { followable: number; capped: number }
}

const NODE_BUDGET = 50000

/** The first line of an assertion's evidence: for an import, the statement. */
const siteOf = (db: Database.Database, assertion: string) => db.prepare('select f.path, e.start_line from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by e.start_byte limit 1').get(assertion) as { path: string; start_line: number }
export const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'type_alias'])

const memo = new Map<string, { membersOf: Map<string, string[]>; kindOf: Map<string, string> }>()
/** Members of every type, by the type's qualified name being the member's parent; computed once per open snapshot. */
export function structure(db: Database.Database, snapshotId: string) {
  const hit = memo.get(snapshotId)
  if (hit) return hit
  const rows = db.prepare("select id, kind, qualified_name from symbol where kind <> 'module'").all() as Array<{ id: string; kind: string; qualified_name: string }>
  const typeByName = new Map<string, string>()
  const kindOf = new Map<string, string>()
  for (const r of rows) { kindOf.set(r.id, r.kind); if (TYPE_KINDS.has(r.kind)) typeByName.set(r.qualified_name, r.id) }
  const membersOf = new Map<string, string[]>()
  for (const r of rows) {
    const cut = r.qualified_name.lastIndexOf('.')
    const owner = cut > 0 ? typeByName.get(r.qualified_name.slice(0, cut)) : undefined
    if (!owner || owner === r.id) continue
    const list = membersOf.get(owner)
    if (list) list.push(r.id)
    else membersOf.set(owner, [r.id])
  }
  const result = { membersOf, kindOf }
  memo.set(snapshotId, result)
  return result
}

/**
 * Potential impact of changing the subjects: everything that reaches them along resolved relationships of the given
 * types, breadth first and bounded. Grouped by project (from project containment), area, and owning team. With imports among
 * the types a file and its module symbol are one node (FR090, FR091), reported once as the file, with the import that reached it.
 */
export function analyzeImpact(db: Database.Database, snapshotId: string, subjects: string[], types: readonly string[], maxDepth: number, maxRows: number, keep: (d: Impact['dependents'][number]) => boolean = () => true, candidates = false, budget = NODE_BUDGET): Impact {
  // A change reaches code through dispatch as well as direct references: a type through its members and the members of
  // the interfaces it implements, a member through the member it overrides or implements. Those peers share the reached node's depth.
  const { membersOf, kindOf } = structure(db, snapshotId)
  const files = types.includes('imports')
  const above = db.prepare(`select e.dst, ${inferredSql()} as inferred from edge e join assertion a on a.id = e.assertion_id where e.src = ? and e.type = 'implements' and e.resolution = 'resolved'`)
  const overrides = db.prepare(`select e.dst, ${inferredSql()} as inferred from edge e join assertion a on a.id = e.assertion_id where e.src = ? and e.type in ('overrides', 'implements') and e.resolution = 'resolved'`)
  /** One breadth-first walk; with observedOnly it follows no inferred edge, so what it reaches is reached by a chain of observed hops alone. */
  const walk = (observedOnly: boolean) => {
    let sawInferred = false
    // Members reached upward through dispatch: their other implementers are siblings of the subject, not dependents of it.
    const upward = new Set<string>()
    const follow = (rows: Array<{ dst: string; inferred: number }>) => rows.filter((r) => { if (r.inferred) sawInferred = true; return !(observedOnly && r.inferred) }).map((r) => r.dst)
    const peers = (id: string): string[] => {
      const out: string[] = []
      if (TYPE_KINDS.has(kindOf.get(id) ?? '')) {
        out.push(...(membersOf.get(id) ?? []))
        for (const dst of follow(above.all(id) as Array<{ dst: string; inferred: number }>)) for (const m of membersOf.get(dst) ?? []) { upward.add(m); out.push(m) }
      } else for (const dst of follow(overrides.all(id) as Array<{ dst: string; inferred: number }>)) { upward.add(dst); out.push(dst) }
      if (files) out.push(...(db.prepare("select id from symbol where file_id = ? and kind = 'module' union select file_id from symbol where id = ? and kind = 'module'").all(id, id) as Array<{ id: string }>).map((r) => r.id))
      return out
    }
    const depthOf = new Map<string, number>()
    /** The assertion that first reached each node. */
    const via = new Map<string, string>()
    const reach = (id: string, depth: number, into: string[], assertion?: string) => {
      if (assertion && !depthOf.has(id)) via.set(id, assertion)
      const queue = [id]
      while (queue.length) {
        const n = queue.pop()!
        if (depthOf.has(n)) continue
        depthOf.set(n, depth)
        into.push(n)
        queue.push(...peers(n))
      }
    }
    let frontier: string[] = []
    for (const id of subjects) reach(id, 0, frontier)
    const subjectSet = new Set(frontier)
    let stopped: Impact['stopped_by'] = null
    for (let depth = 1; frontier.length; depth++) {
      if (depth > maxDepth) { stopped = 'max_depth'; break }
      const next: string[] = []
      for (let i = 0; i < frontier.length; i += 500) {
        const chunk = frontier.slice(i, i + 500)
        // An external subject is reached only through calls that resolved to it; nothing else points at an external.
        const rows = db.prepare(`select e.src, e.dst, e.type, e.assertion_id, ${inferredSql()} as inferred from edge e join assertion a on a.id = e.assertion_id where e.dst in (${chunk.map(() => '?').join(',')}) and e.type in (${types.map(() => '?').join(',')}) and e.resolution in ('resolved', 'resolved_external')`).all(...chunk, ...types) as Array<{ src: string; dst?: string; type?: string; assertion_id: string; inferred: number }>
        // A candidate site names its callers through assertion_candidate; it is an edge only while following (FR202).
        if (candidates) rows.push(...candidatesTo(db, chunk, types).map((c) => ({ src: c.src, assertion_id: c.assertion_id, inferred: 1 })))
        for (const r of rows) {
          if (r.dst && upward.has(r.dst) && (r.type === 'implements' || r.type === 'overrides')) continue
          if (r.inferred) sawInferred = true
          if (!(observedOnly && r.inferred)) reach(r.src, depth, next, r.assertion_id)
          // Checked per row, so a hub with thousands of callers cannot overshoot the budget within one level (FR210).
          if (depthOf.size > budget) break
        }
        if (depthOf.size > budget) break
      }
      if (depthOf.size > budget) { stopped = 'node_budget'; break }
      frontier = next
    }
    return { depthOf, via, subjectSet, stopped, sawInferred }
  }
  // Every node is reached by its shortest chain; one an all-observed chain also reaches is observed, at the depth of its shortest observed
  // chain (FR184). Only a walk that met an inferred edge can differ, so the second walk runs only then.
  const all = walk(false)
  const observed = all.sawInferred ? walk(true) : all
  const { subjectSet, stopped } = all
  const basisOf = (id: string): Basis => (observed.depthOf.has(id) ? 'observed' : 'inferred')
  const depthOf = new Map<string, number>([...all.depthOf, ...observed.depthOf])
  const via = new Map<string, string>([...all.via, ...observed.via])
  const ids = [...depthOf.keys()].filter((id) => depthOf.get(id)! > 0 && (id.startsWith('sym_') || id.startsWith('file_')))
  const info = new Map<string, { kind: string; name: string; qualified_name: string; path: string; file_id: string }>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500), cp = chunk.map(() => '?').join(',')
    for (const r of db.prepare(`select s.id, s.kind, s.name, s.qualified_name, f.path, s.file_id from symbol s join file f on f.id = s.file_id where s.id in (${cp})
      union all select id, 'file', path, path, path, id from file where id in (${cp})`).all(...chunk, ...chunk) as Array<{ id: string; kind: string; name: string; qualified_name: string; path: string; file_id: string }>) info.set(r.id, { ...r, name: r.kind === 'file' ? r.path.slice(r.path.lastIndexOf('/') + 1) : r.name })
  }
  // A module symbol whose file was reached is that file: reported once, as the file, at the site that reached either.
  for (const [id, s] of info) {
    if (s.kind !== 'module' || !info.has(s.file_id)) continue
    if (!via.has(s.file_id) && via.has(id)) via.set(s.file_id, via.get(id)!)
    info.delete(id)
  }
  // A file belongs to the projects that contain its module symbol; a project is owned by the teams it is owned_by.
  const projectOfFile = new Map<string, string>()
  for (const r of db.prepare("select m.file_id, p.qualified_name from assertion a join symbol p on p.id = a.source_id join symbol m on m.id = a.target_id where a.type = 'contains' and p.kind = 'project'").all() as Array<{ file_id: string; qualified_name: string }>) if (!projectOfFile.has(r.file_id)) projectOfFile.set(r.file_id, r.qualified_name)
  const teamsOfProject = new Map<string, string[]>()
  for (const r of db.prepare("select p.qualified_name as project, t.qualified_name as team from assertion a join symbol p on p.id = a.source_id join symbol t on t.id = a.target_id where a.type = 'owned_by' and p.kind = 'project'").all() as Array<{ project: string; team: string }>) teamsOfProject.set(r.project, [...(teamsOfProject.get(r.project) ?? []), r.team])
  const count = (keys: string[]) => {
    const m = new Map<string, number>()
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name, n]) => ({ name, count: n }))
  }
  const projectOf = (id: string) => projectOfFile.get(info.get(id)!.file_id) ?? null
  const found = ids.filter((id) => info.has(id)).filter((id) => { const s = info.get(id)!; return keep({ id, kind: s.kind, name: s.name, qualified_name: s.qualified_name, path: s.path, project: projectOf(id), depth: depthOf.get(id)!, basis: basisOf(id) }) })
  const projects = found.map((id) => projectOf(id) ?? '(no project)')
  const byDepth: Record<string, number> = {}
  for (const id of found) byDepth[String(depthOf.get(id))] = (byDepth[String(depthOf.get(id))] ?? 0) + 1
  const ordered = found.sort((a, b) => depthOf.get(a)! - depthOf.get(b)! || (info.get(a)!.qualified_name < info.get(b)!.qualified_name ? -1 : 1))
  return {
    dependents: ordered.slice(0, maxRows).map((id) => { const s = info.get(id)!; return { id, kind: s.kind, name: s.name, qualified_name: s.qualified_name, path: s.path, project: projectOf(id), depth: depthOf.get(id)!, basis: basisOf(id), ...(s.kind === 'file' && via.has(id) ? { site: siteOf(db, via.get(id)!) } : {}) } }),
    totals: {
      dependents: found.length, by_basis: { observed: found.filter((id) => basisOf(id) === 'observed').length, inferred: found.filter((id) => basisOf(id) === 'inferred').length }, by_depth: byDepth, by_project: count(projects), by_area: count(found.map((id) => areaOf(info.get(id)!.path))),
      by_team: count(projects.flatMap((p) => teamsOfProject.get(p) ?? [])),
    },
    stopped_by: stopped,
    subject_members: [...subjectSet].filter((id) => !subjects.includes(id) && kindOf.has(id)).length,
    reached_by: via,
    sites: sitesNaming(db, [...depthOf.keys()], types),
  }
}
