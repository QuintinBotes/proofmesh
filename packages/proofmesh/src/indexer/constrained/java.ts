// Java's rules for binding a name (FR174, FR175): a simple type name is a type of the same file, else a single-type import (which
// hides a same-package type of that name), else a type of the same package, else a type of a wildcard import's package; a member
// is reachable by its modifier (private within the top-level class, package-private within the package, protected in the package or
// by inheritance, public); a variable in scope hides a type of the same name; a type name binds a type and a method name a method.
import { bind, undeclared, unresolved, type Model, type Project, type Rel, type Sym } from './common.js'

type Vis = 'public' | 'protected' | 'package' | 'private'
type File = { path: string; pkg: string; project?: Project; imports: Array<{ module: string; wildcard: boolean; static: boolean }> }
type Found = { types: Sym[]; rule: string; hidden: Project[] }
const TYPES = new Set(['class', 'interface', 'enum'])
const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'native', 'synchronized', 'transient', 'volatile', 'strictfp', 'default', 'sealed', 'non-sealed'])
const RANK = ['java_same_file', 'java_import', 'java_same_package', 'java_wildcard_import']

/** The modifiers a declaration starts with, read past comments and annotations. */
function leadingModifiers(head: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < head.length;) {
    if (/\s/.test(head[i]!)) i++
    else if (head.startsWith('//', i)) i = head.indexOf('\n', i) < 0 ? head.length : head.indexOf('\n', i)
    else if (head.startsWith('/*', i)) i = head.indexOf('*/', i + 2) < 0 ? head.length : head.indexOf('*/', i + 2) + 2
    else if (head[i] === '@' && !head.startsWith('@interface', i)) {
      i += 1 + (/^[\w.]*/.exec(head.slice(i + 1))?.[0].length ?? 0)
      while (/\s/.test(head[i] ?? '')) i++
      if (head[i] === '(') for (let depth = 0; i < head.length; i++) { if (head[i] === '(') depth++; else if (head[i] === ')' && --depth === 0) { i++; break } }
    } else {
      const word = /^[a-z]+(?:-[a-z]+)?/.exec(head.slice(i))?.[0]
      if (!word || !MODIFIERS.has(word)) break
      out.add(word)
      i += word.length
    }
  }
  return out
}

/** The package a compilation unit declares, read past comments and annotations. */
function packageOf(head: string): string {
  const m = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|@[\w.]+(?:\([^)]*\))?)*package\s+([\w.]+)\s*;/.exec(head)
  return m?.[1] ?? ''
}

