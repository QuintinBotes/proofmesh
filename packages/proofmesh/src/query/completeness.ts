// impact_completeness (FR108 to FR114): every symbol a diff changed, every caller, implementer and importer of each, and whether each
// is changed in the diff, reached by a test that executes it, or neither.
import { spawnSync } from 'node:child_process'
import type Database from 'better-sqlite3'
import { ProofmeshError } from '../core/errors.js'
import { leanName, leanRow, quote } from './lean.js'
import { EXECUTING, importedNames, testReach } from './test-reach.js'

/** Changed line ranges by path, on one side of a diff. */
type Ranges = Map<string, Array<[number, number]>>
/** The changed lines of each side of a diff, and the files renamed (new path to old). */
export type Diff = { head: Ranges; base: Ranges; renamed: Map<string, string> }
/** One side of the comparison: its snapshot database, its id and its changed ranges. */
type Snap = { db: Database.Database; id: string; ranges: Ranges }
type Sym = { id: string; kind: string; name: string; qualified_name: string; path: string; file_id: string; start_line: number; end_line: number }
type Test = { name: string; path: string; line: number; evidence: string; depth: number; changed: boolean }
/** A caller, implementer, overrider, subclass, reference or importer of a changed symbol, with its status. */
export type Dependent = { id: string; name: string; path: string; line: number; relation: string; via: string | null; status: 'changed' | 'tested' | 'neither'; test: Test | null }
/** A symbol the diff changed, with its status and dependents. */
export type Changed = { id: string; name: string; path: string; line: number; change: 'added' | 'modified' | 'deleted'; status: 'tested' | 'neither'; test: Test | null; dependents: Dependent[] }

/** Dependents' relations in row order (FR111); overrides joins them, since a member overriding a changed one is an implementer of it. */
const RELATIONS = ['calls', 'implements', 'overrides', 'inherits', 'references', 'imports']
const SYMBOL_SQL = 'select s.id, s.kind, s.name, s.qualified_name, f.path, s.file_id, s.start_line, s.end_line from symbol s join file f on f.id = s.file_id'

/**
 * The lines `git diff --unified=0` changed between base and head, or the working tree when head is null, with untracked files wholly
 * added. A line removed and added again in the same file, as when two functions swap places, only moved: it is no change (FR110).
 */
export function diffLines(root: string, base: string, head: string | null): Diff {
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })
    if (r.status !== 0) throw new ProofmeshError('INTERNAL_ERROR', `git ${args[0]} failed: ${r.stderr.trim()}`)
    return r.stdout
  }
  const diff: Diff = { head: new Map(), base: new Map(), renamed: new Map() }
  const add = (side: Ranges, p: string, from: number, count: number) => { if (count > 0) side.set(p, [...(side.get(p) ?? []), [from, from + count - 1]]) }
  // One file's removed and added lines, by text; a text on both sides is matched off as moved, once per occurrence.
  let a = '', b = '', from = '', inHunk = false, at = { base: 0, head: 0 }
  let removed: Array<[number, string]> = [], added: Array<[number, string]> = []
  const flush = () => {
    const left = new Map<string, number>()
    for (const [, t] of removed) left.set(t, (left.get(t) ?? 0) + 1)
    const kept = added.filter(([, t]) => { const n = left.get(t) ?? 0; if (n) left.set(t, n - 1); return !n })
    const right = new Map<string, number>()
    for (const [, t] of added) right.set(t, (right.get(t) ?? 0) + 1)
    for (const [l, t] of removed) { const n = right.get(t) ?? 0; if (n) right.set(t, n - 1); else add(diff.base, a, l, 1) }
    for (const [l] of kept) add(diff.head, b, l, 1)
    removed = []
    added = []
  }
  const name = (l: string) => l.slice(6).replace(/\t$/, '')
  // Fixed prefixes and unquoted names, whatever the person's git configuration says.
  // shortcut: a name holding a quote, a backslash or a control character is still quoted by git and so not matched; read -z output if one turns up.
  for (const line of git('diff', '--unified=0', '--no-color', '--no-ext-diff', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', base, ...(head ? [head] : []), '--').split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); a = b = from = ''; inHunk = false }
    else if (!inHunk && line.startsWith('rename from ')) from = line.slice(12)
    else if (!inHunk && line.startsWith('rename to ')) { b = line.slice(10); diff.renamed.set(b, from) }
    else if (!inHunk && line.startsWith('--- ')) a = line === '--- /dev/null' ? '' : name(line)
    else if (!inHunk && line.startsWith('+++ ')) b = line === '+++ /dev/null' ? '' : name(line)
    else if (line.startsWith('@@ ')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)!
      inHunk = true
      at = { base: Number(h[1]), head: Number(h[2]) }
    } else if (inHunk && line.startsWith('-')) removed.push([at.base++, line.slice(1)])
    else if (inHunk && line.startsWith('+')) added.push([at.head++, line.slice(1)])
  }
  flush()
  if (!head) for (const p of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) add(diff.head, p, 1, Number.MAX_SAFE_INTEGER)
  return diff
}

