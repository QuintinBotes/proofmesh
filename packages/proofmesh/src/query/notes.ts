import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { canonicalJson, sha256 } from '../core/hash.js'

export const NOTE_KINDS = ['domain', 'capability', 'decision', 'gotcha', 'invariant', 'glossary', 'ownership'] as const
export type Note = { id: string; title: string; kind: string; status: string | null; target: string | null; refs: string[]; sources: string[]; patterns: string[]; body: string; fingerprint: string | null }

/** Reads a note: YAML-style frontmatter (scalars and `- item` lists) between --- lines, then Markdown. Returns why it is invalid, or the note. */
export function parseNote(text: string, fallbackId: string): Note | string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return 'no frontmatter'
  const fields: Record<string, string | string[]> = {}
  let list: string | null = null
  for (const line of m[1]!.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && list) { (fields[list] as string[]).push(unquote(item[1]!)); continue }
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    if (kv[2] === '') { list = kv[1]!; fields[list] = [] } else { list = null; fields[kv[1]!] = unquote(kv[2]!) }
  }
  const str = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string) : null)
  const arr = (k: string) => (Array.isArray(fields[k]) ? (fields[k] as string[]) : [])
  const id = str('id') ?? fallbackId
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return `"${id}" is not a valid note id: use lowercase letters, digits and hyphens`
  const title = str('title')
  if (!title) return 'a note needs a title'
  const kind = str('kind') ?? 'gotcha'
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) return `kind must be one of ${NOTE_KINDS.join(', ')}`
  // A pattern is a regular expression, matched case-insensitively, for text the target code writes: a SQL clause a helper adds, say.
  for (const p of arr('patterns')) { try { new RegExp(p, 'i') } catch (e) { return `pattern ${JSON.stringify(p)} is not a regular expression: ${(e as Error).message}` } }
  return { id, title, kind, status: str('status'), target: str('target'), refs: arr('nodes'), sources: arr('sources'), patterns: arr('patterns'), body: m[2]!.trim(), fingerprint: str('fingerprint') }
}
const unquote = (v: string) => (/^".*"$/.test(v) ? (JSON.parse(v) as string) : v.trim())

/** Every Markdown note under a directory, with the problem of each one that cannot be read. */
export function readNotes(dir: string): { notes: Array<Note & { file: string }>; problems: string[] } {
  const notes: Array<Note & { file: string }> = [], problems: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.md')) {
        const parsed = parseNote(fs.readFileSync(full, 'utf8'), path.basename(e.name, '.md'))
        if (typeof parsed === 'string') problems.push(`${full}: ${parsed}`)
        else notes.push({ ...parsed, file: full })
      }
    }
  }
  walk(dir)
  return { notes, problems }
}

/**
 * The symbols a reference `kind:qualified name` matches: the symbol of exactly that name, else every overload of it, whose names
 * carry their parameter types (`com.acme.Shop.add(int)`). More than one is an ambiguous reference (FR150).
 */
export function resolveRefs(db: Database.Database, ref: string): string[] {
  const i = ref.indexOf(':')
  if (i < 1) return []
  const kind = ref.slice(0, i), name = ref.slice(i + 1)
  const ids = (sql: string, ...args: Array<string | number>) => (db.prepare(sql).all(...args) as Array<{ id: string }>).map((r) => r.id)
  const exact = ids('select id from symbol where kind = ? and qualified_name = ? order by id', kind, name)
  return exact.length ? exact : ids("select id from symbol where kind = ? and substr(qualified_name, 1, ?) = ? and substr(qualified_name, ? + 1, 1) = '(' order by id", kind, name.length, name, name.length)
}

/** The first symbol a reference matches, or null. */
export const resolveRef = (db: Database.Database, ref: string): string | null => resolveRefs(db, ref)[0] ?? null

/**
 * What a note's referenced symbols look like, by kind and qualified name rather than snapshot-scoped IDs, so the same code gives
 * the same fingerprint in every snapshot: the relationships of the referenced symbols (unresolved references count as absent),
 * then, after a `+`, the content and the tier of each referenced file, which tell a tier switch from a change (FR150). A
 * fingerprint accepted before the second part existed is the first part alone.
 */
export function fingerprint(db: Database.Database, refs: string[]): string {
  const ids = [...new Set(refs.flatMap((r) => resolveRefs(db, r)))]
  const label = (id: string) => { const s = db.prepare('select kind, qualified_name from symbol where id = ?').get(id) as { kind: string; qualified_name: string } | undefined; return s ? `${s.kind}:${s.qualified_name}` : id }
  const lines = new Set<string>()
  for (const id of ids) {
    for (const e of db.prepare("select src, type, dst from edge where (src = ? or dst = ?) and resolution = 'resolved'").all(id, id) as Array<{ src: string; type: string; dst: string }>) lines.add(`${label(e.src)} ${e.type} ${label(e.dst)}`)
  }
  const relations = sha256(canonicalJson({ refs: [...refs].sort(), resolved: ids.map(label).sort(), edges: [...lines].sort() }))
  const files = new Set(ids.map((id) => { const r = db.prepare('select f.path, f.content_hash, ev.extractor from symbol s join file f on f.id = s.file_id join evidence ev on ev.id = s.evidence_id where s.id = ?').get(id) as { path: string; content_hash: string | null; extractor: string }; return `${sha256(r.path).slice(0, 8)}:${(r.content_hash ?? '').slice(0, 12)}:${r.extractor}` }))
  return `${relations}+${[...files].sort().join(',')}`
}

/** Where a note stands: unaccepted, ambiguous, tier_changed (a referenced file's tier moved and its content did not), changed or current. */
export function staleness(db: Database.Database, refs: string[], accepted: string | null, ambiguous: boolean): 'unaccepted' | 'ambiguous' | 'tier_changed' | 'changed' | 'current' {
  if (!accepted) return 'unaccepted'
  if (ambiguous) return 'ambiguous'
  const [was = '', wasFiles = ''] = accepted.split('+'), [now = '', nowFiles = ''] = fingerprint(db, refs).split('+')
  const parts = (v: string) => new Map(v.split(',').filter(Boolean).map((f) => { const [path, content, tier] = f.split(':'); return [path!, { content, tier }] as const }))
  const before = parts(wasFiles), after = parts(nowFiles)
  const sameContent = before.size > 0 && before.size === after.size && [...before].every(([k, v]) => after.get(k)?.content === v.content)
  if (sameContent && [...before].some(([k, v]) => after.get(k)!.tier !== v.tier)) return 'tier_changed'
  return now === was ? 'current' : 'changed'
}

/** Accepted notes with a pattern the text matches: the code a note targets writes text like it, so it is the place to look. */
export function notesMatching(notes: Array<{ id: string; title: string; target: string | null; refs: string[]; patterns: string[]; fingerprint: string | null }>, text: string): Array<{ id: string; title: string; target: string | null; pattern: string }> {
  const out: Array<{ id: string; title: string; target: string | null; pattern: string }> = []
  for (const n of notes) {
    if (!n.fingerprint) continue
    const pattern = n.patterns.find((p) => new RegExp(p, 'i').test(text))
    if (pattern) out.push({ id: n.id, title: n.title, target: n.target ?? n.refs[0] ?? null, pattern })
  }
  return out
}
