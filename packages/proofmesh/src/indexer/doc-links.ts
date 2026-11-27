// Docs link to the code they name (FR820 to FR826): a Markdown doc's inline code and links, matched by name to the snapshot's symbols and files
// with no model, each an inferred `mentions`; and the mentions whose code is gone since the previous snapshot, paired as compare_snapshots pairs.
import path from 'node:path'
import type Database from 'better-sqlite3'
import { pairUp, symbols, type Sym } from '../query/compare.js'

/** Part of snapshot identity: a change to the matching rules indexes again. */
export const DOC_LINKS_VERSION = '1'

/** A Markdown file no adapter reads: its text is captured for its mentions, and it stays `unsupported` as before. */
export const isDoc = (d: { status: string; detail: string | null }): boolean => d.status === 'unsupported' && /^no_adapter:\.(md|markdown)$/i.test(d.detail ?? '')

export type Raw = { path: string; text: string; form: 'code' | 'link'; line: number; start_byte: number; end_byte: number }
export type Mention = Raw & { target?: { kind: 'symbol' | 'file'; id: string }; candidates?: string[]; more?: number }
export type Stale = { path: string; line: number; mention: string; change: 'renamed' | 'moved' | 'moved_renamed' | 'deleted'; to: { name: string; path: string } | null }

/** The most candidates an ambiguous mention lists; one naming more carries `detail.more`, as an ambiguous call does. */
const MAX_CANDIDATES = 5
const IDENT = /^[A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*$/
const SEP = /::|\.|#/
/** A bare name is a type's or a namespace's: a member or a function needs its container or `()`, so `id` or `filter` in backticks names nothing. */
const BARE = new Set(['class', 'interface', 'struct', 'enum', 'type_alias', 'namespace'])
const CALLABLE = new Set(['function', 'method', 'constructor'])

/** Inline code spans and link targets of a Markdown text, outside fenced code blocks. */
export function scanDoc(docPath: string, text: string): Raw[] {
  const out: Raw[] = []
  let fence: string | null = null, byte = 0
  const push = (line: string, n: number, at: number, t: string, form: Raw['form']) => {
    const start = byte + Buffer.byteLength(line.slice(0, at))
    out.push({ path: docPath, text: t, form, line: n, start_byte: start, end_byte: start + Buffer.byteLength(t) })
  }
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '')
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fence) fence = f[1]!
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length && !line.slice(f[0].length).trim()) fence = null
    } else if (!fence) {
      // Code spans first; a link inside one is code, so the spans are blanked before links are read.
      let blanked = line
      for (const m of line.matchAll(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) {
        const inner = m[2]!, t = inner.trim()
        if (t) push(line, i + 1, m.index + m[1]!.length + inner.indexOf(t), t, 'code')
        blanked = blanked.slice(0, m.index) + ' '.repeat(m[0].length) + blanked.slice(m.index + m[0].length)
      }
      for (const m of blanked.matchAll(/\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)|^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/g)) {
        const t = (m[1] ?? m[2])!
        push(line, i + 1, m.index + m[0].indexOf(t), t, 'link')
      }
    }
    byte += Buffer.byteLength(raw) + 1
  })
  return out
}

type Named = { id: string; kind: string; qualified_name: string; segs: string[] }

