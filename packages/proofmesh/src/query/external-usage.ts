import type Database from 'better-sqlite3'

export type UsageGroup = 'module' | 'type' | 'member'
export type UsageRow = { key: string; module: string; call_sites: number; files: number; projects: number; external_ids: number; sample_sites: Array<{ path: string; line: number }> }

/** A closed generic named by its open definition: `Config<Order>.Property` and `Config<Invoice>.Property` become `Config<…>.Property`. */
export function foldGenerics(name: string): string {
  let out = '', depth = 0
  for (const c of name) {
    if (c === '<') { if (depth++ === 0) out += '<…'; continue }
    if (c === '>') { if (--depth === 0) out += '>'; continue }
    if (depth === 0) out += c
  }
  return out
}

/** The type of an external member name: `Ns.Type.Member` and the constructor `Ns.Type..ctor` are `Ns.Type`; a name with no dot stands for itself. */
function typeOf(name: string): string {
  if (name.endsWith('..ctor')) return name.slice(0, -'..ctor'.length)
  let depth = 0
  for (let i = name.length - 1; i >= 0; i--) {
    const c = name[i]
    if (c === '>') depth++
    else if (c === '<') depth--
    else if (c === '.' && depth === 0) return name.slice(0, i)
  }
  return name
}

/**
 * Call sites into code outside the repository, grouped by module, type or member: how many sites, in how many files and projects,
 * with a few sample sites. Only resolved external calls count: a call that does not bind names no external.
 */
export function externalUsage(db: Database.Database, o: { module?: string; prefix?: string; groupBy: UsageGroup; fold: boolean; includeTests: boolean; pathPrefix?: string }): { rows: UsageRow[]; totals: { call_sites: number; files: number; projects: number; groups: number } } {
  const projectOfFile = new Map<string, string>()
  for (const r of db.prepare("select m.file_id, p.qualified_name from assertion a join symbol p on p.id = a.source_id join symbol m on m.id = a.target_id where a.type = 'contains' and p.kind in ('project', 'package') and m.kind = 'module'").all() as Array<{ file_id: string; qualified_name: string }>) if (!projectOfFile.has(r.file_id)) projectOfFile.set(r.file_id, r.qualified_name)
  const sites = db.prepare(`select x.id as ext, x.module, x.name, f.id as file_id, f.path, e.start_line as line from assertion a join external_symbol x on x.id = a.target_id
      join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id
    where a.type = 'calls' and a.resolution = 'resolved_external' and (? is null or x.module = ?) and (? is null or x.name like ? escape '\\')
      and (? is null or f.path like ? escape '\\')${o.includeTests ? '' : ' and pm_is_test(f.path) = 0'}
    order by f.path, e.start_line`).all(o.module ?? null, o.module ?? null, o.prefix ?? null, o.prefix ? `${like(o.prefix)}%` : null, o.pathPrefix ?? null, o.pathPrefix ? `${like(o.pathPrefix)}%` : null) as Array<{ ext: string; module: string; name: string; file_id: string; path: string; line: number }>
  const groups = new Map<string, { module: string; sites: number; files: Set<string>; projects: Set<string>; ids: Set<string>; samples: Array<{ path: string; line: number }> }>()
  for (const s of sites) {
    const name = o.fold ? foldGenerics(s.name) : s.name
    const key = o.groupBy === 'module' ? s.module : o.groupBy === 'type' ? typeOf(name) : name
    let g = groups.get(`${s.module}\u0000${key}`)
    if (!g) groups.set(`${s.module}\u0000${key}`, (g = { module: s.module, sites: 0, files: new Set(), projects: new Set(), ids: new Set(), samples: [] }))
    g.sites++
    g.files.add(s.file_id)
    g.projects.add(projectOfFile.get(s.file_id) ?? '')
    g.ids.add(s.ext)
    if (g.samples.length < 3) g.samples.push({ path: s.path, line: s.line })
  }
  const rows = [...groups].map(([k, g]) => ({ key: k.split('\u0000')[1]!, module: g.module, call_sites: g.sites, files: g.files.size, projects: [...g.projects].filter(Boolean).length, external_ids: g.ids.size, sample_sites: g.samples }))
    .sort((a, b) => b.call_sites - a.call_sites || (a.key < b.key ? -1 : 1))
  return {
    rows,
    totals: { call_sites: sites.length, files: new Set(sites.map((s) => s.file_id)).size, projects: new Set(sites.map((s) => projectOfFile.get(s.file_id)).filter(Boolean)).size, groups: rows.length },
  }
}

const like = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
