// The content hash of a symbol's declaration (FR130): the span as the snapshot records it, normalised so a move or a rename keeps it.
import type Database from 'better-sqlite3'
import { sha256 } from '../core/hash.js'
import type { EvidenceStore } from '../evidence/store.js'

/** Stands where the symbol's own simple name was; no source text holds it. */
const PLACEHOLDER = '\u0001'
const WORD = '[\\p{L}\\p{N}_$]'

/**
 * Line endings as LF, the lines' common leading indentation and every line's trailing whitespace removed, and each whole-identifier
 * occurrence of `name` replaced by one placeholder. A module is its file's text, whatever the file is called. A span that is
 * no more than the name, as a SCIP definition without an enclosing range gives, has no hash.
 */
export function hashDeclaration(text: string, name: string, kind: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  const indent = Math.min(...lines.filter((l) => l !== '').map((l) => /^[ \t]*/.exec(l)![0].length))
  let out = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n')
  if (kind !== 'module') {
    if (out.trim() === name) return null
    if (name) out = out.replace(new RegExp(`(?<!${WORD})${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!${WORD})`, 'gu'), PLACEHOLDER)
  }
  return out === '' ? null : sha256(out)
}

/** The declaration's text, led by the whitespace before it when that is all that precedes it on its line, so its indentation counts. */
function declarationText(content: Buffer, start: number, end: number): string {
  let from = start
  while (from > 0 && (content[from - 1] === 0x20 || content[from - 1] === 0x09)) from--
  if (from > 0 && content[from - 1] !== 0x0a) from = start
  return content.subarray(from, end).toString('utf8')
}

/** Fills `symbol.body_hash` from the captured content of each indexed file, at seal time, whatever adapter declared the symbol. */
export function fillBodyHashes(db: Database.Database, store: EvidenceStore): void {
  const files = db.prepare('select id, content_hash from file where content_hash is not null order by id').all() as Array<{ id: string; content_hash: string }>
  const symbols = db.prepare('select id, kind, name, start_byte, end_byte from symbol where file_id = ?')
  const set = db.prepare('update symbol set body_hash = ? where id = ?')
  db.transaction(() => {
    for (const f of files) {
      const rows = symbols.all(f.id) as Array<{ id: string; kind: string; name: string; start_byte: number; end_byte: number }>
      if (!rows.length) continue
      const content = store.read(f.content_hash)
      if (!content) continue
      for (const s of rows) {
        const text = s.kind === 'module' ? content.toString('utf8') : declarationText(content, s.start_byte, s.end_byte)
        const hash = hashDeclaration(text, s.name, s.kind)
        if (hash) set.run(hash, s.id)
      }
    }
  })()
}