/** Matches every scanned mention against the snapshot being written: recorded ones resolve or are ambiguous; the rest name no code. */
export function resolveMentions(db: Database.Database, raws: Raw[]): { recorded: Mention[]; unmatched: Raw[] } {
  if (!raws.length) return { recorded: [], unmatched: [] }
  const files = new Map((db.prepare("select id, path from file where disposition <> 'excluded_by_rule' and path not like '%/'").all() as Array<{ id: string; path: string }>).map((f) => [f.path, f.id]))
  const byName = new Map<string, Named[]>()
  for (const s of db.prepare("select id, kind, name, qualified_name from symbol where kind not in ('module', 'project', 'package') order by qualified_name, id").all() as Array<{ id: string; kind: string; name: string; qualified_name: string }>) {
    const named = { id: s.id, kind: s.kind, qualified_name: s.qualified_name, segs: s.qualified_name.replace(/\(.*$/, '').split(/::|[:.#/\\]/).filter(Boolean) }
    byName.set(named.segs.at(-1) ?? s.name, [...(byName.get(named.segs.at(-1) ?? s.name) ?? []), named])
  }
  /** A repository path: from the doc's directory for a link (from the root when it starts with /), else from the root and then the doc's directory. */
  const fileOf = (r: Raw): string | undefined => {
    if (r.form === 'link' && /^([a-z][a-z0-9+.-]*:|#)/i.test(r.text)) return undefined
    let p = r.text.replace(/[?#].*$/, '').replace(/:\d+(-\d+)?$/, '')
    try { p = decodeURIComponent(p) } catch { /* kept as written */ }
    const dir = path.posix.dirname(r.path)
    const tries = p.startsWith('/') ? [p.slice(1)] : r.form === 'link' ? [path.posix.join(dir, p)] : [p, path.posix.join(dir, p)]
    return tries.map((t) => path.posix.normalize(t)).find((t) => files.has(t))
  }
  const recorded: Mention[] = [], unmatched: Raw[] = []
  for (const r of raws) {
    const file = fileOf(r)
    if (file) { recorded.push({ ...r, target: { kind: 'file', id: files.get(file)! } }); continue }
    const call = /^(.+?)\(.*\)$/.exec(r.text), name = call ? call[1]! : r.text
    if (r.form === 'link' || !IDENT.test(name)) { unmatched.push(r); continue }
    const segs = name.split(SEP)
    const hits = (byName.get(segs.at(-1)!) ?? []).filter((s) => s.segs.length >= segs.length && segs.every((x, i) => s.segs[s.segs.length - segs.length + i] === x)
      && (call ? CALLABLE.has(s.kind) : segs.length > 1 || BARE.has(s.kind)))
    if (hits.length === 1) recorded.push({ ...r, target: { kind: 'symbol', id: hits[0]!.id } })
    else if (hits.length) recorded.push({ ...r, candidates: hits.slice(0, MAX_CANDIDATES).map((h) => h.id), ...(hits.length > MAX_CANDIDATES ? { more: hits.length - MAX_CANDIDATES } : {}) })
    else unmatched.push(r)
  }
  return { recorded, unmatched }
}

/**
 * The mentions that name nothing now but resolved in the previous snapshot, whose code is gone: renamed, moved or moved_renamed when one
 * removed and one added symbol of a kind share a body hash (FR133), a file moved when one added file has its content, deleted otherwise.
 * A mention already stale there and still unmatched keeps its change at its line now, so it stays listed until the doc is fixed.
 */
export function staleMentions(prev: Database.Database | undefined, head: Database.Database, unmatched: Raw[], headDocs: Record<string, string>): Stale[] {
  if (!prev || !unmatched.length) return []
  const key = (doc: string, text: string) => `${doc}\u0000${text}`
  type Was = { target_kind: string; target_id: string }
  const was = new Map((prev.prepare(`select f.path as doc, json_extract(a.detail, '$.text') as text, a.target_kind, a.target_id from assertion a join file f on f.id = a.source_id
    where a.type = 'mentions' and a.resolution = 'resolved'`).all() as Array<Was & { doc: string; text: string }>).map((r) => [key(r.doc, r.text), r]))
  const meta = prev.prepare("select value from meta where key = 'doc_links'").get() as { value: string } | undefined
  const kept = meta ? (JSON.parse(meta.value) as { docs: Record<string, string>; stale: Stale[] }) : { docs: {} as Record<string, string>, stale: [] }
  const carried = new Map(kept.stale.map((s) => [key(s.path, s.mention), s]))
  let pairs: { head: Map<string, Sym>; to: Map<string, { change: Stale['change']; head: Sym }> } | undefined
  const paired = () => {
    if (pairs) return pairs
    const b = symbols(prev), h = symbols(head)
    const p = pairUp([...h].filter(([k]) => !b.has(k)).map(([, s]) => s), [...b].filter(([k]) => !h.has(k)).map(([, s]) => s))
    return (pairs = { head: h, to: new Map(p.paired.map((x) => [x.base.id, { change: x.change, head: x.head }])) })
  }
  const out: Stale[] = []
  for (const u of unmatched) {
    const w = was.get(key(u.path, u.text))
    const at = { path: u.path, line: u.line, mention: u.text }
    if (!w) { const c = carried.get(key(u.path, u.text)); if (c) out.push({ ...c, ...at }); continue }
    if (w.target_kind === 'file') {
      const gone = prev.prepare('select path, content_hash from file where id = ?').get(w.target_id) as { path: string; content_hash: string | null }
      if (head.prepare('select 1 from file where path = ?').get(gone.path)) continue
      // A doc keeps no content hash in its file row; its text's hash is in the doc_links meta of each side.
      const hash = gone.content_hash ?? kept.docs[gone.path]
      const now = hash ? [...(head.prepare('select path from file where content_hash = ?').all(hash) as Array<{ path: string }>).map((f) => f.path), ...Object.keys(headDocs).filter((p) => headDocs[p] === hash)] : []
      const moved = now.filter((p) => !prev.prepare('select 1 from file where path = ?').get(p))
      out.push({ ...at, ...(moved.length === 1 ? { change: 'moved' as const, to: { name: moved[0]!, path: moved[0]! } } : { change: 'deleted' as const, to: null }) })
      continue
    }
    const { head: now, to } = paired()
    const sym = prev.prepare('select s.kind, s.qualified_name, f.path from symbol s join file f on f.id = s.file_id where s.id = ?').get(w.target_id) as { kind: string; qualified_name: string; path: string }
    if (now.has(`${sym.kind}\u0000${sym.qualified_name}`)) continue
    // A file that failed this time declared nothing: its code is unknown, not gone.
    if (head.prepare("select 1 from file where path = ? and disposition = 'failed'").get(sym.path)) continue
    const p = to.get(w.target_id)
    if (!p) { out.push({ ...at, change: 'deleted', to: null }); continue }
    // The new name as the doc would write it: as many trailing segments as the mention had, joined as it joined them.
    const written = u.text.replace(/\(.*\)$/, ''), sep = SEP.exec(written)?.[0] ?? '.'
    const segs = p.head.qualified_name.replace(/\(.*$/, '').split(/::|[:.#/\\]/).filter(Boolean)
    out.push({ ...at, change: p.change, to: { name: segs.slice(-written.split(SEP).length).join(sep), path: p.head.path } })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.mention < b.mention ? -1 : 1)))
}
