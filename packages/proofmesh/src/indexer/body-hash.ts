// The content hash of a symbol's declaration (FR130): the span as the snapshot records it, normalised so a move or a rename keeps it.
import type Database from 'better-sqlite3'
import { sha256 } from '../core/hash.js'
import type { EvidenceStore } from '../evidence/store.js'

/** Stands where the symbol's own simple name was; no source text holds it. */
const PLACEHOLDER = '\u0001'
const WORD = '[\\p{L}\\p{N}_$]'
/** A normalised text of fewer tokens is the same text under many names (`const a = 1`), so compare_snapshots never pairs it (FR133). */
export const MIN_PAIR_TOKENS = 10

/** Words, numbers and each other non-space character count one each. */
export const tokenCount = (text: string): number => (text.match(/[\p{L}\p{N}_$]+|\S/gu) ?? []).length

/**
 * Line endings as LF, the lines' common leading indentation and every line's trailing whitespace removed, and the symbol's own name
 * replaced by one placeholder where it is a whole identifier that is not a member access (`this.get` is another symbol's name; `get(`
 * declaring it, or a bare call of it, is the symbol's own). A module is its file's text, whatever the file is called. A span that is
 * no more than the name, as a SCIP definition without an enclosing range gives, has none.
 */
export function normaliseDeclaration(text: string, name: string, kind: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  const indent = Math.min(...lines.filter((l) => l !== '').map((l) => /^[ \t]*/.exec(l)![0].length))
  let out = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n')
  if (kind !== 'module') {
    if (out.trim() === name) return null
    if (name) out = replaceName(out, name)
  }
  return out === '' ? null : out
}

const WORD_CHAR = new RegExp(`^${WORD}$`, 'u')
const isWord = (c: string | undefined) => c !== undefined && WORD_CHAR.test(c)
/** Whether `at` falls between the two halves of a surrogate pair, where a `u` regular expression never starts or ends a match. */
const splitsPair = (s: string, at: number) => at > 0 && at < s.length && /[\uD800-\uDBFF]/.test(s[at - 1]!) && /[\uDC00-\uDFFF]/.test(s[at]!)
/** The code point ending just before `at`, and the one starting at `at`, as a `u` regular expression sees them. */
const before = (s: string, at: number) => (at > 0 ? s.slice(splitsPair(s, at - 1) ? at - 2 : at - 1, at) : undefined)
const after = (s: string, at: number) => (at < s.length ? String.fromCodePoint(s.codePointAt(at)!) : undefined)

/**
 * `out.replace(/(?<![.WORD])name(?!WORD)/gu, PLACEHOLDER)` without compiling a Unicode expression per name, which cost seconds a
 * rebuild (#31).
 */
function replaceName(out: string, name: string): string {
  let result = '', from = 0
  for (let at = out.indexOf(name); at >= 0; at = out.indexOf(name, at + 1)) {
    const end = at + name.length, prev = before(out, at)
    if (at < from || splitsPair(out, at) || splitsPair(out, end) || prev === '.' || isWord(prev) || isWord(after(out, end))) continue
    result += out.slice(from, at) + PLACEHOLDER
    from = at + name.length
  }
  return result + out.slice(from)
}

export function hashDeclaration(text: string, name: string, kind: string): string | null {
  const out = normaliseDeclaration(text, name, kind)
  return out === null ? null : sha256(out)
}

/** The declaration's text, led by the whitespace before it when that is all that precedes it on its line, so its indentation counts. */
function declarationText(content: Buffer, start: number, end: number): string {
  let from = start
  while (from > 0 && (content[from - 1] === 0x20 || content[from - 1] === 0x09)) from--
  if (from > 0 && content[from - 1] !== 0x0a) from = start
  return content.subarray(from, end).toString('utf8')
}

/**
 * Fills `symbol.body_hash` and `body_tokens` from the captured content of each indexed file, at seal time, whatever adapter declared
 * the symbol. Returns the paths of files with symbols whose content was missing: their symbols stay null, and the snapshot says so.
 */
export function fillBodyHashes(db: Database.Database, store: EvidenceStore): string[] {
  const files = db.prepare('select id, path, content_hash from file where content_hash is not null order by id').all() as Array<{ id: string; path: string; content_hash: string }>
  const symbols = db.prepare('select id, kind, name, start_byte, end_byte from symbol where file_id = ?')
  const set = db.prepare('update symbol set body_hash = ?, body_tokens = ? where id = ?')
  const missing: string[] = []
  db.transaction(() => {
    for (const f of files) {
      const rows = symbols.all(f.id) as Array<{ id: string; kind: string; name: string; start_byte: number; end_byte: number }>
      if (!rows.length) continue
      const content = store.read(f.content_hash)
      if (!content) { missing.push(f.path); continue }
      for (const s of rows) {
        const text = normaliseDeclaration(s.kind === 'module' ? content.toString('utf8') : declarationText(content, s.start_byte, s.end_byte), s.name, s.kind)
        if (text !== null) set.run(sha256(text), tokenCount(text), s.id)
      }
    }
  })()
  return missing.sort()
}
