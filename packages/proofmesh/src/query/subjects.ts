// The subjects of one MCP query (#50): what it searched for, opened, compared or claimed, as symbol ids and repository-relative
// paths that exist in the snapshot, never source text or the query's own words, so a session's trail can be drawn and compared.
import type Database from 'better-sqlite3'
import { resolveRef } from './notes.js'

export type StepKind = 'searched' | 'opened' | 'changed' | 'claimed'
const SEARCHES = new Set(['find_symbols', 'search_concepts', 'search_structure', 'search_sources'])
/** Tools that tell a caller about the code rather than about the catalog; only their queries have subjects. */
const NONE = new Set(['workspace_status', 'list_queries', 'get_claims', 'get_job', 'request_index', 'get_session_trail', 'prepare_verification', 'get_verification', 'get_overview'])

export const stepKind = (tool: string): StepKind => tool === 'compare_snapshots' ? 'changed' : tool === 'verify_claim' ? 'claimed' : SEARCHES.has(tool) ? 'searched' : 'opened'

const SYMBOL = /^sym_[0-9a-f]{24}$/
const isId = (v: unknown): v is string => typeof v === 'string' && SYMBOL.test(v)

/**
 * A search's subjects are the symbols (and the files, for a text hit outside any symbol) on the page it returned; a diff's are the
 * base side of each removed and changed symbol; a claim's are its source and target; any other query's are the symbols its input
 * names, and what get_symbols_at found at the location. Null when the query has none.
 */
export function subjectsOf(db: Database.Database, tool: string, input: Record<string, unknown>, data: Record<string, unknown>): { symbols: string[]; paths: string[]; base?: string } | null {
  if (NONE.has(tool)) return null
  const symbols: unknown[] = [], paths: unknown[] = []
  let base: string | undefined
  if (tool === 'compare_snapshots') {
    // A module's text change is its file's (FR132), not a change to a symbol with dependents of its own.
    const s = data.symbols as { removed: Array<{ id: string; kind: string }>; changed: Array<{ base_id?: string; kind: string }> }
    symbols.push(...s.removed.filter((r) => r.kind !== 'module').map((r) => r.id), ...s.changed.filter((c) => c.kind !== 'module').map((c) => c.base_id))
    base = (data.base as { snapshot_id: string }).snapshot_id
  } else if (tool === 'verify_claim') {
    const p = data.proposition as { source?: unknown; target?: unknown }
    for (const ref of [p.source, p.target]) if (typeof ref === 'string') symbols.push(isId(ref) ? ref : resolveRef(db, ref))
  } else {
    for (const k of ['subject_id', 'source_id', 'target_id', 'symbol_id']) symbols.push(input[k])
    if (Array.isArray(input.subject_ids)) symbols.push(...input.subject_ids)
    if (SEARCHES.has(tool) || tool === 'get_symbols_at') {
      for (const list of Object.values(data)) {
        if (!Array.isArray(list)) continue
        for (const item of list as Array<Record<string, unknown>>) {
          const sym = item?.symbol as { id?: unknown } | string | undefined
          const id = isId(item?.id) ? item.id : typeof sym === 'object' && sym ? sym.id : sym
          if (isId(id)) symbols.push(id)
          else if (SEARCHES.has(tool) && typeof item?.path === 'string') paths.push(item.path)
        }
      }
    }
  }
  // Only ids and paths this snapshot holds are kept (a diff's base ids are its own answer's), so nothing else can be stored.
  const known = db.prepare('select 1 from symbol where id = ?'), file = db.prepare('select 1 from file where path = ?')
  const ids = [...new Set(symbols.filter(isId))].filter((id) => base !== undefined || known.get(id))
  const files = [...new Set(paths.filter((p): p is string => typeof p === 'string'))].filter((p) => file.get(p))
  return ids.length || files.length ? { symbols: ids, paths: files, ...(base ? { base } : {}) } : null
}
