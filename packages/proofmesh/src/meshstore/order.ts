import type Database from 'better-sqlite3'

// Ids are built from where a repository is checked out, so a tie broken on an id lists rows differently in two checkouts (issue 70).
// These keys use only what the repository holds: its relative path, then position, then name, then kind.
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const pad = (n: number | null): string => String(n ?? 0).padStart(10, '0')
const SEP = '\u0000'

type Memo = { node: Map<string, string>; assertion: Map<string, string>; evidence: Map<string, string> }
const memo = new WeakMap<Database.Database, Memo>()
const of = (db: Database.Database): Memo => {
  let m = memo.get(db)
  if (!m) memo.set(db, (m = { node: new Map(), assertion: new Map(), evidence: new Map() }))
  return m
}
/** A bare edge table, as the traversal tests build, holds no locations; its keys are the ids. */
const located = new WeakMap<Database.Database, boolean>()
const hasLocations = (db: Database.Database): boolean => {
  let v = located.get(db)
  if (v === undefined) located.set(db, (v = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'symbol'").get() !== undefined))
  return v
}
const cached = (db: Database.Database, map: Map<string, string>, id: string, make: () => string): string => {
  if (!hasLocations(db)) return id
  let k = map.get(id)
  if (k === undefined) map.set(id, (k = make()))
  return k
}

/** Where a symbol, file or external symbol sits, as a string that sorts by path, position, name, kind. */
export const nodeKey = (db: Database.Database, id: string): string => cached(db, of(db).node, id, () => {
  const s = db.prepare('select f.path, s.start_byte, s.qualified_name, s.kind from symbol s join file f on f.id = s.file_id where s.id = ?').get(id) as { path: string; start_byte: number; qualified_name: string; kind: string } | undefined
  if (s) return [s.path, pad(s.start_byte), s.qualified_name, s.kind].join(SEP)
  const f = db.prepare('select path from file where id = ?').get(id) as { path: string } | undefined
  if (f) return [f.path, pad(0), '', 'file'].join(SEP)
  const x = db.prepare('select module, name from external_symbol where id = ?').get(id) as { module: string; name: string } | undefined
  return x ? ['￿', x.module, x.name].join(SEP) : `￿${SEP}${id}`
})

/** The site of an evidence row, as a string that sorts by path then position. */
export const evidenceKey = (db: Database.Database, id: string): string => cached(db, of(db).evidence, id, () => {
  const e = db.prepare('select f.path, e.start_byte, e.end_byte from evidence e join file f on f.id = e.file_id where e.id = ?').get(id) as { path: string; start_byte: number; end_byte: number } | undefined
  return e ? [e.path, pad(e.start_byte), pad(e.end_byte)].join(SEP) : `￿${SEP}${id}`
})

/** Where an assertion is made (its first evidence), then its type, then the node on its far side. */
export const assertionKey = (db: Database.Database, id: string): string => cached(db, of(db).assertion, id, () => {
  if (hasSites(db)) {
    const r = db.prepare('select site_path, site_byte, type from assertion where id = ?').get(id) as { site_path: string; site_byte: number; type: string } | undefined
    return r ? [r.site_path, pad(r.site_byte), r.type].join(SEP) : ''
  }
  const e = db.prepare('select f.path, e.start_byte, a.type from assertion a left join assertion_evidence ae on ae.assertion_id = a.id left join evidence e on e.id = ae.evidence_id left join file f on f.id = e.file_id where a.id = ? order by f.path, e.start_byte limit 1').get(id) as { path: string | null; start_byte: number | null; type: string } | undefined
  return e ? [e.path ?? '', pad(e.start_byte), e.type].join(SEP) : ''
})

/** Order ids by key, an id deciding only between two keys that are equal. */
export const byKey = (key: (id: string) => string) => (a: string, b: string): number => cmp(key(a), key(b)) || cmp(a, b)

/** Whether the snapshot holds the site of each assertion (format 0.10); an older one works it out per row. */
const sited = new WeakMap<Database.Database, boolean>()
export const hasSites = (db: Database.Database): boolean => {
  let v = sited.get(db)
  if (v === undefined) sited.set(db, (v = db.prepare("select 1 from pragma_table_info('assertion') where name = 'site_path'").get() !== undefined))
  return v
}
const FIRST = (a: string, col: string) => `(select ${col} from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ${a}.id order by f.path, e.start_byte limit 1)`
/** Select columns giving an assertion row its site; `by` is the alias whose columns hold it (an assertion, or its candidate row). */
export const siteCols = (db: Database.Database, a = 'a', by = a): string => hasSites(db) ? `${by}.site_path as _path, ${by}.site_byte as _byte` : `${FIRST(a, 'f.path')} as _path, ${FIRST(a, 'e.start_byte')} as _byte`
/** The order of rows by site, then type, then id, written so an index leading with the filtered column serves it. */
export const siteOrder = (db: Database.Database, a = 'a', by = a, id = `${by}.id`): string => hasSites(db) ? `${by}.site_path, ${by}.site_byte, ${by}.type, ${id}` : '_path, _byte, type, id'
export type Sited = { id: string; type: string; _path: string | null; _byte: number | null }
export const bySite = (x: Sited, y: Sited): number => cmp(x._path ?? '', y._path ?? '') || (x._byte ?? 0) - (y._byte ?? 0) || cmp(x.type, y.type) || cmp(x.id, y.id)
