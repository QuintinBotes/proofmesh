// Proofmesh TypeScript adapter: reads only the captured workspace and the TypeScript library declarations; never runs repository code.
import fs from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import readline from 'node:readline'
import type * as TS from 'typescript'
import { graphqlDocument } from '../../syntax/src/contracts.js'

const ts = createRequire(import.meta.url)('typescript') as typeof TS
const VERSION = '0.2.3'
type Range = { start_byte: number; end_byte: number; start_line: number; end_line: number }
type Ref = { symbol: string } | { file: string } | { external: { module: string; name: string } }

let workspace = ''
/** The repository itself, read only for installed packages under node_modules: external inputs (A2), never sources. */
let repoRoot = ''
let externalInputs: string[] = []
let files: Array<{ path: string; language: string }> = []
/** One program per project configuration; `program` and `checker` are those of the project whose file is being read. */
type Project = { program: TS.Program; checker: TS.TypeChecker; host: TS.CompilerHost }
const projects: Project[] = []
const projectOf = new Map<string, Project>()
let program: TS.Program | undefined
let checker: TS.TypeChecker
const use = (p: Project) => { program = p.program; checker = p.checker }
/** Declarations by file and position, not node identity, so a call from one project finds a declaration another project read. */
const declLocal = new Map<string, string>()
/** Pulumi resources by the `new` expression that constructs each (A8, A25). */
const resourceLocal = new Map<string, string>()
/** TypeORM and Prisma tables already declared, each at its first mapping or Prisma Client access in index order (A9, A36). */
const declaredTables = new Set<string>()
/** Each Prisma model's table by its Prisma Client accessor, read from the workspace's Prisma schemas (A36). */
const prismaTables = new Map<string, { qualified: string; name: string }>()
/** Candidate Express registrations and decorated classes in index order, read once every file is indexed; then the route facts by file. */
const routeSites: Array<TS.CallExpression | TS.ClassDeclaration> = []
const routeFacts = new Map<string, Array<Record<string, unknown>>>()
/** GraphQL resolver maps' root objects, `Query: { ... }` and the like, in index order (FR402). */
const resolverRoots: TS.PropertyAssignment[] = []
const keyOf = (n: TS.Node) => `${n.getSourceFile().fileName}|${n.pos}|${n.end}|${n.kind}`
const symbolsByFile = new Map<string, Array<Record<string, unknown>>>()
/**
 * Names that may denote a repository class, interface, enum, type alias, variable, function or method: their own, and the names default
 * imports and renaming imports or exports give; only an identifier with one of these names can reference one, and the checker decides whether it does.
 */
const refNames = new Set<string>()
/** Symbol kinds a use can reference. */
const REFERABLE = /^(class|interface|enum|type_alias|variable|function|method)$/
const byteMaps = new Map<TS.SourceFile, Int32Array>()

const rel = (abs: string) => path.relative(workspace, abs).split(path.sep).join('/')
const inWorkspace = (abs: string) => !rel(abs).startsWith('..') && !path.isAbsolute(rel(abs)) && !rel(abs).split('/').includes('node_modules')
/** The package a file under node_modules belongs to, such as `greeter` or `@fx/util`. */
const packageOf = (file: string): string | undefined => {
  const parts = file.split(/[\\/]/), i = parts.lastIndexOf('node_modules')
  if (i < 0 || !parts[i + 1]) return undefined
  return parts[i + 1]!.startsWith('@') ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1]
}
/** A workspace path under node_modules, read from the repository's own node_modules instead: packages are never captured. */
const installedPath = (abs: string): string | undefined => {
  const r = path.relative(workspace, abs)
  return repoRoot && !r.startsWith('..') && !path.isAbsolute(r) && r.split(path.sep).includes('node_modules') ? path.join(repoRoot, r) : undefined
}
/** A package linked into node_modules from the repository itself, as npm workspaces link them, is read from the captured copy. */
function realpath(abs: string): string {
  const installed = installedPath(abs)
  if (!installed) return abs
  let real: string
  try { real = fs.realpathSync(installed) } catch { return abs }
  const r = path.relative(repoRoot, real)
  return !r.startsWith('..') && !path.isAbsolute(r) && !r.split(path.sep).includes('node_modules') ? path.join(workspace, r) : abs
}
const readsInstalled = {
  fileExists: (p: string) => ts.sys.fileExists(installedPath(p) ?? p),
  readFile: (p: string) => ts.sys.readFile(installedPath(p) ?? p),
  directoryExists: (p: string) => ts.sys.directoryExists(installedPath(p) ?? p),
  getDirectories: (p: string) => ts.sys.getDirectories(installedPath(p) ?? p),
}
const noExt = (p: string) => p.replace(/\.[^./]+$/, '')

/** 3 when the file as stored starts with a UTF-8 byte order mark, which ts.sys.readFile drops from the text. */
function bomBytes(file: string): number {
  const head = Buffer.alloc(3)
  try { const fd = fs.openSync(installedPath(file) ?? file, 'r'); try { fs.readSync(fd, head, 0, 3, 0) } finally { fs.closeSync(fd) } } catch { return 0 }
  return head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0
}

/** UTF-8 byte offset in the file as stored for every UTF-16 position of the file's text. */
function bytesAt(sf: TS.SourceFile, pos: number): number {
  let map = byteMaps.get(sf)
  if (!map) {
    const text = sf.text
    map = new Int32Array(text.length + 1)
    let b = bomBytes(sf.fileName)
    for (let i = 0; i < text.length; i++) {
      map[i] = b
      const c = text.charCodeAt(i)
      if (c < 0x80) b += 1
      else if (c < 0x800) b += 2
      else if (c >= 0xd800 && c <= 0xdbff) { b += 4; map[++i] = b - 4 + 0 }
      else b += 3
    }
    map[text.length] = b
    byteMaps.set(sf, map)
  }
  return map[pos]!
}

function range(sf: TS.SourceFile, start: number, end: number): Range {
  return {
    start_byte: bytesAt(sf, start), end_byte: bytesAt(sf, end),
    start_line: sf.getLineAndCharacterOfPosition(start).line + 1, end_line: sf.getLineAndCharacterOfPosition(end).line + 1,
  }
}

const DEFAULT_OPTIONS: TS.CompilerOptions = { allowJs: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
/** Declaration files parse alike under every project, so each is parsed once and shared, as editors share them. */
const declarationFiles = new Map<string, TS.SourceFile>()

function createProject(rootNames: string[], options: TS.CompilerOptions): Project {
  delete options.plugins
  const host = ts.createCompilerHost(options)
  Object.assign(host, readsInstalled, { realpath })
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (!fileName.endsWith('.d.ts')) return getSourceFile(fileName, languageVersion, onError, shouldCreate)
    const key = `${fileName}|${typeof languageVersion === 'object' ? `${languageVersion.languageVersion}|${languageVersion.impliedNodeFormat}` : languageVersion}`
    let sf = declarationFiles.get(key)
    if (!sf) { sf = getSourceFile(fileName, languageVersion, onError, shouldCreate); if (sf) declarationFiles.set(key, sf) }
    return sf
  }
  const p = ts.createProgram(rootNames, options, host)
  return { program: p, checker: p.getTypeChecker(), host }
}

/**
 * A project per tsconfig.json or jsconfig.json, with that configuration's options, extends and path aliases. Each source belongs to the
 * nearest configuration above it, as an editor would open it; sources under none share the default options.
 */
function buildProjects(): void {
  process.chdir(workspace)
  const parseHost = { ...ts.sys, ...readsInstalled }
  const configs = files.map((f) => f.path).filter((p) => /^(tsconfig|jsconfig)\.json$/.test(path.posix.basename(p)))
  const dirOf = (c: string) => path.posix.dirname(c)
  const nearest = (p: string) => configs.filter((c) => dirOf(c) === '.' || p.startsWith(`${dirOf(c)}/`)).sort((a, b) => dirOf(b).length - dirOf(a).length || (a < b ? -1 : 1))[0] ?? ''
  const owned = new Map<string, string[]>()
  for (const f of files) if (f.language === 'typescript' || f.language === 'javascript') owned.set(nearest(f.path), [...(owned.get(nearest(f.path)) ?? []), f.path])
  for (const [config, mine] of [...owned].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let options = { ...DEFAULT_OPTIONS }
    let rootNames = mine.map((p) => path.join(workspace, p))
    if (config) {
      const read = ts.readConfigFile(path.join(workspace, config), parseHost.readFile)
      const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, parseHost, path.join(workspace, dirOf(config)))
      options = { ...parsed.options, allowJs: true, noEmit: true, skipLibCheck: true }
      rootNames = [...new Set([...parsed.fileNames, ...rootNames])]
    }
    const project = createProject(rootNames, options)
    projects.push(project)
    for (const p of mine) projectOf.set(p, project)
  }
  externalInputs = packageInputs()
  for (const f of files.filter((f) => /\.prisma$/i.test(f.path)).sort((a, b) => (a.path < b.path ? -1 : 1))) readPrismaSchema(fs.readFileSync(path.join(workspace, f.path), 'utf8'))
  for (const [p, project] of projectOf) {
    const sf = project.program.getSourceFile(path.join(workspace, p))
    if (!sf) continue
    use(project)
    indexDeclarations(sf)
  }
  indexRoutes()
  indexResolvers()
}

const readJson = (file: string): Record<string, any> | undefined => { try { return JSON.parse(ts.sys.readFile(file) ?? '') } catch { return undefined } }

/** Whether a package is installed in node_modules at a directory or any directory above it, as Node resolves it. */
function installed(dir: string, name: string): boolean {
  for (let d = dir; ; d = path.posix.dirname(d)) {
    if (ts.sys.fileExists(path.join(repoRoot, d === '.' ? '' : d, 'node_modules', name, 'package.json'))) return true
    if (d === '.' || d === '/' || d === '') return false
  }
}

