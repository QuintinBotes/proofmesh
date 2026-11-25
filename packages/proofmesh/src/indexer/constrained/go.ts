// Go's rules for binding a name (FR173): a package is a directory of one module, a file sees the package it is in, the packages its imports
// name (through the alias, or the package's own name) and the exported names of a dot import; a blank import binds nothing; another
// package's unexported names are never reachable; a local variable hides a package or a function of the same name.
import path from 'node:path'
import { bind, undeclared, unresolved, type Model, type Project, type Rel, type Sym } from './common.js'

type Pkg = { key: string; project?: Project; dir: string; name: string; files: string[] }
type Import = { rel: Rel; path: string; alias?: string; pkg?: Pkg; project?: Project; state: 'package' | 'undeclared' | 'missing' | 'external' }

const exported = (name: string) => /^\p{Lu}/u.test(name)
const FUNC = new Set(['function']), TYPE = new Set(['struct', 'interface', 'type_alias', 'class'])
const dirOf = (p: string) => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p))

/** The name a package clause declares, read past comments at the top of the file. */
function packageName(head: string): string | undefined {
  for (let i = 0; i < head.length;) {
    if (/\s/.test(head[i]!)) i++
    else if (head.startsWith('//', i)) i = head.indexOf('\n', i) < 0 ? head.length : head.indexOf('\n', i)
    else if (head.startsWith('/*', i)) i = head.indexOf('*/', i + 2) < 0 ? head.length : head.indexOf('*/', i + 2) + 2
    else return /^package\s+([\p{L}\p{N}_]+)/u.exec(head.slice(i, i + 200))?.[1]
  }
  return undefined
}

/** The names an import of a path outside the repository may go by when it names none: the last element, with the usual affixes dropped. */
function plausibleNames(importPath: string): string[] {
  const parts = importPath.split('/').filter(Boolean)
  const last = /^v\d+$/.test(parts.at(-1) ?? '') ? parts.at(-2) ?? '' : parts.at(-1) ?? ''
  const base = last.replace(/\.v\d+$/, '')
  return [...new Set([base, base.replace(/^go-/, ''), base.replace(/-go$/, ''), base.split(/[-.]/).at(-1) ?? base, base.replace(/[-.]/g, '_')])]
}

