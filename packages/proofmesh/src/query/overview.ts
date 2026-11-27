import type Database from 'better-sqlite3'

/** Resolved relationships between files by type, excluding a project's containment of its own files and a doc's mentions of code. */
const LINKS_SQL = `
  select ss.file_id as src, sd.file_id as dst, e.type, count(*) as n from edge e
    join symbol ss on ss.id = e.src join symbol sd on sd.id = e.dst
    where e.resolution = 'resolved' and e.type <> 'contains' and ss.file_id <> sd.file_id
    group by ss.file_id, sd.file_id, e.type
  union all
  select e.src, e.dst, e.type, count(*) from edge e
    where e.resolution = 'resolved' and e.type <> 'mentions' and e.src like 'file\\_%' escape '\\' and e.dst like 'file\\_%' escape '\\' and e.src <> e.dst
    group by e.src, e.dst, e.type`
const STATS_SQL = "select file_id, sum(kind <> 'module') as symbols, count(*) as entries from symbol group by file_id"

/** Fills the aggregate tables of a snapshot that is being written. */
export function fillAggregates(db: Database.Database): void {
  db.exec(`insert into file_link (src_file, dst_file, type, n) select src, dst, type, sum(n) from (${LINKS_SQL}) group by src, dst, type`)
  db.exec(`insert into file_stat (file_id, symbols, entries) ${STATS_SQL}`)
}

type Aggregates = { files: Array<{ id: string; path: string; symbols: number; entries: number }>; links: Array<{ src: string; dst: string; type: string; n: number }> }
const memo = new Map<string, Aggregates>()

function aggregates(db: Database.Database, snapshotId: string): Aggregates {
  const hit = memo.get(snapshotId)
  if (hit) return hit
  // Snapshots written before the aggregate tables existed compute the same rows once per process.
  const stored = !!db.prepare("select 1 from sqlite_master where name = 'file_link'").get()
  const stats = new Map((db.prepare(stored ? 'select file_id, symbols, entries from file_stat' : STATS_SQL).all() as Array<{ file_id: string; symbols: number; entries: number }>).map((r) => [r.file_id, r]))
  // A manifest holds the project it declares and no code, so it is no area of its own: a root package.json must not stop the overview stepping down into src.
  const manifestOnly = new Set((db.prepare("select file_id from symbol group by file_id having sum(kind <> 'project') = 0").all() as Array<{ file_id: string }>).map((r) => r.file_id))
  const files = (db.prepare("select id, path from file where disposition = 'indexed' order by path").all() as Array<{ id: string; path: string }>)
    .map((f) => ({ ...f, symbols: stats.get(f.id)?.symbols ?? 0, entries: stats.get(f.id)?.entries ?? 0 }))
    .filter((f) => f.entries > 0 && !manifestOnly.has(f.id))
  const links = db.prepare(stored ? 'select src_file as src, dst_file as dst, type, n from file_link' : LINKS_SQL).all() as Aggregates['links']
  const result = { files, links }
  memo.set(snapshotId, result)
  return result
}

export type OverviewChild = { key: string; name: string; kind: 'directory' | 'file' | 'symbol'; symbols: number; matches: number | null; symbol_kind: string | null }
export type OverviewLink = { from: string; to: string; count: number; by_type: Record<string, number> }
export type Overview = { path: string; scope: 'directory' | 'file'; children: OverviewChild[]; links: OverviewLink[]; omitted: number }

/**
 * The children of a directory (subdirectories and files) or of a file (its symbols), with resolved relationships between
 * them. A directory chain with a single child collapses into one step, at the scope and for each child. With `text`, only
 * children holding a matching symbol remain, sized by their matches.
 */
