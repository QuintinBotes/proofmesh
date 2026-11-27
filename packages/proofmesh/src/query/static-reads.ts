import type Database from 'better-sqlite3'

export type StaticRead = { entity: string; property: string; symbol_id: string; read_by: string[]; depth: number }
export type StaticReads = { reads: StaticRead[]; methods: number; unresolved_calls: number; stopped_by: 'max_depth' | 'max_rows' | null; not_visited: number }

/** Edges followed forward from an endpoint: to its action, the calls it makes, the handlers it dispatches to, the code a job runs. */
const FORWARD = ['exposes', 'calls', 'dispatches_to', 'runs'] as const
const CHUNK = 500

const chunks = <T>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))

/** The code reached from the given symbols over resolved calls, dispatch, endpoint actions and job classes, with each one's hop count. */
export function forwardReach(db: Database.Database, from: string[], maxDepth: number, maxNodes: number): { depthOf: Map<string, number>; stopped: StaticReads['stopped_by']; notVisited: number } {
  const depthOf = new Map<string, number>(from.map((id) => [id, 0]))
  let frontier = [...from], stopped: StaticReads['stopped_by'] = null, notVisited = 0
  const forward = db.prepare(`select dst as id from edge where src = ? and type in (${FORWARD.map(() => '?').join(',')}) and resolution = 'resolved'`)
  // A call to an interface or virtual member may dispatch to any implementation of it.
  const down = db.prepare("select src as id from edge where dst = ? and type in ('implements', 'overrides') and resolution = 'resolved'")
  const step = (id: string) => [...(forward.all(id, ...FORWARD) as Array<{ id: string }>), ...(down.all(id) as Array<{ id: string }>)]
  for (let depth = 1; frontier.length; depth++) {
    // The symbols one hop past the cut: the least the cut left out, since what lies beyond them is not walked.
    if (depth > maxDepth) { stopped = 'max_depth'; notVisited = new Set(frontier.flatMap((id) => step(id).map((r) => r.id)).filter((id) => !depthOf.has(id))).size; break }
    const next: string[] = []
    for (const id of frontier) {
      for (const r of step(id)) {
        if (depthOf.has(r.id)) continue
        if (depthOf.size >= maxNodes) { stopped = 'max_rows'; break }
        depthOf.set(r.id, depth)
        next.push(r.id)
      }
    }
    frontier = next
  }
  return { depthOf, stopped, notVisited }
}

/**
 * Entity properties read along resolved paths from the given symbols (A9, static reach, not load): breadth first over calls and
 * dispatch, then every `references` read from the code reached to a property or field of a mapped entity, its subtypes or its base
 * types. An upper bound on what executed branches read, blind past unresolved calls (counted) and to reads by reflection or
 * serialization. Reads in EF model configuration are left out.
 */
/** What every static-reads question in one snapshot shares: the entity types and the EF model configuration members. Compute once, pass to each call. */
export type ReadsModel = { entities: Set<string>; config: Set<string> }
export const readsModel = (db: Database.Database): ReadsModel => ({ entities: entityTypes(db), config: modelConfiguration(db) })

export function staticPropertyReads(db: Database.Database, from: string[], maxDepth: number, maxNodes: number, model: ReadsModel = readsModel(db)): StaticReads {
  const { depthOf, stopped, notVisited } = forwardReach(db, from, maxDepth, maxNodes)
  const reached = [...depthOf.keys()]
  const { entities, config } = model
  const reads = new Map<string, StaticRead>()
  for (const part of chunks(reached)) {
    const rows = db.prepare(`select a.source_id, a.detail, p.id as property_id, p.name, p.qualified_name, src.qualified_name as reader from assertion a join symbol p on p.id = a.target_id join symbol src on src.id = a.source_id
      where a.type = 'references' and a.resolution = 'resolved' and p.kind in ('property', 'field') and a.source_id in (${part.map(() => '?').join(',')})`).all(...part) as Array<{ source_id: string; detail: string | null; property_id: string; name: string; qualified_name: string; reader: string }>
    for (const r of rows) {
      const uses = ((r.detail ? (JSON.parse(r.detail) as { use?: string }).use : undefined) ?? 'read').split(',')
      const declaring = r.qualified_name.slice(0, r.qualified_name.length - r.name.length - 1)
      if (!uses.some((u) => u === 'read' || u === 'read_write') || !entities.has(declaring) || config.has(r.source_id)) continue
      const seen = reads.get(r.property_id)
      const depth = depthOf.get(r.source_id)!
      if (!seen) reads.set(r.property_id, { entity: declaring, property: r.name, symbol_id: r.property_id, read_by: [r.reader], depth })
      else {
        if (!seen.read_by.includes(r.reader) && seen.read_by.length < 5) seen.read_by.push(r.reader)
        seen.depth = Math.min(seen.depth, depth)
      }
    }
  }
  let unresolved = 0
  for (const part of chunks(reached)) unresolved += (db.prepare(`select count(*) as n from assertion where type = 'calls' and resolution in ('unresolved', 'candidate', 'ambiguous') and source_id in (${part.map(() => '?').join(',')})`).get(...part) as { n: number }).n
  return {
    reads: [...reads.values()].sort((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : a.property < b.property ? -1 : 1)),
    methods: reached.length - from.length, unresolved_calls: unresolved, stopped_by: stopped, not_visited: notVisited,
  }
}

/** Qualified names of mapped entities, the types deriving from them, and their base types: a property declared on any of them is an entity property. */
function entityTypes(db: Database.Database): Set<string> {
  const ids = new Set((db.prepare("select src as id from edge where type = 'maps_to' and resolution = 'resolved'").all() as Array<{ id: string }>).map((r) => r.id))
  for (const dir of [['dst', 'src'], ['src', 'dst']] as const) {
    let frontier = [...ids]
    while (frontier.length) {
      const next: string[] = []
      for (const part of chunks(frontier)) for (const r of db.prepare(`select ${dir[1]} as id from edge where type = 'inherits' and resolution = 'resolved' and ${dir[0]} in (${part.map(() => '?').join(',')})`).all(...part) as Array<{ id: string }>) if (!ids.has(r.id)) { ids.add(r.id); next.push(r.id) }
      frontier = next
    }
  }
  const names = new Set<string>()
  for (const part of chunks([...ids])) for (const r of db.prepare(`select qualified_name from symbol where id in (${part.map(() => '?').join(',')})`).all(...part) as Array<{ qualified_name: string }>) names.add(r.qualified_name)
  return names
}

/** Members of EF model configuration: OnModelCreating, and the members of types that configure an entity type. */
function modelConfiguration(db: Database.Database): Set<string> {
  const ids = new Set((db.prepare("select id from symbol where name = 'OnModelCreating'").all() as Array<{ id: string }>).map((r) => r.id))
  const types = db.prepare(`select distinct t.qualified_name, t.file_id from assertion a join external_symbol x on x.id = a.target_id join symbol t on t.id = a.source_id
    where a.type in ('inherits', 'implements') and a.resolution = 'resolved_external' and x.name like '%EntityTypeConfiguration%'`).all() as Array<{ qualified_name: string; file_id: string }>
  const members = db.prepare("select id from symbol where file_id = ? and qualified_name like ? escape '\\'")
  for (const t of types) for (const m of members.all(t.file_id, `${t.qualified_name.replace(/[\\%_]/g, (c) => `\\${c}`)}.%`) as Array<{ id: string }>) ids.add(m.id)
  return ids
}
