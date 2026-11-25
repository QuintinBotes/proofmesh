// Cycles among build modules that syntax-tier edges form (FR178). A name match can only cross into a module the source declares a
// dependency on, so a cycle means the declared dependencies already loop, or a rule bound across modules it should not have; either
// is worth a warning where the build tool itself forbids module cycles.
import path from 'node:path'
import type Database from 'better-sqlite3'

export type ModuleCycle = { ecosystem: string; modules: string[]; edges: Array<{ from: string; to: string; type: string; sites: number; path: string; line: number; assertion_id: string }> }

const FORBIDDEN: Array<[RegExp, string]> = [[/^pom\.xml$/, 'maven'], [/^(settings|build)\.gradle(\.kts)?$/, 'gradle'], [/^go\.mod$/, 'go modules'], [/^Cargo\.toml$/, 'cargo'], [/\.(cs|fs|vb)proj$/, '.net']]

export function moduleCycles(db: Database.Database): ModuleCycle[] {
  const projects = new Map((db.prepare("select s.id, s.name, f.path from symbol s join file f on f.id = s.file_id where s.kind = 'project'").all() as Array<{ id: string; name: string; path: string }>)
    .flatMap((p) => { const eco = FORBIDDEN.find(([re]) => re.test(path.posix.basename(p.path)))?.[1]; return eco ? [[p.id, { name: p.name, eco }] as const] : [] }))
  if (projects.size < 2) return []
  // Each syntax-tier edge that binds a source to a symbol or file, as a pair of modules; the lowest assertion of a pair is its sample.
  const pairs = db.prepare(`
    with owner as (select s.file_id as file_id, e.src as project from edge e join symbol s on s.id = e.dst and s.kind = 'module' join symbol p on p.id = e.src and p.kind = 'project' where e.type = 'contains'),
    bound as (
      select a.id, a.type, case a.source_kind when 'file' then a.source_id else (select file_id from symbol where id = a.source_id) end as src_file,
        case when a.resolution = 'resolved' then case a.target_kind when 'file' then a.target_id else (select file_id from symbol where id = a.target_id) end else (select file_id from symbol where id = c.symbol_id) end as dst_file
      from assertion a left join assertion_candidate c on c.assertion_id = a.id
      where a.origin = 'syntax' and a.type in ('calls', 'imports', 'inherits', 'implements') and a.resolution in ('resolved', 'candidate', 'ambiguous') and (a.resolution <> 'resolved' or a.target_kind in ('file', 'symbol'))
    )
    select so.project as src, d.project as dst, b.type as type, count(*) as sites, min(b.id) as assertion_id
    from bound b join owner so on so.file_id = b.src_file join owner d on d.file_id = b.dst_file where so.project <> d.project
    group by so.project, d.project, b.type order by so.project, d.project, b.type`).all() as Array<{ src: string; dst: string; type: string; sites: number; assertion_id: string }>
  const edges = pairs.filter((p) => projects.has(p.src) && projects.has(p.dst) && projects.get(p.src)!.eco === projects.get(p.dst)!.eco)
  // Strongly connected components of the module graph; any of more than one module is a cycle.
  const out = new Map<string, string[]>()
  for (const e of edges) out.set(e.src, [...(out.get(e.src) ?? []), e.dst])
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), components: string[][] = []
  let counter = 0
  const visit = (v: string) => {
    index.set(v, counter); low.set(v, counter++); stack.push(v); on.add(v)
    for (const w of out.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) === index.get(v)) { const c: string[] = []; for (let w: string | undefined; w !== v;) { w = stack.pop()!; on.delete(w); c.push(w) } if (c.length > 1) components.push(c) }
  }
  for (const v of [...new Set(edges.map((e) => e.src))].sort()) if (!index.has(v)) visit(v)
  const site = db.prepare('select f.path as path, e.start_line as line from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by e.start_byte limit 1')
  return components.map((c) => {
    const inside = new Set(c)
    return {
      ecosystem: projects.get(c[0]!)!.eco,
      modules: c.map((id) => projects.get(id)!.name).sort(),
      edges: edges.filter((e) => inside.has(e.src) && inside.has(e.dst)).map((e) => { const s = site.get(e.assertion_id) as { path: string; line: number }; return { from: projects.get(e.src)!.name, to: projects.get(e.dst)!.name, type: e.type, sites: e.sites, path: s.path, line: s.line, assertion_id: e.assertion_id } })
        .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : a.type < b.type ? -1 : 1)),
    }
  }).sort((a, b) => (a.modules.join() < b.modules.join() ? -1 : 1))
}