export function resolveJava(m: Model, rels: Rel[]): Map<Rel, Rel> {
  const out = new Map<Rel, Rel>()
  const mine = rels.filter((r) => r.site.path.endsWith('.java'))
  if (!mine.length) return out
  const syms = m.symbols.filter((s) => s.path.endsWith('.java'))
  const byLocal = new Map(syms.map((s) => [s.local_id, s]))
  const files = new Map<string, File>()
  for (const path of new Set([...syms.map((s) => s.path), ...mine.map((r) => r.site.path)])) {
    const buf = m.read(path), project = m.projectOf(path, ['maven', 'gradle'])
    files.set(path, { path, pkg: buf ? packageOf(buf.subarray(0, 4096).toString('utf8')) : '', ...(project ? { project } : {}), imports: [] })
  }
  for (const r of mine) if (r.type === 'imports' && r.detail?.module) files.get(r.site.path)?.imports.push({ module: r.detail.module, wildcard: r.detail.module.endsWith('.*'), static: r.detail.static === 'true' })

  // Containment by range: a type holds the members and types declared inside it.
  const inFile = new Map<string, Sym[]>()
  for (const s of syms) inFile.set(s.path, [...(inFile.get(s.path) ?? []), s])
  const container = new Map<Sym, Sym | undefined>()
  for (const list of inFile.values()) for (const s of list) container.set(s, list.filter((o) => o !== s && TYPES.has(o.kind) && o.start <= s.start && s.end <= o.end).sort((a, b) => b.start - a.start)[0])
  const topOf = (s: Sym): Sym => { let t = s; for (let c = container.get(t); c; c = container.get(t)) t = c; return t }
  const types = syms.filter((s) => TYPES.has(s.kind))
  const byFqn = new Map<string, Sym[]>(), byPackage = new Map<string, Sym[]>()
  for (const t of types) {
    byFqn.set(t.qualified_name, [...(byFqn.get(t.qualified_name) ?? []), t])
    if (!container.get(t)) { const pkg = files.get(t.path)!.pkg; byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), t]) }
  }
  const membersOf = new Map<Sym, Sym[]>()
  for (const s of syms) if (s.kind === 'method' && container.get(s)) membersOf.set(container.get(s)!, [...(membersOf.get(container.get(s)!) ?? []), s])

  // Visibility: the modifier a declaration states, and what an interface or an enclosing public API makes of one it does not.
  const mods = new Map<Sym, Set<string>>()
  const modifiersOf = (s: Sym) => {
    let r = mods.get(s)
    if (!r) { const buf = m.read(s.path); r = buf ? leadingModifiers(buf.subarray(s.start, Math.min(buf.length, s.start + 1024)).toString('utf8')) : new Set(); mods.set(s, r) }
    return r
  }
  const visibility = (s: Sym): Vis => {
    const mm = modifiersOf(s)
    if (mm.has('private')) return 'private'
    if (mm.has('public')) return 'public'
    if (mm.has('protected')) return 'protected'
    return container.get(s)?.kind === 'interface' ? 'public' : 'package'
  }
  const pkgOf = (s: Sym) => files.get(s.path)!.pkg
  /** A type can be named from a file when it, and every type around it, is public or in the file's package. */
  const accessible = (t: Sym, from: File): boolean => {
    for (let c: Sym | undefined = t; c; c = container.get(c)) { const v = visibility(c); if (v === 'private' ? topOf(c) !== topOf(t) : v !== 'public' && pkgOf(c) !== from.pkg) return false }
    return true
  }
  const memberVisible = (s: Sym, from: File, site: Sym | undefined, inherited: boolean): boolean => {
    const v = visibility(s)
    if (v === 'public') return true
    if (v === 'private') return !!site && topOf(site) === topOf(s) && !inherited
    return pkgOf(s) === from.pkg || (v === 'protected' && inherited)
  }
  const sees = (from: File, t: Sym) => m.sees(from.project, files.get(t.path)!.project, from.path)

  /** The types a name may mean from a file, by the first rule that finds one; types only a module the file does not depend on holds are `hidden` (FR172). */
  const resolveType = (from: File, name: string): Found => {
    const hidden: Project[] = []
    const keep = (list: Sym[]) => {
      const visible = list.filter((t) => accessible(t, from))
      for (const t of visible) if (!sees(from, t)) { const p = files.get(t.path)!.project; if (p) hidden.push(p) }
      return visible.filter((t) => sees(from, t))
    }
    if (name.includes('.')) {
      const exact = keep(byFqn.get(name) ?? [])
      if (exact.length || hidden.length) return { types: exact, rule: 'java_qualified_name', hidden }
      const [head, ...rest] = name.split('.')
      let held = resolveType(from, head!)
      for (const part of rest) held = { ...held, types: held.types.flatMap((t) => types.filter((n) => container.get(n) === t && n.name === part && accessible(n, from))) }
      return held
    }
    const own = keep((inFile.get(from.path) ?? []).filter((t) => TYPES.has(t.kind) && t.name === name))
    if (own.length) return { types: own, rule: RANK[0]!, hidden }
    const named = from.imports.filter((i) => !i.wildcard && !i.static && i.module.split('.').at(-1) === name)
    const single = named.flatMap((i) => keep(byFqn.get(i.module) ?? []))
    if (single.length) return { types: single, rule: RANK[1]!, hidden }
    if (hidden.length) return { types: [], rule: RANK[1]!, hidden }
    // A single-type import of a name the repository does not declare (java.util.List) still hides the package's type of that name.
    if (named.length) return { types: [], rule: RANK[1]!, hidden }
    const samePackage = keep((byPackage.get(from.pkg) ?? []).filter((t) => t.name === name))
    if (samePackage.length) return { types: samePackage, rule: RANK[2]!, hidden }
    const wild = from.imports.filter((i) => i.wildcard && !i.static).flatMap((i) => keep((byPackage.get(i.module.slice(0, -2)) ?? []).filter((t) => t.name === name)))
    return { types: wild, rule: RANK[3]!, hidden }
  }

  // Supertypes, from the heritage rows, named from their own file; a supertype no rule finds makes a lookup through it incomplete.
  const supers = new Map<Sym, { types: Sym[]; complete: boolean }>()
  for (const r of mine.filter((x) => x.type === 'inherits' || x.type === 'implements')) {
    const sub = r.source.symbol ? byLocal.get(r.source.symbol) : undefined, name = r.detail?.name
    if (!sub || !name) continue
    const found = resolveType(files.get(r.site.path)!, name).types.filter((t) => (r.type === 'implements' ? t.kind === 'interface' : t.kind === 'class'))
    const entry = supers.get(sub) ?? { types: [], complete: true }
    entry.types.push(...found)
    if (found.length !== 1) entry.complete = false
    supers.set(sub, entry)
  }
  /** The methods of a name a type declares or inherits that the site may reach, and whether every supertype searched was known. */
  const methodsOf = (t: Sym, name: string, from: File, site: Sym | undefined, inherited: boolean, seen = new Set<Sym>()): { found: Sym[]; complete: boolean } => {
    if (seen.has(t)) return { found: [], complete: true }
    seen.add(t)
    // Overloads span the type and its supertypes, so the inherited methods of the name count beside the type's own.
    const found = (membersOf.get(t) ?? []).filter((s) => s.name === name && memberVisible(s, from, site, inherited))
    const up = supers.get(t)
    let complete = up?.complete ?? true
    for (const s of up?.types ?? []) { const r = methodsOf(s, name, from, site, true, seen); found.push(...r.found); complete &&= r.complete }
    return { found, complete }
  }
  const lexical = (site: Sym | undefined) => { const out: Sym[] = []; for (let t = site && (TYPES.has(site.kind) ? site : container.get(site)); t; t = container.get(t)) out.push(t); return out }
  const ranked = (list: Array<{ s: Sym; rank: number }>) => list.sort((a, b) => a.rank - b.rank || (a.s.path < b.s.path ? -1 : a.s.path > b.s.path ? 1 : a.s.start - b.s.start)).map((x) => x.s)

  for (const rel of mine) {
    const from = files.get(rel.site.path)!
    const site = rel.source.symbol ? byLocal.get(rel.source.symbol) : undefined
    if (rel.type === 'imports') {
      const module = rel.detail?.module
      if (!module) continue
      if (rel.detail?.static === 'true' && !module.endsWith('.*')) {
        const dot = module.lastIndexOf('.'), owner = byFqn.get(module.slice(0, dot))?.filter((t) => accessible(t, from) && sees(from, t)) ?? []
        const found = owner.flatMap((t) => (membersOf.get(t) ?? []).filter((s) => s.name === module.slice(dot + 1) && memberVisible(s, from, undefined, false)))
        if (found.length) out.set(rel, bind(rel, found, 'java_static_import'))
        continue
      }
      if (module.endsWith('.*')) {
        const pkgTypes = (byPackage.get(module.slice(0, -2)) ?? []).filter((t) => accessible(t, from))
        const hidden = pkgTypes.filter((t) => !sees(from, t)).flatMap((t) => files.get(t.path)!.project ?? [])
        if (pkgTypes.length && hidden.length === pkgTypes.length) out.set(rel, undeclared(rel, hidden))
        continue
      }
      const all = (byFqn.get(module) ?? []).filter((t) => accessible(t, from)), seen = all.filter((t) => sees(from, t))
      if (seen.length) out.set(rel, bind(rel, seen, 'java_import'))
      else if (all.length) out.set(rel, undeclared(rel, all.flatMap((t) => files.get(t.path)!.project ?? [])))
      continue
    }
    if (rel.type === 'inherits' || rel.type === 'implements') {
      const name = rel.detail?.name
      if (!name) continue
      const found = resolveType(from, name)
      const right = found.types.filter((t) => (rel.type === 'implements' ? t.kind === 'interface' : t.kind === 'class'))
      if (right.length) out.set(rel, bind(rel, right, found.rule))
      else if (!found.types.length && found.hidden.length) out.set(rel, undeclared(rel, found.hidden))
      continue
    }
    if (rel.type !== 'calls') continue
    const callee = rel.detail?.callee
    if (!callee) continue
    const qualifier = rel.detail?.qualifier, shadowed = rel.detail?.shadowed === 'local'
    // `new T()` binds a type, never a method of the same name (FR175).
    if (rel.detail?.form === 'new') {
      const found = resolveType(from, qualifier ? `${qualifier}.${callee}` : callee)
      const right = found.types.filter((t) => t.kind === 'class' || t.kind === 'interface')
      if (right.length) out.set(rel, bind(rel, right, found.rule))
      else if (!found.types.length && found.hidden.length) out.set(rel, undeclared(rel, found.hidden))
      continue
    }
    const inside = lexical(site)
    // A bare name or `this`: the innermost enclosing type that has a method of that name, its own or inherited, else a static import.
    // A supertype the repository does not hold may declare the name, and an inherited method hides a static import (JLS 15.12.1), so
    // an incomplete search binds to nothing past it, and what it finds is ambiguous.
    if (!qualifier || qualifier === 'this' || qualifier === 'super') {
      if (!qualifier || qualifier === 'this') {
        let incomplete = false
        for (const t of qualifier ? inside.slice(0, 1) : inside) {
          const r = methodsOf(t, callee, from, site, false)
          if (r.found.length) { out.set(rel, bind(rel, r.found, 'java_same_class', { ambiguous: !r.complete })); break }
          if (!r.complete) { incomplete = true; break }
        }
        if (out.has(rel) || qualifier || incomplete) continue
        const viaImport = from.imports.filter((i) => i.static).flatMap((i) => {
          const owner = i.wildcard ? i.module.slice(0, -2) : i.module.slice(0, i.module.lastIndexOf('.'))
          if (!i.wildcard && i.module.slice(owner.length + 1) !== callee) return []
          return (byFqn.get(owner) ?? []).filter((t) => accessible(t, from) && sees(from, t)).flatMap((t) => (membersOf.get(t) ?? []).filter((s) => s.name === callee && memberVisible(s, from, undefined, false)))
        })
        if (viaImport.length) out.set(rel, bind(rel, viaImport, 'java_static_import'))
      } else if (inside[0]) {
        const r = (supers.get(inside[0])?.types ?? []).map((t) => methodsOf(t, callee, from, site, true))
        const found = r.flatMap((x) => x.found)
        if (found.length) out.set(rel, bind(rel, found, 'java_inherited', { ambiguous: !(supers.get(inside[0])?.complete ?? true) || r.some((x) => !x.complete) }))
      }
      continue
    }
    // `T.m()`: a type, by the same rules that name it, then the methods of it that the site may reach. A variable of that name hides the
    // type, and a receiver of any other kind has a type the tier cannot know: both bind to nothing, for a method of that name on any type
    // the file sees would be a guess.
    if (shadowed || rel.detail?.receiver === 'expression') continue
    const named = resolveType(from, qualifier)
    if (named.types.length) {
      const r = named.types.map((t) => methodsOf(t, callee, from, site, false))
      const found = r.flatMap((x) => x.found)
      const inherited = found.length && named.types.every((t) => !(membersOf.get(t) ?? []).some((s) => found.includes(s)))
      if (found.length) out.set(rel, bind(rel, found, inherited ? 'java_inherited' : named.rule, { ambiguous: r.some((x) => !x.complete) }))
      else if (r.every((x) => x.complete)) out.set(rel, unresolved(rel, 'unknown_name', { type: named.types[0]!.qualified_name }))
    } else if (named.hidden.length) out.set(rel, undeclared(rel, named.hidden))
  }
  return out
}
