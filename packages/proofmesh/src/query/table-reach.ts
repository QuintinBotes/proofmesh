import type Database from 'better-sqlite3'
import { analyzeImpact, IMPACT_TYPES, type Impact } from './impact.js'

type Reached = { id: string; kind: 'endpoint' | 'job'; qualified_name: string; name: string; path: string; depth: number }
/** A table and every table symbol that names it, shown as its first declaration in path order. */
export type Table = { id: string; qualified_name: string; name: string; path: string; symbols: Array<{ id: string; qualified_name: string; path: string }> }
export type TableReach = Omit<Table, 'symbols'> & {
  /** Every table symbol of the table, when more than one names it (A36). */
  symbols?: Table['symbols']
  entities: Array<{ id: string; qualified_name: string; via: 'maps_to' | 'inherits' }>
  accessors: Array<{ id: string; qualified_name: string; readers: number }>
  reach: Reached[]
  horizon: boolean
  stopped_by: Impact['stopped_by']
}

/**
 * The tables a name denotes: its qualified name (`sales.Clients`) or bare name (`Clients`), or any name ignoring case when asked. A table
 * is its name (A36): table symbols sharing a qualified name, ignoring case, are one table, whichever adapter declared each.
 */
export function findTables(db: Database.Database, table: string, ignoreCase = false): Table[] {
  const rows = db.prepare(`select s.id, s.qualified_name, s.name, f.path, lower(s.qualified_name) as key from symbol s join file f on f.id = s.file_id where s.kind = 'table' and lower(s.qualified_name) in (select lower(qualified_name) from symbol where kind = 'table' and ${ignoreCase ? 'lower(name) = lower(?)' : '(qualified_name = ? or name = ?)'}) order by f.path, s.start_byte, s.id`)
    .all(...(ignoreCase ? [table] : [table, table])) as Array<Omit<Table, 'symbols'> & { key: string }>
  const tables = new Map<string, Table>()
  for (const { key, ...r } of rows) {
    const symbol = { id: r.id, qualified_name: r.qualified_name, path: r.path }
    const known = tables.get(key)
    if (known) known.symbols.push(symbol)
    else tables.set(key, { ...r, symbols: [symbol] })
  }
  return [...tables.values()].sort((a, b) => (a.qualified_name < b.qualified_name ? -1 : a.qualified_name > b.qualified_name ? 1 : 0))
}

/**
 * Static reach (A9): the endpoints and jobs from which a resolved path leads to the table, breadth first over the impact
 * relationship types, so each depth is the shortest path length. A lower bound: unresolved calls and anything past a limit are not in it.
 */
