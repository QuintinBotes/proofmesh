// Imported coverage on the snapshot being asked (#241, FR2061 to FR2063): each executable line on the innermost symbol holding it, as
// get_symbols_at picks it, and stale for a file whose content in the snapshot is not what it was at import.
import type Database from 'better-sqlite3'
import type { CoverageImportRecord } from '../meshstore/catalog.js'
import { innermost, type Span } from './symbol-at.js'

export type Coverage = {
  executed: boolean | null; lines_covered: number; lines_total: number; source: string; format: string; window: { from: string; to: string }
  stale: boolean; at: { path: string; line: number } | null
}

/**
 * What the newest import that covers a subject's file and is not stale says of the subjects' own lines, or the newest stale one, with executed
 * null, when every import covering them is stale; null when no import covers their files. `tests` are the report's test names that hit them.
 */
export function coverageOf(db: Database.Database, imports: CoverageImportRecord[], ids: string[]): (Coverage & { tests: string[] }) | null {
  if (!imports.length || !ids.length) return null
  const subjects = new Set(ids), files = new Map<string, { hash: string; syms: Span[] }>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    for (const f of db.prepare(`select distinct f.id, f.path, f.content_hash from symbol s join file f on f.id = s.file_id where s.id in (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ id: string; path: string; content_hash: string | null }>) {
      if (!files.has(f.path)) files.set(f.path, { hash: f.content_hash ?? '', syms: db.prepare('select id, kind, start_line, end_line from symbol where file_id = ?').all(f.id) as Span[] })
    }
  }
  const covering = imports.filter((c) => [...files.keys()].some((p) => c.files[p])).sort((a, b) => (a.imported_at < b.imported_at ? 1 : a.imported_at > b.imported_at ? -1 : 0))
  const stale = (c: CoverageImportRecord) => [...files].some(([p, f]) => c.files[p] && c.files[p]!.hash !== f.hash)
  const c = covering.find((x) => !stale(x)) ?? covering[0]
  if (!c) return null
  let total = 0, covered = 0, first: Coverage['at'] = null
  const tests = new Set<string>()
  for (const [p, f] of files) {
    const cov = c.files[p]
    if (!cov) continue
    const inner = f.syms.filter((s) => s.kind !== 'module'), module = f.syms.find((s) => s.kind === 'module')
    // A file asked for as its module holds every line of the file.
    const whole = !!module && subjects.has(module.id)
    const hits = Object.entries(cov.tests).map(([t, lines]) => [t, new Set(lines)] as const)
    for (const line of cov.lines) {
      if (!whole && !subjects.has((innermost(inner, line) ?? module)?.id ?? '')) continue
      total++
      const by = hits.filter(([, h]) => h.has(line))
      if (!by.length) continue
      covered++
      first ??= { path: p, line }
      for (const [t] of by) if (t) tests.add(t)
    }
  }
  const isStale = stale(c)
  return { executed: isStale ? null : covered > 0, lines_covered: covered, lines_total: total, source: c.source, format: c.format, window: c.window, stale: isStale, at: isStale ? null : first, tests: isStale ? [] : [...tests].sort() }
}
