import path from 'node:path'
import type Database from 'better-sqlite3'
import type { EvidenceStore } from '../evidence/store.js'

// A read-only move plan (#38, FR1280 to FR1285): every site a move of a file, or of a top-level symbol to another file, must change, code
// sites as the snapshot observed them and path seams as inferred, for an agent or an editor to apply. Nothing here writes a file.

export type MoveSite = { path: string; line: number; kind: string; basis: 'observed' | 'inferred'; specifier?: string; new_specifier?: string; name?: string; split?: boolean; seam?: string; rule?: string }
type Ev = { start_byte: number; end_byte: number; start_line: number; path: string; hash: string | null }
type Sym = { id: string; name: string; kind: string; path: string; file_id: string; start_byte: number; end_byte: number }

const posix = path.posix
const bare = (p: string) => p.replace(/\.(d\.ts|[cm]?[jt]sx?|pyi?)$/, '')
const lines = (s: string) => s.match(/\n/g)?.length ?? 0
const EV_SQL = 'select e.start_byte, e.end_byte, e.start_line, f.path, f.content_hash as hash from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by f.path, e.start_byte'
/** Statements that import or re-export a file: from it (`source_id`) or to it (`target_id`). */
const IMPORTS_SQL = "select a.id, a.source_id, s.path as source, t.path as target from assertion a join file s on s.id = a.source_id join file t on t.id = a.target_id where a.type = 'imports' and a.resolution = 'resolved' and a.target_kind = 'file'"

/**
 * `written`, which names the file `target` from the directory `base` (from the repository root when `base` is null), rewritten to name
 * `next` from `nextBase` in the same style: without the extension when it had none, with the `.js` it wrote for a `.ts`, a directory for
 * its `index`, a Python module dotted. Undefined when it does not name `target`, such as a path alias or a package name.
 */
export function respell(written: string, base: string | null, target: string, nextBase: string | null, next: string): string | undefined {
  if (/\.pyi?$/.test(target)) {
    const dotted = (p: string) => bare(p).replace(/\/__init__$/, '').split('/').join('.')
    return written === dotted(target) ? dotted(next) : undefined
  }
  const abs = posix.normalize(base === null ? written : posix.join(base, written))
  const to = (p: string) => {
    if (nextBase === null) return p
    const r = posix.relative(nextBase, p)
    return written.startsWith('.') && !r.startsWith('.') ? `./${r}` : r
  }
  const js = /\.[cm]?jsx?$/.exec(abs)?.[0]
  if (abs === target) return to(next)
  if (abs === bare(target)) return to(bare(next))
  if (js && bare(abs) === bare(target)) return to(bare(next)) + js
  if (/^index\./.test(posix.basename(target)) && abs === posix.dirname(target)) return to(/^index\./.test(posix.basename(next)) ? posix.dirname(next) : bare(next))
  return undefined
}

/** How a file that has no import of `target` yet would write one from `from`: relative and without its extension, or dotted for Python. */
// shortcut: a new import is written without an extension; follow the file's own imports' style when an ESM repository needs `.js`.
const specifierFor = (from: string, target: string) => (/\.pyi?$/.test(target) ? bare(target).replace(/\/__init__$/, '').split('/').join('.') : ((r) => (r.startsWith('.') ? r : `./${r}`))(posix.relative(posix.dirname(from), bare(target))))

