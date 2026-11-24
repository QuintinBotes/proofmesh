import type Database from 'better-sqlite3'
import { notesMatching, resolveRef } from './notes.js'
import { forwardReach, readsModel, staticPropertyReads } from './static-reads.js'
import { findTables, tableReach } from './table-reach.js'

export type ParsedSql = { tables: Array<{ name: string; schema: string | null; matched: string[] }>; columns: string[]; comments: string[] }
export type Candidate = {
  id: string; kind: 'endpoint' | 'job'; qualified_name: string; path: string; score: number; depth: number
  evidence: { tables: string[]; owner: string | null; columns: string[]; helpers: Array<{ note: string; target: string }> }
}

const IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|` + '`[^`]+`' + String.raw`|[\w$#@]+)`
const unquote = (s: string) => s.replace(/^[[\"`]|[\]\"`]$/g, '')

/** Tables (after FROM, JOIN, UPDATE, INTO), compared columns, and comments of a SQL statement, read by pattern, not by a full parser. */
export function parseSql(sql: string): Omit<ParsedSql, 'tables'> & { tables: Array<{ name: string; schema: string | null }> } {
  const comments = [...sql.matchAll(/\/\*([\s\S]*?)\*\//g), ...sql.matchAll(/--([^\n]*)/g)].map((m) => m[1]!.trim()).filter(Boolean)
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/N?'(?:[^']|'')*'/g, "''")
  const tables = new Map<string, { name: string; schema: string | null }>()
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:from|join|update|into)\s+(${IDENT}(?:\s*\.\s*${IDENT}){0,2})`, 'gi'))) {
    const parts = m[1]!.split(/\s*\.\s*/).map(unquote)
    const name = parts[parts.length - 1]!, schema = parts.length > 1 ? parts[parts.length - 2]! : null
    if (!/^(select|with)$/i.test(name)) tables.set(`${schema ?? ''}.${name}`.toLowerCase(), { name, schema })
  }
  const columns = new Set<string>()
  for (const m of code.matchAll(new RegExp(String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})\s*(?:=|<>|!=|<=|>=|<|>|\bin\b|\blike\b|\bis\b|\bbetween\b)`, 'gi'))) {
    const c = unquote(m[1]!)
    if (!/^(@|\d)/.test(c) && !/^(and|or|not|null|where|on|case|when|then)$/i.test(c)) columns.add(c)
  }
  return { tables: [...tables.values()], columns: [...columns], comments }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
/** How many of the strongest candidates have their reads and helpers weighed. */
export const WEIGHED = 30

/**
 * The endpoints and jobs that may issue a SQL statement, ranked by the evidence each has: it statically reaches the statement's tables,
 * a team named in the statement's comments owns it, code it reaches reads entity properties named like the compared columns, and it
 * reaches a helper an accepted note says writes a clause of the statement. Every candidate carries that evidence.
 */
export function findQuerySource(db: Database.Database, snapshotId: string, notes: Parameters<typeof notesMatching>[0], sql: string, o: { maxDepth: number; maxRows: number }): { parsed: ParsedSql; candidates: Candidate[]; considered: number; notes: ReturnType<typeof notesMatching> } {
  const p = parseSql(sql)
  const tables = p.tables.map((t) => {
    const exact = t.schema ? findTables(db, `${t.schema}.${t.name}`) : []
    const found = exact.length ? exact : findTables(db, t.name).length ? findTables(db, t.name) : findTables(db, t.name, true)
    return { ...t, symbols: found }
  })
  const pool = new Map<string, { kind: 'endpoint' | 'job'; qualified_name: string; path: string; depth: number; tables: Set<string> }>()
  for (const t of tables) for (const sym of t.symbols) for (const r of tableReach(db, snapshotId, sym, o.maxDepth, 5000).reach) {
    const c = pool.get(r.id) ?? { kind: r.kind, qualified_name: r.qualified_name, path: r.path, depth: r.depth, tables: new Set<string>() }
    c.tables.add(sym.qualified_name)
    c.depth = Math.min(c.depth, r.depth)
    pool.set(r.id, c)
  }
  const tokens = p.comments.flatMap((c) => [norm(c), ...c.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 3).map(norm)])
  const ownerOf = (id: string): string | null => {
    const code = (db.prepare("select dst from edge where src = ? and type in ('exposes', 'runs') and resolution = 'resolved'").all(id) as Array<{ dst: string }>).map((r) => r.dst)
    const holders = [id, ...code, ...code.flatMap((c) => { const s = db.prepare('select qualified_name, file_id from symbol where id = ?').get(c) as { qualified_name: string; file_id: string } | undefined; return s ? (db.prepare("select s.id from symbol s join file f on f.id = s.file_id where (s.qualified_name = ? and s.kind in ('class', 'struct') and (s.file_id = ? or f.language not in ('java', 'kotlin', 'scala', 'php'))) or (s.file_id = ? and s.kind = 'module')").all(s.qualified_name.slice(0, s.qualified_name.lastIndexOf('.')), s.file_id, s.file_id) as Array<{ id: string }>).map((x) => x.id) : [] })]
    const teams = holders.flatMap((h) => (db.prepare("select t.name, t.qualified_name from edge e join symbol t on t.id = e.dst where e.src = ? and e.type = 'owned_by' and e.resolution = 'resolved'").all(h) as Array<{ name: string; qualified_name: string }>))
    const team = teams.find((t) => [t.name, t.qualified_name].some((n) => norm(n).length >= 3 && tokens.some((tok) => tok === norm(n) || tok.includes(norm(n)))))
    return team ? team.qualified_name : null
  }
  const matchedNotes = notesMatching(notes, sql)
  const helpers = matchedNotes.flatMap((n) => { const id = n.target ? resolveRef(db, n.target) : null; return id ? [{ note: n.id, target: n.target!, id }] : [] })
  const columns = new Set(p.columns.map((c) => c.toLowerCase()))
  // Owner and table evidence are cheap; reach and reads are computed for the strongest candidates only, sharing one entity model.
  const coarse = [...pool].map(([id, c]) => ({ id, c, owner: tokens.length ? ownerOf(id) : null }))
    .sort((a, b) => b.c.tables.size + (b.owner ? 1 : 0) - (a.c.tables.size + (a.owner ? 1 : 0)) || a.c.depth - b.c.depth || (a.c.qualified_name < b.c.qualified_name ? -1 : 1))
    .slice(0, WEIGHED)
  const model = columns.size ? readsModel(db) : null
  const candidates = coarse.map(({ id, c, owner }) => {
    const reached = helpers.length ? forwardReach(db, [id], o.maxDepth, 5000).depthOf : new Map<string, number>()
    const reads = model ? staticPropertyReads(db, [id], o.maxDepth, 5000, model).reads : []
    const matchedColumns = [...new Set(reads.filter((r) => columns.has(r.property.toLowerCase())).map((r) => `${r.entity}.${r.property}`))].sort()
    const usedHelpers = helpers.filter((h) => reached.has(h.id)).map(({ note, target }) => ({ note, target }))
    const score = 4 * c.tables.size + (owner ? 3 : 0) + 3 * usedHelpers.length + 2 * matchedColumns.length
    return { id, kind: c.kind, qualified_name: c.qualified_name, path: c.path, score, depth: c.depth, evidence: { tables: [...c.tables].sort(), owner, columns: matchedColumns, helpers: usedHelpers } }
  }).sort((a, b) => b.score - a.score || a.depth - b.depth || (a.qualified_name < b.qualified_name ? -1 : 1))
  return {
    parsed: { tables: tables.map((t) => ({ name: t.name, schema: t.schema, matched: t.symbols.map((s) => s.qualified_name) })), columns: p.columns, comments: p.comments },
    candidates: candidates.slice(0, o.maxRows), considered: pool.size, notes: matchedNotes,
  }
}