/** Every installed package the program read, by name and version, and every declared dependency that is not installed (A2). */
function packageInputs(): string[] {
  if (!repoRoot) return []
  const out = new Set<string>()
  for (const sf of projects.flatMap((p) => p.program.getSourceFiles().filter((f) => !p.program.isSourceFileDefaultLibrary(f)))) {
    const r = path.relative(workspace, sf.fileName).split(path.sep).join('/')
    const pkg = packageOf(r)
    if (!pkg || r.startsWith('..')) continue
    const dir = r.slice(0, r.lastIndexOf('node_modules/') + 'node_modules/'.length) + pkg
    out.add(`npm:${pkg}/${readJson(path.join(repoRoot, dir, 'package.json'))?.version ?? 'unknown'}`)
  }
  for (const f of files.filter((f) => path.posix.basename(f.path) === 'package.json')) {
    const json = readJson(path.join(workspace, f.path))
    const declared = { ...json?.dependencies, ...json?.devDependencies, ...json?.peerDependencies, ...json?.optionalDependencies }
    for (const name of Object.keys(declared)) if (!installed(path.posix.dirname(f.path), name)) out.add(`npm:${name} missing`)
  }
  return [...out].sort()
}

/** The module an imported name comes from, when that import does not resolve. */
function unresolvedImport(id: TS.Identifier): string | undefined {
  const sym = checker.getSymbolAtLocation(id)
  if (!sym || !(sym.flags & ts.SymbolFlags.Alias)) return undefined
  let n: TS.Node | undefined = sym.declarations?.[0]
  while (n && !ts.isImportDeclaration(n)) n = n.parent
  if (!n || !ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return undefined
  return checker.getSymbolAtLocation(n.moduleSpecifier) ? undefined : n.moduleSpecifier.text
}

/** An external target named by package and symbol, never by a machine path, so the same tree seals the same facts anywhere. */
function externalRef(sym: TS.Symbol, decl: TS.Declaration): Ref {
  const sf = decl.getSourceFile(), full = checker.getFullyQualifiedName(sym)
  if (program!.isSourceFileDefaultLibrary(sf)) return { external: { module: path.basename(sf.fileName), name: full } }
  const quoted = /^"([^"]+)"\.(.+)$/.exec(full)
  if (quoted && !path.isAbsolute(quoted[1]!)) return { external: { module: quoted[1]!, name: quoted[2]! } }
  return { external: { module: packageOf(sf.fileName) ?? path.basename(sf.fileName), name: quoted ? quoted[2]! : full } }
}

function isFunctionLike(e: TS.Expression | undefined): boolean {
  return !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
}

const hasModifier = (n: TS.Node, kind: TS.SyntaxKind) => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === kind)

function signatureOf(name: string, node: TS.SignatureDeclaration | undefined): string | null {
  if (!node) return null
  const sig = checker.getSignatureFromDeclaration(node)
  return sig ? `${name}${checker.signatureToString(sig)}` : null
}

function indexDeclarations(sf: TS.SourceFile): void {
  const p = rel(sf.fileName), base = noExt(p), out: Array<Record<string, unknown>> = []
  const add = (node: TS.Node, kind: string, name: string, qualified: string, signature: string | null, start = node.getStart(sf), end = node.getEnd()) => {
    const r = range(sf, start, end)
    const local = `${p}#${kind}#${qualified}#${r.start_byte}`
    declLocal.set(keyOf(node), local)
    out.push({ local_id: local, path: p, kind, name, qualified_name: qualified, range: r, signature })
    if (REFERABLE.test(kind)) refNames.add(name)
    return local
  }
  /**
   * One method symbol per member name, static and instance apart: the implementation, else the first declaration, so an abstract
   * member, an overload set, a get/set accessor pair and an interface member each have one; every overload or accessor resolves to it.
   * Members are methods, method signatures, get and set accessors, and properties holding a function (by initializer, or by type when there is none), of a class, an interface, or the
   * object literal a typed module-level constant holds.
   */
  const members = (list: TS.NodeArray<TS.ClassElement | TS.TypeElement | TS.ObjectLiteralElementLike>, owner: string) => {
    const byName = new Map<string, Array<{ node: TS.Node; name: string; signature: () => string | null }>>()
    for (const m of list) {
      const name = m.name?.getText(sf)
      const typed = ts.isPropertySignature(m) || (ts.isPropertyDeclaration(m) && !m.initializer)
      const callable = typed && m.name ? checker.getNonNullableType(checker.getTypeAtLocation(m.name)).getCallSignatures()[0] : undefined
      const signature = ts.isMethodDeclaration(m) || ts.isMethodSignature(m) || ts.isAccessor(m) ? () => signatureOf(name!, m)
        : (ts.isPropertyDeclaration(m) || ts.isPropertyAssignment(m)) && isFunctionLike(m.initializer) ? () => signatureOf(name!, m.initializer as TS.ArrowFunction)
          : callable ? () => `${name}${checker.signatureToString(callable)}` : undefined
      const key = `${hasModifier(m, ts.SyntaxKind.StaticKeyword) ? 'static ' : ''}${name}`
      if (name && signature) byName.set(key, [...(byName.get(key) ?? []), { node: m, name, signature }])
    }
    for (const decls of byName.values()) {
      const main = decls.find((d) => !ts.isMethodDeclaration(d.node) || d.node.body) ?? decls[0]!
      const local = add(main.node, 'method', main.name, `${owner}.${main.name}`, main.signature())
      for (const d of decls) declLocal.set(keyOf(d.node), local)
    }
  }
  if (sf.text.length) {
    const r = range(sf, 0, sf.text.length)
    const endLine = sf.text.endsWith('\n') ? r.end_line - 1 : r.end_line
    const local = `${p}#module#${base}#0`
    declLocal.set(keyOf(sf), local)
    // The module is the whole file, its byte order mark included.
    out.push({ local_id: local, path: p, kind: 'module', name: path.posix.basename(p), qualified_name: base, range: { ...r, start_byte: 0, end_line: Math.max(1, endLine) }, signature: null })
  }
  const visit = (statements: TS.NodeArray<TS.Statement>, prefix: string) => {
    for (const s of statements) {
      if (ts.isFunctionDeclaration(s) && s.name && (s.body || !statements.some((o) => o !== s && ts.isFunctionDeclaration(o) && o.name?.text === s.name!.text && o.body))) {
        add(s, 'function', s.name.text, `${base}:${prefix}${s.name.text}`, signatureOf(s.name.text, s))
      } else if (ts.isClassDeclaration(s) && s.name) {
        add(s, 'class', s.name.text, `${base}:${prefix}${s.name.text}`, null)
        for (const d of ts.getDecorators(s) ?? []) {
          const orm = importedDecorator(d, 'typeorm'), t = orm?.name === 'Entity' ? entityTable(orm.call, s.name.text) : null
          if (!t || declaredTables.has(t.qualified)) continue
          declaredTables.add(t.qualified)
          out.push({ local_id: `fw#table#${t.qualified}`, path: p, kind: 'table', name: t.name, qualified_name: t.qualified, range: range(sf, orm!.call.getStart(sf), orm!.call.getEnd()), signature: null })
        }
        members(s.members, `${base}:${prefix}${s.name.text}`)
      } else if (ts.isInterfaceDeclaration(s)) {
        add(s, 'interface', s.name.text, `${base}:${prefix}${s.name.text}`, null)
        members(s.members, `${base}:${prefix}${s.name.text}`)
      } else if (ts.isEnumDeclaration(s)) {
        add(s, 'enum', s.name.text, `${base}:${prefix}${s.name.text}`, null)
      } else if (ts.isTypeAliasDeclaration(s)) {
        add(s, 'type_alias', s.name.text, `${base}:${prefix}${s.name.text}`, null)
      } else if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue
          const fn = isFunctionLike(d.initializer)
          add(d, fn ? 'function' : 'variable', d.name.text, `${base}:${prefix}${d.name.text}`, fn ? signatureOf(d.name.text, d.initializer as TS.ArrowFunction) : null, s.getStart(sf), s.getEnd())
          if (d.type && d.initializer && ts.isObjectLiteralExpression(d.initializer) && s.declarationList.flags & ts.NodeFlags.Const) members(d.initializer.properties, `${base}:${prefix}${d.name.text}`)
        }
      } else if (ts.isModuleDeclaration(s) && s.body && ts.isModuleBlock(s.body) && ts.isIdentifier(s.name)) {
        visit(s.body.statements, `${prefix}${s.name.text}.`)
      } else if (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) {
        const renamed = (n: TS.Node): void => {
          if (ts.isImportClause(n) && n.name) refNames.add(n.name.text)
          if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && n.propertyName) refNames.add(n.name.text)
          ts.forEachChild(n, renamed)
        }
        renamed(s)
      }
    }
  }
  visit(sf.statements, '')
  const resources = (n: TS.Node): void => {
    const r = ts.isNewExpression(n) ? pulumiResource(n) : undefined
    if (r) {
      const local = `${p}#resource#${r.token}::${r.name}#${n.getStart(sf)}`
      resourceLocal.set(keyOf(n), local)
      out.push({ local_id: local, path: p, kind: 'resource', name: r.name, qualified_name: `${base}:${r.token}::${r.name}`, range: range(sf, n.getStart(sf), n.getEnd()), signature: `resource "${r.token}"` })
    }
    if (isRouteSite(n)) routeSites.push(n)
    if (ts.isPropertyAssignment(n) && GRAPHQL_ROOTS.has(keyName(n.name, sf)) && ts.isObjectLiteralExpression(n.initializer)) resolverRoots.push(n)
    const access = prismaAccess(n), table = access && prismaTables.get(access.accessor)
    if (table && !declaredTables.has(table.qualified)) {
      declaredTables.add(table.qualified)
      out.push({ local_id: `fw#table#${table.qualified}`, path: p, kind: 'table', name: table.name, qualified_name: table.qualified, range: range(sf, access.site.getStart(sf), access.site.getEnd()), signature: null })
    }
    ts.forEachChild(n, resources)
  }
  resources(sf)
  symbolsByFile.set(p, out)
}

