// Rust's rules for binding a name (FR750 to FR754): a module is a file (`a.rs` or `a/mod.rs`, its children beside it) or an inline
// `mod x { }`, and a crate is the files under one `lib.rs` or `main.rs`. A bare call binds a function of its own module, else one a `use`
// names, else one a glob `use` brings; a path call follows `crate::`, `self::`, `super::`, a child module, a name a `use` brought, or
// another crate of the repository the caller's crate declares a dependency on, to a function or to an associated function of a type;
// `Self::f()` and `self.f()` bind the methods of the impl's own type. Only `pub` items cross modules, `pub(crate)` stays in its crate,
// and a private item is seen from its module and the modules inside it. A call on any other receiver binds to nothing.
import path from 'node:path'
import { bind, callForm, group, undeclared, unresolved, type Model, type Project, type Rel, type Sym } from './common.js'

const join = (dir: string, name: string) => (dir === '.' || dir === '' ? name : `${dir}/${name}`)

/** A crate root Cargo builds by its place: `lib.rs`, `main.rs`, and each file of `src/bin/`, `tests/`, `examples/` and `benches/`. */
const CRATE_ROOT = /(^|\/)(lib|main)\.rs$|(^|\/)(src\/bin|tests|examples|benches)\/[^/]+\.rs$/

/** Rust modules by file: a crate root and `mod.rs` hold their children beside them, `a.rs` in `a/`. Shared with the FFI seams (FR465). */
export function rustModules(files: Set<string>) {
  const childrenOf = (f: string) => (CRATE_ROOT.test(f) || /(^|\/)mod\.rs$/.test(f) ? path.posix.dirname(f) : f.slice(0, -'.rs'.length))
  const firstFile = (...candidates: string[]) => candidates.find((c) => files.has(c))
  // A crate root is its own crate, so `src/main.rs` beside `src/lib.rs` is the binary's; another file belongs to the nearest root above it.
  const crateRoot = (f: string) => { if (CRATE_ROOT.test(f)) return f; for (let d = path.posix.dirname(f); ; d = path.posix.dirname(d)) { const root = firstFile(join(d, 'lib.rs'), join(d, 'main.rs')); if (root || d === '.') return root } }
  /** The file of the module a path names from a file: `ffi`, `self::ffi`, `super::ffi`, `crate::sys::ffi`; none for a path through a type or a crate outside the repository. */
  const moduleFile = (from: string, qualifier: string): string | undefined => {
    let cur: string | undefined = from
    for (const [i, seg] of qualifier.split('::').entries()) {
      if (!cur) return undefined
      if (seg === 'crate' && i === 0) cur = crateRoot(from)
      else if (seg === 'self' && i === 0) continue
      else if (seg === 'super') { const dir = path.posix.dirname(childrenOf(cur)); cur = firstFile(`${dir}.rs`, join(dir, 'mod.rs'), join(dir, 'lib.rs'), join(dir, 'main.rs')) }
      else { const dir = join(childrenOf(cur), seg); cur = firstFile(`${dir}.rs`, join(dir, 'mod.rs')) }
    }
    return cur
  }
  return { childrenOf, crateRoot, moduleFile }
}

type Scope = { file: string; inline: string }
/** A `use` inside a function body is `local`: it names something for that body only, so no other call of the module is bound through it. */
type Use = { scope: Scope; segs: string[]; name: string; glob: boolean; local: boolean; rel: Rel }
/** Where a path leads: a module, a type, a module of a crate the caller does not declare, or nowhere the rules can say. */
type Place = { module: Scope } | { type: Sym } | { undeclared: Project } | undefined
type Vis = 'pub' | 'crate' | 'private'

const TYPES = new Set(['class', 'interface', 'enum', 'type_alias'])

