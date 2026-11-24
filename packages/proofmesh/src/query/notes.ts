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

/** A reference is `kind:qualified name`; it resolves to the symbol of that kind and name in a snapshot. */
export function resolveRef(db: Database.Database, ref: string): string | null {
  const i = ref.indexOf(':')
  if (i < 1) return null
  const row = db.prepare('select id from symbol where kind = ? and qualified_name = ? order by id limit 1').get(ref.slice(0, i), ref.slice(i + 1)) as { id: string } | undefined
  return row?.id ?? null
}

/**
 * The relationships of a note's referenced symbols, by kind and qualified name rather than snapshot-scoped IDs, so the
 * same code gives the same fingerprint in every snapshot. Unresolved references count as absent.
 */
export function fingerprint(db: Database.Database, refs: string[]): string {
  const ids = refs.map((r) => resolveRef(db, r)).filter((x): x is string => !!x)
  const label = (id: string) => { const s = db.prepare('select kind, qualified_name from symbol where id = ?').get(id) as { kind: string; qualified_name: string } | undefined; return s ? `${s.kind}:${s.qualified_name}` : id }
  const lines = new Set<string>()
  for (const id of ids) {
    for (const e of db.prepare("select src, type, dst from edge where (src = ? or dst = ?) and resolution = 'resolved'").all(id, id) as Array<{ src: string; type: string; dst: string }>) lines.add(`${label(e.src)} ${e.type} ${label(e.dst)}`)
  }
  return sha256(canonicalJson({ refs: [...refs].sort(), resolved: ids.map(label).sort(), edges: [...lines].sort() }))
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
