// search_structure (#37, FR1060 to FR1066): code found by its shape, with ast-grep's pattern syntax, in the captured content of a
// snapshot (never the working tree), optionally only inside the symbols or files a graph scope names. The match runs in the syntax
// adapter's own process, given a deadline it keeps and killed if it does not: a pattern is only parsed, never run.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import { ProofmeshError } from '../core/errors.js'
import type { EvidenceStore } from '../evidence/store.js'
import { DISPATCH_TYPES, SqliteEdges, trace, type EdgeSource } from '../meshstore/traversal.js'

/** ast-grep's languages over the grammars the syntax tier ships, with the file extensions ast-grep gives each (JavaScript is read with the TSX grammar). */
export const PATTERN_LANGUAGES: Record<string, string[]> = {
  typescript: ['ts', 'cts', 'mts'], tsx: ['tsx'], javascript: ['cjs', 'js', 'mjs', 'jsx'], python: ['py', 'py3', 'pyi', 'bzl', 'bazel'], go: ['go'],
  rust: ['rs'], java: ['java'], c: ['c', 'h'], cpp: ['cc', 'hpp', 'cpp', 'c++', 'hh', 'cxx', 'cu', 'ino'], csharp: ['cs'], ruby: ['rb', 'rbw', 'gemspec'],
  kotlin: ['kt', 'ktm', 'kts'], scala: ['scala', 'sc', 'sbt'], swift: ['swift'], bash: ['bash', 'bats', 'cgi', 'command', 'env', 'fcgi', 'ksh', 'sh', 'tmux', 'tool', 'zsh'],
  hcl: ['hcl', 'nomad', 'tf', 'tfvars', 'workflow'],
}
const BY_EXTENSION = new Map(Object.entries(PATTERN_LANGUAGES).flatMap(([l, exts]) => exts.map((e) => [e, l] as const)))
/** A file larger than this is not parsed, and the answer counts it. */
export const MAX_FILE_BYTES = 1024 * 1024
/** The most source one search sends to the matcher; files past it are not searched, and the answer says how many. */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024

const extension = (p: string) => { const name = p.slice(p.lastIndexOf('/') + 1), dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : '' }

// ---------- graph scope ----------
/** The relationship types and resolutions trace_paths follows by default. */
const WALK_TYPES = ['calls', ...DISPATCH_TYPES]
/** Edges read backwards, so the walk trace_paths makes from a symbol finds what reaches it; dispatch runs both ways in either walk. */
class InEdges implements EdgeSource {
  constructor(private readonly db: Database.Database) {}
  outEdges(nodes: string[], types: string[], resolutions: string[]) {
    const out: Array<{ src: string; dst: string; assertion_id: string }> = []
    const marks = (n: number) => Array(n).fill('?').join(',')
    const dispatch = types.filter((t) => (DISPATCH_TYPES as readonly string[]).includes(t))
    for (let i = 0; i < nodes.length; i += 500) {
      const chunk = nodes.slice(i, i + 500)
      out.push(...(this.db.prepare(`select dst as src, src as dst, assertion_id from edge where dst in (${marks(chunk.length)}) and type in (${marks(types.length)}) and resolution in (${marks(resolutions.length)})`).all(...chunk, ...types, ...resolutions) as typeof out))
      if (dispatch.length) out.push(...(this.db.prepare(`select src, dst, assertion_id from edge where src in (${marks(chunk.length)}) and type in (${marks(dispatch.length)}) and resolution in (${marks(resolutions.length)})`).all(...chunk, ...dispatch, ...resolutions) as typeof out))
    }
    return out
  }
}

/** The symbols trace_paths reaches from (`out`) or that reach (`in`) each start, the starts included, within max_depth. */
export function reachSet(db: Database.Database, starts: string[], direction: 'out' | 'in', maxDepth: number, deadline: number): { ids: Set<string>; stopped: 'max_depth' | 'timeout' | null } {
  const edges = direction === 'out' ? new SqliteEdges(db) : new InEdges(db)
  const ids = new Set<string>()
  let stopped: 'max_depth' | 'timeout' | null = null
  for (const source of starts) {
    // No target is ever found, so the walk runs until nothing is left, the depth or the deadline; what it saw is the set.
    const t = trace(edges, { source, target: '', types: WALK_TYPES, resolutions: ['resolved'], maxDepth, maxRows: 1, deadline })
    for (const id of [source, ...t.expanded, ...t.horizon.map((h) => h.id)]) ids.add(id)
    if (t.stopped_by === 'max_depth' || t.stopped_by === 'timeout') stopped ??= t.stopped_by
  }
  return { ids, stopped }
}

/** The files that import any of these files, as resolved imports run between files (or from a file's module symbol). */
export function importersOf(db: Database.Database, fileIds: string[]): Set<string> {
  const marks = fileIds.map(() => '?').join(',')
  const modules = (db.prepare(`select id from symbol where kind = 'module' and file_id in (${marks})`).all(...fileIds) as Array<{ id: string }>).map((m) => m.id)
  const targets = [...fileIds, ...modules]
  const rows = db.prepare(`select distinct coalesce(s.file_id, e.src) as file from edge e left join symbol s on s.id = e.src where e.type = 'imports' and e.resolution = 'resolved' and e.dst in (${targets.map(() => '?').join(',')})`).all(...targets) as Array<{ file: string }>
  return new Set(rows.map((r) => r.file))
}