export function resolveRust(m: Model, rels: Rel[]): Map<Rel, Rel> {
  const out = new Map<Rel, Rel>()
  const mine = rels.filter((r) => r.site.path.endsWith('.rs'))
  if (!mine.length) return out
  const syms = m.symbols.filter((s) => s.path.endsWith('.rs'))
  const files = new Set([...syms.map((s) => s.path), ...mine.map((r) => r.site.path)])
  const { childrenOf, crateRoot, moduleFile } = rustModules(files)
  const byLocal = new Map(syms.map((s) => [s.local_id, s]))
  const text = (f: string, from: number, to: number) => m.read(f)?.subarray(from, to).toString('utf8') ?? ''
  const localName = (s: Sym) => s.qualified_name.slice(s.qualified_name.indexOf(':') + 1)

  // Inline modules, `mod x { }`, by file: their local name and range. A `mod x;` declaration is a namespace too, with no body.
  // Each file's symbols by their own name, so a lookup costs the name's declarations and not the file's.
  const named = new Map<string, Sym[]>(), inlines = new Map<string, Sym[]>(), moduleSyms = new Map<string, Sym[]>(), bodies = new Map<string, Sym[]>()
  for (const s of syms) {
    group(named, `${s.path}\u0000${s.name}`, s)
    if (s.kind === 'module') group(moduleSyms, s.path, s)
    if (s.kind === 'function' || s.kind === 'method') group(bodies, s.path, s)
    if (s.kind === 'namespace' && text(s.path, s.start, s.end).includes('{')) group(inlines, s.path, s)
  }
  const inFileNamed = (file: string, name: string) => named.get(`${file}\u0000${name}`) ?? []
  /** The inline module around a byte of a file, by its local name; '' for the file's own module. */
  const inlineAt = (file: string, byte: number) => (inlines.get(file) ?? []).filter((n) => n.start <= byte && byte < n.end).sort((a, b) => b.start - a.start).map(localName)[0] ?? ''
  const scopeOf = (s: Sym): Scope => ({ file: s.path, inline: inlineAt(s.path, s.start) })
  const prefix = (sc: Scope) => (sc.inline ? `${sc.inline}.` : '')
  /** The items a module declares by name: functions (an inline module's are named under it), or types. */
  const itemsIn = (sc: Scope, name: string, kinds: 'fn' | 'type'): Sym[] => inFileNamed(sc.file, name).filter((s) =>
    localName(s) === `${prefix(sc)}${name}` && (kinds === 'type' ? TYPES.has(s.kind) : s.kind === 'function' || (!!sc.inline && s.kind === 'method')) && scopeOf(s).inline === sc.inline)
  /** A type of a file by its local name: `Widget`, or `tests.Widget` in an inline module. */
  const typeNamed = (file: string, local: string) => inFileNamed(file, local.slice(local.lastIndexOf('.') + 1)).find((t) => TYPES.has(t.kind) && localName(t) === local)
  /** The methods and associated functions of a type, from the impl blocks of its own file, trait impls included. */
  const methodsOf = (t: Sym, name: string): Sym[] => {
    const owner = localName(t)
    return inFileNamed(t.path, name).filter((s) => s.kind === 'method' && (localName(s) === `${owner}.${name}` || localName(s).startsWith(`${owner}.<`)))
  }

  const vis = new Map<Sym, Vis>()
  const visibilityOf = (s: Sym): Vis => {
    let v = vis.get(s)
    if (!v) {
      const head = /^\s*pub\b\s*(\(\s*([^)]*)\))?/.exec(text(s.path, s.start, s.start + 256))
      // A trait's items and the methods of a trait impl are as visible as the trait, and say no `pub` of their own.
      const ofTrait = /\.<[^>]*>\./.test(localName(s)) || (s.kind === 'method' && typeNamed(s.path, localName(s).replace(/\.[^.]+$/, ''))?.kind === 'interface')
      v = head ? (!head[1] ? 'pub' : head[2]!.trim() === 'self' ? 'private' : 'crate') : ofTrait ? 'pub' : 'private'
      vis.set(s, v)
    }
    return v
  }
  /** Rust privacy: `pub` reaches everywhere, `pub(crate)` its crate, a private item its own module and the modules inside it. */
  const visible = (s: Sym, from: Scope): boolean => {
    const v = visibilityOf(s)
    if (v === 'pub') return true
    if (crateRoot(s.path) !== crateRoot(from.file)) return false
    if (v === 'crate') return true
    const own = scopeOf(s)
    if (own.file === from.file) return from.inline === own.inline || from.inline.startsWith(`${prefix(own)}`)
    return !own.inline && from.file.startsWith(`${childrenOf(own.file)}/`)
  }

  // The library crates of the repository by the name code uses for them, and the module each file is in.
  const crates = new Map<string, { project: Project; root: string }>()
  for (const f of files) {
    const p = m.projectOf(f, ['cargo']), root = p && [join(p.dir, 'src/lib.rs')].find((r) => files.has(r))
    if (p && root) crates.set(p.name.replace(/-/g, '_'), { project: p, root })
  }

  // The `use` declarations of each module: a path to a name (its alias, or its last segment), or a glob.
  const uses = new Map<string, Use[]>()
  const key = (sc: Scope) => `${sc.file}\u0000${sc.inline}`
  const isModDecl = (r: Rel) => /^\s*(pub\b\s*(\([^)]*\))?\s*)?mod\b/.test(text(r.site.path, r.site.range.start_byte, r.site.range.end_byte))
  for (const r of mine) {
    if (r.type !== 'imports' || !r.detail?.module || isModDecl(r)) continue
    const scope = { file: r.site.path, inline: inlineAt(r.site.path, r.site.range.start_byte) }
    const local = (bodies.get(r.site.path) ?? []).some((f) => f.start <= r.site.range.start_byte && r.site.range.start_byte < f.end)
    const base = r.detail.module.split('::').filter(Boolean)
    const entries = r.detail.names ? r.detail.names.split(',').map((e) => e.trim()).filter(Boolean) : [null]
    for (const e of entries) {
      const [written, alias] = e ? e.split(/\s+as\s+/) : [undefined, r.detail.alias]
      const segs = written ? (written === 'self' ? base : [...base, ...written.split('::')]) : base
      const glob = segs.at(-1) === '*'
      const u: Use = { scope, segs: glob ? segs.slice(0, -1) : segs, name: alias ?? (written === 'self' ? base.at(-1)! : segs.at(-1)!), glob, local, rel: r }
      uses.set(key(scope), [...(uses.get(key(scope)) ?? []), u])
    }
  }

  /** Where a path leads from a module. A `use` name is followed once, so a path never loops through its own declarations. */
  const follow = (from: Scope, segs: string[], viaUse = false): Place => {
    const [first, ...rest] = segs
    if (!first) return { module: from }
    let place: Place
    if (first === 'crate') { const root = crateRoot(from.file); place = root ? { module: { file: root, inline: '' } } : undefined }
    else if (first === 'self') place = { module: from }
    else if (first === 'super') {
      if (from.inline) place = { module: { file: from.file, inline: from.inline.split('.').slice(0, -1).join('.') } }
      else { const f = moduleFile(from.file, 'super'); place = f ? { module: { file: f, inline: '' } } : undefined }
    } else {
      const used = viaUse ? undefined : (uses.get(key(from)) ?? []).find((u) => !u.glob && !u.local && u.name === first)
      if (used) return follow(from, [...used.segs, ...rest], true)
      // A child module, its own or one a glob `use` brings (`config::load()` under `use super::*`), then a type. A glob is read only
      // from the path as written, never while following a `use`, so `use a::*;` with no module `a` cannot loop through itself.
      place = child(from, first) ?? (viaUse ? [] : uses.get(key(from)) ?? []).filter((u) => u.glob && !u.local).map((u) => { const p = follow(u.scope, u.segs, true); return p && 'module' in p ? child(p.module, first) : undefined }).find(Boolean)
      place ??= typeIn(from, first)
      // A name the module declares with `mod` is no crate's, whether or not its file is found.
      if (!place && !inFileNamed(from.file, first).some((n) => n.kind === 'namespace')) {
        const c = crates.get(first), here = m.projectOf(from.file, ['cargo'])
        if (c && c.root !== crateRoot(from.file)) place = m.sees(here, c.project, from.file) ? { module: { file: c.root, inline: '' } } : m.declares(here, first) ? undefined : { undeclared: c.project }
      }
    }
    for (const seg of rest) {
      // Past a type or a crate the caller does not declare, a path leads nowhere further the rules can follow.
      if (!place || !('module' in place)) return place && 'undeclared' in place ? place : undefined
      place = seg === 'self' ? place : seg === 'super' ? follow(place.module, ['super'], true) : child(place.module, seg) ?? typeIn(place.module, seg)
    }
    return place
  }
  const typeIn = (sc: Scope, name: string): Place => { const t = itemsIn(sc, name, 'type'); return t.length === 1 ? { type: t[0]! } : undefined }
  /** A child module of a module: an inline `mod x { }` in its file, else the file of `mod x;`. */
  const child = (sc: Scope, name: string): Place => {
    const inline = `${prefix(sc)}${name}`
    if ((inlines.get(sc.file) ?? []).some((n) => localName(n) === inline)) return { module: { file: sc.file, inline } }
    if (sc.inline) return undefined
    const f = moduleFile(sc.file, name)
    return f && f !== sc.file ? { module: { file: f, inline: '' } } : undefined
  }
  type At = { found: Sym[] } | { hidden: Sym[] } | { undeclared: Project } | undefined
  /** The functions (or types) a path names, visible from a module, or why there are none. */
  const itemAt = (from: Scope, segs: string[], name: string, kind: 'fn' | 'type' = 'fn'): At => {
    const place = follow(from, segs)
    if (!place) return undefined
    if ('undeclared' in place) return place
    const all = 'module' in place ? itemsIn(place.module, name, kind) : kind === 'fn' ? methodsOf(place.type, name) : []
    const found = all.filter((s) => visible(s, from))
    return found.length ? { found } : all.length ? { hidden: all } : undefined
  }
  /** A bare name: the module's own item, else the one a `use` names, else the ones glob `use`s bring (a glob never hides an item). */
  const lookup = (scope: Scope, name: string, kind: 'fn' | 'type'): { at: At; rule: string } | undefined => {
    const own = itemsIn(scope, name, kind)
    if (own.length) return { at: { found: own }, rule: 'rust_same_module' }
    const used = (uses.get(key(scope)) ?? []).find((u) => !u.glob && !u.local && u.name === name)
    if (used) return { at: itemAt(used.scope, used.segs.slice(0, -1), used.segs.at(-1)!, kind), rule: 'rust_use' }
    const found = (uses.get(key(scope)) ?? []).filter((u) => u.glob && !u.local).flatMap((u) => { const g = itemAt(u.scope, u.segs, name, kind); return g && 'found' in g ? g.found : [] })
    return found.length ? { at: { found }, rule: 'rust_glob_use' } : undefined
  }
  /** The type the methods of a site belong to: `Widget` of `Widget.new` and of `Widget.<Trait>.draw`. */
  const selfType = (site: Sym | undefined): Sym | undefined => {
    if (!site || site.kind !== 'method') return undefined
    const owner = localName(site).replace(/\.<[^>]*>\.[^.]+$|\.[^.]+$/, '')
    return typeNamed(site.path, owner)
  }

  for (const rel of mine) {
    const file = rel.site.path
    if (rel.type === 'imports') {
      const name = rel.detail?.module
      if (!name) continue
      if (isModDecl(rel)) {
        // `mod x;` names its file by the layout of the crate. It is a candidate of that file's module symbol, as a Go import path is
        // (FR177): the syntax tier gives no observed row (FR215), and a `#[path]` attribute or a build script can still move the file.
        const f = inlineAt(file, rel.site.range.start_byte) ? undefined : moduleFile(file, name)
        const modules = f && f !== file ? moduleSyms.get(f) ?? [] : []
        if (modules.length) out.set(rel, bind(rel, modules, 'rust_mod_file'))
        continue
      }
      const targets: Sym[] = []
      let missing: Project | undefined, hidden: Sym | undefined
      for (const u of uses.get(key({ file, inline: inlineAt(file, rel.site.range.start_byte) })) ?? []) {
        if (u.rel !== rel) continue
        const place = follow(u.scope, u.segs, true)
        if (place && 'undeclared' in place) { missing = place.undeclared; continue }
        if (u.glob || (place && 'module' in place)) {
          if (place && 'module' in place && !place.module.inline) targets.push(...moduleSyms.get(place.module.file) ?? [])
          continue
        }
        if (place && 'type' in place) { targets.push(place.type); continue }
        const at = itemAt(u.scope, u.segs.slice(0, -1), u.segs.at(-1)!)
        if (at && 'found' in at) targets.push(...at.found)
        else if (at && 'hidden' in at) hidden = at.hidden[0]
        else if (at && 'undeclared' in at) missing = at.undeclared
      }
      if (targets.length) out.set(rel, bind(rel, targets, 'rust_use'))
      else if (missing) out.set(rel, undeclared(rel, [missing]))
      else if (hidden) out.set(rel, unresolved(rel, 'unknown_name', { visibility: visibilityOf(hidden) }))
      continue
    }
    const settle = (at: At, rule: string) => {
      if (!at) return
      if ('found' in at) out.set(rel, bind(rel, at.found, rule))
      else if ('hidden' in at) out.set(rel, unresolved(rel, 'unknown_name', { visibility: visibilityOf(at.hidden[0]!) }))
      else out.set(rel, undeclared(rel, [at.undeclared]))
    }
    const site = rel.source.symbol ? byLocal.get(rel.source.symbol) : undefined
    if (rel.type === 'inherits' || rel.type === 'implements') {
      // A trait an impl names, or a supertrait: a type, by the rules that name a function (FR175: never a function).
      const segs = rel.detail?.name?.replace(/<[\s\S]*$/, '').split('::').map((x) => x.trim()) ?? []
      if (!site || !segs.length || !segs.at(-1)) continue
      const scope = scopeOf(site)
      if (segs.length === 1) { const l = lookup(scope, segs[0]!, 'type'); if (l) settle(l.at, l.rule) }
      else settle(itemAt(scope, segs.slice(0, -1), segs.at(-1)!, 'type'), 'rust_path')
      continue
    }
    if (rel.type !== 'calls') continue
    const callee = rel.detail?.callee
    if (!callee || !site) continue
    const form = callForm(text(file, rel.site.range.start_byte, rel.site.range.end_byte), callee)
    if (!form) continue
    const scope = scopeOf(site)
    if (form.form === 'member') {
      // `self.f()` is a method of the impl's own type; any other receiver has a type the tier cannot know (FR173's review 4 holds here too).
      const t = form.before === 'self' ? selfType(site) : undefined, found = t ? methodsOf(t, callee) : []
      if (found.length) out.set(rel, bind(rel, found, 'rust_self'))
      continue
    }
    if (form.form === 'path') {
      const q = rel.detail?.qualifier ?? form.before
      if (q === 'Self') {
        const t = selfType(site), found = t ? methodsOf(t, callee) : []
        if (found.length) out.set(rel, bind(rel, found, 'rust_self'))
        continue
      }
      settle(itemAt(scope, q.split('::').map((x) => x.trim()), callee), 'rust_path')
      continue
    }
    const l = lookup(scope, callee, 'fn')
    if (l) settle(l.at, l.rule)
  }
  return out
}
