import type Database from 'better-sqlite3'
import { areaOf } from './galaxy.js'

/** Relationship types along which a change travels from a symbol to the code that depends on it. */
export const IMPACT_TYPES = ['calls', 'inherits', 'implements', 'overrides', 'injects', 'registered_as', 'handles', 'dispatches_to', 'evaluates_flag', 'maps_to', 'exposes', 'consumes', 'reads_config', 'runs', 'calls_service', 'renders', 'uses_hook', 'provides_context', 'uses_context'] as const

export type Impact = {
  dependents: Array<{ id: string; kind: string; name: string; qualified_name: string; path: string; project: string | null; depth: number; site?: { path: string; start_line: number } }>
  totals: { dependents: number; by_depth: Record<string, number>; by_project: Array<{ name: string; count: number }>; by_area: Array<{ name: string; count: number }>; by_team: Array<{ name: string; count: number }> }
  stopped_by: 'max_depth' | 'node_budget' | null
  subject_members: number
  /** The assertion that first reached each node, whose site is a lean impact row's line (FR097); a peer reached through dispatch has none. */
  reached_by: Map<string, string>
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
export function analyzeImpact(db: Database.Database, snapshotId: string, subjects: string[], types: readonly string[], maxDepth: number, maxRows: number, keep: (d: Impact['dependents'][number]) => boolean = () => true): Impact {
  // A change reaches code through dispatch as well as direct references: a type through its members and the members of
  // the interfaces it implements, a member through the member it overrides or implements. Those peers share the reached node's depth.
  const { membersOf, kindOf } = structure(db, snapshotId)
  const files = types.includes('imports')
  const peers = (id: string): string[] => {
    const out: string[] = []
    if (TYPE_KINDS.has(kindOf.get(id) ?? '')) {
      out.push(...(membersOf.get(id) ?? []))
      for (const r of db.prepare("select dst from edge where src = ? and type = 'implements' and resolution = 'resolved'").all(id) as Array<{ dst: string }>) out.push(...(membersOf.get(r.dst) ?? []))
    } else {
      for (const r of db.prepare("select dst from edge where src = ? and type in ('overrides', 'implements') and resolution = 'resolved'").all(id) as Array<{ dst: string }>) out.push(r.dst)
    }
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
      const rows = db.prepare(`select src, assertion_id from edge where dst in (${chunk.map(() => '?').join(',')}) and type in (${types.map(() => '?').join(',')}) and resolution in ('resolved', 'resolved_external')`).all(...chunk, ...types) as Array<{ src: string; assertion_id: string }>
      for (const r of rows) reach(r.src, depth, next, r.assertion_id)
    }
    if (depthOf.size > NODE_BUDGET) { stopped = 'node_budget'; break }
    frontier = next
  }
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
  const found = ids.filter((id) => info.has(id)).filter((id) => { const s = info.get(id)!; return keep({ id, kind: s.kind, name: s.name, qualified_name: s.qualified_name, path: s.path, project: projectOf(id), depth: depthOf.get(id)! }) })
  const projects = found.map((id) => projectOf(id) ?? '(no project)')
  const byDepth: Record<string, number> = {}
  for (const id of found) byDepth[String(depthOf.get(id))] = (byDepth[String(depthOf.get(id))] ?? 0) + 1
  const ordered = found.sort((a, b) => depthOf.get(a)! - depthOf.get(b)! || (info.get(a)!.qualified_name < info.get(b)!.qualified_name ? -1 : 1))
  return {
    dependents: ordered.slice(0, maxRows).map((id) => { const s = info.get(id)!; return { id, kind: s.kind, name: s.name, qualified_name: s.qualified_name, path: s.path, project: projectOf(id), depth: depthOf.get(id)!, ...(s.kind === 'file' && via.has(id) ? { site: siteOf(db, via.get(id)!) } : {}) } }),
    totals: {
      dependents: found.length, by_depth: byDepth, by_project: count(projects), by_area: count(found.map((id) => areaOf(info.get(id)!.path))),
      by_team: count(projects.flatMap((p) => teamsOfProject.get(p) ?? [])),
    },
    stopped_by: stopped,
    subject_members: [...subjectSet].filter((id) => !subjects.includes(id) && kindOf.has(id)).length,
    reached_by: via,
  }
}