export function planMove(db: Database.Database, store: EvidenceStore, from: { fileId: string; path: string; symbol?: Sym }, to: string, deadline: number): { sites: MoveSite[]; carriers: string[]; stopped: boolean } {
  const texts = new Map<string, Buffer | null>()
  const text = (hash: string | null) => (hash ? (texts.has(hash) ? texts.get(hash)! : texts.set(hash, store.read(hash) ?? null).get(hash)!) : null)
  const spanOf = (e: Ev) => text(e.hash)?.subarray(e.start_byte, e.end_byte).toString('utf8') ?? ''
  const evidenceOf = db.prepare(EV_SQL)
  const importers = db.prepare(`${IMPORTS_SQL} and a.target_id = ?`)
  const sites: MoveSite[] = []
  const add = (s: MoveSite) => sites.push(s)

  /** The specifier of an import statement that names `target`, as written and as it must be to name `next`, at its line. */
  const specifierIn = (e: Ev, target: string, next: string, base = posix.dirname(e.path), nextBase = base) => {
    const stmt = spanOf(e)
    const quoted = [...stmt.matchAll(/(['"`])([^'"`\n]+)\1/g)].map((m) => ({ at: m.index + 1, written: m[2]! }))
    const py = /^\s*(?:from|import)\s+([\w.]+)/.exec(stmt)
    if (py && !quoted.length) quoted.push({ at: py[0].length - py[1]!.length, written: py[1]! })
    const named = quoted.map((q) => ({ ...q, next: respell(q.written, q.written.startsWith('.') ? base : null, target, q.written.startsWith('.') ? nextBase : null, next) }))
    const hit = named.find((q) => q.next !== undefined) ?? named.at(-1)
    return hit ? { line: e.start_line + lines(stmt.slice(0, hit.at)), specifier: hit.written, ...(hit.next !== undefined ? { new_specifier: hit.next } : {}), stmt } : undefined
  }
  const row = (e: Ev, s: NonNullable<ReturnType<typeof specifierIn>>, more: Partial<MoveSite> = {}): MoveSite => ({ path: e.path, line: s.line, kind: /^\s*export\b/.test(s.stmt) ? 'export' : 'import', basis: 'observed', specifier: s.specifier, ...(s.new_specifier !== undefined ? { new_specifier: s.new_specifier } : {}), ...more })

  // The files that re-export the moved code, directly or through each other: whether a package's public entry carries it.
  const carriers: string[] = []
  for (const queue = [from.fileId], seen = new Set(queue); queue.length;) {
    for (const a of importers.all(queue.shift()!) as Array<{ id: string; source_id: string; source: string }>) {
      const reExport = (evidenceOf.all(a.id) as Ev[]).some((e) => /^\s*export\b/.test(spanOf(e)))
      if (reExport && !seen.has(a.source_id)) { seen.add(a.source_id); queue.push(a.source_id); carriers.push(a.source) }
    }
  }

  const sym = from.symbol
  if (!sym) {
    // Every statement elsewhere that imports or re-exports the file, and the file's own imports, whose relative specifiers its new place changes.
    for (const a of importers.all(from.fileId) as Array<{ id: string }>) for (const e of evidenceOf.all(a.id) as Ev[]) { const s = specifierIn(e, from.path, to); if (s) add(row(e, s)) }
    for (const a of db.prepare(`${IMPORTS_SQL} and a.source_id = ?`).all(from.fileId) as Array<{ id: string; target: string }>) {
      for (const e of evidenceOf.all(a.id) as Ev[]) { const s = specifierIn(e, a.target, a.target, posix.dirname(from.path), posix.dirname(to)); if (s?.new_specifier !== undefined && s.new_specifier !== s.specifier) add(row(e, s)) }
    }
    // A doc's link to the file or its path in inline code (FR821), as the doc wrote it: from the root, else from the doc's directory.
    for (const a of db.prepare("select id, json_extract(detail, '$.text') as text from assertion where type = 'mentions' and target_kind = 'file' and target_id = ?").all(from.fileId) as Array<{ id: string; text: string }>) {
      const [, written, tail] = /^(.*?)((?:[?#].*|:\d+(?:-\d+)?)?)$/.exec(a.text)!
      for (const e of evidenceOf.all(a.id) as Ev[]) {
        const dir = posix.dirname(e.path), rooted = written!.startsWith('/') ? respell(written!.slice(1), null, from.path, null, to) : undefined
        const next = rooted !== undefined ? `/${rooted}` : respell(written!, null, from.path, null, to) ?? respell(written!, dir, from.path, dir, to)
        add({ path: e.path, line: e.start_line, kind: 'mention', basis: 'inferred', specifier: a.text, ...(next !== undefined ? { new_specifier: next + tail } : {}), seam: 'doc_mention', rule: 'doc_mention' })
      }
    }
    // Path seams: a string literal anywhere that names the file's path, from its own file's directory or from the root (a config's
    // entry, a mock registry's module), which no import binds. A line already listed as an import is not listed again.
    const listed = new Set(sites.map((s) => `${s.path}:${s.line}`)), stem = posix.basename(bare(from.path))
    let stopped = false
    for (const f of db.prepare("select path, content_hash as hash from file where content_hash is not null and path not like '%.md' and path not like '%.markdown' order by path").all() as Array<{ path: string; hash: string }>) {
      if (Date.now() > deadline) { stopped = true; break }
      const t = text(f.hash)
      if (!t?.includes(stem)) continue
      t.toString('utf8').split('\n').forEach((line, i) => {
        if (listed.has(`${f.path}:${i + 1}`)) return
        for (const m of line.matchAll(/(['"`])([^'"`\n]+)\1/g)) {
          const w = m[2]!, base = w.startsWith('.') ? posix.dirname(f.path) : null
          const next = respell(w, base, from.path, base, to)
          if (next !== undefined) add({ path: f.path, line: i + 1, kind: 'string', basis: 'inferred', specifier: w, new_specifier: next, seam: 'path', rule: 'path_string' })
        }
      })
    }
    return { sites: order(sites), carriers, stopped }
  }

  // A symbol: the statements in other files that import it or re-export its file by name or wholesale (`export *`), which must name its
  // new file; `split` when they name other things of the old file too, which stay.
  for (const a of importers.all(from.fileId) as Array<{ id: string }>) {
    for (const e of evidenceOf.all(a.id) as Ev[]) {
      const s = specifierIn(e, from.path, to)
      if (!s) continue
      const list = (/\{([^}]*)\}/.exec(s.stmt) ?? /^\s*from\s+\S+\s+import\s+\(?([^)#]*)/.exec(s.stmt))?.[1]
      const names = list ? [...list.matchAll(/([\w$]+)(?:\s+as\s+[\w$]+)?/g)].map((m) => m[1]!).filter((n) => n !== 'type') : []
      if (names.includes(sym.name)) add(row(e, s, names.length > 1 ? { split: true } : {}))
      else if (/^\s*export\s*\*\s*from/.test(s.stmt)) add(row(e, s, { split: true }))
    }
  }
  // Imports by path are what a move changes: a language that imports by namespace (C#) needs none for the uses below.
  if (bare(sym.path) === sym.path) return { sites: order(sites), carriers, stopped: false }
  // The symbol and everything declared inside it, and the line of a name in an evidence span.
  const inside = new Set((db.prepare('select id from symbol where file_id = ? and start_byte >= ? and end_byte <= ?').all(sym.file_id, sym.start_byte, sym.end_byte) as Array<{ id: string }>).map((r) => r.id))
  const within = (e: Ev) => e.path === sym.path && e.start_byte >= sym.start_byte && e.end_byte <= sym.end_byte
  const lineOf = (e: Ev, name: string) => { const span = spanOf(e); const at = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`).exec(span); return e.start_line + (at ? lines(span.slice(0, at.index)) : 0) }
  const ids = [...inside].map(() => '?').join(', ')
  // A use of it elsewhere in its old file: that file must import it from the new one.
  const uses = db.prepare(`select a.id from assertion a where a.target_id in (${ids}) and a.type in ('calls', 'references') and a.resolution = 'resolved' and a.origin in ('semantic_resolver', 'syntax') and a.source_id not in (${ids})`).all(...inside, ...inside) as Array<{ id: string }>
  const firstUse = uses.flatMap((a) => (evidenceOf.all(a.id) as Ev[]).filter((e) => e.path === sym.path && !within(e)).map((e) => lineOf(e, sym.name))).sort((a, b) => a - b)[0]
  if (firstUse !== undefined) add({ path: sym.path, line: firstUse, kind: 'add_import', basis: 'observed', name: sym.name, new_specifier: specifierFor(sym.path, to) })
  // What it uses outside itself: a top-level declaration of another file, or of its old one, that the new file must import.
  const deps = new Map<string, MoveSite>()
  for (const a of db.prepare(`select a.id, t.name, t.kind, f.path from assertion a join symbol t on t.id = a.target_id join file f on f.id = t.file_id where a.source_id in (${ids}) and a.type in ('calls', 'references', 'inherits', 'implements') and a.resolution = 'resolved' and a.origin in ('semantic_resolver', 'syntax') and a.target_kind = 'symbol' and a.target_id not in (${ids}) and t.kind not in ('method', 'property', 'field', 'constructor', 'module', 'parameter') order by f.path, t.start_byte`).all(...inside, ...inside) as Array<{ id: string; name: string; kind: string; path: string }>) {
    if (a.path === to || deps.has(`${a.path}\0${a.name}`)) continue
    const e = (evidenceOf.all(a.id) as Ev[]).find(within)
    if (e) deps.set(`${a.path}\0${a.name}`, { path: sym.path, line: lineOf(e, a.name), kind: 'dependency', basis: 'observed', name: a.name, new_specifier: specifierFor(to, a.path) })
  }
  sites.push(...deps.values())
  return { sites: order(sites), carriers, stopped: false }
}

/** Path then line order; on one line, an observed site before a seam. */
const order = (s: MoveSite[]) => s.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.basis === b.basis ? 0 : a.basis === 'observed' ? -1 : 1)))
