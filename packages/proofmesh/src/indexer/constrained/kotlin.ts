// Kotlin's rules for binding a name (FR880 to FR882): a call inside a class binds a member of an enclosing class first, its own or
// inherited; then a top-level function or class an explicit import names (by its alias too), else one of the same package, else one a
// star import brings. `T.f()` binds the members of the type `T` (its companion and object members included), `this.f()` the enclosing
// class's and `super.f()` its supertypes'. A private top-level declaration is seen only from its file, a private member only from its
// top-level class, an `internal` one only from its own module; a module's names are seen only from modules that declare a dependency
// on it. A call on any other receiver binds to nothing.
import { bind, callForm, group, undeclared, unresolved, type Model, type Project, type Rel, type Sym } from './common.js'

type File = { path: string; pkg: string; project?: Project; imports: Array<{ fqn: string; name: string; star: boolean }> }
type Vis = 'public' | 'internal' | 'protected' | 'private'
/** What a lookup found: the visible targets, and the ones it left out for visibility or for a module the file does not depend on. */
type Found = { found: Sym[]; rule: string; invisible: Sym[]; hidden: Project[] }

const TYPES = new Set(['class', 'interface', 'enum'])
const VISIBILITY = /^(public|internal|protected|private)$/
const MODIFIER = /^(public|internal|protected|private|open|override|abstract|final|data|sealed|inline|suspend|operator|infix|tailrec|external|const|lateinit|enum|annotation|inner|value|expect|actual|companion|vararg|noinline|crossinline)$/

/** The package a file declares, read past comments and file annotations. */
const packageOf = (head: string) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|@[\w.:]+(?:\([^)]*\))?)*package\s+([\w.]+)/.exec(head)?.[1] ?? ''

/** The modifiers a declaration starts with, read past comments and annotations. */
function modifiers(head: string): Set<string> {
  const out = new Set<string>()
  for (let t = head; ;) {
    t = t.replace(/^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|@[\w.:]+(\([^)]*\))?)+/, '')
    const word = /^[a-z]+/.exec(t)?.[0]
    if (!word || !MODIFIER.test(word)) return out
    out.add(word)
    t = t.slice(word.length)
  }
}

const CONTROL = /\b(if|for|while|catch|when|get|set|constructor|init)\s*$/
/** Whether a call at the end of a declaration's text runs inside a lambda or an anonymous object, whose receiver may supply the name, or
 * names a parameter or a local of the function (`render(1)` on `render: (Int) -> Unit`): either way the bare name is not the tier's to bind.
 * shortcut: a brace inside a string template's `${...}` is skipped with the string; a nested string in one can confuse the count. */