export function resolveGo(m: Model, rels: Rel[]): Map<Rel, Rel> {
  const out = new Map<Rel, Rel>()
  const mine = rels.filter((r) => r.site.path.endsWith('.go'))
  if (!mine.length) return out
  // Packages: the files of one directory and one package clause, in one module.
  const files = new Set([...m.symbols.filter((s) => s.path.endsWith('.go')).map((s) => s.path), ...mine.map((r) => r.site.path)])
  const pkgOf = new Map<string, Pkg>(), packages = new Map<string, Pkg>()
  for (const file of [...files].sort()) {
    const buf = m.read(file)
    const name = buf ? packageName(buf.subarray(0, 4096).toString('utf8')) : undefined
    if (!name) continue
    const project = m.projectOf(file, ['go']), dir = dirOf(file), key = `${project?.id ?? ''}\u0000${dir}\u0000${name}`
    const pkg = packages.get(key) ?? { key, ...(project ? { project } : {}), dir, name, files: [] }
    pkg.files.push(file)
    packages.set(key, pkg)
    pkgOf.set(file, pkg)
  }
  // The declarations of each name in each package, so a call site's lookup costs the name's declarations and not the package's.
  const symbolsOf = new Map<string, Sym[]>()
  for (const s of m.symbols) { const pkg = pkgOf.get(s.path); if (pkg && s.path.endsWith('.go')) { const k = `${pkg.key}\u0000${s.name}`; const list = symbolsOf.get(k); if (list) list.push(s); else symbolsOf.set(k, [s]) } }
  const inTest = (p: string) => p.endsWith('_test.go')
  /** The declarations of a name in a package that the calling file can see: a test file's own declarations stay in test files. */
  const declared = (pkg: Pkg, name: string, kinds: Set<string>, from: string, receiver?: boolean): Sym[] =>
    (symbolsOf.get(`${pkg.key}\u0000${name}`) ?? []).filter((s) => (receiver ? s.kind === 'method' : kinds.has(s.kind)) && (!inTest(s.path) || inTest(from)))
  const nonTest = (pkg: Pkg) => pkg.files.filter((f) => !inTest(f))

  // Imports: the package each names, when the repository has it, and whether the importing module may see it (FR172).
  const projectsByModule = new Map<string, Project>()
  for (const p of packages.values()) if (p.project) projectsByModule.set(p.project.name, p.project)
  for (const file of files) { const p = m.projectOf(file, ['go']); if (p) projectsByModule.set(p.name, p) }
  const importsOf = new Map<string, Import[]>()
  for (const rel of mine.filter((r) => r.type === 'imports')) {
    const ip = rel.detail?.module
    if (!ip) continue
    const from = m.projectOf(rel.site.path, ['go'])
    const owner = [...projectsByModule.values()].filter((p) => ip === p.name || ip.startsWith(`${p.name}/`)).sort((a, b) => b.name.length - a.name.length)[0]
    const imp: Import = { rel, path: ip, ...(rel.detail?.alias ? { alias: rel.detail.alias } : {}), state: 'external' }
    if (owner) {
      const dir = path.posix.join(owner.dir || '.', ip.slice(owner.name.length)).replace(/^\.$/, '')
      const here = [...packages.values()].filter((p) => p.project === owner && p.dir === dir && !p.name.endsWith('_test') && nonTest(p).length)
      if (!m.sees(from, owner)) { imp.state = 'undeclared'; imp.project = owner }
      else if (here.length === 1) { imp.state = 'package'; imp.pkg = here[0]!; imp.project = owner }
      else imp.state = 'missing'
    }
    importsOf.set(rel.site.path, [...(importsOf.get(rel.site.path) ?? []), imp])
  }

  // What a file's qualifier can name: an import by its alias, or by the package's own name.
  const qualifiers = (file: string) => {
    const named = new Map<string, Import>(), external = new Set<string>(), dots: Import[] = []
    for (const imp of importsOf.get(file) ?? []) {
      if (imp.alias === '_') continue
      if (imp.alias === '.') { dots.push(imp); continue }
      if (imp.alias) { named.set(imp.alias, imp); continue }
      if (imp.state === 'package') named.set(imp.pkg!.name, imp)
      else if (imp.state === 'external') for (const n of plausibleNames(imp.path)) external.add(n)
      else for (const n of plausibleNames(imp.path)) if (!named.has(n)) named.set(n, imp)
    }
    return { named, external, dots }
  }

  for (const rel of mine) {
    const file = rel.site.path, pkg = pkgOf.get(file)
    if (rel.type === 'imports') {
      const imp = (importsOf.get(file) ?? []).find((i) => i.rel === rel)
      if (!imp || imp.state === 'external') continue
      if (imp.state === 'undeclared') out.set(rel, undeclared(rel, [imp.project!]))
      else if (imp.state === 'missing') out.set(rel, unresolved(rel, 'import_unresolved', { package: imp.path }))
      else {
        // A path declared in a module the repository holds is fixed by that path: resolved to the package's lowest-path file (FR177).
        const target = nonTest(imp.pkg!).sort()[0]!
        const { candidates: _c, reason: _r, ...rest } = rel
        out.set(rel, { ...rest, resolution: 'resolved', target: { file: target }, detail: { ...(rel.detail ?? {}), rule: 'go_import_path', package: imp.pkg!.dir || '.' } })
      }
      continue
    }
    if (!pkg) continue
    const { named, external, dots } = qualifiers(file)
    const types = (name: string) => {
      const dot = name.indexOf('.')
      if (dot < 0) return { found: declared(pkg, name, TYPE, file), rule: 'go_same_package', imp: undefined as Import | undefined }
      const imp = named.get(name.slice(0, dot))
      return { found: imp?.state === 'package' && exported(name.slice(dot + 1)) ? declared(imp.pkg!, name.slice(dot + 1), TYPE, file) : [], rule: 'go_package_member', imp }
    }
    if (rel.type === 'inherits') {
      const name = rel.detail?.name
      if (!name) continue
      const { found, rule, imp } = types(name)
      if (found.length) out.set(rel, bind(rel, found, rule))
      else if (imp?.state === 'undeclared') out.set(rel, undeclared(rel, [imp.project!]))
      continue
    }
    if (rel.type !== 'calls') continue
    const callee = rel.detail?.callee
    if (!callee) continue
    const qualifier = rel.detail?.qualifier, shadowed = rel.detail?.shadowed === 'local'
    if (!qualifier) {
      // A bare name is a function of this package, or an exported one of a dot import; a local of the same name hides both.
      if (shadowed) { out.set(rel, unresolved(rel, 'unknown_name', { shadowed: 'local' })); continue }
      const own = declared(pkg, callee, FUNC, file)
      if (own.length) { out.set(rel, bind(rel, own, 'go_same_package')); continue }
      const dotted = exported(callee) ? dots.flatMap((d) => (d.state === 'package' ? declared(d.pkg!, callee, FUNC, file) : [])) : []
      if (dotted.length) out.set(rel, bind(rel, dotted, 'go_dot_import'))
      continue
    }
    const imp = shadowed || qualifier.includes('.') ? undefined : named.get(qualifier)
    if (imp) {
      // `pkg.Name`: only an exported function of that package, never an unexported one and never another module's (FR172, FR173).
      if (imp.state === 'undeclared') out.set(rel, undeclared(rel, [imp.project!]))
      else if (imp.state === 'package') {
        const found = exported(callee) ? declared(imp.pkg!, callee, FUNC, file) : []
        out.set(rel, found.length ? bind(rel, found, 'go_package_member') : unresolved(rel, 'unknown_name', { visibility: exported(callee) ? 'exported' : 'unexported', package: imp.pkg!.dir || '.' }))
      }
      continue
    }
    // A package outside the repository, or a receiver the tier cannot type: only the second may be matched, by method name.
    if (!shadowed && !qualifier.includes('.') && external.has(qualifier)) continue
    const reach: Array<{ pkg: Pkg; own: boolean }> = [{ pkg, own: true }, ...[...new Set((importsOf.get(file) ?? []).flatMap((i) => (i.state === 'package' && i.alias !== '_' ? [i.pkg!] : [])))].map((p) => ({ pkg: p, own: false }))]
    const found = reach.flatMap(({ pkg: p, own }) => declared(p, callee, FUNC, file, true).filter((s) => own || exported(s.name)))
    if (found.length) out.set(rel, bind(rel, found, 'go_method_name'))
  }
  return out
}