const PULUMI_BASES = new Set(['CustomResource', 'ComponentResource'])
/** A Pulumi resource: a class deriving from @pulumi/pulumi's CustomResource or ComponentResource, named as its URN names it, type then name. */
function pulumiResource(n: TS.NewExpression): { token: string; name: string } | undefined {
  const derives = (t: TS.Type): boolean => {
    const target = (t as TS.TypeReference).target ?? t
    const sym = target.getSymbol(), decl = sym?.declarations?.[0]
    if (sym && decl && PULUMI_BASES.has(sym.name) && packageOf(decl.getSourceFile().fileName) === '@pulumi/pulumi') return true
    return target.isClassOrInterface() && checker.getBaseTypes(target).some(derives)
  }
  const type = checker.getTypeAtLocation(n), cls = ((type as TS.TypeReference).target ?? type).getSymbol(), decl = cls?.declarations?.[0]
  const first = n.arguments?.[0]
  if (!cls || !decl || !first || !derives(type)) return undefined
  const ref = inWorkspace(decl.getSourceFile().fileName) ? undefined : externalRef(cls, decl as TS.Declaration)
  const token = ref && 'external' in ref ? `${ref.external.module.replace(/^@pulumi\//, '')}.${ref.external.name}` : cls.name
  const name = ts.isStringLiteralLike(first) ? first.text : ts.isTemplateExpression(first) ? first.getText().slice(1, -1) : first.getText()
  return { token, name }
}

/** The resource a name holds, when it is declared with the `new` expression that constructs one. */
function resourceOf(id: TS.Identifier): string | undefined {
  let sym = checker.getSymbolAtLocation(id)
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
  const decl = sym?.valueDeclaration
  return decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isNewExpression(decl.initializer) ? resourceLocal.get(keyOf(decl.initializer)) : undefined
}

/** A resource references each resource whose outputs its arguments read, and depends on each its `dependsOn` option names. */
function resourceFacts(n: TS.NewExpression, source: string, p: string, sf: TS.SourceFile): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const walk = (node: TS.Node, type: 'references' | 'depends_on') => {
    const target = ts.isIdentifier(node) ? resourceOf(node) : undefined
    if (target && target !== source) {
      // The site is the output read, such as `logs.arn`, short of a method called on it.
      let site: TS.Node = node
      while (ts.isPropertyAccessExpression(site.parent) && site.parent.expression === site && !(ts.isCallExpression(site.parent.parent) && site.parent.parent.expression === site.parent)) site = site.parent
      out.push({ type, origin: 'framework_adapter', source: { symbol: source }, site: { path: p, range: range(sf, site.getStart(sf), site.getEnd()) }, resolution: 'resolved', target: { symbol: target } })
    }
    ts.forEachChild(node, (c) => walk(c, type))
  }
  const [, args, opts] = n.arguments ?? []
  if (args) walk(args, 'references')
  if (opts && ts.isObjectLiteralExpression(opts)) {
    for (const prop of opts.properties) if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'dependsOn') walk(prop.initializer, 'depends_on')
  }
  return out
}

/**
 * The module and export a callee names, by its import's specifier text, so the package need not be installed: `f` from a named import
 * (its exported name), a default import (`default`), and `ns.f` through a namespace or default import.
 */
// shortcut: a name re-exported through a local module is not followed; resolve the alias when a repository does that.
function importedCallee(callee: TS.Expression): { module: string; name: string } | undefined {
  const root = ts.isPropertyAccessExpression(callee) ? callee.expression : callee
  const decl = ts.isIdentifier(root) ? checker.getSymbolAtLocation(root)?.declarations?.[0] : undefined
  if (!decl) return undefined
  const imported = ts.isImportSpecifier(decl) ? (decl.propertyName ?? decl.name).text : ts.isImportClause(decl) ? 'default' : undefined
  const name = root === callee ? imported : ts.isNamespaceImport(decl) || imported === 'default' ? (callee as TS.PropertyAccessExpression).name.text : undefined
  let imp: TS.Node = decl
  while (!ts.isImportDeclaration(imp) && imp.parent) imp = imp.parent
  return name && ts.isImportDeclaration(imp) && ts.isStringLiteral(imp.moduleSpecifier) ? { module: imp.moduleSpecifier.text, name } : undefined
}

/** A decorator call whose callee a module exports, such as TypeORM's `@Entity()` or NestJS's `@Get()`. */
function importedDecorator(d: TS.Decorator, module: string): { name: string; call: TS.CallExpression } | undefined {
  const call = d.expression
  const callee = ts.isCallExpression(call) ? importedCallee(call.expression) : undefined
  return callee?.module === module ? { name: callee.name, call: call as TS.CallExpression } : undefined
}

/** TypeORM's default naming strategy for a table the decorator does not name: the class name in snake case. */
const snakeCase = (s: string) => s.replace(/([A-Z])([A-Z])([a-z])/g, '$1_$2$3').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/** The table `@Entity(name?, options?)` maps to, from a string name or the options' `name` and `schema`; null when either is not a string literal. */
function entityTable(call: TS.CallExpression, className: string): { qualified: string; name: string; inferred: boolean } | null {
  const [first, second] = call.arguments
  const options = [first, second].find((a): a is TS.ObjectLiteralExpression => !!a && ts.isObjectLiteralExpression(a))
  const option = (key: string) => options?.properties.find((x): x is TS.PropertyAssignment => ts.isPropertyAssignment(x) && x.name.getText() === key)?.initializer
  const literal = (e: TS.Expression) => (ts.isStringLiteralLike(e) ? e.text : undefined)
  const nameExpr = first && first !== options ? first : option('name'), schemaExpr = option('schema')
  const name = nameExpr ? literal(nameExpr) : snakeCase(className), schema = schemaExpr && literal(schemaExpr)
  if (name === undefined || (schemaExpr && schema === undefined)) return null
  return { qualified: schema ? `${schema}.${name}` : name, name, inferred: !nameExpr }
}

/** TypeORM (A9): `@Entity` maps its class to a table; `@ChildEntity` inherits its parent, whose table it shares (single-table inheritance). */
function typeormFacts(cls: TS.ClassDeclaration, p: string, sf: TS.SourceFile): Array<Record<string, unknown>> {
  const local = declLocal.get(keyOf(cls))
  if (!local || !cls.name) return []
  return (ts.getDecorators(cls) ?? []).flatMap((d): Array<Record<string, unknown>> => {
    const orm = importedDecorator(d, 'typeorm')
    if (!orm) return []
    const fact = { origin: 'framework_adapter', source: { symbol: local }, site: { path: p, range: range(sf, orm.call.getStart(sf), orm.call.getEnd()) } }
    if (orm.name === 'Entity') {
      const t = entityTable(orm.call, cls.name!.text)
      if (!t) return [{ type: 'maps_to', ...fact, resolution: 'unresolved', reason: 'outside_capability', detail: { rule: 'Entity', why: 'the table name is not a string literal' } }]
      const inferred = t.inferred ? { inferred: "TypeORM's default naming strategy snake-cases the class name; a DataSource may install another naming strategy" } : {}
      return [{ type: 'maps_to', ...fact, resolution: 'resolved', target: { symbol: `fw#table#${t.qualified}` }, detail: { rule: 'Entity', ...inferred } }]
    }
    const parent = orm.name === 'ChildEntity' ? cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0] : undefined
    return parent ? [{ type: 'inherits', ...fact, ...resolveCall(parent.expression), detail: { rule: 'ChildEntity' } }] : []
  })
}

type Heritable = TS.ClassDeclaration | TS.InterfaceDeclaration
/** The class and interface declarations a heritage clause or type annotation names: several when declarations merge. */
const heritable = (name: TS.Node) => (aliased(checker.getSymbolAtLocation(name))?.declarations ?? []).filter((s): s is Heritable => ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s))
/** Every class and interface a class or interface extends or implements, through any chain of clauses. */
function supertypes(d: Heritable, out = new Set<Heritable>()): Set<Heritable> {
  for (const t of (d.heritageClauses ?? []).flatMap((h) => h.types)) {
    for (const s of heritable(t.expression)) if (!out.has(s)) { out.add(s); supertypes(s, out) }
  }
  return out
}

/**
 * A class `implements` each interface its implements clause names and `inherits` the class it extends, and an interface `inherits`
 * each interface it extends, each cited at the clause: one row per declaration named, so a merged interface gives one per declaration;
 * a type alias, a package's type or a name that does not bind resolves as a call would.
 */
function heritageFacts(d: Heritable, p: string, sf: TS.SourceFile): Array<Record<string, unknown>> {
  const source = declLocal.get(keyOf(d))
  if (!source) return []
  const out: Array<Record<string, unknown>> = []
  const site = (t: TS.Node) => ({ path: p, range: range(sf, t.getStart(sf), t.getEnd()) })
  for (const h of d.heritageClauses ?? []) {
    const type = ts.isClassDeclaration(d) && h.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'inherits'
    for (const t of h.types) {
      const targets = new Set(heritable(t.expression).map((s) => declLocal.get(keyOf(s))).filter((l): l is string => !!l))
      // A supertype that does not bind keeps the name it is written with, which the gRPC server rule reads (FR403).
      if (!targets.size) { const r = resolveCall(t.expression); out.push({ type, origin: 'semantic_resolver', source: { symbol: source }, site: site(t), ...r, ...(r.resolution === 'unresolved' ? { detail: { name: t.expression.getText(sf) } } : {}) }) }
      for (const target of targets) out.push({ type, origin: 'semantic_resolver', source: { symbol: source }, site: site(t), resolution: 'resolved', target: { symbol: target } })
    }
  }
  return ts.isClassDeclaration(d) && d.heritageClauses ? [...out, ...dispatchFacts(d.members, supertypes(d), p, sf)] : out
}