function lambdaOrLocal(text: string, name: string, isFunction: boolean): boolean {
  const code = text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (x) => ' '.repeat(x.length))
  if (!isFunction) { const body = code.indexOf('{'); return body >= 0 && openBlocks(code, body + 1).some((lambda) => lambda) }
  // The parameter list, then the body: a block, or an expression after `=`.
  const open = code.indexOf('(', Math.max(0, code.search(/\bfun\b/)))
  if (open < 0) return false
  let i = open
  for (let depth = 0; i < code.length; i++) { if (code[i] === '(') depth++; else if (code[i] === ')' && --depth === 0) break }
  const word = name.replace(/[^\p{L}\p{N}_]/gu, '')
  if (new RegExp(`(^|[(,\\s])${word}\\s*:`, 'u').test(code.slice(open + 1, i))) return true
  const body = /^[^{=]*?([{=])/.exec(code.slice(i + 1))
  if (!body) return false
  const start = i + 1 + body[0].length
  return new RegExp(`\\b(val|var)\\s+${word}\\b`, 'u').test(code.slice(start)) || openBlocks(code, start).some((lambda) => lambda)
}
/** The blocks still open at the end of the text, from a position: true for a lambda or an object body, false for a control block. */
function openBlocks(code: string, from: number): boolean[] {
  const open: boolean[] = []
  for (let i = from; i < code.length; i++) {
    if (code[i] === '}') open.pop()
    if (code[i] !== '{') continue
    const before = code.slice(Math.max(0, i - 200), i).trimEnd()
    let control = /(\belse|\btry|\bfinally|\bdo|->|\bwhen|\binit)$/.test(before)
    if (!control && before.endsWith(')')) {
      let j = before.length - 1
      for (let depth = 0; j >= 0; j--) { if (before[j] === ')') depth++; else if (before[j] === '(' && --depth === 0) break }
      control = CONTROL.test(before.slice(0, Math.max(j, 0)))
    }
    open.push(!control)
  }
  return open
}

/** How a call names its callee, a trailing lambda (`f { }`, `f(x) { }`) and a call without parentheses taken as a call. */
function kotlinForm(text: string, callee: string) {
  let t = text.trimEnd()
  if (t.endsWith('}')) {
    let i = t.length - 1
    for (let depth = 0; i >= 0; i--) { if (t[i] === '}') depth++; else if (t[i] === '{' && --depth === 0) break }
    t = t.slice(0, Math.max(i, 0)).trimEnd()
  }
  return callForm(t.endsWith(')') ? t : `${t}()`, callee)
}

export function resolveKotlin(m: Model, rels: Rel[]): Map<Rel, Rel> {
  const out = new Map<Rel, Rel>()
  const mine = rels.filter((r) => r.site.path.endsWith('.kt'))
  if (!mine.length) return out
  const syms = m.symbols.filter((s) => s.path.endsWith('.kt'))
  const byLocal = new Map(syms.map((s) => [s.local_id, s]))
  const files = new Map<string, File>()
  for (const path of new Set([...syms.map((s) => s.path), ...mine.map((r) => r.site.path)])) {
    const buf = m.read(path), project = m.projectOf(path, ['gradle', 'maven'])
    files.set(path, { path, pkg: buf ? packageOf(buf.subarray(0, 4096).toString('utf8')) : '', ...(project ? { project } : {}), imports: [] })
  }
  for (const r of mine) {
    const fqn = r.type === 'imports' ? r.detail?.module : undefined
    if (fqn) files.get(r.site.path)?.imports.push({ fqn: fqn.replace(/\.\*$/, ''), name: r.detail?.alias ?? fqn.split('.').at(-1)!, star: fqn.endsWith('.*') })
  }

  // Containment by range: a class holds the functions and classes declared inside it.
  const inFile = new Map<string, Sym[]>()
  for (const s of syms) group(inFile, s.path, s)
  const container = new Map<Sym, Sym | undefined>()
  for (const list of inFile.values()) for (const s of list) container.set(s, list.filter((o) => o !== s && TYPES.has(o.kind) && o.start <= s.start && s.end <= o.end).sort((a, b) => b.start - a.start)[0])
  const topOf = (s: Sym): Sym => { let t = s; for (let c = container.get(t); c; c = container.get(t)) t = c; return t }
  // A declaration inside a function is local to it: never a member, never a top-level name.
  const local = new Set<Sym>()
  for (const list of inFile.values()) for (const s of list) if (list.some((o) => o !== s && o.kind === 'function' && o.start <= s.start && s.end <= o.end)) local.add(s)
  // Top-level declarations by package and name, and every declaration by its qualified name; members by their class.
  const topLevel = new Map<string, Sym[]>(), byFqn = new Map<string, Sym[]>(), membersOf = new Map<Sym, Sym[]>(), inPackage = new Map<string, Sym[]>()
  for (const s of syms) {
    if ((s.kind !== 'function' && !TYPES.has(s.kind)) || local.has(s)) continue
    const owner = container.get(s)
    if (owner) { if (s.kind === 'function') { const list = membersOf.get(owner); if (list) list.push(s); else membersOf.set(owner, [s]) } } else { group(topLevel, `${files.get(s.path)!.pkg}\u0000${s.name}`, s); group(inPackage, files.get(s.path)!.pkg, s) }
    group(byFqn, s.qualified_name, s)
  }

  const mods = new Map<Sym, Set<string>>()
  const modifiersOf = (s: Sym) => {
    let r = mods.get(s)
    if (!r) { const buf = m.read(s.path); r = buf ? modifiers(buf.subarray(s.start, Math.min(buf.length, s.start + 1024)).toString('utf8')) : new Set(); mods.set(s, r) }
    return r
  }
  const visibility = (s: Sym): Vis => ([...modifiersOf(s)].find((x) => VISIBILITY.test(x)) as Vis | undefined) ?? 'public'
  // A named companion object is a class symbol of its own; its members are the class's too. (An unnamed one's already are.)
  const companions = new Map<Sym, Sym[]>()
  for (const s of syms) { const owner = container.get(s); if (owner && s.kind === 'class' && !local.has(s) && modifiersOf(s).has('companion')) companions.set(owner, [...(companions.get(owner) ?? []), s]) }
  const projectOf = (s: Sym) => files.get(s.path)!.project
  /** Whether a declaration, and each class around it, may be named from a site: private within its file or top-level class, internal within its module. */
  const visible = (s: Sym, from: File, site: Sym | undefined, inherited = false): boolean => {
    for (let c: Sym | undefined = s; c; c = container.get(c)) {
      const v = visibility(c)
      if (v === 'internal' && projectOf(c) !== from.project) return false
      if (v === 'private' && (container.get(c) ? !site || topOf(site) !== topOf(c) || (c === s && inherited) : c.path !== from.path)) return false
      if (v === 'protected' && !inherited && (!site || topOf(site) !== topOf(c))) return false
    }
    return true
  }
  /** Sorts what a lookup met into the visible, the invisible and the ones of a module the file does not depend on. */
  const sort = (list: Sym[], from: File, site: Sym | undefined, rule: string, inherited = false): Found => {
    const r: Found = { found: [], rule, invisible: [], hidden: [] }
    for (const s of list) {
      if (!m.sees(from.project, projectOf(s), from.path)) { const p = projectOf(s); if (p) r.hidden.push(p) }
      else if (visible(s, from, site, inherited)) r.found.push(s)
      else r.invisible.push(s)
    }
    return r
  }
  /** A top-level name from a file: an explicit import, the same package, then a star import; the first level that holds one wins. */
  const lookup = (from: File, name: string, site: Sym | undefined, keep: (s: Sym) => boolean): Found => {
    const levels: Array<[string, Sym[]]> = [
      ['kotlin_import', from.imports.filter((i) => !i.star && i.name === name).flatMap((i) => byFqn.get(i.fqn) ?? []).filter((s) => !container.get(s) || TYPES.has(s.kind))],
      ['kotlin_same_package', topLevel.get(`${from.pkg}\u0000${name}`) ?? []],
      ['kotlin_star_import', from.imports.filter((i) => i.star).flatMap((i) => topLevel.get(`${i.fqn}\u0000${name}`) ?? [])],
    ]
    const missed: Found = { found: [], rule: '', invisible: [], hidden: [] }
    for (const [rule, list] of levels) {
      const r = sort(list.filter(keep), from, site, rule)
      if (r.found.length) return r
      missed.invisible.push(...r.invisible)
      missed.hidden.push(...r.hidden)
      if (rule === 'kotlin_import' && from.imports.some((i) => !i.star && i.name === name)) break
    }
    return missed
  }
  /** A type by name or qualified name. */
  const typeNamed = (from: File, name: string, site: Sym | undefined): Found =>
    name.includes('.') ? sort((byFqn.get(name) ?? []).filter((s) => TYPES.has(s.kind)), from, site, 'kotlin_qualified_name') : lookup(from, name, site, (s) => TYPES.has(s.kind))

  // Supertypes, from the heritage rows, named from their own file; one no rule finds makes a member lookup through it incomplete.
  const supers = new Map<Sym, { types: Sym[]; complete: boolean }>()
  for (const r of mine.filter((x) => x.type === 'inherits' || x.type === 'implements')) {
    const sub = r.source.symbol ? byLocal.get(r.source.symbol) : undefined, name = r.detail?.name?.replace(/<.*$/s, '')
    if (!sub || !name) continue
    const found = typeNamed(files.get(r.site.path)!, name, sub).found
    const entry = supers.get(sub) ?? { types: [], complete: true }
    entry.types.push(...found)
    if (found.length !== 1) entry.complete = false
    supers.set(sub, entry)
  }
  /** The member functions of a name a class declares or inherits, the ones the site may reach, and whether every supertype was known. */
  const methodsOf = (t: Sym, name: string, from: File, site: Sym | undefined, inherited: boolean, seen = new Set<Sym>()): { found: Sym[]; invisible: Sym[]; complete: boolean } => {
    if (seen.has(t)) return { found: [], invisible: [], complete: true }
    seen.add(t)
    const own = [t, ...(companions.get(t) ?? [])].flatMap((c) => membersOf.get(c) ?? []).filter((s) => s.name === name)
    const found = own.filter((s) => visible(s, from, site, inherited)), invisible = own.filter((s) => !found.includes(s))
    const up = supers.get(t)
    let complete = up?.complete ?? true
    // A class's own member hides an inherited one of the name.
    if (!found.length) for (const s of up?.types ?? []) { const r = methodsOf(s, name, from, site, true, seen); found.push(...r.found); invisible.push(...r.invisible); complete &&= r.complete }
    return { found, invisible, complete }
  }
  const memberRule = (t: Sym, found: Sym[], own: string) => (found.every((s) => container.get(s) === t || companions.get(t)?.includes(container.get(s)!)) ? own : 'kotlin_inherited')
  const ranked = (list: Sym[]) => [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start))
  /** The row for what a lookup found: bound, or unresolved for visibility or an undeclared module, or left as it came. */
  const settle = (rel: Rel, r: Found, ambiguous = false) => {
    if (r.found.length) out.set(rel, bind(rel, ranked(r.found), r.rule, { ambiguous }))
    else if (r.invisible.length) out.set(rel, unresolved(rel, 'unknown_name', { visibility: visibility(r.invisible[0]!) }))
    else if (r.hidden.length) out.set(rel, undeclared(rel, r.hidden))
  }

  for (const rel of mine) {
    const from = files.get(rel.site.path)!
    const site = rel.source.symbol ? byLocal.get(rel.source.symbol) : undefined
    if (rel.type === 'imports') {
      const fqn = rel.detail?.module
      if (!fqn) continue
      if (fqn.endsWith('.*')) {
        // A star import of a package only modules the file does not depend on hold.
        const all = inPackage.get(fqn.slice(0, -2)) ?? []
        const r = sort(all, from, site, '')
        if (all.length && r.hidden.length === all.length) out.set(rel, undeclared(rel, r.hidden))
        continue
      }
      settle(rel, sort(byFqn.get(fqn) ?? [], from, site, 'kotlin_import'))
      continue
    }
    if (rel.type === 'inherits' || rel.type === 'implements') {
      const name = rel.detail?.name?.replace(/<.*$/s, '')
      if (name) settle(rel, typeNamed(from, name, site))
      continue
    }
    const callee = rel.detail?.callee, b = m.read(from.path)
    if (rel.type !== 'calls' || !callee || !b) continue
    const form = kotlinForm(b.subarray(rel.site.range.start_byte, rel.site.range.end_byte).toString('utf8'), callee)
    if (!form) continue
    // The classes around the site, innermost first.
    const inside: Sym[] = []
    for (let t = site && (TYPES.has(site.kind) ? site : container.get(site)); t; t = container.get(t)) inside.push(t)
    const unknownScope = () => !!site && lambdaOrLocal(b.subarray(site.start, rel.site.range.start_byte).toString('utf8'), callee, site.kind === 'function')
    if (form.form === 'bare') {
      if (unknownScope()) continue
      // A member of an enclosing class, own or inherited, wins over a top-level name; past a supertype the repository does not hold, nothing is
      // bound. A class that is not `inner` sees only the companion members of the classes around it.
      let stop = false, instance = true
      for (const t of inside) {
        const r = instance ? methodsOf(t, callee, from, site, false) : { found: (companions.get(t) ?? []).flatMap((c) => methodsOf(c, callee, from, site, false).found), complete: true }
        if (r.found.length) { out.set(rel, bind(rel, ranked(r.found), memberRule(t, r.found, 'kotlin_same_class'), { ambiguous: !r.complete })); break }
        if (!r.complete) { stop = true; break }
        if (!modifiersOf(t).has('inner')) instance = false
      }
      if (out.has(rel) || stop) continue
      // A call of a class's name is its constructor.
      settle(rel, lookup(from, callee, site, (s) => s.kind === 'function' || s.kind === 'class'))
      continue
    }
    if (form.form !== 'member') continue
    const receiver = form.before
    if (receiver === 'this' || receiver === 'super') {
      const t = inside[0]
      if (!t || unknownScope()) continue
      const r = receiver === 'this' ? [methodsOf(t, callee, from, site, false)] : (supers.get(t)?.types ?? []).map((s) => methodsOf(s, callee, from, site, true))
      const found = r.flatMap((x) => x.found)
      if (found.length) out.set(rel, bind(rel, ranked(found), receiver === 'this' ? memberRule(t, found, 'kotlin_same_class') : 'kotlin_inherited', { ambiguous: r.some((x) => !x.complete) || (receiver === 'super' && !(supers.get(t)?.complete ?? true)) }))
      continue
    }
    // `T.f()` and `a.b.T.f()`: the members of a type; `a.b.f()`: a top-level function of a package. A receiver of any other kind is a
    // value whose type the tier cannot know, so it binds to nothing.
    // shortcut: a local value named like a type (`val Order = ...`) is read as the type; a scope check would tell them apart.
    if (!/^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(receiver)) continue
    if (inPackage.has(receiver) && !receiver.split('.').some((p) => /^\p{Lu}/u.test(p))) {
      settle(rel, sort(topLevel.get(`${receiver}\u0000${callee}`) ?? [], from, site, 'kotlin_qualified_name'))
      continue
    }
    if (!/^\p{Lu}/u.test(receiver.split('.').at(-1)!)) continue
    const type = typeNamed(from, receiver, site)
    if (!type.found.length) { settle(rel, type); continue }
    const r = type.found.map((t) => methodsOf(t, callee, from, site, false))
    const found = r.flatMap((x) => x.found)
    if (found.length) out.set(rel, bind(rel, ranked(found), type.rule, { ambiguous: r.some((x) => !x.complete) }))
    else { const invisible = r.flatMap((x) => x.invisible); if (invisible.length) out.set(rel, unresolved(rel, 'unknown_name', { visibility: visibility(invisible[0]!) })) }
  }
  return out
}
