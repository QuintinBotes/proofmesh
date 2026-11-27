// C's and C++'s rules for binding a name (FR755 to FR758). A quoted `#include` names a file by its path relative to the including
// file; otherwise, as an angle include does, it names any file of the repository whose path ends with it. A bare call binds, in a C++
// method, a member of its own class first; then a function of its own file (a `static` one only there); then a function the headers
// the file includes (directly or through each other) declare: its definitions in those headers and in the files that include the
// declaring header, never a `static` one of another file. A call through `T::` binds the members of the class `T`, and through a
// namespace the functions of headers that open that namespace. A call on an object or a pointer binds to nothing. A name only
// declared, with no definition in the repository, keeps its row: its body is in a library or across a foreign-function interface (FR465).
import path from 'node:path'
import { bind, callForm, group, type Model, type Rel, type Sym } from './common.js'

const C_FILE = /\.(c|h|cc|cpp|cxx|hpp|hh|hxx)$/
const HEADER = /\.(h|hh|hpp|hxx)$/
const FUNCTION = new Set(['function', 'method'])
const TYPES = new Set(['class', 'struct'])

export function resolveC(m: Model, rels: Rel[]): Map<Rel, Rel> {
  const out = new Map<Rel, Rel>()
  const mine = rels.filter((r) => C_FILE.test(r.site.path))
  if (!mine.length) return out
  const syms = m.symbols.filter((s) => C_FILE.test(s.path))
  const files = [...new Set([...syms.map((s) => s.path), ...mine.map((r) => r.site.path)])]
  const known = new Set(files)
  const byLocal = new Map(syms.map((s) => [s.local_id, s]))
  const localName = (s: Sym) => s.qualified_name.slice(s.qualified_name.indexOf(':') + 1)
  const byName = new Map<string, Sym[]>(), moduleSyms = new Map<string, Sym[]>()
  for (const s of syms) { group(byName, localName(s), s); if (s.kind === 'module') group(moduleSyms, s.path, s) }

  // Includes: a quoted path relative to the including file is fixed by that path; otherwise every file whose path ends with it.
  // Files by their base name, so an include costs the files of its name and not the repository's.
  const byBase = new Map<string, string[]>()
  for (const f of [...files].sort()) { const list = byBase.get(path.posix.basename(f)); if (list) list.push(f); else byBase.set(path.posix.basename(f), [f]) }
  const bySuffix = (written: string) => { const tail = written.replace(/^(\.\.?\/)+/, ''); return (byBase.get(path.posix.basename(tail)) ?? []).filter((f) => f === tail || f.endsWith(`/${tail}`)) }
  const includes = new Map<string, string[]>(), includers = new Map<string, Set<string>>()
  const resolvedInclude = new Map<Rel, { path: string } | { found: string[] }>()
  for (const r of mine) {
    const written = r.type === 'imports' ? r.detail?.module : undefined
    if (!written) continue
    const relative = r.detail?.system !== 'true' ? path.posix.normalize(path.posix.join(path.posix.dirname(r.site.path), written)) : undefined
    const found = relative && known.has(relative) ? [relative] : bySuffix(written)
    if (!found.length) continue
    resolvedInclude.set(r, relative && known.has(relative) ? { path: relative } : { found })
    includes.set(r.site.path, [...(includes.get(r.site.path) ?? []), ...found])
    for (const f of found) includers.set(f, (includers.get(f) ?? new Set()).add(r.site.path))
  }
  /** Every file a file includes, directly or through other headers; kept for the files last asked, as a file's calls come together. */
  const closure = new Map<string, Set<string>>()
  const reach = (file: string) => {
    let seen = closure.get(file)
    if (seen) return seen
    seen = new Set()
    for (const queue = [...(includes.get(file) ?? [])]; queue.length;) { const f = queue.pop()!; if (seen.has(f) || f === file) continue; seen.add(f); queue.push(...(includes.get(f) ?? [])) }
    closure.set(file, seen)
    if (closure.size > 32) closure.delete(closure.keys().next().value!)
    return seen
  }

  const head = (s: Sym) => {
    const b = m.read(s.path)
    if (!b) return ''
    const before = b.subarray(Math.max(0, s.start - 256), s.start).toString('utf8')
    // The declaration's own specifiers: what follows the end of the statement or block before it, past a preprocessor line.
    return before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('}'), before.lastIndexOf('{'), before.lastIndexOf('\n#')) + 1)
  }
  const isStatic = (s: Sym) => /\bstatic\b/.test(head(s))
  /** A function's symbol spans its declarator: it is a definition when a body follows it before any `;`. */
  const defined = new Map<Sym, boolean>()
  const defines = (s: Sym) => {
    let d = defined.get(s)
    if (d === undefined) { const b = m.read(s.path), brace = b ? b.indexOf('{', s.end) : -1, semi = b ? b.indexOf(';', s.end) : -1; defined.set(s, (d = brace >= 0 && (semi < 0 || brace < semi))) }
    return d
  }
  const opens = new Map<string, boolean>()
  /** Whether a header opens a namespace of that name. */
  const opensNamespace = (h: string, ns: string) => {
    const k = `${h}\u0000${ns}`
    if (!opens.has(k)) opens.set(k, new RegExp(`\\bnamespace\\s+${ns.replace(/\W/g, '')}\\b`).test(m.read(h)?.toString('utf8') ?? ''))
    return opens.get(k)!
  }
  /** A file's own definitions of a name, or its types of that name. */
  const ownOf = (file: string, name: string) => (byName.get(name) ?? []).filter((s) => s.path === file && (FUNCTION.has(s.kind) ? defines(s) : TYPES.has(s.kind)))
  /** The definitions behind a declaration of a header: in the header itself, and in a file that includes it, where not `static`. */
  const definitionsOf = (decl: Sym): Sym[] => (byName.get(localName(decl)) ?? []).filter((s) => FUNCTION.has(s.kind) && defines(s) && (s.path === decl.path || (!isStatic(s) && includers.get(decl.path)?.has(s.path))))
  const order = (list: Sym[]) => [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start))
  /** The definitions of the declarations of a name in the headers a file reaches; a type binds as itself. */
  const throughHeaders = (from: string, name: string, keep: (h: string) => boolean = () => true): Sym[] => {
    const reached = reach(from)
    const decls = (byName.get(name) ?? []).filter((s) => reached.has(s.path) && HEADER.test(s.path) && keep(s.path))
    return order([...new Set(decls.flatMap((d) => (TYPES.has(d.kind) ? [d] : FUNCTION.has(d.kind) ? definitionsOf(d) : [])))])
  }

  for (const rel of mine) {
    const file = rel.site.path
    if (rel.type === 'imports') {
      const inc = resolvedInclude.get(rel)
      if (!inc) continue
      // A quoted include of a path relative to its file names that file; one found by the end of its path may name several. Both are
      // candidates of the files' module symbols, as a Go import path is (FR177): the syntax tier gives no observed row (FR215).
      const modules = ('path' in inc ? [inc.path] : inc.found).flatMap((f) => moduleSyms.get(f) ?? [])
      if (modules.length) out.set(rel, bind(rel, modules, 'path' in inc ? 'c_include_path' : 'c_include_name'))
      continue
    }
    if (rel.type !== 'calls') continue
    const callee = rel.detail?.callee, site = rel.source.symbol ? byLocal.get(rel.source.symbol) : undefined
    const b = m.read(file)
    if (!callee || !site || !b) continue
    const form = callForm(b.subarray(rel.site.range.start_byte, rel.site.range.end_byte).toString('utf8'), callee)
    if (!form || form.form === 'member') continue
    if (form.form === 'path') {
      // `T::f()`: a member of a class the file sees; `ns::f()`: a function of a header that opens that namespace.
      const owner = form.before.split('::').map((s) => s.trim()).filter(Boolean).at(-1)
      if (!owner) continue
      const classes = [...ownOf(file, owner), ...throughHeaders(file, owner)].filter((s) => TYPES.has(s.kind))
      const members = classes.length ? order([...new Set([...ownOf(file, `${owner}.${callee}`), ...throughHeaders(file, `${owner}.${callee}`)])]) : []
      if (members.length) { out.set(rel, bind(rel, members, 'cpp_class_member')); continue }
      if (classes.length) continue
      const found = throughHeaders(file, callee, (h) => opensNamespace(h, owner)).filter((s) => FUNCTION.has(s.kind))
      if (found.length) out.set(rel, bind(rel, found, 'cpp_namespace'))
      continue
    }
    // A bare name: in a C++ method, a member of its class first; then this file's own function, static or not; then what the headers declare.
    const cls = localName(site).includes('.') ? localName(site).slice(0, localName(site).lastIndexOf('.')) : undefined
    if (cls && /\.(cc|cpp|cxx|hpp|hh|hxx)$/.test(file)) {
      const members = order([...new Set([...ownOf(file, `${cls}.${callee}`), ...throughHeaders(file, `${cls}.${callee}`)])]).filter((s) => FUNCTION.has(s.kind))
      if (members.length) { out.set(rel, bind(rel, members, 'cpp_same_class')); continue }
      // A class that declares the name hides every function outside it, also when the repository holds no body for its member.
      if ((byName.get(`${cls}.${callee}`) ?? []).some((s) => FUNCTION.has(s.kind) && (s.path === file || reach(file).has(s.path)))) continue
    }
    const own = ownOf(file, callee)
    if (own.length) { out.set(rel, bind(rel, order(own), 'c_same_file')); continue }
    const found = throughHeaders(file, callee)
    if (found.length) out.set(rel, bind(rel, found, 'c_include'))
  }
  return out
}