/**
 * A concrete member `implements` or `overrides` each member of its name that a class or interface above it declares, at any
 * distance, so a call through any of them may dispatch to it. An abstract member links nothing, so it is never a dispatch target, and a
 * static member neither links nor is linked: a call names its class, so it does not dispatch.
 */
// shortcut: a member inherited from a class that does not itself implement the interface is not linked to it; link it when a repository relies on that.
function dispatchFacts(list: readonly (TS.ClassElement | TS.ObjectLiteralElementLike)[], above: Set<Heritable>, p: string, sf: TS.SourceFile): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [], done = new Set<string>()
  for (const m of list) {
    const member = declLocal.get(keyOf(m))
    if (!member || !m.name || (ts.isMethodDeclaration(m) && !m.body) || hasModifier(m, ts.SyntaxKind.AbstractKeyword) || hasModifier(m, ts.SyntaxKind.StaticKeyword) || done.has(member)) continue
    done.add(member) // a get/set pair is one member: link it once, at its first accessor
    const name = m.name.getText(sf), linked = new Set<string>()
    for (const s of above) {
      for (const x of s.members as TS.NodeArray<TS.ClassElement | TS.TypeElement>) {
        const target = x.name?.getText() === name && !hasModifier(x, ts.SyntaxKind.StaticKeyword) ? declLocal.get(keyOf(x)) : undefined
        if (!target || linked.has(target)) continue
        linked.add(target)
        out.push({ type: ts.isInterfaceDeclaration(s) ? 'implements' : 'overrides', origin: 'semantic_resolver', source: { symbol: member }, site: { path: p, range: range(sf, m.name.getStart(sf), m.name.getEnd()) }, resolution: 'resolved', target: { symbol: target } })
      }
    }
  }
  return out
}

/** An object literal held by a named module-level constant typed as an interface or class: its members may be dispatched to like a class's. */
function literalFacts(d: TS.VariableDeclaration, p: string, sf: TS.SourceFile): Array<Record<string, unknown>> {
  if (!d.type || !ts.isTypeReferenceNode(d.type) || !d.initializer || !ts.isObjectLiteralExpression(d.initializer) || !declLocal.has(keyOf(d))) return []
  const above = new Set<Heritable>()
  for (const s of heritable(d.type.typeName)) { above.add(s); supertypes(s, above) }
  return dispatchFacts(d.initializer.properties, above, p, sf)
}

/**
 * The repository function, method or variable a shorthand destructuring binds (`const { escape } = driver` binds `Driver.escape`):
 * the local is that member under its own name, so the language service renames both together.
 */
function boundMember(decl: TS.Node | undefined): string | undefined {
  if (!decl || !ts.isBindingElement(decl) || decl.propertyName || !ts.isIdentifier(decl.name) || !ts.isObjectBindingPattern(decl.parent)) return undefined
  for (const d of checker.getTypeAtLocation(decl.parent).getProperty(decl.name.text)?.declarations ?? []) {
    const local = declLocal.get(keyOf(d))
    if (local && /^(variable|function|method)#/.test(local.slice(rel(d.getSourceFile().fileName).length + 1))) return local
  }
  return undefined
}

/**
 * A use of a repository class, interface, enum or type alias other than its declaration or an import or export specifier, and how
 * it is used: a heritage clause (`implements`, `extends`), `typeof`, a type (annotations, generics, `satisfies`, `as`), `new`, or a value.
 * Also a use of a repository variable, read or assigned, or a function or method used as a value without being called, as a `value` use,
 * or named in a type query, as a `typeof` use.
 */
function referenceOf(id: TS.Identifier): { target: string; use: string } | undefined {
  const p = id.parent
  // A shorthand destructuring (`const { escape } = driver`) names the member it reads, as a value use of that member.
  if (ts.isBindingElement(p) && p.name === id) {
    const member = refNames.has(id.text) ? boundMember(p) : undefined
    return member ? { target: member, use: 'value' } : undefined
  }
  // A shorthand property's name is also its value, a use of what it names.
  if (!refNames.has(id.text) || ((p as { name?: TS.Node }).name === id && !ts.isPropertyAccessExpression(p) && !ts.isShorthandPropertyAssignment(p))) return undefined
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isExportAssignment(p)) return undefined
  let n: TS.Node = id
  while (ts.isQualifiedName(n.parent) || (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) n = n.parent
  const at = n.parent
  // A call is a `calls`, not a reference.
  if (ts.isCallExpression(at) && at.expression === n) return undefined
  const use = ts.isExpressionWithTypeArguments(at) && ts.isHeritageClause(at.parent) ? (at.parent.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends')
    : ts.isTypeQueryNode(at) ? 'typeof' : ts.isTypeReferenceNode(at) || ts.isImportTypeNode(at) ? 'type' : ts.isNewExpression(at) && at.expression === n ? 'create' : 'value'
  // A name that is both a value and a type (a constant and the type inferred from it) means the value outside type positions.
  const sym = aliased(ts.isShorthandPropertyAssignment(p) ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(id))
  const member = use === 'value' ? boundMember(sym?.valueDeclaration) : undefined
  if (member) return { target: member, use }
  const decls = use === 'value' || use === 'create' || use === 'typeof' ? [sym?.valueDeclaration] : sym?.declarations ?? []
  const decl = decls.find((d) => !!d && (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isEnumDeclaration(d) || ts.isTypeAliasDeclaration(d)))
  const target = decl && declLocal.get(keyOf(decl))
  if (target) return { target, use }
  // A function component's JSX tag is a `renders`, not a reference.
  if ((use !== 'value' && use !== 'typeof') || ((ts.isJsxOpeningLikeElement(at) || ts.isJsxClosingElement(at)) && at.tagName === n)) return undefined
  for (const d of sym?.declarations ?? []) {
    const local = declLocal.get(keyOf(d))
    if (local && /^(variable|function|method)#/.test(local.slice(rel(d.getSourceFile().fileName).length + 1))) return { target: local, use }
  }
  return undefined
}

/**
 * A Prisma schema's models and views (A36), each named as the syntax tier's Prisma rule names its table: the first string of `@@map`, else
 * the model's name, in the schema `@@schema` names. Keyed by the Prisma Client accessor, the name with a lower-case first letter; the first
 * declaration of a name in path order wins.
 */
// shortcut: one map for every schema in the repository, so two clients whose schemas share a model name both resolve to the first; read the
// generator's output path to tell clients apart when a repository does that.
function readPrismaSchema(text: string): void {
  // Strings and comments become spaces, keeping offsets, so braces and attributes inside them are not read as structure.
  const code = text.replace(/"(?:[^"\\\n]|\\.)*"|\/\/.*/g, (m) => (m[0] === '"' ? `"${' '.repeat(m.length - 2)}"` : ' '.repeat(m.length)))
  let end = 0
  for (const m of code.matchAll(/^[ \t]*(?:model|view)[ \t]+(\w+)[ \t]*\{/gm)) {
    if (m.index < end) continue
    let depth = 1
    for (end = m.index + m[0].length; end < code.length && depth; end++) depth += code[end] === '{' ? 1 : code[end] === '}' ? -1 : 0
    const literal = (attribute: string) => {
      const at = new RegExp(`@@${attribute}\\s*\\([^)]*\\)`).exec(code.slice(m.index, end))
      return at ? /"((?:[^"\\\n]|\\.)*)"/.exec(text.slice(m.index + at.index, m.index + at.index + at[0].length))?.[1] : undefined
    }
    const model = m[1]!, name = literal('map') ?? model, schema = literal('schema')
    const accessor = model[0]!.toLowerCase() + model.slice(1)
    if (!prismaTables.has(accessor)) prismaTables.set(accessor, { qualified: schema ? `${schema}.${name}` : name, name })
  }
}

/** Whether an expression names `@prisma/client`'s PrismaClient, by its import's specifier, so the package need not be installed. */
const isPrismaClientName = (e: TS.Node) => {
  const imported = ts.isIdentifier(e) ? importedCallee(e) : undefined
  return imported?.module === '@prisma/client' && imported.name === 'PrismaClient'
}

/** Whether a type or class name is PrismaClient or a repository class whose extends chain reaches it, as NestJS's `PrismaService` does. */
function isPrismaClientType(e: TS.Node, seen = new Set<TS.Node>()): boolean {
  if (isPrismaClientName(e)) return true
  const cls = aliased(checker.getSymbolAtLocation(e))?.declarations?.find(ts.isClassDeclaration)
  if (!cls || seen.has(cls)) return false
  seen.add(cls)
  const base = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression
  return !!base && isPrismaClientType(base, seen)
}

/**
 * A Prisma Client model access (A36): `client.<accessor>.<operation>(...)`, where the client is a variable, property or parameter declared
 * with the type PrismaClient, or a repository class extending it, or created with `new` of either, also through an import of a module-level client.
 */
// shortcut: a client typed through an alias, a factory's return type or `$extends` is not recognised, nor a transaction's client
// parameter; follow the checker's type when a repository needs them.
function prismaAccess(n: TS.Node): { site: TS.PropertyAccessExpression; accessor: string; operation: string } | undefined {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || !ts.isPropertyAccessExpression(n.expression.expression)) return undefined
  const model = n.expression.expression, client = model.expression
  if (model.name.text.startsWith('$')) return undefined
  const decl = aliased(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(client) ? client.name : client))?.valueDeclaration
  if (!decl || !(ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isParameter(decl))) return undefined
  const typed = !!decl.type && ts.isTypeReferenceNode(decl.type) && isPrismaClientType(decl.type.typeName)
  const created = !!decl.initializer && ts.isNewExpression(decl.initializer) && isPrismaClientType(decl.initializer.expression)
  return typed || created ? { site: n.expression, accessor: model.name.text, operation: n.expression.name.text } : undefined
}

