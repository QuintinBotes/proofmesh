// Go's rules for binding a name (FR173): a package is a directory of one module, a file sees the package it is in, the packages its imports
// name (through the alias, or the package's own name) and the exported names of a dot import; a blank import binds nothing; another
// package's unexported names are never reachable, nor is an `internal` package outside the parent of `internal`; vendor and testdata
// are no packages; a local variable hides a package or a function of the same name. A call on a receiver whose type the tier cannot
// know binds to nothing.
import path from 'node:path'
import { bind, undeclared, unresolved, type Model, type Project, type Rel, type Sym } from './common.js'

type Pkg = { key: string; project?: Project; dir: string; name: string; files: string[] }
type Import = { rel: Rel; path: string; alias?: string; pkg?: Pkg; project?: Project; state: 'package' | 'undeclared' | 'missing' | 'internal' | 'external' }

const exported = (name: string) => /^\p{Lu}/u.test(name)
const FUNC = new Set(['function']), TYPE = new Set(['struct', 'interface', 'type_alias', 'class'])
/** Go builds no package from a vendor or testdata directory, nor from one whose name starts with a dot or an underscore. */
const ignoredDir = (dir: string) => dir.split('/').some((p) => p === 'vendor' || p === 'testdata' || /^[._]/.test(p))
/** A file a build constraint of `ignore` keeps out of every build, such as a `package main` generator beside a library. */
const buildIgnored = (head: string) => /^\s*\/\/(go:build\s+ignore\b|\s*\+build\s+ignore\b)/m.test(head.split(/^package\s/m)[0] ?? '')
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
  const mine = rels.filter((r) => r.site.path.endsWith('.go') && !ignoredDir(dirOf(r.site.path)))
  if (!mine.length) return out
  // Packages: the files of one directory and one package clause, in one module.
  const files = new Set([...m.symbols.filter((s) => s.path.endsWith('.go')).map((s) => s.path), ...mine.map((r) => r.site.path)])
  const pkgOf = new Map<string, Pkg>(), packages = new Map<string, Pkg>()
  for (const file of [...files].sort()) {
    if (ignoredDir(dirOf(file))) continue
    const buf = m.read(file), head = buf ? buf.subarray(0, 4096).toString('utf8') : ''
    const name = buf && !buildIgnored(head) ? packageName(head) : undefined
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
  const declared = (pkg: Pkg, name: string, kinds: Set<string>, from: string): Sym[] =>
    (symbolsOf.get(`${pkg.key}\u0000${name}`) ?? []).filter((s) => kinds.has(s.kind) && (!inTest(s.path) || inTest(from)))
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
      const within = from ? path.posix.relative(from.dir || '.', dirOf(rel.site.path) || '.') : '', importer = from ? (within ? `${from.name}/${within}` : from.name) : ''
      const parent = /(^|\/)internal(\/|$)/.test(ip) ? ip.slice(0, ip.search(/(^|\/)internal(\/|$)/)) : undefined
      if (!m.sees(from, owner, rel.site.path)) { imp.state = 'undeclared'; imp.project = owner }
      else if (ignoredDir(dir)) imp.state = 'external'
      // An internal package is importable only from code rooted at the parent of its `internal` directory.
      else if (parent !== undefined && !(importer === parent || importer.startsWith(`${parent}/`))) { imp.state = 'internal'; imp.project = owner }
      else if (here.length === 1) { imp.state = 'package'; imp.pkg = here[0]!; imp.project = owner }
      // Several package names in one directory, none a test package, is a layout this tier does not judge.
      else if (here.length > 1) imp.state = 'external'
      else imp.state = 'missing'
    }
    importsOf.set(rel.site.path, [...(importsOf.get(rel.site.path) ?? []), imp])
  }

  // What a file's qualifier can name: an import by its alias, or by the package's own name.
  const qualifiers = (file: string) => {
    const named = new Map<string, Import>(), dots: Import[] = []
    for (const imp of importsOf.get(file) ?? []) {
      if (imp.alias === '_') continue
      if (imp.alias === '.') { dots.push(imp); continue }
      if (imp.alias) { named.set(imp.alias, imp); continue }
      if (imp.state === 'package') named.set(imp.pkg!.name, imp)
      else if (imp.state === 'external') continue
      else for (const n of plausibleNames(imp.path)) if (!named.has(n)) named.set(n, imp)
    }
    return { named, dots }
  }

  for (const rel of mine) {
    const file = rel.site.path, pkg = pkgOf.get(file)
    if (rel.type === 'imports') {
      const imp = (importsOf.get(file) ?? []).find((i) => i.rel === rel)
      if (!imp || imp.state === 'external') continue
      if (imp.state === 'undeclared') out.set(rel, undeclared(rel, [imp.project!]))
      else if (imp.state === 'missing') out.set(rel, unresolved(rel, 'import_unresolved', { package: imp.path }))
      else if (imp.state === 'internal') out.set(rel, unresolved(rel, 'import_unresolved', { visibility: 'internal', package: imp.path }))
      else {
        // An import is a link between files and a package is a directory, so the row lists the module symbols of the package's files as candidates (FR177).
        const files = nonTest(imp.pkg!).sort(), modules = files.flatMap((f) => m.symbols.filter((s) => s.path === f && s.kind === 'module'))
        if (!modules.length) continue
        out.set(rel, bind(rel, modules, 'go_import_path', { inferred: 'package_directory' }))
        out.set(rel, { ...out.get(rel)!, detail: { ...out.get(rel)!.detail!, package: imp.pkg!.dir || '.', files: String(files.length) } })
      }
      continue
    }
    if (!pkg) continue
    const { named, dots } = qualifiers(file)
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
      else if (imp.state === 'internal') out.set(rel, unresolved(rel, 'unknown_name', { visibility: 'internal', package: imp.path }))
      else if (imp.state === 'package') {
        const found = exported(callee) ? declared(imp.pkg!, callee, FUNC, file) : []
        out.set(rel, found.length ? bind(rel, found, 'go_package_member') : unresolved(rel, 'unknown_name', { visibility: exported(callee) ? 'exported' : 'unexported', package: imp.pkg!.dir || '.' }))
      }
      continue
    }
    // A package outside the repository, or a receiver of a type the tier cannot know: bound to nothing, for any method of that name would be a guess.
  }
  return out
}
