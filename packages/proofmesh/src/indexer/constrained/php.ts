// PHP's rules for binding a name (FR883 to FR886), case-insensitive as PHP's are. A class name written `\A\B` is that class; `A\B` and
// `B` take a `use` alias for their first part, else the namespace of the file. A function name takes a `use function` alias, else the
// namespace's function, else the global one, as PHP falls back at run time. When Composer's PSR-4 map places a class's file, only the
// class in that file is a candidate. `new T()` binds a class; `T::f()` the methods of `T` and its parents; `self::`, `static::` and
// `$this->` the enclosing class's and `parent::` its parent's; a private method only from its class, a protected one only from its
// class's line. A class of a Composer project the caller's project does not require is never a candidate. A call on any other
// receiver binds to nothing.
import path from 'node:path'
import { bind, callForm, group, undeclared, unresolved, type Model, type Project, type Rel, type Sym } from './common.js'

type Use = { kind: 'class' | 'function' | 'const'; fqn: string; alias: string }
type Found = { found: Sym[]; rule: string; hidden: Project[]; psr4?: boolean }
const TYPES = new Set(['class', 'interface', 'enum', 'trait'])
const key = (fqn: string) => fqn.replace(/^\\/, '').toLowerCase()
/** A symbol's qualified name, dotted by the tier, as PHP writes it. */
const fqnOf = (s: Sym) => s.qualified_name.replace(/\./g, '\\')

/** The `use` clauses of a statement as written: `use A\B as C;`, `use function A\f;`, `use A\{B, function c}`. */
function usesOf(statement: string): Use[] {
  const m = /^use\s+(?:(function|const)\s+)?([\s\S]*?);?\s*$/.exec(statement.trim())
  if (!m) return []
  const one = (clause: string, kind: Use['kind'], prefix = ''): Use[] => {
    const c = /^(?:(function|const)\s+)?\\?([\w\\]+)(?:\s+as\s+(\w+))?$/.exec(clause.trim())
    if (!c) return []
    const fqn = `${prefix}${c[2]!}`
    return [{ kind: (c[1] as Use['kind'] | undefined) ?? kind, fqn, alias: c[3] ?? fqn.split('\\').at(-1)! }]
  }
  const kind = (m[1] as Use['kind'] | undefined) ?? 'class'
  const group = /^\\?([\w\\]+?)\\?\{([\s\S]*)\}$/.exec(m[2]!.trim())
  if (group) return group[2]!.split(',').flatMap((c) => one(c, kind, `${group[1]!.replace(/\\$/, '')}\\`))
  return m[2]!.split(',').flatMap((c) => one(c, kind))
}