/** A36: a Prisma Client model access references its model's table; an accessor that names no model of the schemas is unresolved. */
function prismaFact(call: TS.CallExpression, p: string, sf: TS.SourceFile): Record<string, unknown> | undefined {
  const access = prismaAccess(call)
  if (!access) return undefined
  const table = prismaTables.get(access.accessor)
  return {
    type: 'references', origin: 'framework_adapter', site: { path: p, range: range(sf, access.site.getStart(sf), access.site.getEnd()) },
    ...(table ? { resolution: 'resolved', target: { symbol: `fw#table#${table.qualified}` } } : { resolution: 'unresolved', reason: 'unknown_name' }),
    detail: { rule: 'prisma_client', accessor: access.accessor, operation: access.operation },
  }
}

// ---- HTTP clients (FR250 to FR252): `fetch` and `axios` calls whose path the code writes as a literal ----
const CLIENT_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
/** A path expression's text with each non-literal part a `{param}`: `known` is false when the expression starts with one (a base URL held in a variable). Undefined for anything that is no string. */
function pathText(e: TS.Expression, depth = 0): { text: string; known: boolean } | undefined {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return pathText(e.expression, depth)
  if (ts.isStringLiteralLike(e)) return { text: e.text, known: true }
  if (ts.isTemplateExpression(e)) {
    // A span that is a module constant is its text; any other is a parameter.
    const spans = e.templateSpans.map((s) => ({ part: pathText(s.expression, depth + 1), after: s.literal.text }))
    return { text: e.head.text + spans.map((s) => `${s.part?.known ? s.part.text : '{param}'}${s.after}`).join(''), known: e.head.text !== '' || !!spans[0]?.part?.known }
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = pathText(e.left, depth), r = pathText(e.right, depth)
    // A string on either side makes `+` concatenation; a side that is no literal stands for one parameter.
    if (!l && !r) return undefined
    const side = (x: { text: string; known: boolean } | undefined) => x ?? { text: '{param}', known: false }
    return { text: side(l).text + side(r).text, known: side(l).known }
  }
  // A module constant, followed a few steps as the Python rule follows one.
  if (ts.isIdentifier(e) && depth < 3) {
    const d = checker.getSymbolAtLocation(e)?.valueDeclaration
    if (d && ts.isVariableDeclaration(d) && d.initializer && ts.isVariableDeclarationList(d.parent) && d.parent.flags & ts.NodeFlags.Const) return pathText(d.initializer, depth + 1)
  }
  return undefined
}
/** An expression without the wrappers that only change its type: parentheses, `as`, `satisfies`, `!` and `<T>`. */
function unwrap(e: TS.Expression | undefined): TS.Expression | undefined {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e))) e = e.expression
  return e
}
const stringProp = (given: TS.Expression | undefined, name: string): { value: TS.Expression } | undefined => {
  const o = unwrap(given)
  if (!o || !ts.isObjectLiteralExpression(o)) return undefined
  const prop = o.properties.find((x): x is TS.PropertyAssignment => ts.isPropertyAssignment(x) && (ts.isIdentifier(x.name) || ts.isStringLiteralLike(x.name)) && x.name.text === name)
  return prop && { value: prop.initializer }
}
/** Whether an identifier is the global `fetch`: nothing in the repository declares it. */
const isGlobal = (id: TS.Identifier) => (checker.getSymbolAtLocation(id)?.declarations ?? []).every((d) => program!.isSourceFileDefaultLibrary(d.getSourceFile()))
/** The axios instance a name is: `axios` itself or a variable initialised by `axios.create(...)`, with the literal `baseURL` of the latter (null when it is not a literal). */
function axiosClient(root: TS.Expression): { base: string | null } | undefined {
  if (!ts.isIdentifier(root)) return undefined
  const imported = importedCallee(root)
  if (imported?.module === 'axios' && imported.name === 'default') return { base: '' }
  const d = checker.getSymbolAtLocation(root)?.valueDeclaration
  const init = d && ts.isVariableDeclaration(d) ? d.initializer : undefined
  if (!init || !ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression) || init.expression.name.text !== 'create') return undefined
  const made = axiosClient(init.expression.expression)
  if (!made) return undefined
  const base = stringProp(init.arguments[0], 'baseURL')?.value, text = base && pathText(base)
  return { base: !base ? '' : text && text.known ? text.text : null }
}
/** The endpoint `VERB path` a `fetch` or `axios` call names, as the Python client rule names it: no scheme, host, query or outer slash, each interpolation a `{param}`. */
function httpClient(call: TS.CallExpression): { endpoint: string; rule: 'fetch_client' | 'axios_client'; prefixUnknown: boolean } | undefined {
  const callee = call.expression, args = call.arguments
  let rule: 'fetch_client' | 'axios_client', verb = 'GET', target: TS.Expression | undefined, config: TS.Expression | undefined, base: string | null = ''
  if (ts.isIdentifier(callee) && callee.text === 'fetch' && isGlobal(callee)) { rule = 'fetch_client'; target = args[0]; config = args[1] }
  else {
    const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined
    const client = axiosClient(ts.isPropertyAccessExpression(callee) ? callee.expression : callee)
    if (!client) return undefined
    rule = 'axios_client'; base = client.base
    const object = unwrap(args[0]) && ts.isObjectLiteralExpression(unwrap(args[0])!) ? unwrap(args[0]) : undefined
    if (method && CLIENT_VERBS.has(method)) { verb = method.toUpperCase(); target = args[0] }
    else if (method === 'request' || !method) { target = object ? stringProp(object, 'url')?.value : args[0]; config = object ?? args[1] }
    else return undefined
  }
  const m = stringProp(config, 'method')?.value
  if (m) verb = ts.isStringLiteralLike(m) ? m.text.toUpperCase() : 'ANY'
  const written = target && pathText(target)
  if (!written) return undefined
  // A leading interpolation, or a base the client does not state, is a prefix the code does not say.
  let text = written.text
  const prefixUnknown = !written.known || base === null
  if (!written.known) text = text.replace(/^(?:\{param\})+/, '')
  else if (base) text = `${base.replace(/\/+$/, '')}/${text.replace(/^\/+/, '')}`
  // A path starts with `/` or a scheme, or is relative to a base URL and shaped like a route (`rates/add`); a prefix we do not know needs the `/` that ends it.
  if (!(/^(\/|https?:\/\/)/.test(text) || (!prefixUnknown && /^[\w.{}-]+(\/[\w.{}-]+)+(\?|$)/.test(text)))) return undefined
  const clean = text.replace(/^https?:\/\/[^/]*/, '').split(/[?#]/)[0]!.replace(/^\/+|\/+$/g, '')
  return clean ? { endpoint: `${verb} ${clean}`, rule, prefixUnknown } : undefined
}

const EXPRESS_VERBS = new Map([['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['delete', 'DELETE'], ['options', 'OPTIONS'], ['head', 'HEAD'], ['all', 'ANY']])
const NEST_VERBS = new Map([['Get', 'GET'], ['Post', 'POST'], ['Put', 'PUT'], ['Patch', 'PATCH'], ['Delete', 'DELETE'], ['Options', 'OPTIONS'], ['Head', 'HEAD'], ['All', 'ANY']])

/** A call that may register an Express route (a path and a handler) or mount a router, or a class that may be a NestJS controller. */
function isRouteSite(n: TS.Node): n is TS.CallExpression | TS.ClassDeclaration {
  if (ts.isClassDeclaration(n)) return !!ts.getDecorators(n)?.length
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return false
  // `app.get('env')` reads a setting: a route has a path and at least one handler.
  return n.expression.name.text === 'use' ? n.arguments.length > 0 : EXPRESS_VERBS.has(n.expression.name.text) && n.arguments.length > 1
}

/** A route path argument's strings: a string literal, or an array of them as Express and NestJS both accept; undefined for anything else. */
function literalPaths(e: TS.Expression): string[] | undefined {
  const items = ts.isArrayLiteralExpression(e) ? [...e.elements] : [e]
  return items.every((i) => ts.isStringLiteralLike(i)) ? items.map((i) => (i as TS.StringLiteralLike).text) : undefined
}
const joinPath = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`
/** An endpoint's qualified name as the C# rules write it: the verb, then the path without outer slashes, each `:param` written `{param}`. */
const endpointName = (verb: string, route: string) => `${verb} ${route.replace(/:(\w+)(?:\([^)]*\))?(\??)/g, '{$1$2}').replace(/^\/+|\/+$/g, '') || '/'}`

/** The variable holding an Express application or router that an expression names, followed through imports and default exports. */
function expressReceiver(e: TS.Expression): { key: string; kind: 'app' | 'router' } | undefined {
  if (!ts.isIdentifier(e)) return undefined
  const sym = aliased(checker.getSymbolAtLocation(e)), decl = sym?.valueDeclaration ?? sym?.declarations?.[0]
  if (decl && ts.isExportAssignment(decl)) return expressReceiver(decl.expression)
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isCallExpression(decl.initializer)) return undefined
  const callee = importedCallee(decl.initializer.expression)
  const kind = callee?.module !== 'express' ? undefined : callee.name === 'default' ? 'app' : callee.name === 'Router' ? 'router' : undefined
  return kind && { key: keyOf(decl), kind }
}

/** The code an Express route runs: its last handler, named or inline (an inline one becomes a function symbol, as A5 makes function-valued variables), else the code that registers it. */
function expressHandler(call: TS.CallExpression, file: string): string {
  const last = call.arguments[call.arguments.length - 1]!, sf = call.getSourceFile()
  if (isFunctionLike(last)) {
    const known = declLocal.get(keyOf(last))
    if (known) return known
    const name = `${call.expression.getText(sf)}(${call.arguments[0]!.getText(sf)})`, qualified = `${noExt(file)}:${name}`
    const r = range(sf, last.getStart(sf), last.getEnd()), local = `${file}#function#${qualified}#${r.start_byte}`
    declLocal.set(keyOf(last), local)
    symbolsByFile.get(file)!.push({ local_id: local, path: file, kind: 'function', name, qualified_name: qualified, range: r, signature: signatureOf(name, last as TS.ArrowFunction) })
    return local
  }
  const named = resolveCall(last)
  return named.resolution === 'resolved' && named.target && 'symbol' in named.target ? named.target.symbol : owner(call)!
}

/** A route as written: its site, verb, paths (undefined when not literal), the receiver whose mounts prefix it, and the code it runs. */
type RouteSite = { file: string; site: TS.Node; verb: string; paths: string[] | undefined; receiver?: string; handler: string; rule: 'express_route' | 'nestjs_route' }

/** NestJS: each verb decorator on a method of a `@Controller` class, under each of the controller's paths. */
function nestRoutes(cls: TS.ClassDeclaration, file: string): RouteSite[] {
  const controller = (ts.getDecorators(cls) ?? []).map((d) => importedDecorator(d, '@nestjs/common')).find((d) => d?.name === 'Controller')
  if (!controller) return []
  const pathsOf = (call: TS.CallExpression) => (call.arguments[0] ? literalPaths(call.arguments[0]) : [''])
  const prefixes = pathsOf(controller.call)
  return cls.members.flatMap((m) => {
    const handler = declLocal.get(keyOf(m))
    return !handler || !ts.canHaveDecorators(m) ? [] : (ts.getDecorators(m) ?? []).flatMap((d): RouteSite[] => {
      const route = importedDecorator(d, '@nestjs/common'), verb = route && NEST_VERBS.get(route.name)
      if (!route || !verb) return []
      const paths = pathsOf(route.call)
      return [{ file, site: route.call, verb, paths: prefixes && paths && prefixes.flatMap((pre) => paths.map((p) => joinPath(pre, p))), handler, rule: 'nestjs_route' }]
    })
  })
}

/**
 * Inbound HTTP endpoints (A7, A9) with the C# rules' fact shapes: each endpoint, named by verb and path, exposes the code that handles it,
 * declared once at its first site in index order. Express: `<verb>(path, ...handlers)` on a value of `express()` or `express.Router()`,
 * under every chain of `use(prefix, router)` mounts up to an application. NestJS: the verb decorators of a `@Controller` class's methods.
 * A path or mount prefix that is not a string literal, or a router no application mounts, leaves the handler's exposes unresolved.
 */
// shortcut: `app.route(path).get(...)`, receivers that are parameters or properties, CommonJS `require('express')`, and NestJS's global
// prefix and RouterModule are not modelled; add them when a repository relies on them.
function indexRoutes(): void {
  const routes: RouteSite[] = [], receivers = new Map<string, 'app' | 'router'>()
  const mounts: Array<{ parent: string; child: string; prefixes: string[] | undefined }> = []
  for (const node of routeSites) {
    const file = rel(node.getSourceFile().fileName)
    use(projectOf.get(file)!)
    if (ts.isClassDeclaration(node)) { routes.push(...nestRoutes(node, file)); continue }
    const access = node.expression as TS.PropertyAccessExpression, recv = expressReceiver(access.expression), args = node.arguments
    if (!recv) continue
    receivers.set(recv.key, recv.kind)
    if (access.name.text !== 'use') {
      routes.push({ file, site: node, verb: EXPRESS_VERBS.get(access.name.text)!, paths: literalPaths(args[0]!), receiver: recv.key, handler: expressHandler(node, file), rule: 'express_route' })
      continue
    }
    // A leading string is the mount path; without one, every router passed is mounted at the receiver's own path.
    const first = args[0]!, prefixed = literalPaths(first) !== undefined || !!(checker.getTypeAtLocation(first).flags & ts.TypeFlags.StringLike)
    for (const a of prefixed ? args.slice(1) : args) {
      const child = expressReceiver(a)
      if (child) { receivers.set(child.key, child.kind); mounts.push({ parent: recv.key, child: child.key, prefixes: prefixed ? literalPaths(first) : [''] }) }
    }
  }
  /** The paths a receiver serves under, one per chain of mounts up to an application; null where a prefix is not a literal. */
  const prefixesOf = (key: string, seen: Set<string>): Array<string | null> => {
    const parents = mounts.filter((m) => m.child === key)
    if (!parents.length) return receivers.get(key) === 'app' ? [''] : []
    return parents.flatMap((m) => (seen.has(m.parent) ? [] : !m.prefixes ? [null] : prefixesOf(m.parent, new Set([...seen, m.parent])).flatMap((outer) => (outer === null ? [null] : m.prefixes!.map((p) => joinPath(outer, p))))))
  }
  const declared = new Set<string>()
  for (const r of routes) {
    const sf = r.site.getSourceFile(), site = { path: r.file, range: range(sf, r.site.getStart(sf), r.site.getEnd()) }
    const facts = routeFacts.get(r.file) ?? routeFacts.set(r.file, []).get(r.file)!
    const unresolved = (why: string) => facts.push({ type: 'exposes', origin: 'framework_adapter', source: { symbol: r.handler }, site, resolution: 'unresolved', reason: 'outside_capability', detail: { rule: r.rule, why } })
    if (!r.paths) { unresolved('the route path is not a string literal'); continue }
    const prefixes = r.receiver ? prefixesOf(r.receiver, new Set([r.receiver])) : ['']
    if (!prefixes.length) unresolved('no application mounts the router where the rules can read it')
    if (prefixes.includes(null)) unresolved('a mount prefix is not a string literal')
    for (const name of new Set(prefixes.flatMap((pre) => (pre === null ? [] : r.paths!.map((p) => endpointName(r.verb, joinPath(pre, p))))))) {
      const id = `fw#endpoint#${name}`
      if (!declared.has(id)) { declared.add(id); symbolsByFile.get(r.file)!.push({ local_id: id, path: r.file, kind: 'endpoint', name, qualified_name: name, range: site.range, signature: null }) }
      facts.push({ type: 'exposes', origin: 'framework_adapter', source: { symbol: id }, site, resolution: 'resolved', target: { symbol: r.handler }, detail: { rule: r.rule } })
    }
  }
}

const GRAPHQL_ROOTS = new Set(['Query', 'Mutation', 'Subscription'])
const keyName = (n: TS.PropertyName, sf: TS.SourceFile) => n.getText(sf).replace(/^['"]|['"]$/g, '')

/**
 * GraphQL resolver maps (FR402): each function of a `Query`, `Mutation` or `Subscription` object in an object literal is the resolver of the
 * root field it is keyed by, so an endpoint `graphql <Root>.<field>` exposes it, rule graphql_resolver_map. An inline function becomes a
 * function symbol named by the keys down to it, as an inline route handler does; a named one is the function its name resolves to.
 */
// shortcut: shorthand properties and `{ resolve }` objects are not read; add them when a repository relies on them.
function indexResolvers(): void {
  for (const root of resolverRoots) {
    const sf = root.getSourceFile(), file = rel(sf.fileName)
    use(projectOf.get(file)!)
    const keys: string[] = []
    for (let n: TS.Node = root; !ts.isSourceFile(n); n = n.parent) {
      if (ts.isPropertyAssignment(n)) keys.unshift(keyName(n.name, sf))
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) { keys.unshift(n.name.text); break }
    }
    for (const m of (root.initializer as TS.ObjectLiteralExpression).properties) {
      if (!m.name || !(ts.isMethodDeclaration(m) || ts.isPropertyAssignment(m))) continue
      const field = keyName(m.name, sf), fn = ts.isMethodDeclaration(m) ? m : m.initializer
      let handler = declLocal.get(keyOf(fn))
      if (!handler && (ts.isMethodDeclaration(fn) || isFunctionLike(fn))) {
        const qualified = `${noExt(file)}:${[...keys, field].join('.')}`, r = range(sf, fn.getStart(sf), fn.getEnd())
        handler = `${file}#function#${qualified}#${r.start_byte}`
        declLocal.set(keyOf(fn), handler)
        symbolsByFile.get(file)!.push({ local_id: handler, path: file, kind: 'function', name: field, qualified_name: qualified, range: r, signature: signatureOf(field, fn as TS.ArrowFunction) })
      } else if (!handler && (ts.isIdentifier(fn) || ts.isPropertyAccessExpression(fn))) {
        const named = resolveCall(fn)
        if (named.resolution === 'resolved' && named.target && 'symbol' in named.target) handler = named.target.symbol
      }
      if (!handler) continue
      const name = `graphql ${keyName(root.name, sf)}.${field}`, id = `${file}#resolver#${name}#${m.getStart(sf)}`, site = { path: file, range: range(sf, m.getStart(sf), m.getEnd()) }
      symbolsByFile.get(file)!.push({ local_id: id, path: file, kind: 'endpoint', name: name.slice('graphql '.length), qualified_name: name, range: site.range, signature: null })
      const facts = routeFacts.get(file) ?? routeFacts.set(file, []).get(file)!
      facts.push({ type: 'exposes', origin: 'framework_adapter', source: { symbol: id }, site, resolution: 'resolved', target: { symbol: handler }, detail: { rule: 'graphql_resolver_map' } })
    }
  }
}

/** The text of a `gql` or `graphql` tagged template, each substitution blanked so offsets stay those of the source, and where it starts. */
function graphqlTemplate(node: TS.TaggedTemplateExpression, sf: TS.SourceFile): { text: string; at: number } | undefined {
  const tag = ts.isIdentifier(node.tag) ? node.tag.text : ts.isPropertyAccessExpression(node.tag) ? node.tag.name.text : ''
  if (tag !== 'gql' && tag !== 'graphql') return undefined
  const t = node.template, at = t.getStart(sf) + 1
  let text = sf.text.slice(at, t.getEnd() - 1)
  if (ts.isTemplateExpression(t)) for (const span of t.templateSpans) {
    const from = span.expression.getFullStart() - 2 - at, to = span.literal.getStart(sf) + 1 - at
    text = text.slice(0, from) + ' '.repeat(to - from) + text.slice(to)
  }
  return { text, at }
}

function owner(node: TS.Node): string | undefined {
  for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
    const local = declLocal.get(keyOf(n))
    if (local) return local
  }
  return undefined
}

function classify(callee: TS.Expression): string {
  if (ts.isElementAccessExpression(callee) && !ts.isStringLiteralLike(callee.argumentExpression)) return 'dynamic_element_access'
  // A call through a name imported from a module that does not resolve is blamed on the missing package, or on the broken import.
  let root: TS.Expression = callee
  while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root) || ts.isElementAccessExpression(root)) root = root.expression
  const missing = ts.isIdentifier(root) ? unresolvedImport(root) : undefined
  if (missing !== undefined) return missing.startsWith('.') || missing.startsWith('/') ? 'import_unresolved' : 'dependency_missing'
  if (ts.isPropertyAccessExpression(callee)) {
    if (ts.isCallExpression(callee.expression)) return 'chained_callee'
    return checker.getTypeAtLocation(callee.expression).flags & ts.TypeFlags.Any ? 'untyped_receiver' : 'outside_capability'
  }
  return ts.isIdentifier(callee) ? 'unknown_name' : 'outside_capability'
}