// ---------- the search ----------
export type StructureMatch = { path: string; line: number; end_line: number; text: string; symbol: { id: string; key: string; kind: string; name: string; qualified_name: string } | null }
export type StructureResult = {
  matches: StructureMatch[]; total: number; stopped: 'timeout' | null; files_searched: number
  skipped: { no_grammar: Record<string, number>; too_large: number; over_budget: number }; failed_languages: Record<string, string>
}
type Sym = { id: string; key: string; kind: string; name: string; qualified_name: string; start_byte: number; end_byte: number }
type Reply = { error: string; tree: string; language: string } | { matches: Array<{ file: number; start_byte: number; end_byte: number; start_line: number; end_line: number; text: string; symbol: number | null }>; total: number; files_searched: number; stopped: 'timeout' | null; failed_languages: Record<string, string> }

/**
 * A match's symbol is the innermost that holds it whole (its module when nothing smaller does). With a symbol scope, a match counts
 * only when that symbol is in the scope: reaching a class does not put every method of it in scope (FR1062).
 */
export function searchStructure(db: Database.Database, store: EvidenceStore, o: { pattern: string; language?: string; pathPrefix?: string; symbols: Set<string> | null; files: Set<string> | null; offset: number; maxRows: number; deadline: number }): StructureResult {
  const result: StructureResult = { matches: [], total: 0, stopped: null, files_searched: 0, skipped: { no_grammar: {}, too_large: 0, over_budget: 0 }, failed_languages: {} }
  const all = db.prepare("select id, path, content_hash from file where disposition = 'indexed' and content_hash is not null and (? is null or instr(path, ?) = 1) order by path")
    .all(o.pathPrefix ?? null, o.pathPrefix ?? null) as Array<{ id: string; path: string; content_hash: string }>
  const symbolsOf = db.prepare('select id, stable_key as key, kind, name, qualified_name, start_byte, end_byte from symbol where file_id = ? order by end_byte - start_byte, id')
  const sent: Array<{ path: string; text: string; language: string; symbols: Sym[] }> = []
  let bytes = 0
  for (const f of all) {
    const ext = extension(f.path)
    const lang = o.language ? (PATTERN_LANGUAGES[o.language]!.includes(ext) ? o.language : null) : BY_EXTENSION.get(ext)
    if (!lang) { if (!o.language) { const k = ext ? `.${ext}` : '(none)'; result.skipped.no_grammar[k] = (result.skipped.no_grammar[k] ?? 0) + 1 } continue }
    if (o.files && !o.files.has(f.id)) continue
    const symbols = symbolsOf.all(f.id) as Sym[]
    if (o.symbols && !symbols.some((s) => o.symbols!.has(s.id))) continue
    const content = store.read(f.content_hash)
    if (!content) continue
    if (content.length > MAX_FILE_BYTES) { result.skipped.too_large++; continue }
    if (bytes + content.length > MAX_SOURCE_BYTES) { result.skipped.over_budget++; continue }
    bytes += content.length
    sent.push({ path: f.path, text: content.toString('utf8'), language: lang, symbols })
  }
  if (!sent.length) {
    // Nothing to search still checks the pattern, so a pattern that does not parse is refused whatever the scope.
    if (o.language) answer({ pattern: o.pattern, files: [{ text: '', language: o.language, symbols: [], scoped: false }], skip: 0, take: 0, deadline: o.deadline, strict: true }, o.deadline)
    return result
  }
  const files = sent.map((f) => ({ text: f.text, language: f.language, scoped: !!o.symbols, symbols: f.symbols.map((s) => [s.start_byte, s.end_byte, o.symbols?.has(s.id) ? 1 : 0]) }))
  const reply = answer({ pattern: o.pattern, files, skip: o.offset, take: o.maxRows, deadline: o.deadline, strict: !!o.language }, o.deadline)
  if (!reply) { result.stopped = 'timeout'; return result }
  result.total = reply.total
  result.stopped = reply.stopped
  result.files_searched = reply.files_searched
  result.failed_languages = reply.failed_languages
  result.matches = reply.matches.map((m) => {
    const f = sent[m.file]!
    const s = m.symbol === null ? null : f.symbols[m.symbol]!
    return { path: f.path, line: m.start_line, end_line: m.end_line, text: m.text, symbol: s && { id: s.id, key: s.key, kind: s.kind, name: s.name, qualified_name: s.qualified_name } }
  })
  return result
}

/** The matcher's answer; null when it was killed at the deadline. A pattern that does not parse is refused here. */
function answer(req: unknown, deadline: number): Exclude<Reply, { error: string }> | null {
  let entry: string
  try { entry = createRequire(import.meta.url).resolve('@proofmesh/adapter-syntax/pattern') } catch { throw new ProofmeshError('DEPENDENCY_UNAVAILABLE', 'the syntax adapter is not installed, so search_structure cannot run') }
  // Its own deadline stops the scan and returns what it found; the kill a second later bounds a process that does not.
  const r = spawnSync(process.execPath, ['--max-old-space-size=1024', entry], { input: JSON.stringify(req), timeout: Math.max(1, deadline - Date.now()) + 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } })
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || r.signal) return null
  if (r.status !== 0) throw new ProofmeshError('DEPENDENCY_UNAVAILABLE', `the structural matcher failed: ${(r.stderr?.toString() ?? '').split('\n').find((l) => l.trim()) ?? `exit ${r.status}`}`)
  const reply = JSON.parse(r.stdout.toString('utf8')) as Reply
  if ('error' in reply) throw new ProofmeshError('INVALID_ARGUMENT', `${reply.error}\nThe pattern as parsed (ast-grep's dump_syntax_tree, pattern format):\n${reply.tree}`, { detail: 'pattern_parse_error', language: reply.language, syntax_tree: reply.tree })
  return reply
}
