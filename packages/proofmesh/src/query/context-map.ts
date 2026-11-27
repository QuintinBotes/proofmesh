// get_context_map (FR920 to FR924): the declarations around a focus, both directions, ranked, for one budgeted answer.
import type Database from 'better-sqlite3'
import { inferredSql } from './basis.js'
import { candidatesFrom, candidatesTo } from './inferred.js'
import { leanName } from './lean.js'
import { isTestCode, parseRoles, rolesSql } from './tests.js'
import { dispatchedFrom } from './tools.js'

/** Relations in rank order: a stronger relation comes first at the same depth (FR921). */
const RELATIONS = ['changed', 'implements', 'implemented_by', 'calls', 'called_by', 'tests', 'references', 'referenced_by', 'imports', 'imported_by'] as const
type Relation = (typeof RELATIONS)[number]
type MapRow = { id: string; name: string; path: string; line: number; relation: Relation; depth: number; inferred: boolean; direction: 'in' | 'out' | 'focus'; weight: number }

const TYPES = ['calls', 'references', 'imports', 'implements', 'overrides', 'inherits']
const OUT: Record<string, Relation> = { calls: 'calls', references: 'references', imports: 'imports', implements: 'implements', overrides: 'implements', inherits: 'implements' }
const IN: Record<string, Relation> = { calls: 'called_by', references: 'referenced_by', imports: 'imported_by', implements: 'implemented_by', overrides: 'implemented_by', inherits: 'implemented_by' }
const marks = (n: number) => Array.from({ length: n }, () => '?').join(',')

type Node = { key: string; ids: string[]; name: string; path: string; line: number; test: boolean; file: string }

/**
 * Every declaration within maxDepth of the focus along resolved relationships in both directions, calls and references to a member the
 * reached symbol implements included (dispatch), and candidate edges labelled inferred. One row per declaration, at its least depth and,
 * there, its strongest relation. A file and its module symbol are one declaration, the file. Rows in rank order (see rank).
 */
export function contextMap(db: Database.Database, focus: string[], changed: Set<string>, maxDepth: number): MapRow[] {
  const nodeOf = memoNode(db)
  const focusNodes = new Map<string, Node>()
  for (const id of focus) { const n = nodeOf(id); if (n) focusNodes.set(n.key, n) }
  // A focus file stands for every declaration in it: none of them is a row, and each is a start.
  const focusFiles = new Set([...focusNodes.values()].filter((n) => n.key === n.file).map((n) => n.file))
  const starts = new Set<string>([...focusNodes.values()].flatMap((n) => n.ids))
  for (const file of focusFiles) for (const r of db.prepare('select id from symbol where file_id = ?').all(file) as Array<{ id: string }>) starts.add(r.id)
  const inFocus = (n: Node) => focusNodes.has(n.key) || focusFiles.has(n.file)

  const best = new Map<string, MapRow>()
  const keep = (n: Node, relation: Relation, depth: number, inferred: boolean, direction: 'in' | 'out') => {
    if (inFocus(n)) return
    const had = best.get(n.key)
    // Weight: the relationships joining the declaration to the code one hop nearer the focus, every site counted.
    const row: MapRow = { id: n.key, name: n.name, path: n.path, line: n.line, relation: direction === 'in' && n.test ? 'tests' : relation, depth, inferred, direction, weight: had?.depth === depth ? had.weight + 1 : 1 }
    if (!had || had.depth > depth || (had.depth === depth && rankOf(row) < rankOf(had))) best.set(n.key, row)
    else if (had.depth === depth) had.weight++
  }
  const inbound = db.prepare(`select a.source_id as other, a.type, ${inferredSql('a')} as inferred from assertion a where a.target_id = ? and a.type in (${marks(TYPES.length)}) and a.resolution = 'resolved'`)
  const viaCalls = db.prepare(`select a.source_id as other, a.type, ${inferredSql('a')} as inferred from assertion a where a.target_id = ? and a.type in ('calls', 'references') and a.resolution = 'resolved'`)
  const outbound = db.prepare(`select a.target_id as other, a.type, ${inferredSql('a')} as inferred from assertion a where a.source_id = ? and a.type in (${marks(TYPES.length)}) and a.resolution = 'resolved' and a.target_kind <> 'external'`)
  for (const direction of ['in', 'out'] as const) {
    let frontier = [...starts]
    const seen = new Set(frontier)
    // Whether the strongest chain to each frontier id has an inferred hop: a row reached through it is inferred too (FR184).
    let chain = new Map<string, boolean>()
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const reached: Array<{ other: string; type: string; inferred: boolean }> = []
      const push = (rows: unknown[], from: string) => { for (const r of rows as Array<{ other: string; type: string; inferred: number }>) reached.push({ ...r, inferred: !!r.inferred || !!chain.get(from) }) }
      for (const id of frontier) {
        if (direction === 'in') {
          push(inbound.all(id, ...TYPES), id)
          // A call or reference to a member this one implements may run it (dispatch).
          if (!id.startsWith('file_')) for (const via of dispatchedFrom(db, id).keys()) push(viaCalls.all(via), id)
        } else push(outbound.all(id, ...TYPES), id)
      }
      for (const c of direction === 'in' ? candidatesTo(db, frontier, TYPES) : candidatesFrom(db, frontier, TYPES)) reached.push(direction === 'in' ? { other: c.src, type: c.type, inferred: true } : { other: c.dst, type: c.type, inferred: true })
      const next = new Map<string, boolean>()
      for (const r of reached) {
        const n = nodeOf(r.other)
        if (!n) continue
        keep(n, (direction === 'in' ? IN : OUT)[r.type]!, depth, r.inferred, direction)
        // An id reached both ways at one depth goes on as observed.
        for (const id of n.ids) if (!seen.has(id) || next.has(id)) { seen.add(id); next.set(id, (next.get(id) ?? true) && r.inferred) }
      }
      frontier = [...next.keys()]
      chain = next
    }
  }
  for (const n of focusNodes.values()) if (n.ids.some((id) => changed.has(id))) best.set(n.key, { id: n.key, name: n.name, path: n.path, line: n.line, relation: 'changed', depth: 0, inferred: false, direction: 'focus', weight: 0 })
  return rank([...best.values()])
}