function resolveCall(callee: TS.Expression): { resolution: string; target?: Ref; reason?: string; candidates?: string[] } {
  if (ts.isElementAccessExpression(callee) && !ts.isStringLiteralLike(callee.argumentExpression)) return { resolution: 'unresolved', reason: 'dynamic_element_access' }
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isElementAccessExpression(callee) ? callee.argumentExpression : callee
  let sym = checker.getSymbolAtLocation(nameNode)
  if (sym && sym.flags & ts.SymbolFlags.Alias) {
    try { sym = checker.getAliasedSymbol(sym) } catch { /* keep the alias */ }
  }
  const decls = sym?.declarations ?? []
  if (!sym || !decls.length) return { resolution: 'unresolved', reason: classify(callee) }
  const member = boundMember(sym.valueDeclaration)
  if (member) return { resolution: 'resolved', target: { symbol: member } }
  const first = decls[0]!
  if (!inWorkspace(first.getSourceFile().fileName)) {
    return { resolution: 'resolved_external', target: externalRef(sym, first) }
  }
  const targets = new Set<string>()
  for (const d of decls) {
    for (let n: TS.Node | undefined = d; n; n = n.parent) {
      const local = declLocal.get(keyOf(n))
      if (local) { targets.add(local); break }
    }
  }
  const list = [...targets]
  if (list.length === 1) return { resolution: 'resolved', target: { symbol: list[0]! } }
  if (list.length > 1) return { resolution: 'ambiguous', reason: 'outside_capability', candidates: list.sort() }
  return { resolution: 'unresolved', reason: 'outside_capability' }
}

