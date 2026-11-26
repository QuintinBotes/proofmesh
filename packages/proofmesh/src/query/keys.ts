import type Database from 'better-sqlite3'
import type { ToolName } from './tools.js'

/**
 * Rows that name a symbol by its snapshot id, per tool (FR280): [where the rows are, the field holding the id, the field to add].
 * `[]` walks an array and `{}` the values of a map keyed by id (idField `$`). An id that is no symbol of the snapshot (a file reached
 * through imports, a directory) gets no key.
 */
const KEYED: Partial<Record<ToolName, Array<[string, string, string]>>> = {
  workspace_status: [['hubs[]', 'id', 'key']],
  find_symbols: [['symbols[]', 'id', 'key']],
  get_relationships: [['relationships[].other', 'id', 'key'], ['relationships[].via', 'id', 'key'], ['boundaries[]', 'from_id', 'from_key']],
  trace_paths: [['nodes{}', '$', 'key'], ['search.horizon[]', 'id', 'key'], ['boundaries[]', 'from_id', 'from_key']],
  analyze_impact: [['dependents[]', 'id', 'key']],
  find_tests: [['tests[]', 'id', 'key']],
  find_query_source: [['candidates[]', 'id', 'key']],
  // A file child's key is its path; only a symbol child's is an id.
  get_overview: [['children[]', 'key', 'symbol_key']],
  get_property_reads: [['reads[]', 'symbol_id', 'symbol_key'], ['unread_mapped_properties[]', 'symbol_id', 'symbol_key'], ['static_reads[]', 'symbol_id', 'symbol_key']],
  get_table_reach: [['tables[]', 'id', 'key'], ['tables[].symbols[]', 'id', 'key'], ['tables[].entities[]', 'id', 'key'], ['tables[].reach[]', 'id', 'key'], ['tables[].accessors[]', 'id', 'key'], ['tables[].property_reads[]', 'symbol_id', 'symbol_key']],
}

/** The objects at a path of `data`, with the id each carries. */
function visit(node: unknown, segments: string[], idField: string, out: Array<{ row: Record<string, unknown>; id: unknown }>): void {
  if (node === null || typeof node !== 'object') return
  const [head, ...rest] = segments
  if (head === undefined) {
    out.push({ row: node as Record<string, unknown>, id: (node as Record<string, unknown>)[idField] })
    return
  }
  const name = head.replace(/\[\]$|\{\}$/, '')
  const next = name ? (node as Record<string, unknown>)[name] : node
  if (head.endsWith('[]')) for (const item of (Array.isArray(next) ? next : [])) visit(item, rest, idField, out)
  else if (head.endsWith('{}')) for (const [id, item] of Object.entries((next ?? {}) as Record<string, unknown>)) {
    if (rest.length === 0 && item !== null && typeof item === 'object') out.push({ row: item as Record<string, unknown>, id })
    else visit(item, rest, idField, out)
  }
  else visit(next, rest, idField, out)
}

/** Adds each row's stable key beside the id it names a symbol by, in the lists of `data` that the tool keys (FR280). */
export function addKeys(db: Database.Database, tool: ToolName, data: unknown): void {
  const found: Array<{ row: Record<string, unknown>; id: unknown; into: string }> = []
  for (const [path, idField, into] of KEYED[tool] ?? []) {
    const hits: Array<{ row: Record<string, unknown>; id: unknown }> = []
    visit(data, path.split('.'), idField, hits)
    for (const h of hits) found.push({ ...h, into })
  }
  const ids = [...new Set(found.flatMap((f) => (typeof f.id === 'string' ? [f.id] : [])))]
  const key = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    for (const r of db.prepare(`select id, stable_key from symbol where id in (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ id: string; stable_key: string }>) key.set(r.id, r.stable_key)
  }
  for (const f of found) if (typeof f.id === 'string' && key.has(f.id)) f.row[f.into] = key.get(f.id)
}
