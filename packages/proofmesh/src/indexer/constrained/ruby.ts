// Ruby's rules for binding a name (FR887 to FR889). `require_relative` names a file by its path from the requiring file, `require` a
// file under a `lib/` directory (or the repository root) by the end of its path. A file sees the constants and methods of itself and of
// the files it requires, directly or through each other. A constant is looked up through the lexical nesting of modules and classes
// around the site, innermost first, then at the top level. `C.new` binds the class `C`; `C.f` and `C::f` the singleton methods of `C`
// (`def self.f`); a bare call or `self.f` the methods of the enclosing class or module, singleton or instance as the site is, then its
// superclass and the modules it includes; a bare call with no such method a top-level `def`. A file of a gem the requiring gem does
// not depend on is never a candidate. A call on any other receiver binds to nothing.
import path from 'node:path'
import { bind, group, undeclared, type Model, type Rel, type Sym } from './common.js'

const NAMESPACES = new Set(['class', 'namespace'])
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function resolveRuby(m: Model, rels: Rel[]): Map<Rel, Rel> {
  const out = new Map<Rel, Rel>()
  const mine = rels.filter((r) => r.site.path.endsWith('.rb'))
  if (!mine.length) return out
  const syms = m.symbols.filter((s) => s.path.endsWith('.rb'))
  const files = new Set([...syms.map((s) => s.path), ...mine.map((r) => r.site.path)])
  const byLocal = new Map(syms.map((s) => [s.local_id, s]))
  const text = (f: string, from: number, to: number) => m.read(f)?.subarray(from, to).toString('utf8') ?? ''
  const moduleSyms = new Map<string, Sym[]>(), nests = new Map<string, Sym[]>()
  for (const s of syms) {
    if (s.kind === 'module') group(moduleSyms, s.path, s)
    if (NAMESPACES.has(s.kind)) group(nests, s.path, s)
  }
  /** The modules and classes around a byte of a file, innermost first. */
  const around = (file: string, at: number, but?: Sym) => (nests.get(file) ?? []).filter((n) => n !== but && n.start <= at && at < n.end).sort((a, b) => b.start - a.start)
  // A constant's full path (`Shop.Cart`) from the nesting and its header as written: `class Shop::Cart` names it whole, which the
  // symbol's own name (`Cart`) does not say. A method is named under the innermost module or class around it.
  const paths = new Map<Sym, string>()
  const pathOf = (s: Sym): string => {
    let p = paths.get(s)
    if (p !== undefined) return p
    const outer = around(s.path, s.start, s)[0], prefix = outer ? `${pathOf(outer)}.` : ''
    const written = NAMESPACES.has(s.kind) ? /^(?:class|module)\s+((?:::)?[A-Z]\w*(?:::[A-Z]\w*)*)/.exec(text(s.path, s.start, s.start + 256))?.[1] : undefined
    p = written ? (written.startsWith('::') ? written.slice(2).replace(/::/g, '.') : `${prefix}${written.replace(/::/g, '.')}`) : `${prefix}${s.name}`
    paths.set(s, p)
    return p
  }
  const named = new Map<string, Sym[]>()
  for (const s of syms) if (s.kind !== 'module') group(named, pathOf(s), s)
  // shortcut: a method inside `class << self` reads as an instance method; reading that block would tell it apart.
  const singleton = new Map<Sym, boolean>()
  const isSingleton = (s: Sym) => { let v = singleton.get(s); if (v === undefined) singleton.set(s, (v = /^def\s+(self|[A-Z]\w*)\s*\./.test(text(s.path, s.start, s.start + 128)))); return v }

  // Requires: a file each `require_relative` or `require` names, and every file a file reaches through them.
  const gemOf = (f: string) => m.projectOf(f, ['gem'])
  const required = new Map<Rel, { files: string[]; rule: string }>(), requires = new Map<string, string[]>()
  for (const r of mine) {
    const written = r.type === 'imports' ? r.detail?.module : undefined
    if (!written) continue
    const relative = /^require_relative\b/.test(text(r.site.path, r.site.range.start_byte, r.site.range.end_byte).trimStart())
    const target = written.endsWith('.rb') ? written : `${written}.rb`
    const found = relative ? [path.posix.normalize(path.posix.join(path.posix.dirname(r.site.path), target))].filter((f) => files.has(f)) : [...files].filter((f) => f === target || f.endsWith(`/lib/${target}`) || f === `lib/${target}`).sort()
    if (!found.length) continue
    required.set(r, { files: found, rule: relative ? 'ruby_require_relative' : 'ruby_require' })
    // A file of a gem the requiring gem does not depend on is required but brings nothing into reach.
    const from = gemOf(r.site.path), seen = found.filter((f) => { const to = gemOf(f); return !from || !to || m.sees(from, to, r.site.path) })
    requires.set(r.site.path, [...(requires.get(r.site.path) ?? []), ...seen])
  }
  const reached = new Map<string, Set<string>>()
  const reach = (file: string) => {
    let seen = reached.get(file)
    if (seen) return seen
    seen = new Set([file])
    for (const queue = [...(requires.get(file) ?? [])]; queue.length;) { const f = queue.pop()!; if (!seen.has(f)) { seen.add(f); queue.push(...(requires.get(f) ?? [])) } }
    reached.set(file, seen)
    if (reached.size > 32) reached.delete(reached.keys().next().value!)
    return seen
  }

  /** The modules and classes of a constant path (`Shop.Cart`) that a file reaches. */
  const defined = (from: string, constant: string) => (named.get(constant) ?? []).filter((s) => NAMESPACES.has(s.kind) && reach(from).has(s.path))
  /** A constant as written (`Cart`, `Shop::Cart`, `::Cart`) from a byte of a file: through the lexical nesting there, innermost first, then the top level. */
  const resolveConst = (from: string, at: number, written: string): string | undefined => {
    const [first, ...rest] = written.replace(/^::/, '').split('::')
    let base: string | undefined
    if (!written.startsWith('::')) for (const n of around(from, at)) if (defined(from, `${pathOf(n)}.${first}`).length) { base = `${pathOf(n)}.${first}`; break }
    base ??= defined(from, first!).length ? first : undefined
    const full = base && [base, ...rest].join('.')
    return full && defined(from, full).length ? full : undefined
  }

  // Superclasses and included modules, from the heritage rows; one no rule finds makes a lookup through it incomplete.
  const supers = new Map<string, Array<{ path?: string; include: boolean }>>()
  for (const r of mine.filter((x) => x.type === 'inherits')) {
    const sub = r.source.symbol ? byLocal.get(r.source.symbol) : undefined, name = r.detail?.name
    if (!sub || !name) continue
    supers.set(pathOf(sub), [...(supers.get(pathOf(sub)) ?? []), { path: resolveConst(r.site.path, r.site.range.start_byte, name), include: r.detail?.relation === 'include' }])
  }
  /** The methods of a name a class or module (`''` for the top level) declares, singleton or instance, that a file reaches, else its ancestors'. */
  const methodsOf = (from: string, owner: string, name: string, single: boolean, seen = new Set<string>()): { found: Sym[]; inherited: boolean; complete: boolean } => {
    if (seen.has(owner)) return { found: [], inherited: false, complete: true }
    seen.add(owner)
    const own = (named.get(owner ? `${owner}.${name}` : name) ?? []).filter((s) => s.kind === 'method' && reach(from).has(s.path) && isSingleton(s) === single)
    if (own.length || !owner) return { found: own, inherited: false, complete: true }
    const r = { found: [] as Sym[], inherited: true, complete: true }
    // A singleton method is inherited from the superclass; an instance method from it and from the included modules too.
    for (const up of (supers.get(owner) ?? []).filter((u) => !single || !u.include)) {
      if (!up.path) { r.complete = false; continue }
      const x = methodsOf(from, up.path, name, single, seen)
      r.found.push(...x.found)
      r.complete &&= x.complete
    }
    return r
  }
  const ranked = (list: Sym[]) => [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start))

  for (const rel of mine) {
    const file = rel.site.path
    if (rel.type === 'imports') {
      const req = required.get(rel)
      if (!req) continue
      const from = gemOf(file), hidden = req.files.flatMap((f) => { const to = gemOf(f); return from && to && !m.sees(from, to, file) ? [to] : [] })
      const modules = req.files.flatMap((f) => moduleSyms.get(f) ?? [])
      if (hidden.length === req.files.length) out.set(rel, undeclared(rel, hidden))
      else if (modules.length) out.set(rel, bind(rel, modules, req.rule))
      continue
    }
    if (rel.type === 'inherits') {
      const name = rel.detail?.name, found = name ? resolveConst(file, rel.site.range.start_byte, name) : undefined
      const list = found ? defined(file, found).filter((s) => (rel.detail?.relation === 'include' ? s.kind === 'namespace' : s.kind === 'class')) : []
      if (list.length) out.set(rel, bind(rel, ranked(list), 'ruby_constant'))
      continue
    }
    const callee = rel.detail?.callee
    if (rel.type !== 'calls' || !callee) continue
    const written = text(file, rel.site.range.start_byte, rel.site.range.end_byte)
    const constant = new RegExp(`^((?:::)?[A-Z]\\w*(?:::[A-Z]\\w*)*)\\s*(?:\\.|::)\\s*${escape(callee)}(?![\\w?!=])`).exec(written)
    if (constant) {
      // `C.new` makes a `C`; `C.f` and `C::f` call a singleton method of `C`.
      const owner = resolveConst(file, rel.site.range.start_byte, constant[1]!)
      if (!owner) continue
      const found = callee === 'new' ? defined(file, owner).filter((s) => s.kind === 'class') : methodsOf(file, owner, callee, true).found
      if (found.length) out.set(rel, bind(rel, ranked(found), 'ruby_constant', { ambiguous: callee !== 'new' && !methodsOf(file, owner, callee, true).complete }))
      continue
    }
    const self = new RegExp(`^self\\s*\\.\\s*${escape(callee)}(?![\\w?!=])`).test(written)
    if (!self && !new RegExp(`^${escape(callee)}(?![\\w?!=]|\\s*(\\.|::))`).test(written)) continue
    // The class or module the site runs in, and whether `self` is it (in its body or a `def self.`) or an instance of it.
    const site = rel.source.symbol ? byLocal.get(rel.source.symbol) : undefined
    const ctx = !site ? undefined : site.kind === 'method' ? { owner: pathOf(site).split('.').slice(0, -1).join('.'), single: isSingleton(site) } : NAMESPACES.has(site.kind) ? { owner: pathOf(site), single: true } : site.kind === 'module' ? { owner: '', single: false } : undefined
    if (ctx?.owner) {
      const r = methodsOf(file, ctx.owner, callee, ctx.single)
      if (r.found.length) { out.set(rel, bind(rel, ranked(r.found), r.inherited ? 'ruby_inherited' : 'ruby_same_class', { ambiguous: !r.complete })); continue }
      if (!r.complete || self) continue
    }
    if (self) continue
    // A top-level `def` is a private method of every object, so a bare call anywhere reaches it.
    const top = methodsOf(file, '', callee, false).found
    if (top.length) out.set(rel, bind(rel, ranked(top), 'ruby_top_level'))
  }
  return out
}