const calleeName = (e: TS.Expression) => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '')
const aliased = (sym: TS.Symbol | undefined) => {
  if (sym && sym.flags & ts.SymbolFlags.Alias) { try { return checker.getAliasedSymbol(sym) } catch { /* keep the alias */ } }
  return sym
}
type Resolution = { resolution: string; target?: Ref; reason?: string }

/** The local or external symbol a declaration names, as a resolved target. */
function targetOf(sym: TS.Symbol, decl: TS.Declaration): Resolution {
  if (!inWorkspace(decl.getSourceFile().fileName)) return { resolution: 'resolved_external', target: externalRef(sym, decl) }
  const local = declLocal.get(keyOf(decl))
  return local ? { resolution: 'resolved', target: { symbol: local } } : { resolution: 'unresolved', reason: 'outside_capability' }
}

/** A context: an expression whose value comes from `createContext(...)`. */
function contextOf(expr: TS.Expression): Resolution | undefined {
  const sym = aliased(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr))
  const decl = sym?.declarations?.[0]
  if (!sym || !decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isCallExpression(decl.initializer) || calleeName(decl.initializer.expression) !== 'createContext') return undefined
  return targetOf(sym, decl)
}

/** The component behind `lazy(() => import('./Module'))`: that module's default export. */
function lazyComponent(tag: TS.Expression): Resolution | undefined {
  const decl = aliased(checker.getSymbolAtLocation(tag))?.declarations?.[0]
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isCallExpression(decl.initializer) || calleeName(decl.initializer.expression) !== 'lazy') return undefined
  let spec: TS.StringLiteral | undefined
  const find = (n: TS.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) spec = n.arguments[0]
    else ts.forEachChild(n, find)
  }
  if (decl.initializer.arguments[0]) find(decl.initializer.arguments[0])
  if (!spec) return undefined
  const mod = checker.getSymbolAtLocation(spec)
  if (!mod) return { resolution: 'unresolved', reason: spec.text.startsWith('.') ? 'import_unresolved' : 'dependency_missing' }
  const def = aliased(checker.getExportsOfModule(mod).find((e) => e.escapedName === 'default'))
  const target = def?.declarations?.[0]
  return def && target ? targetOf(def, target) : { resolution: 'unresolved', reason: 'outside_capability' }
}

/**
 * React (FR078): what a JSX element means. A lowercase tag is a DOM element and says nothing. `<C.Provider>` provides context C and
 * `<C.Consumer>` reads it; `<C>` whose value comes from createContext provides it, as React 19 allows. Any other tag renders the component
 * it names, through `lazy(() => import(...))` to that module's default export; the props it passes are listed.
 */
function jsxFact(node: TS.JsxOpeningElement | TS.JsxSelfClosingElement): Record<string, unknown> | undefined {
  const tag = node.tagName
  if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) return undefined
  if (!ts.isIdentifier(tag) && !ts.isPropertyAccessExpression(tag)) return undefined
  if (ts.isPropertyAccessExpression(tag) && (tag.name.text === 'Provider' || tag.name.text === 'Consumer')) {
    const context = contextOf(tag.expression)
    if (context) return { type: tag.name.text === 'Provider' ? 'provides_context' : 'uses_context', ...context, detail: { rule: tag.name.text } }
  }
  const direct = contextOf(tag)
  if (direct) return { type: 'provides_context', ...direct, detail: { rule: 'Provider' } }
  const props = node.attributes.properties.flatMap((a) => (ts.isJsxAttribute(a) ? [a.name.getText()] : [])).sort().join(',')
  const lazy = lazyComponent(tag)
  const r = lazy ?? resolveCall(tag)
  return { type: 'renders', ...r, detail: { rule: lazy ? 'lazy' : 'jsx', ...(props ? { props } : {}) } }
}

/** React (FR078): a call to a hook. `useContext(C)` reads context C; any other `use…` call uses that hook. */
function hookFact(call: TS.CallExpression): Record<string, unknown> | undefined {
  const name = calleeName(call.expression)
  if (!/^use[A-Z0-9]/.test(name)) return undefined
  if (name === 'useContext') {
    const context = call.arguments[0] ? contextOf(call.arguments[0]) : undefined
    return { type: 'uses_context', ...(context ?? { resolution: 'unresolved', reason: 'outside_capability' }), detail: { rule: 'useContext' } }
  }
  return { type: 'uses_hook', ...resolveCall(call.expression), detail: { rule: 'hook' } }
}

const BUILTINS = new Set(builtinModules)

/** Whether a tsconfig `paths` key, exact or with one `*`, matches a specifier. */
const mapsName = (paths: TS.MapLike<string[]> | undefined, spec: string) => Object.keys(paths ?? {}).some((k) => {
  const star = k.indexOf('*')
  return star < 0 ? k === spec : spec.length >= k.length - 1 && spec.startsWith(k.slice(0, star)) && spec.endsWith(k.slice(star + 1))
})

/** What an import specifier names: a Node.js built-in (FR093), a file this adapter indexes, a package, or why none of them. */
function importTarget(spec: string, p: string, sf: TS.SourceFile, project: Project): Resolution {
  const resolve = () => ts.resolveModuleName(spec, sf.fileName, program!.getCompilerOptions(), project.host).resolvedModule
  // A built-in, unless an explicit tsconfig paths entry maps its name to a repository file, which tsc and editors then read.
  if (spec.startsWith('node:') || BUILTINS.has(spec)) {
    const mapped = mapsName(program!.getCompilerOptions().paths, spec) ? resolve() : undefined
    if (!mapped || !inWorkspace(mapped.resolvedFileName)) return { resolution: 'resolved_external', target: { external: { module: `node:${spec.replace(/^node:/, '')}`, name: '*' } } }
  }
  // shortcut: the adapter sees only the files it was given, so a JSON file that does not exist is also not_indexed; ask the core for the inventory if that matters.
  if (spec.startsWith('.') && spec.endsWith('.json')) {
    const file = path.posix.join(path.posix.dirname(p), spec)
    return files.some((f) => f.path === file) ? { resolution: 'resolved', target: { file } } : { resolution: 'unresolved', reason: 'not_indexed' }
  }
  const resolved = resolve()
  if (!resolved) return { resolution: 'unresolved', reason: 'import_unresolved' }
  const file = rel(resolved.resolvedFileName)
  // A file in the repository is never external: indexed, or not_indexed.
  if (inWorkspace(resolved.resolvedFileName)) return files.some((f) => f.path === file) ? { resolution: 'resolved', target: { file } } : { resolution: 'unresolved', reason: 'not_indexed' }
  return { resolution: 'resolved_external', target: { external: { module: spec, name: '*' } } }
}