export function resolvePhp(m: Model, rels: Rel[]): Map<Rel, Rel> {
  const out = new Map<Rel, Rel>()
  const mine = rels.filter((r) => r.site.path.endsWith('.php'))
  if (!mine.length) return out
  const syms = m.symbols.filter((s) => s.path.endsWith('.php'))
  const byLocal = new Map(syms.map((s) => [s.local_id, s]))
  const text = (f: string, from: number, to: number) => m.read(f)?.subarray(from, to).toString('utf8') ?? ''

  // Containment by range: a class holds its methods. Classes and functions by their lower-cased qualified name.
  const inFile = new Map<string, Sym[]>()
  for (const s of syms) group(inFile, s.path, s)
  const container = new Map<Sym, Sym | undefined>()
  for (const list of inFile.values()) for (const s of list) container.set(s, list.filter((o) => o !== s && TYPES.has(o.kind) && o.start <= s.start && s.end <= o.end).sort((a, b) => b.start - a.start)[0])
  const classes = new Map<string, Sym[]>(), functions = new Map<string, Sym[]>(), membersOf = new Map<Sym, Sym[]>()
  for (const s of syms) {
    if (TYPES.has(s.kind)) group(classes, key(fqnOf(s)), s)
    else if (s.kind === 'function' || s.kind === 'method') { const owner = container.get(s); if (owner) { const list = membersOf.get(owner); if (list) list.push(s); else membersOf.set(owner, [s]) } else group(functions, key(fqnOf(s)), s) }
  }

  // Each file's namespaces, by where they start, and its `use` clauses.
  const namespaces = new Map<string, Array<{ at: number; name: string }>>(), uses = new Map<string, Use[]>()
  const nsAt = (file: string, byte: number) => {
    let list = namespaces.get(file)
    if (!list) { list = [...(m.read(file)?.toString('utf8') ?? '').matchAll(/(?:^|[;{}\s])namespace\s+([\w\\]+)\s*[;{]/g)].map((x) => ({ at: Buffer.byteLength(x.input!.slice(0, x.index)), name: x[1]! })); namespaces.set(file, list) }
    return list.filter((n) => n.at <= byte).at(-1)?.name ?? ''
  }
  for (const r of mine) if (r.type === 'imports') uses.set(r.site.path, [...(uses.get(r.site.path) ?? []), ...usesOf(text(r.site.path, r.site.range.start_byte, r.site.range.end_byte))])
  const useOf = (file: string, kind: Use['kind'], alias: string) => (uses.get(file) ?? []).filter((u) => u.kind === kind && u.alias.toLowerCase() === alias.toLowerCase())

  const projectOf = (file: string) => m.projectOf(file, ['composer'])
  /** A Composer project sees itself and the projects it requires; a file in no project, or a class in none, is not judged (FR172). */
  const sees = (from: string, s: Sym) => { const a = projectOf(from), b = projectOf(s.path); return !a || !b || m.sees(a, b, from) }
  /** The files Composer's PSR-4 map places a class in. */
  const psr4 = (fqn: string) => m.autoload.flatMap((a) => (key(fqn).startsWith(a.prefix.toLowerCase()) ? [path.posix.join(a.dir || '.', `${fqn.replace(/^\\/, '').slice(a.prefix.length).replace(/\\/g, '/')}.php`)] : []))
  /** The classes of a qualified name the file may reach: only the one PSR-4 places, when it places one; the others of a module the file does not depend on are `hidden`. */
  const classNamed = (from: string, fqn: string, rule: string): Found => {
    const all = classes.get(key(fqn)) ?? []
    const placed = new Set(psr4(fqn)), there = all.filter((s) => placed.has(s.path))
    const list = there.length ? there : all
    return { found: list.filter((s) => sees(from, s)), rule, hidden: list.filter((s) => !sees(from, s)).flatMap((s) => projectOf(s.path) ?? []), ...(there.length ? { psr4: true } : {}) }
  }
  /** A class name as written, from a file at a byte: fully qualified, through a `use` alias, or in the namespace. */
  const resolveClass = (from: string, at: number, written: string): Found => {
    if (written.startsWith('\\')) return classNamed(from, written.slice(1), 'php_fully_qualified')
    const [first, ...rest] = written.split('\\')
    const alias = useOf(from, 'class', first!)[0]
    if (alias) return classNamed(from, [alias.fqn, ...rest].join('\\'), 'php_use')
    const ns = nsAt(from, at)
    return classNamed(from, ns ? `${ns}\\${written}` : written, 'php_same_namespace')
  }
  const functionNamed = (from: string, fqn: string, rule: string): Found => {
    const all = functions.get(key(fqn)) ?? []
    return { found: all.filter((s) => sees(from, s)), rule, hidden: all.filter((s) => !sees(from, s)).flatMap((s) => projectOf(s.path) ?? []) }
  }
  /** A function name as written: fully qualified, through a `use function` (or a namespace alias), in the namespace, else global. */
  const resolveFunction = (from: string, at: number, written: string): Found => {
    const named = (fqn: string, rule: string) => functionNamed(from, fqn, rule)
    if (written.startsWith('\\')) return named(written.slice(1), 'php_fully_qualified')
    const ns = nsAt(from, at)
    if (written.includes('\\')) {
      const [first, ...rest] = written.split('\\'), alias = useOf(from, 'class', first!)[0]
      return alias ? named([alias.fqn, ...rest].join('\\'), 'php_use') : named(ns ? `${ns}\\${written}` : written, 'php_same_namespace')
    }
    const alias = useOf(from, 'function', written)[0]
    if (alias) return named(alias.fqn, 'php_use')
    const local = named(ns ? `${ns}\\${written}` : written, 'php_same_namespace')
    return local.found.length || !ns ? local : named(written, 'php_global_function')
  }

  // Parents and interfaces, from the heritage rows, named from their own file; one no rule finds makes a lookup through it incomplete.
  const supers = new Map<Sym, { types: Sym[]; complete: boolean }>()
  for (const r of mine.filter((x) => x.type === 'inherits' || x.type === 'implements')) {
    const sub = r.source.symbol ? byLocal.get(r.source.symbol) : undefined, name = r.detail?.name
    if (!sub || !name || r.type !== 'inherits') continue
    const found = resolveClass(r.site.path, r.site.range.start_byte, name).found
    const entry = supers.get(sub) ?? { types: [], complete: true }
    entry.types.push(...found)
    if (found.length !== 1) entry.complete = false
    supers.set(sub, entry)
  }
  const lineOf = (t: Sym, seen = new Set<Sym>()): Sym[] => { if (seen.has(t)) return []; seen.add(t); return [t, ...(supers.get(t)?.types ?? []).flatMap((s) => lineOf(s, seen))] }
  const visibilityOf = (s: Sym) => /\b(private|protected)\b/.exec(text(s.path, s.start, s.start + 256).split(/\bfunction\b/)[0] ?? '')?.[1] ?? 'public'
  /** A private method is reached from its class only, a protected one from a class of its line. */
  const reaches = (s: Sym, from: Sym | undefined) => {
    const v = visibilityOf(s), owner = container.get(s)!
    return v === 'public' || (!!from && (v === 'private' ? from === owner : lineOf(from).includes(owner) || lineOf(owner).includes(from)))
  }
  const traits = new Map<Sym, boolean>()
  /** Whether a class body has a `use T;` of a trait (a closure's `use ($x)` is no such statement). */
  const usesTrait = (t: Sym) => {
    let v = traits.get(t)
    if (v === undefined) { const body = text(t.path, t.start, t.end); traits.set(t, (v = /(^|[;{}])\s*use\s+\\?[A-Za-z_]/.test(body.slice(body.indexOf('{') + 1)))) }
    return v
  }
  /** The methods of a name a class declares or inherits, the ones the site reaches, and whether every parent was known. */
  const methodsOf = (t: Sym, name: string, from: Sym | undefined, seen = new Set<Sym>()): { found: Sym[]; unreached: Sym[]; complete: boolean } => {
    if (seen.has(t)) return { found: [], unreached: [], complete: true }
    seen.add(t)
    const own = (membersOf.get(t) ?? []).filter((s) => s.name.toLowerCase() === name.toLowerCase())
    if (own.length) return { found: own.filter((s) => reaches(s, from)), unreached: own.filter((s) => !reaches(s, from)), complete: true }
    // A trait's method overrides an inherited one, and the tier records no trait a class uses: past one, nothing is bound.
    if (usesTrait(t)) return { found: [], unreached: [], complete: false }
    const up = supers.get(t), r = { found: [] as Sym[], unreached: [] as Sym[], complete: up?.complete ?? true }
    for (const s of up?.types ?? []) { const x = methodsOf(s, name, from, seen); r.found.push(...x.found); r.unreached.push(...x.unreached); r.complete &&= x.complete }
    return r
  }
  const ranked = (list: Sym[]) => [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start))
  const settle = (rel: Rel, r: Found, keep: (s: Sym) => boolean = () => true) => {
    const found = r.found.filter(keep)
    if (found.length) { const b = bind(rel, ranked(found), r.rule); out.set(rel, r.psr4 ? { ...b, detail: { ...b.detail!, autoload: 'psr-4' } } : b) }
    else if (!r.found.length && r.hidden.length) out.set(rel, undeclared(rel, r.hidden))
  }

  for (const rel of mine) {
    const file = rel.site.path, at = rel.site.range.start_byte
    const site = rel.source.symbol ? byLocal.get(rel.source.symbol) : undefined
    const cls = site && (TYPES.has(site.kind) ? site : container.get(site))
    if (rel.type === 'imports') {
      // One clause per row; a group `use A\{B, C}` names several and keeps its row.
      const clauses = usesOf(text(file, rel.site.range.start_byte, rel.site.range.end_byte))
      if (clauses.length !== 1) continue
      const u = clauses[0]!
      if (u.kind !== 'const') settle(rel, u.kind === 'class' ? classNamed(file, u.fqn, 'php_use') : functionNamed(file, u.fqn, 'php_use'))
      continue
    }
    if (rel.type === 'inherits' || rel.type === 'implements') {
      const name = rel.detail?.name
      if (name) settle(rel, resolveClass(file, at, name), (s) => (rel.type === 'implements' ? s.kind === 'interface' : site?.kind === 'interface' ? s.kind === 'interface' : s.kind === 'class'))
      continue
    }
    const callee = rel.detail?.callee
    if (rel.type !== 'calls' || !callee) continue
    const qualifier = rel.detail?.qualifier
    if (rel.detail?.form === 'new') {
      const written = qualifier ? `${qualifier === '\\' ? '' : qualifier}\\${callee}` : callee
      if (/^(self|static)$/i.test(written)) { if (cls) out.set(rel, bind(rel, [cls], 'php_same_class')) }
      else settle(rel, resolveClass(file, at, written), (s) => s.kind === 'class')
      continue
    }
    const form = callForm(text(file, rel.site.range.start_byte, rel.site.range.end_byte), callee)
    if (!form) continue
    if (form.form === 'member') {
      // `$this->f()` only: any other receiver is a value whose class the tier cannot know.
      if (form.before.replace(/\?$/, '') !== '$this' || !cls) continue
      const r = methodsOf(cls, callee, cls)
      if (r.found.length) out.set(rel, bind(rel, ranked(r.found), 'php_same_class', { ambiguous: !r.complete }))
      continue
    }
    if (form.form === 'path' && qualifier) {
      // `T::f()`: a class by name, or the enclosing class or its parent; a variable (`$x::f()`) binds to nothing.
      if (qualifier.startsWith('$')) continue
      const self = /^(self|static)$/i.test(qualifier), parent = /^parent$/i.test(qualifier)
      const owners = self ? (cls ? [cls] : []) : parent ? (cls ? supers.get(cls)?.types ?? [] : []) : undefined
      const named = owners ? undefined : resolveClass(file, at, qualifier)
      const types = owners ?? named!.found
      if (!types.length) { if (named) settle(rel, named); continue }
      const r = types.map((t) => methodsOf(t, callee, cls))
      const found = r.flatMap((x) => x.found), unreached = r.flatMap((x) => x.unreached)
      const rule = self ? 'php_same_class' : parent ? 'php_inherited' : named!.rule
      if (found.length) { const b = bind(rel, ranked(found), rule, { ambiguous: r.some((x) => !x.complete) || (parent && !(supers.get(cls!)?.complete ?? true)) }); out.set(rel, named?.psr4 ? { ...b, detail: { ...b.detail!, autoload: 'psr-4' } } : b) }
      else if (unreached.length) out.set(rel, unresolved(rel, 'unknown_name', { visibility: visibilityOf(unreached[0]!) }))
      continue
    }
    // A plain or namespaced function name.
    const written = qualifier ? `${qualifier === '\\' ? '' : qualifier}\\${callee}` : callee
    settle(rel, resolveFunction(file, at, written))
  }
  return out
}