export function tableReach(db: Database.Database, snapshotId: string, table: Table, maxDepth: number, maxRows: number): TableReach {
  const { symbols, ...shown } = table
  const ids = symbols.map((s) => s.id), among = ids.map(() => '?').join(',')
  // A job's class is reached through its methods, which no edge joins to the class, so a reached method stands for the job that runs its class.
  const jobOfType = new Map<string, { id: string; qualified_name: string; name: string; path: string }>()
  for (const r of db.prepare("select j.id, j.qualified_name, j.name, f.path, t.qualified_name as type_qn from edge e join symbol j on j.id = e.src join symbol t on t.id = e.dst join file f on f.id = j.file_id where e.type = 'runs' and e.resolution = 'resolved'").all() as Array<{ id: string; qualified_name: string; name: string; path: string; type_qn: string }>) jobOfType.set(r.type_qn, r)
  const owner = (qn: string) => qn.slice(0, Math.max(0, qn.lastIndexOf('.')))
  const keep = (d: Impact['dependents'][number]) => d.kind === 'endpoint' || d.kind === 'job' || jobOfType.has(owner(d.qualified_name))
  const reach = new Map<string, Reached>()
  /** Adds what a search reached, `hops` further from the table than the search's subjects are. */
  const add = (dependents: Impact['dependents'], hops: number) => {
    for (const d of dependents) {
      const hit = d.kind === 'endpoint' || d.kind === 'job' ? { ...d, kind: d.kind as 'endpoint' | 'job' } : { ...jobOfType.get(owner(d.qualified_name))!, kind: 'job' as const, depth: d.depth + 1 }
      const depth = hit.depth + hops, known = reach.get(hit.id)
      if (!known || known.depth > depth) reach.set(hit.id, { id: hit.id, kind: hit.kind, qualified_name: hit.qualified_name, name: hit.name, path: hit.path, depth })
    }
  }
  const r = analyzeImpact(db, snapshotId, ids, [...IMPACT_TYPES], maxDepth, maxRows, keep)
  add(r.dependents, 0)
  const mapped = db.prepare(`select distinct s.id, s.qualified_name from edge e join symbol s on s.id = e.src where e.type = 'maps_to' and e.resolution = 'resolved' and e.dst in (${among}) order by s.qualified_name`).all(...ids) as Array<{ id: string; qualified_name: string }>
  // Table-per-hierarchy: a type that inherits a mapped entity, directly or through others, shares its table.
  const entities: TableReach['entities'] = mapped.map((e) => ({ ...e, via: 'maps_to' as const }))
  const subtypes = db.prepare("select s.id, s.qualified_name from edge e join symbol s on s.id = e.src where e.type = 'inherits' and e.resolution = 'resolved' and e.dst = ? order by s.qualified_name")
  const seen = new Set(mapped.map((e) => e.id))
  for (let i = 0; i < entities.length; i++) for (const sub of subtypes.all(entities[i]!.id) as Array<{ id: string; qualified_name: string }>) if (!seen.has(sub.id)) { seen.add(sub.id); entities.push({ ...sub, via: 'inherits' }) }
  // Code reading a DbSet property of a mapped entity queries the table, so its readers reach it one hop further than the property.
  const names = new Set(mapped.map((e) => e.qualified_name.slice(e.qualified_name.lastIndexOf('.') + 1)))
  const accessors = (db.prepare("select id, qualified_name, signature from symbol where kind = 'property' and signature like '%DbSet<%'").all() as Array<{ id: string; qualified_name: string; signature: string }>)
    .filter((p) => names.has(/I?DbSet<(?:[\w.]*\.)?(\w+)>/.exec(p.signature)?.[1] ?? ''))
  const readers = accessors.length ? db.prepare(`select distinct source_id as id, target_id from assertion where type = 'references' and resolution = 'resolved' and target_id in (${accessors.map(() => '?').join(',')})`).all(...accessors.map((a) => a.id)) as Array<{ id: string; target_id: string }> : []
  if (readers.length) add(analyzeImpact(db, snapshotId, [...new Set(readers.map((x) => x.id))], [...IMPACT_TYPES], Math.max(0, maxDepth - 1), maxRows, keep).dependents, 2)
  // Code that references the table itself, such as a Prisma Client model access (A36), reaches it one hop further than that code.
  const referrers = (db.prepare(`select distinct source_id as id from assertion where type = 'references' and resolution = 'resolved' and target_id in (${among})`).all(...ids) as Array<{ id: string }>).map((x) => x.id)
  const direct = referrers.length ? analyzeImpact(db, snapshotId, referrers, [...IMPACT_TYPES], Math.max(0, maxDepth - 1), maxRows, keep) : undefined
  if (direct) add(direct.dependents, 1)
  const stopped = r.stopped_by ?? direct?.stopped_by ?? null
  return {
    ...shown, ...(symbols.length > 1 ? { symbols } : {}), entities, stopped_by: stopped,
    horizon: stopped !== null || r.totals.dependents > maxRows || (direct?.totals.dependents ?? 0) > maxRows,
    accessors: accessors.map((a) => ({ id: a.id, qualified_name: a.qualified_name, readers: readers.filter((x) => x.target_id === a.id).length })),
    reach: [...reach.values()].sort((a, b) => a.depth - b.depth || (a.qualified_name < b.qualified_name ? -1 : 1)),
  }
}