export function overview(db: Database.Database, snapshotId: string, input: { path?: string; text?: string; maxRows: number }): Overview {
  const { files, links } = aggregates(db, snapshotId)
  const matchesByFile = new Map<string, number>()
  const like = input.text ? `%${input.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
  if (like) {
    for (const r of db.prepare(`select file_id, count(*) as n from symbol where kind <> 'module' and id in (select symbol_id from symbol_fts where name like ? escape '\\' or qualified_name like ? escape '\\') group by file_id`).all(like, like) as Array<{ file_id: string; n: number }>) matchesByFile.set(r.file_id, r.n)
  }
  const file = files.find((f) => f.path === input.path)
  if (file) return fileOverview(db, file.id, input.path!, like, input.maxRows)

  let path = (input.path ?? '').replace(/\/+$/, '')
  const relevant = input.text ? files.filter((f) => matchesByFile.has(f.id)) : files
  const under = (p: string) => relevant.filter((f) => p === '' || f.path.startsWith(`${p}/`))
  const rest = (p: string, f: { path: string }) => (p === '' ? f.path : f.path.slice(p.length + 1))
  const childOf = (p: string, f: { path: string }) => rest(p, f).split('/')[0]!
  // Step down while the scope holds a single directory and no files of its own.
  for (;;) {
    const inside = under(path)
    const heads = new Set(inside.map((f) => childOf(path, f)))
    if (heads.size !== 1 || inside.some((f) => !rest(path, f).includes('/'))) break
    path = path === '' ? [...heads][0]! : `${path}/${[...heads][0]}`
  }
  const inside = under(path)
  const groups = new Map<string, typeof inside>()
  for (const f of inside) {
    const r = rest(path, f)
    const head = r.includes('/') ? childOf(path, f) : r
    const group = groups.get(head)
    if (group) group.push(f)
    else groups.set(head, [f])
  }
  const children: OverviewChild[] = []
  const keyOfFile = new Map<string, string>()
  for (const [head, members] of groups) {
    const isFile = members.length === 1 && rest(path, members[0]!) === head
    let key = path === '' ? head : `${path}/${head}`
    if (!isFile) {
      for (;;) {
        const heads = new Set(members.map((f) => childOf(key, f)))
        if (heads.size !== 1 || members.some((f) => !rest(key, f).includes('/'))) break
        key = `${key}/${[...heads][0]}`
      }
    }
    for (const f of members) keyOfFile.set(f.id, key)
    children.push({
      key, name: path === '' ? key : key.slice(path.length + 1), kind: isFile ? 'file' : 'directory', symbol_kind: null,
      symbols: members.reduce((n, f) => n + f.symbols, 0),
      matches: input.text ? members.reduce((n, f) => n + (matchesByFile.get(f.id) ?? 0), 0) : null,
    })
  }
  children.sort((a, b) => (b.matches ?? b.symbols) - (a.matches ?? a.symbols) || (a.key < b.key ? -1 : 1))
  const shown = children.slice(0, input.maxRows)
  const shownKeys = new Set(shown.map((c) => c.key))
  const byPair = new Map<string, OverviewLink>()
  for (const l of links) {
    const from = keyOfFile.get(l.src), to = keyOfFile.get(l.dst)
    if (!from || !to || from === to || !shownKeys.has(from) || !shownKeys.has(to)) continue
    const k = `${from}\u0000${to}`
    const link = byPair.get(k) ?? { from, to, count: 0, by_type: {} }
    link.count += l.n
    link.by_type[l.type] = (link.by_type[l.type] ?? 0) + l.n
    byPair.set(k, link)
  }
  return { path, scope: 'directory', children: shown, links: [...byPair.values()].sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1)), omitted: children.length - shown.length }
}

function fileOverview(db: Database.Database, fileId: string, path: string, like: string | null, maxRows: number): Overview {
  const symbols = db.prepare("select id, kind, name, qualified_name from symbol where file_id = ? and kind <> 'module' order by start_byte, qualified_name, kind, id").all(fileId) as Array<{ id: string; kind: string; name: string; qualified_name: string }>
  const matching = like ? new Set((db.prepare(`select id from symbol where file_id = ? and id in (select symbol_id from symbol_fts where name like ? escape '\\' or qualified_name like ? escape '\\')`).all(fileId, like, like) as Array<{ id: string }>).map((r) => r.id)) : null
  const shown = symbols.filter((s) => !matching || matching.has(s.id)).slice(0, maxRows)
  const ids = new Set(shown.map((s) => s.id))
  const byPair = new Map<string, OverviewLink>()
  for (const e of db.prepare(`select src, dst, type, count(*) as n from edge where resolution = 'resolved' and type <> 'contains' and src in (select id from symbol where file_id = ?) group by src, dst, type`).all(fileId) as Array<{ src: string; dst: string; type: string; n: number }>) {
    if (!ids.has(e.src) || !ids.has(e.dst) || e.src === e.dst) continue
    const k = `${e.src}\u0000${e.dst}`
    const link = byPair.get(k) ?? { from: e.src, to: e.dst, count: 0, by_type: {} }
    link.count += e.n
    link.by_type[e.type] = (link.by_type[e.type] ?? 0) + e.n
    byPair.set(k, link)
  }
  return {
    path, scope: 'file',
    children: shown.map((s) => ({ key: s.id, name: s.name, kind: 'symbol', symbol_kind: s.kind, symbols: 1, matches: matching ? (matching.has(s.id) ? 1 : 0) : null })),
    links: [...byPair.values()], omitted: symbols.filter((s) => !matching || matching.has(s.id)).length - shown.length,
  }
}
