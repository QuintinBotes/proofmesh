// Imported SARIF findings on the snapshot being asked (#30, FR1901, FR1904): each on the innermost symbol at its line, or the file's module,
// and stale when its file's content in the snapshot is not what it was when the SARIF file was imported.
import type Database from 'better-sqlite3'
import type { SarifImportRecord } from '../meshstore/catalog.js'
import type { Finding } from '../sarif/read.js'
import { innermost, type Span } from './symbol-at.js'

type At = Span & { name: string; qualified_name: string }
export type Attached = Finding & { import: string; symbol: { id: string; kind: string; name: string; qualified_name: string } | null; stale: string | null }

/** Every finding of the imports whose file is indexed in the snapshot, in import, path and line order. */
export function attachFindings(db: Database.Database, imports: SarifImportRecord[]): Attached[] {
  const files = new Map<string, { hash: string; syms: At[] } | null>(), out: Attached[] = []
  const fileOf = (p: string) => {
    if (!files.has(p)) {
      const f = db.prepare("select id, content_hash from file where path = ? and disposition = 'indexed'").get(p) as { id: string; content_hash: string } | undefined
      files.set(p, f ? { hash: f.content_hash, syms: db.prepare('select id, kind, name, qualified_name, start_line, end_line from symbol where file_id = ?').all(f.id) as At[] } : null)
    }
    return files.get(p)
  }
  for (const imp of imports) {
    for (const x of imp.findings) {
      const f = fileOf(x.path)
      // A file the snapshot no longer indexes has nowhere to show its findings.
      if (!f) continue
      const hit = (x.line === null ? undefined : innermost(f.syms.filter((s) => s.kind !== 'module'), x.line)) ?? f.syms.find((s) => s.kind === 'module')
      out.push({ ...x, import: imp.name, symbol: hit ? { id: hit.id, kind: hit.kind, name: hit.name, qualified_name: hit.qualified_name } : null, stale: imp.files[x.path] === f.hash ? null : `sarif_stale:${imp.name}` })
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.line ?? 0) - (b.line ?? 0) || (a.import < b.import ? -1 : a.import > b.import ? 1 : 0))
}

/** How many findings each symbol holds; empty, and no snapshot read, when nothing was imported. */
export function findingCounts(db: Database.Database, imports: SarifImportRecord[]): Map<string, number> {
  const counts = new Map<string, number>()
  if (imports.length) for (const f of attachFindings(db, imports)) if (f.symbol) counts.set(f.symbol.id, (counts.get(f.symbol.id) ?? 0) + 1)
  return counts
}