const overlaps = (ranges: Array<[number, number]> | undefined, start: number, end: number) => !!ranges?.some(([s, e]) => s <= end && e >= start)
/**
 * A line outside every symbol that is no statement of its own: blank, a comment, an export list, or `export default` of a name; import lines are
 * taken from the imports recorded. `export default <expression>` is a statement: it changes what importers get.
 */
// shortcut: a comment or export list is read from the line's first characters, so its continuation lines count as statements; read the syntax tree if that matters.
const notAStatement = (text: string) => /^\s*($|\/\/|\/\*|\*|export\s*(\{|\*|default\s+[\w$.]+\s*;?\s*$))/.test(text)

/**
 * The innermost symbol of each changed line on one side (a method, not its class); a changed top-level line that is a statement makes the
 * module changed (FR110). `text` reads a file of that side.
 */
function touched(db: Database.Database, ranges: Ranges, text: (path: string) => string | undefined): Sym[] {
  const out = new Map<string, Sym>()
  for (const [p, rs] of ranges) {
    const syms = db.prepare(`${SYMBOL_SQL} where f.path = ? and f.disposition = 'indexed'`).all(p) as Sym[]
    if (!syms.length) continue
    const module = syms.find((s) => s.kind === 'module'), inner = syms.filter((s) => s.kind !== 'module')
    const lines = text(p)?.split('\n') ?? []
    const imports = db.prepare("select e.start_line as s, e.end_line as e from assertion a join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id where a.type = 'imports' and a.source_id = ?").all(module?.file_id ?? '') as Array<{ s: number; e: number }>
    for (const [s, e] of rs) {
      for (let l = s; l <= Math.min(e, Math.max(lines.length, s)); l++) {
        const hit = inner.filter((x) => x.start_line <= l && l <= x.end_line).sort((x, y) => (x.end_line - x.start_line) - (y.end_line - y.start_line))[0]
        const sym = hit ?? (module && !notAStatement(lines[l - 1] ?? '') && !imports.some((i) => i.s <= l && l <= i.e) ? module : undefined)
        if (sym) out.set(sym.id, sym)
      }
    }
  }
  return [...out.values()]
}

/** The changed symbols (FR110): head symbols touched, modified when base has one of that kind and name, else added; base symbols touched that head lacks, deleted. */
export function changedSymbols(head: Snap, base: Snap, diff: Diff, read: (db: Database.Database, path: string) => string | undefined): Array<{ sym: Sym; change: Changed['change']; snap: Snap }> {
  const counterpart = (db: Database.Database, s: Sym) => db.prepare('select 1 from symbol where kind = ? and qualified_name = ?').get(s.kind, s.qualified_name)
  const out = new Map<string, { sym: Sym; change: Changed['change']; snap: Snap }>()
  for (const s of touched(head.db, diff.head, (p) => read(head.db, p))) out.set(s.id, { sym: s, change: counterpart(base.db, s) ? 'modified' : 'added', snap: head })
  for (const s of touched(base.db, diff.base, (p) => read(base.db, p))) {
    const h = head.db.prepare(`${SYMBOL_SQL} where s.kind = ? and s.qualified_name = ?`).get(s.kind, s.qualified_name) as Sym | undefined
    if (!h) out.set(s.id, { sym: s, change: 'deleted', snap: base })
    else if (!out.has(h.id)) out.set(h.id, { sym: h, change: 'modified', snap: head })
  }
  // A file renamed with no other change: its module, whose importers now name another path.
  for (const [to] of [...diff.renamed].filter(([to]) => !diff.head.has(to))) {
    const m = head.db.prepare(`${SYMBOL_SQL} where f.path = ? and s.kind = 'module'`).get(to) as Sym | undefined
    if (m && !out.has(m.id)) out.set(m.id, { sym: m, change: 'modified', snap: head })
  }
  return [...out.values()].sort((x, y) => (x.sym.path < y.sym.path ? -1 : x.sym.path > y.sym.path ? 1 : x.sym.start_line - y.sym.start_line))
}

/** The project that contains a file, by its module symbol, for recognising test code by project naming. */
const projectOf = (db: Database.Database, fileId: string) => (db.prepare("select p.qualified_name as q from assertion a join symbol p on p.id = a.source_id join symbol m on m.id = a.target_id where a.type = 'contains' and p.kind = 'project' and m.file_id = ? limit 1").get(fileId) as { q: string } | undefined)?.q ?? null
/** Whether a symbol is in test code, by its path and project naming. */
export const inTestCode = (db: Database.Database, s: { path: string; file_id: string }, isTest: (path: string, project: string | null) => boolean) => isTest(s.path, projectOf(db, s.file_id))

/** What `complete` needs: both sides, the depth, whether test code counts, and readers for file and object text. */
export type Options = { head: Snap; base: Snap; depth: number; includeTests: boolean; isTest: (path: string, project: string | null) => boolean; read: (db: Database.Database, path: string) => string | undefined; readHash: (hash: string) => Buffer | undefined; maxDepth: number }

/**
 * One changed symbol with its dependents (FR111) and every status (FR112): callers (dispatch included, via the member called), implementers,
 * overriders, subclasses, references, then importers whose import binds it as file rows, unless the file already has a row; callers of
 * callers to `depth`, via the caller they reach it through.
 */
export function complete(c: { sym: Sym; change: Changed['change']; snap: Snap }, o: Options): { changed: Changed; stopped: number; unfollowed: string[] } {
  const { db, ranges } = c.snap, other = c.snap === o.head ? o.base : o.head
  // Changed on either side: a deletion inside a symbol leaves no head line, and an insertion no base line.
  const changedIn = (s: Sym) => overlaps(ranges.get(s.path), s.start_line, s.end_line) || (() => {
    const t = other.db.prepare(`${SYMBOL_SQL} where s.kind = ? and s.qualified_name = ?`).get(s.kind, s.qualified_name) as Sym | undefined
    return !!t && overlaps(other.ranges.get(t.path), t.start_line, t.end_line)
  })()
  const testCode = (s: { path: string; file_id: string }) => inTestCode(db, s, o.isTest)
  const site = db.prepare('select f.path, e.start_line as line from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by e.start_byte limit 1')
  const symbol = db.prepare(`${SYMBOL_SQL} where s.id = ?`)
  const inbound = (id: string, types: string[]) => db.prepare(`select src, type, assertion_id from edge where dst = ? and resolution = 'resolved' and type in (${types.map(() => '?').join(',')})`).all(id, ...types) as Array<{ src: string; type: string; assertion_id: string }>

  // The test nearest a symbol or file that executes it, by find_tests' evidence (FR112); a search cut short is counted, so neither can say so.
  let stopped = 0
  const unfollowed = new Set<string>()
  const nearest = (ids: string[], files: string[]): Test | null => {
    const r = testReach(db, c.snap.id, ids, files, o.readHash, o.maxDepth, o.isTest)
    const t = r.rows.find((x) => EXECUTING.has(x.evidence))
    if (!t) {
      if (r.stopped_by) stopped++
      for (const a of r.unfollowed) unfollowed.add(a)
      return null
    }
    const own = symbol.get(t.id) as Sym | undefined
    return { name: leanName(t), path: t.path, line: t.line, evidence: t.evidence, depth: t.depth, changed: !!own && changedIn(own) }
  }
  const statusOf = (changed: boolean, ids: string[], files: string[]): Pick<Dependent, 'status' | 'test'> => {
    if (changed) return { status: 'changed', test: null }
    const test = nearest(ids, files)
    return { status: test ? 'tested' : 'neither', test }
  }

  // One row per dependent and relation, at its first site.
  const rows = new Map<string, Dependent>()
  const keep = (s: Sym, relation: string, assertion: string, via: string | null) => {
    if (s.id === c.sym.id || (!o.includeTests && testCode(s))) return
    const key = `${s.id}\u0000${relation}`, at = site.get(assertion) as { path: string; line: number }
    const had = rows.get(key)
    if (had && (had.path < at.path || (had.path === at.path && had.line <= at.line))) return
    rows.set(key, { id: s.id, name: leanName(s), path: at.path, line: at.line, relation, via, status: 'neither', test: null })
  }
  // Every member above the changed one, at any distance, whose calls may dispatch to it.
  const above = db.prepare("select dst from edge where src = ? and type in ('implements', 'overrides') and resolution = 'resolved'")
  const up: string[] = []
  for (const q = [c.sym.id]; q.length;) for (const r of above.all(q.pop()!) as Array<{ dst: string }>) if (!up.includes(r.dst)) { up.push(r.dst); q.push(r.dst) }
  for (const e of inbound(c.sym.id, ['calls', 'implements', 'overrides', 'inherits', 'references'])) { const s = symbol.get(e.src) as Sym | undefined; if (s) keep(s, e.type, e.assertion_id, null) }
  for (const m of up) {
    const via = leanName(symbol.get(m) as Sym)
    for (const e of inbound(m, ['calls'])) { const s = symbol.get(e.src) as Sym | undefined; if (s) keep(s, 'calls', e.assertion_id, via) }
  }
  // Callers of callers, breadth first, each at its shortest depth.
  let frontier = [...rows.values()].filter((r) => r.relation === 'calls')
  for (let d = 2; d <= o.depth && frontier.length; d++) {
    const next: Dependent[] = []
    for (const f of frontier) {
      for (const e of inbound(f.id, ['calls'])) {
        const s = symbol.get(e.src) as Sym | undefined
        if (!s || rows.has(`${s.id}\u0000calls`)) continue
        keep(s, 'calls', e.assertion_id, f.name)
        const added = rows.get(`${s.id}\u0000calls`)
        if (added) next.push(added)
      }
    }
    frontier = next
  }
  // Importers: a module's every importer; a symbol's, where the import binds its name or the whole module and nothing else in the file has a row.
  const module = c.sym.kind === 'module', name = c.sym.qualified_name.slice(c.sym.qualified_name.indexOf(':') + 1)
  const covered = new Set([...rows.values()].map((r) => (symbol.get(r.id) as Sym).file_id))
  if (module || !name.includes('.')) {
    const imports = db.prepare(`select a.id, a.source_id as file, f.path from assertion a join file f on f.id = a.source_id where a.type = 'imports' and a.resolution = 'resolved' and a.target_id = ?`).all(c.sym.file_id) as Array<{ id: string; file: string; path: string }>
    const texts = db.prepare('select e.object_hash as hash, e.start_byte as start, e.end_byte as end from assertion_evidence ae join evidence e on e.id = ae.evidence_id where ae.assertion_id = ?')
    for (const i of imports) {
      if (covered.has(i.file) || (!o.includeTests && o.isTest(i.path, projectOf(db, i.file)))) continue
      const names = (texts.all(i.id) as Array<{ hash: string; start: number; end: number }>).flatMap((t) => importedNames(o.readHash(t.hash)?.subarray(t.start, t.end).toString('utf8') ?? ''))
      if (!module && !names.some((n) => n === '*' || n === name)) continue
      const at = site.get(i.id) as { path: string; line: number }, had = rows.get(`${i.file}\u0000imports`)
      if (had && had.line <= at.line) continue
      rows.set(`${i.file}\u0000imports`, { id: i.file, name: i.path.slice(i.path.lastIndexOf('/') + 1), path: at.path, line: at.line, relation: 'imports', via: null, status: 'neither', test: null })
    }
  }

  const dependents = [...rows.values()].map((r) => {
    if (r.relation === 'imports') {
      const ids = (db.prepare('select id from symbol where file_id = ?').all(r.id) as Array<{ id: string }>).map((x) => x.id)
      return { ...r, ...statusOf(ranges.has(r.path) || other.ranges.has(r.path), ids, [r.id]) }
    }
    const s = symbol.get(r.id) as Sym
    return { ...r, ...statusOf(changedIn(s), [s.id], []) }
  }).sort((x, y) => RELATIONS.indexOf(x.relation) - RELATIONS.indexOf(y.relation) || (x.path < y.path ? -1 : x.path > y.path ? 1 : x.line - y.line))
  const test = nearest([c.sym.id], module ? [c.sym.file_id] : [])
  return { changed: { id: c.sym.id, name: leanName(c.sym), path: c.sym.path, line: c.sym.start_line, change: c.change, status: test ? 'tested' : 'neither', test, dependents }, stopped, unfollowed: [...unfollowed] }
}

const statusText = (s: { status: string; test: Test | null }) => s.test
  ? `tested: ${quote(s.test.name)} ${quote(s.test.path)}:${s.test.line} ${s.test.evidence} depth=${s.test.depth}${s.test.changed ? ' (test changed)' : ''}`
  : s.status

/** The text form of scenario 1: each changed symbol, then its dependents indented (FR113). */
export function completenessRows(changed: Changed[]): string[] {
  return changed.flatMap((c) => [
    `changed ${leanRow(c.name, c.path, c.line, [c.change, statusText(c)])}`,
    ...c.dependents.map((d) => `  ${d.relation} ${leanRow(d.relation === 'imports' ? null : d.name, d.path, d.line, [statusText(d), ...(d.via ? [`(via ${d.via})`] : [])])}`),
  ])
}

/** The `summary:` line of the lean answer (FR113). */
export const summaryLine = (t: { changed_symbols: number; dependents: number; changed: number; tested: number; neither: number }) =>
  `summary: ${t.changed_symbols} changed symbol${t.changed_symbols === 1 ? '' : 's'}; ${t.dependents} dependent${t.dependents === 1 ? '' : 's'}: ${t.changed} changed, ${t.tested} tested, ${t.neither} neither`