function analyze(paths: string[]) {
  if (!projects.length) buildProjects()
  const symbols: unknown[] = [], relationships: unknown[] = [], file_results: unknown[] = [], diagnostics: unknown[] = []
  for (const p of paths) {
    const project = projectOf.get(p)
    const sf = project?.program.getSourceFile(path.join(workspace, p))
    if (!project || !sf) {
      file_results.push({ path: p, status: 'failed', detail: 'not_in_program', capabilities: {} })
      continue
    }
    use(project)
    symbols.push(...(symbolsByFile.get(p) ?? []))
    let unresolvedCalls = 0, unresolvedImports = 0, graphqlUnread = 0
    const endpoints = new Set<string>(), clientEndpoints: Array<Record<string, unknown>> = []
    /** One reference per user and target, cited at its first site, with every way the user uses the target and every further site (protocol 1.3). */
    const references = new Map<string, { from: string; target: string; site: TS.Node; more: TS.Node[]; uses: Set<string> }>()
    const visit = (node: TS.Node) => {
      // Every import carries its kind (FR092): import, import type, export ... from, and import() with a literal specifier.
      const kind = ts.isImportDeclaration(node) ? (node.importClause?.isTypeOnly ? 'type_only' : 'static')
        : ts.isExportDeclaration(node) ? (node.isTypeOnly ? 'type_only' : 're_export')
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic' : undefined
      const spec = kind === 'dynamic' ? (node as TS.CallExpression).arguments[0] : kind ? (node as TS.ImportDeclaration | TS.ExportDeclaration).moduleSpecifier : undefined
      if (kind && spec) {
        const r = ts.isStringLiteralLike(spec) ? importTarget(spec.text, p, sf, project) : { resolution: 'unresolved', reason: 'dynamic_specifier' }
        if (r.resolution === 'unresolved') unresolvedImports++
        relationships.push({ type: 'imports', origin: 'semantic_resolver', source: { file: p }, site: { path: p, range: range(sf, node.getStart(sf), node.getEnd()) }, ...r, detail: { kind } })
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const from = owner(node) ?? declLocal.get(keyOf(sf))
        if (from) {
          const r = resolveCall(node.expression)
          const isSelf = r.resolution === 'resolved' && 'symbol' in (r.target ?? {}) && (r.target as { symbol: string }).symbol === from
          if (!isSelf) {
            if (r.resolution !== 'resolved' && r.resolution !== 'resolved_external') unresolvedCalls++
            // A call that does not resolve keeps the name it calls and its argument count, which find its likely targets by name.
            const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : undefined
            const unbound = r.resolution === 'resolved' || r.resolution === 'resolved_external' ? {} : { detail: { ...('detail' in r ? (r.detail as Record<string, string>) : {}), ...(callee ? { callee } : {}), arity: String(node.arguments?.length ?? 0) } }
            relationships.push({ type: 'calls', origin: 'semantic_resolver', source: { symbol: from }, site: { path: p, range: range(sf, node.getStart(sf), node.getEnd()) }, ...r, ...unbound })
          }
          const client = ts.isCallExpression(node) ? httpClient(node) : undefined
          if (client) {
            const r = range(sf, node.getStart(sf), node.getEnd()), local = `${p}#endpoint#${client.endpoint}`
            if (!endpoints.has(local)) { endpoints.add(local); clientEndpoints.push({ local_id: local, path: p, kind: 'endpoint', name: client.endpoint.split(' ')[1]!, qualified_name: client.endpoint, range: r, signature: null }) }
            relationships.push({ type: 'dispatches_to', origin: 'framework_adapter', source: { symbol: from }, site: { path: p, range: r }, resolution: 'resolved', target: { symbol: local }, detail: { direction: 'outbound', rule: client.rule, ...(client.prefixUnknown ? { prefix_unknown: 'true' } : {}) } })
          }
          const hook = ts.isCallExpression(node) ? hookFact(node) : undefined
          if (hook) relationships.push({ origin: 'framework_adapter', source: { symbol: from }, site: { path: p, range: range(sf, node.getStart(sf), node.getEnd()) }, ...hook })
          const prisma = ts.isCallExpression(node) ? prismaFact(node, p, sf) : undefined
          if (prisma) relationships.push({ source: { symbol: from }, ...prisma })
        }
      }
      const gql = ts.isTaggedTemplateExpression(node) ? graphqlTemplate(node, sf) : undefined
      if (gql) {
        // A `gql` template (FR402): an operation dispatches_to each root field it selects, rule graphql_operation; SDL declares its types and root fields.
        const from = owner(node) ?? declLocal.get(keyOf(sf))!
        let doc: ReturnType<typeof graphqlDocument> | undefined
        try { doc = graphqlDocument(gql.text, noExt(p)) } catch (e) { diagnostics.push({ level: 'warning', message: `a gql template that is no GraphQL document is not read: ${(e as Error).message}`, path: p }); graphqlUnread++ }
        for (const c of doc?.contracts ?? []) clientEndpoints.push({ local_id: `${p}#graphql-schema#${c.qualified_name}#${gql.at + c.start}`, path: p, kind: c.kind, name: c.name, qualified_name: c.qualified_name, range: range(sf, gql.at + c.start, gql.at + c.end), signature: c.signature })
        for (const o of doc?.operations ?? []) {
          const r = range(sf, gql.at + o.start, gql.at + o.end), local = `${p}#endpoint#${o.endpoint}`
          if (!endpoints.has(local)) { endpoints.add(local); clientEndpoints.push({ local_id: local, path: p, kind: 'endpoint', name: o.endpoint.slice('graphql '.length), qualified_name: o.endpoint, range: r, signature: null }) }
          relationships.push({ type: 'dispatches_to', origin: 'framework_adapter', source: { symbol: from }, site: { path: p, range: r }, resolution: 'resolved', target: { symbol: local }, detail: { direction: 'outbound', rule: 'graphql_operation' } })
        }
      }
      if (ts.isClassDeclaration(node)) relationships.push(...typeormFacts(node, p, sf))
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) relationships.push(...heritageFacts(node, p, sf))
      if (ts.isVariableDeclaration(node)) relationships.push(...literalFacts(node, p, sf))
      const reference = ts.isIdentifier(node) ? referenceOf(node) : undefined
      const user = reference && (owner(node) ?? declLocal.get(keyOf(sf)))
      if (reference && user && user !== reference.target) {
        const key = `${user}|${reference.target}`
        if (!references.has(key)) references.set(key, { from: user, target: reference.target, site: node, more: [], uses: new Set() }); else references.get(key)!.more.push(node)
        references.get(key)!.uses.add(reference.use)
      }
      const resource = ts.isNewExpression(node) ? resourceLocal.get(keyOf(node)) : undefined
      if (resource) relationships.push(...resourceFacts(node as TS.NewExpression, resource, p, sf))
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const from = owner(node) ?? declLocal.get(keyOf(sf))
        const fact = from ? jsxFact(node) : undefined
        if (fact) relationships.push({ origin: 'framework_adapter', source: { symbol: from }, site: { path: p, range: range(sf, node.getStart(sf), node.getEnd()) }, ...fact })
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    for (const r of references.values()) relationships.push({ type: 'references', origin: 'semantic_resolver', source: { symbol: r.from }, site: { path: p, range: range(sf, r.site.getStart(sf), r.site.getEnd()) }, ...(r.more.length ? { sites: r.more.map((n) => range(sf, n.getStart(sf), n.getEnd())) } : {}), resolution: 'resolved', target: { symbol: r.target }, detail: { use: [...r.uses].sort().join(',') } })
    relationships.push(...(routeFacts.get(p) ?? []))
    symbols.push(...clientEndpoints)
    file_results.push({
      path: p, status: 'ok',
      capabilities: { text: 'complete', syntax: 'complete', symbols: 'complete', imports: unresolvedImports ? 'partial' : 'complete', references: 'partial', resolved_calls: unresolvedCalls ? 'partial' : 'complete', framework: clientEndpoints.length || graphqlUnread ? 'partial' : 'unsupported' },
    })
  }
  return { symbols, relationships, file_results, diagnostics }
}

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let req: { id: number; method: string; params: any }
  try { req = JSON.parse(line) } catch { return }
  try {
    if (req.method === 'initialize') {
      workspace = req.params.workspace
      repoRoot = req.params.repository_root ?? ''
      files = req.params.files
      // Built now, not at the first analyze, so the manifest lists exactly the packages the analysis reads.
      buildProjects()
      send({ jsonrpc: '2.0', id: req.id, result: {
        adapter: { id: 'typescript', version: VERSION, protocol_version: '1.3', languages: ['typescript', 'javascript'], toolchain: { typescript: ts.version } },
        capabilities: { syntax: true, symbols: true, imports: true, resolved_calls: true, references: true, framework: false },
        external_inputs: externalInputs,
      } })
    } else if (req.method === 'workspace') {
      // Every fact this adapter produces belongs to one analysed file.
      send({ jsonrpc: '2.0', id: req.id, result: { symbols: [], relationships: [], file_results: [], diagnostics: [] } })
    } else if (req.method === 'analyze') {
      send({ jsonrpc: '2.0', id: req.id, result: analyze(req.params.paths) })
    } else if (req.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: req.id, result: {} })
      process.exit(0)
    } else {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } })
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } })
  }
})
