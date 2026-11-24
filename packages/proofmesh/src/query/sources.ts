import type Database from 'better-sqlite3'
import type { EvidenceStore } from '../evidence/store.js'

export type SourceHit = { path: string; line: number; text: string; symbol: { id: string; kind: string; qualified_name: string } | null }

/**
 * Lexical search over the captured text of indexed files, line by line, in path order, from the file at `fileOffset`. No
 * index is kept: the scan reads the content-addressed copies and stops at the row limit, the byte budget or the deadline.
 * A page holds whole files: a file whose hits do not fit is left for the next page, unless it alone overflows the page,
 * in which case its first hits are returned and `overflow` names it. `next_offset` is the file the next page starts at.
 */
export function searchSources(db: Database.Database, store: EvidenceStore, input: { text: string; caseSensitive: boolean; pathPrefix?: string; maxRows: number; maxBytes: number; deadline: number; fileOffset: number }): { hits: SourceHit[]; files_scanned: number; files_total: number; stopped: 'max_rows' | 'max_bytes' | 'timeout' | null; next_offset: number | null; overflow: string | null } {
  const files = db.prepare("select id, path, content_hash from file where disposition = 'indexed' and content_hash is not null and (? is null or path like ? escape '\\') order by path")
    .all(input.pathPrefix ?? null, input.pathPrefix ? `${input.pathPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null) as Array<{ id: string; path: string; content_hash: string }>
  const needle = input.caseSensitive ? input.text : input.text.toLowerCase()
  const symbolsIn = db.prepare("select id, kind, qualified_name, start_line, end_line from symbol where file_id = ? and kind <> 'module' order by (end_line - start_line), start_line")
  const hits: SourceHit[] = []
  const budget = input.maxBytes - 128
  let scanned = 0, bytes = 0
  const done = (stopped: 'max_rows' | 'max_bytes' | 'timeout' | null, next: number, overflow: string | null = null) => ({ hits, files_scanned: scanned, files_total: files.length, stopped, next_offset: next < files.length ? next : null, overflow })
  for (let i = input.fileOffset; i < files.length; i++) {
    const f = files[i]!
    if (Date.now() > input.deadline) return done('timeout', i)
    const content = store.read(f.content_hash)
    if (!content) { scanned++; continue }
    const text = content.toString('utf8')
    if (!(input.caseSensitive ? text : text.toLowerCase()).includes(needle)) { scanned++; continue }
    const symbols = symbolsIn.all(f.id) as Array<{ id: string; kind: string; qualified_name: string; start_line: number; end_line: number }>
    const lines = text.split('\n')
    const fileHits: SourceHit[] = []
    let fileBytes = 0
    for (let ln = 0; ln < lines.length; ln++) {
      const line = lines[ln]!
      if (!(input.caseSensitive ? line : line.toLowerCase()).includes(needle)) continue
      const n = ln + 1
      const owner = symbols.find((s) => s.start_line <= n && n <= s.end_line)
      const hit: SourceHit = { path: f.path, line: n, text: line.trim().slice(0, 240), symbol: owner ? { id: owner.id, kind: owner.kind, qualified_name: owner.qualified_name } : null }
      const size = Buffer.byteLength(JSON.stringify(hit)) + 1
      const stopped = hits.length + fileHits.length >= input.maxRows ? 'max_rows' : bytes + fileBytes + size > budget ? 'max_bytes' : null
      if (stopped) {
        if (hits.length) return done(stopped, i)
        hits.push(...fileHits)
        scanned++
        return done(stopped, i + 1, f.path)
      }
      fileHits.push(hit)
      fileBytes += size
    }
    hits.push(...fileHits)
    bytes += fileBytes
    scanned++
  }
  return done(null, files.length)
}