const rankOf = (r: MapRow) => RELATIONS.indexOf(r.relation) + (r.inferred ? RELATIONS.length : 0)
const byOrder = (a: MapRow, b: MapRow) => rankOf(a) - rankOf(b) || b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/**
 * The rank (FR921): by depth, and at a depth observed rows before inferred ones; within those, a file's first row before any file's second, so
 * the map names as many places as it can; within that, the rows the focus uses and the rows that use it alternate, each side by relation
 * strength, then the file's weight, the row's weight, path, line and name.
 */
function rank(rows: MapRow[]): MapRow[] {
  const out: MapRow[] = []
  const groups = [...new Set(rows.map((r) => r.depth * 2 + (r.inferred ? 1 : 0)))].sort((a, b) => a - b)
  for (const group of groups) {
    const at = rows.filter((r) => r.depth * 2 + (r.inferred ? 1 : 0) === group)
    const fileWeight = new Map<string, number>()
    for (const r of at) fileWeight.set(r.path, (fileWeight.get(r.path) ?? 0) + r.weight)
    at.sort((a, b) => rankOf(a) - rankOf(b) || fileWeight.get(b.path)! - fileWeight.get(a.path)! || byOrder(a, b))
    // Round n holds each file's (n+1)th row, split into what the focus uses (out) and what uses it (in).
    const rounds: Array<{ out: MapRow[]; in: MapRow[] }> = [], count = new Map<string, number>()
    for (const r of at) {
      const n = count.get(r.path) ?? 0
      count.set(r.path, n + 1)
      ;(rounds[n] ??= { out: [], in: [] })[r.direction === 'in' ? 'in' : 'out'].push(r)
    }
    for (const { out: a, in: b } of rounds) for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) out.push(a[i]!); if (b[i]) out.push(b[i]!) }
  }
  return out
}

/** A node by id: a file or a module symbol is its file, at line 1; another symbol is itself. Undefined for an external or unknown id. */
function memoNode(db: Database.Database) {
  const cache = new Map<string, Node | undefined>()
  const sym = db.prepare(`select s.id, s.kind, s.name, s.qualified_name, s.start_line, s.file_id, f.path, ${rolesSql(db)} as roles from symbol s join file f on f.id = s.file_id where s.id = ?`)
  const file = db.prepare('select id, path from file where id = ?')
  const moduleOf = db.prepare("select id from symbol where file_id = ? and kind = 'module'")
  const fileNode = (f: { id: string; path: string }): Node => ({ key: f.id, ids: [f.id, ...(moduleOf.all(f.id) as Array<{ id: string }>).map((m) => m.id)], name: f.path, path: f.path, line: 1, test: isTestCode(f.path, null), file: f.id })
  return (id: string): Node | undefined => {
    if (cache.has(id)) return cache.get(id)
    let n: Node | undefined
    if (id.startsWith('file_')) { const f = file.get(id) as { id: string; path: string } | undefined; n = f && fileNode(f) }
    else {
      const s = sym.get(id) as { id: string; kind: string; name: string; qualified_name: string; start_line: number; file_id: string; path: string; roles: string | null } | undefined
      n = !s ? undefined : s.kind === 'module' ? fileNode({ id: s.file_id, path: s.path }) : { key: s.id, ids: [s.id], name: leanName(s), path: s.path, line: s.start_line, test: isTestCode(s.path, null, parseRoles(s.roles)), file: s.file_id }
    }
    cache.set(id, n)
    return n
  }
}
