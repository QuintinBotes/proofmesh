// The Python adapter: declarations and imports from Tree-sitter, and every call's target from Pyright's language server, which
// never runs Python. Pyright is started with no interpreter on its path, so it reads the workspace, its bundled standard library
// stubs, and the repository's installed packages when a virtual environment holds them, and imports nothing.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createRequire } from 'node:module'
import { Parser, type Node } from 'web-tree-sitter'
import { byteOffsets, lastLine, parser, send, toolchain, type Range } from './common.js'

const VERSION = '0.1.0'
type Sym = { local_id: string; path: string; kind: string; name: string; qualified_name: string; range: Range; signature: string | null; roles?: string[] }
type Location = { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetSelectionRange?: { start: { line: number; character: number } } }

let workspace = ''
let pythonFiles = new Set<string>()
let sitePackages: string | null = null
let shadow: string | null = null
let extraPaths: string[] = []
let installed = new Set<string>()
const pyrightRoot = path.dirname(createRequire(import.meta.url).resolve('pyright/package.json'))
const pyrightVersion = JSON.parse(fs.readFileSync(path.join(pyrightRoot, 'package.json'), 'utf8')).version as string
const typeshed = path.join(pyrightRoot, 'dist', 'typeshed-fallback')

// ---- Pyright over the Language Server Protocol ----
let server: ChildProcess
let buffer = Buffer.alloc(0), nextId = 1
const pending = new Map<number, (v: unknown) => void>()
// Untyped code can make Pyright infer return types across the whole program for one definition request; PROOFMESH_PYRIGHT_UNANNOTATED=off
// tells it not to analyse unannotated function bodies, trading some resolution inside them for bounded time.
const settings = () => ({ typeCheckingMode: 'off', diagnosticMode: 'openFilesOnly', autoSearchPaths: false, extraPaths, analyzeUnannotatedFunctions: process.env.PROOFMESH_PYRIGHT_UNANNOTATED !== 'off' })
function write(m: unknown) { const s = JSON.stringify(m); server.stdin!.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`) }
/** How long one Pyright request may take before its call is reported unresolved; a stuck request must not stall the whole index. */
const REQUEST_MS = 60000
let timedOut = 0
function request<T>(method: string, params: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    const id = nextId++
    const timer = setTimeout(() => { if (pending.delete(id)) { timedOut++; resolve(null) } }, REQUEST_MS)
    pending.set(id, (v) => { clearTimeout(timer); resolve(v as T) })
    write({ jsonrpc: '2.0', id, method, params })
  })
}
const notify = (method: string, params: unknown) => write({ jsonrpc: '2.0', method, params })
function startPyright() {
  // An empty path: Pyright is started by its full path and finds no interpreter to run, so no start-up file of any environment executes (D14).
  server = spawn(process.execPath, [path.join(pyrightRoot, 'langserver.index.js'), '--stdio'], { env: { PATH: '', HOME: process.env.HOME ?? '' }, stdio: ['pipe', 'pipe', 'ignore'] })
  server.stdout!.on('data', (d: Buffer) => {
    buffer = Buffer.concat([buffer, d])
    for (;;) {
      const h = buffer.indexOf('\r\n\r\n'); if (h < 0) return
      const len = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, h).toString())![1])
      if (buffer.length < h + 4 + len) return
      const msg = JSON.parse(buffer.subarray(h + 4, h + 4 + len).toString()); buffer = buffer.subarray(h + 4 + len)
      if (msg.id !== undefined && !msg.method && pending.has(msg.id)) { pending.get(msg.id)!(msg.result ?? null); pending.delete(msg.id) }
      else if (msg.method === 'workspace/configuration') write({ jsonrpc: '2.0', id: msg.id, result: msg.params.items.map((i: { section?: string }) => (i.section === 'python.analysis' ? settings() : i.section === 'python' ? { analysis: settings() } : {})) })
      else if (msg.id !== undefined && msg.method) write({ jsonrpc: '2.0', id: msg.id, result: null })
    }
  })
}

// ---- Declarations ----
type FileFacts = { text: string; at: Uint32Array; tree: { rootNode: Node }; symbols: Sym[]; byName: Map<string, string>; classes: Map<string, Node>; constants: Map<string, string> }
const facts = new Map<string, Promise<FileFacts>>()
const moduleOf = (file: string) => file.replace(/\.pyi?$/, '')

function rangeOf(f: { at: Uint32Array }, n: Node): Range {
  return { start_byte: f.at[n.startIndex]!, end_byte: Math.max(f.at[n.endIndex]!, f.at[n.startIndex]! + 1), start_line: n.startPosition.row + 1, end_line: n.endPosition.row + 1 }
}

/** A definition's header as written, up to the colon that opens its body, on one line. */
function header(n: Node): string {
  const body = n.childForFieldName('body')
  return n.text.slice(0, body ? body.startIndex - n.startIndex : undefined).replace(/\s+/g, ' ').trim().replace(/:$/, '').trim()
}

/**
 * Test roles (FR192, FR193). pytest collects the test_ functions of a test_*.py or *_test.py file and the test_ methods of its Test classes;
 * unittest collects the test methods of a TestCase subclass wherever it is. A collected function or method is a test; a class holding one, and the
 * other members of such a class, are test support; a helper function at the top of a test file is neither, and is test code by its file.
 */
function testRoles(file: string, declared: Array<{ id: string; node: Node; top: boolean; owner?: string }>, symbols: Sym[]): void {
  const pytestFile = /(^|\/)test_[^/]*\.py$|_test\.py$/.test(file)
  const bySymbol = new Map(symbols.map((s) => [s.local_id, s]))
  const unittestClass = (n: Node) => (n.childForFieldName('superclasses')?.namedChildren ?? []).some((b) => /(^|\.)\w*TestCase$/.test(b.text))
  const pytestClass = (n: Node) => pytestFile && /^Test/.test(n.childForFieldName('name')!.text)
  const testClass = new Map(declared.filter((d) => d.node.type === 'class_definition').map((d) => [d.id, unittestClass(d.node) ? 'unittest' : pytestClass(d.node) ? 'pytest' : null]))
  const entries = new Set<string>()
  for (const d of declared) {
    if (d.node.type !== 'function_definition') continue
    const name = d.node.childForFieldName('name')!.text
    const kind = d.owner ? testClass.get(d.owner) : null
    if ((d.top && pytestFile && /^test(_|$)/.test(name)) || (kind === 'unittest' && /^test/.test(name)) || (kind === 'pytest' && /^test(_|$)/.test(name))) entries.add(d.id)
  }
  const holding = new Set(declared.filter((d) => d.node.type === 'class_definition' && (testClass.get(d.id) === 'unittest' || [...entries].some((e) => declared.find((x) => x.id === e)!.owner === d.id))).map((d) => d.id))
  for (const d of declared) {
    const s = bySymbol.get(d.id)!
    if (entries.has(d.id)) s.roles = ['test']
    else if (holding.has(d.id) || (d.owner && holding.has(d.owner))) s.roles = ['test_support']
  }
}

function readFacts(file: string): Promise<FileFacts> {
  let f = facts.get(file)
  if (!f) {
    f = (async () => {
      const text = fs.readFileSync(path.join(workspace, file), 'utf8')
      const at = byteOffsets(text)
      const tree = (await parser('python')).parse(text)!
      const module = moduleOf(file)
      // An empty file, such as a bare __init__.py, has no byte to cite, so it has no symbol.
      const symbols: Sym[] = text ? [{ local_id: `${file}#module`, path: file, kind: 'module', name: path.posix.basename(module), qualified_name: module, range: { start_byte: 0, end_byte: at[text.length]!, start_line: 1, end_line: lastLine(text) }, signature: null }] : []
      // Where each declaration's name sits, so a definition Pyright reports maps back to the symbol it names.
      const byName = new Map<string, string>()
      const classes = new Map<string, Node>()
      const declared: Array<{ id: string; node: Node; top: boolean; owner?: string }> = []
      const walk = (n: Node, chain: string[], inClass: boolean, ownerId?: string) => {
        for (const c of n.namedChildren) {
          const d = c.type === 'decorated_definition' ? c.childForFieldName('definition') ?? c : c
          if (d.type === 'class_definition' || d.type === 'function_definition') {
            const name = d.childForFieldName('name')!.text, id = `${file}#${d.startIndex}`
            // A property is its getter; its setter and deleter share the name, so they take their parameters as a suffix (FR146).
            const decorators = c.type === 'decorated_definition' ? c.namedChildren.filter((x) => x.type === 'decorator').map((x) => x.text.replace(/^@\s*/, '')) : []
            const accessor = inClass && d.type === 'function_definition' && decorators.some((t) => /^\w+\.(setter|deleter)\b/.test(t))
            const property = accessor || (inClass && d.type === 'function_definition' && decorators.some((t) => /^(?:[\w.]+\.)?(?:property|cached_property)$/.test(t)))
            const kind = d.type === 'class_definition' ? 'class' : property ? 'property' : inClass ? 'method' : 'function'
            const params = accessor ? `(${(d.childForFieldName('parameters')?.namedChildren ?? []).slice(1).map((p) => (p.childForFieldName('name') ?? p.namedChildren[0] ?? p).text).join(',')})` : ''
            symbols.push({ local_id: id, path: file, kind, name, qualified_name: `${module}:${[...chain, name].join('.')}${params}`, range: rangeOf({ at }, d), signature: header(d) })
            const nameNode = d.childForFieldName('name')!
            byName.set(`${nameNode.startPosition.row}:${nameNode.startPosition.column}`, id)
            if (d.type === 'class_definition') classes.set(id, d)
            declared.push({ id, node: d, top: chain.length === 0, ...(inClass && ownerId ? { owner: ownerId } : {}) })
            const body = d.childForFieldName('body')
            if (body) walk(body, [...chain, name], d.type === 'class_definition', id)
          } else if (!['lambda'].includes(c.type)) walk(c, chain, false)
        }
      }
      walk(tree.rootNode, [], false)
      testRoles(file, declared, symbols)
      // Module-level string constants, so a path kept in one (`PATH = "/api/x"`) is read where it is used.
      const constants = new Map<string, string>()
      for (const n of tree.rootNode.namedChildren) {
        const a = n.type === 'expression_statement' ? n.namedChildren[0] : undefined
        const l = a?.type === 'assignment' ? a.childForFieldName('left') : null, r = a?.type === 'assignment' ? a.childForFieldName('right') : null
        if (l?.type === 'identifier' && r?.type === 'string') constants.set(l.text, stringValue(r))
      }
      return { text, at, tree, symbols, byName, classes, constants }
    })()
    facts.set(file, f)
  }
  return f
}

// ---- HTTP clients (A7): outbound calls to an endpoint named by a path literal ----
/** A string literal's text, with each f-string interpolation as `{}`. */
function stringValue(n: Node): string {
  return n.namedChildren.map((c) => (c.type === 'string_content' ? c.text : c.type === 'interpolation' ? '{}' : c.type === 'escape_sequence' ? c.text : '')).join('')
}
/** A string literal's text, or null for anything else, an f-string with an interpolation included. */
const stringLiteral = (n: Node | null | undefined) => (n?.type === 'string' && !n.namedChildren.some((c) => c.type === 'interpolation') ? stringValue(n) : null)
const VERBS: Array<[RegExp, string]> = [[/^_?(get|fetch)/i, 'GET'], [/^_?(post|push|create|send|submit)/i, 'POST'], [/^_?put/i, 'PUT'], [/^_?patch/i, 'PATCH'], [/^_?(delete|remove)/i, 'DELETE'], [/^_?(request|call)/i, 'ANY']]
/**
 * An HTTP call: a callee whose name says the verb (`get`, `post`, `_push`, `request`...), with a first argument that is a path
 * literal, an f-string with a literal start, or a module constant, beginning with `/` or `http` or shaped like a route relative
 * to a base URL (`rates/add`); `request("POST", path)` takes the verb from its first argument. The endpoint is `VERB path`
 * without scheme, host, query or leading slash, each interpolation a `{param}`; the link rules match it against what another
 * repository exposes. A path built any other way is not reported.
 */
const ROUTE_REGISTRATION = new Set(['add_api_route', 'add_route', 'route', 'add_url_rule', 'api_route', 'websocket'])
function httpEndpoint(f: FileFacts, call: Node): string | undefined {
  // A decorated route (`@router.get("/x")`) or a route registration declares what this service exposes; it calls nothing.
  if (call.parent?.type === 'decorator') return undefined
  const fn = call.childForFieldName('function')!
  const last = fn.type === 'attribute' ? fn.childForFieldName('attribute')!.text : fn.text
  if (ROUTE_REGISTRATION.has(last)) return undefined
  const name = fn.type === 'identifier' ? fn.text : fn.type === 'attribute' ? fn.childForFieldName('attribute')!.text : ''
  let verb = VERBS.find(([re]) => re.test(name))?.[1]
  if (!verb) return undefined
  const args = call.childForFieldName('arguments')?.namedChildren.filter((c) => c.type !== 'comment' && c.type !== 'keyword_argument') ?? []
  // `request("POST", path)`: the verb is the first argument and the path the second.
  const method = args[0]?.type === 'string' ? stringValue(args[0]).toUpperCase() : ''
  const first = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? ((verb = method), args[1]) : args[0]
  if (!first) return undefined
  const raw = first.type === 'string' ? stringValue(first) : first.type === 'identifier' ? f.constants.get(first.text) : undefined
  // A path starts with `/` or a scheme, or is relative to a base URL and shaped like a route (`rates/add`).
  if (!raw || !(/^(\/|https?:\/\/)/.test(raw) || /^[\w.{}-]+(\/[\w.{}-]+)+(\?|$)/.test(raw))) return undefined
  const path = raw.replace(/^https?:\/\/[^/]*/, '').split('?')[0]!.replace(/\{\}/g, '{param}').replace(/^\/+|\/+$/g, '')
  // A bare host names no operation.
  return path ? `${verb} ${path}` : undefined
}

// ---- Imports ----
/** The workspace file a module path names: the module itself, or its package's __init__. */
function moduleFile(dotted: string, base = ''): string | null {
  const rel = path.posix.join(base, ...dotted.split('.').filter(Boolean))
  for (const c of [`${rel}.py`, `${rel}.pyi`, `${rel}/__init__.py`, `${rel}/__init__.pyi`]) if (pythonFiles.has(c.replace(/^\.\//, ''))) return c.replace(/^\.\//, '')
  return null
}

type ImportRef = { node: Node; base: string; dotted: string; names: string[]; relative: boolean }
function importRefs(file: string, f: FileFacts): ImportRef[] {
  const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)
  const nameOf = (c: Node) => (c.type === 'aliased_import' ? c.childForFieldName('name')! : c).text
  const out: ImportRef[] = []
  for (const n of f.tree.rootNode.descendantsOfType(['import_statement', 'import_from_statement'])) {
    const listed = n.namedChildren.filter((c) => c.type === 'dotted_name' || c.type === 'aliased_import')
    if (n.type === 'import_statement') {
      for (const c of listed) out.push({ node: n, base: '', dotted: nameOf(c), names: [], relative: false })
      continue
    }
    const moduleName = n.childForFieldName('module_name')!
    const names = listed.filter((c) => c.startIndex !== moduleName.startIndex).map(nameOf)
    if (moduleName.type !== 'relative_import') { out.push({ node: n, base: '', dotted: moduleName.text, names, relative: false }); continue }
    const dots = moduleName.text.match(/^\.+/)![0].length, parts = dir.split('/').filter(Boolean)
    out.push({ node: n, base: parts.slice(0, Math.max(0, parts.length - (dots - 1))).join('/'), dotted: moduleName.text.slice(dots), names, relative: true })
  }
  return out
}

/** The repository files an import names. `from . import x` imports submodule x when there is one; otherwise a name from the package. */
function targets(r: ImportRef): string[] {
  const subs = r.names.map((n) => moduleFile([r.dotted, n].filter(Boolean).join('.'), r.base)).filter((x): x is string => !!x)
  return subs.length ? subs : [moduleFile(r.dotted, r.base)].filter((x): x is string => !!x)
}

/** Every workspace file Pyright may read to resolve this file's imports: each package on a dotted path and the module itself, as
 *  source or stub, searched as Pyright searches: from the workspace root and, for an absolute import, from the importing file's own
 *  directory and each editable install's directory too. */
function dependencies(file: string, f: FileFacts): string[] {
  const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)
  const out = new Set<string>()
  const editable = extraPaths.filter((p) => p.startsWith(workspace + '/')).map((p) => path.relative(workspace, p))
  for (const r of importRefs(file, f)) {
    const parts = r.dotted.split('.').filter(Boolean)
    const named = [...parts.map((_, k) => parts.slice(0, k + 1)), ...r.names.map((n) => [...parts, n]), ...(r.relative ? [[]] : [])]
    for (const base of r.relative ? [r.base] : ['', dir, ...editable]) {
      for (const p of named) {
        const rel = path.posix.join(base, ...p)
        for (const c of [`${rel}.py`, `${rel}.pyi`, `${rel}/__init__.py`, `${rel}/__init__.pyi`]) if (pythonFiles.has(c.replace(/^\.\//, ''))) out.add(c.replace(/^\.\//, ''))
      }
    }
  }
  out.delete(file)
  return [...out].sort()
}

/** Units (A16): the import graph's strongly connected groups. Each id carries a hash of every Python path, because adding or removing
 *  a module can change what any import resolves to; an edit to a file's text reanalyses only the files that import it, directly or not. */
async function units(): Promise<Array<{ id: string; files: string[]; depends_on: string[] }>> {
  const files = [...pythonFiles].sort()
  const deps = new Map(await Promise.all(files.map(async (p) => [p, dependencies(p, await readFacts(p))] as const)))
  const paths = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16)
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>(), groups: string[][] = []
  // Tarjan's algorithm. shortcut: recursive, so an import chain thousands of modules deep could exhaust the stack; make it iterative then.
  const visit = (v: string) => {
    index.set(v, index.size); low.set(v, index.get(v)!); stack.push(v); onStack.add(v)
    for (const w of deps.get(v)!) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = []
      for (let w = stack.pop()!; ; w = stack.pop()!) { onStack.delete(w); group.push(w); if (w === v) break }
      groups.push(group.sort())
    }
  }
  for (const p of files) if (!index.has(p)) visit(p)
  const unitOf = new Map(groups.flatMap((g) => g.map((p) => [p, `${paths}:${g[0]}`] as const)))
  return groups.map((g) => ({ id: unitOf.get(g[0]!)!, files: g, depends_on: [...new Set(g.flatMap((p) => deps.get(p)!.map((d) => unitOf.get(d)!)))].filter((u) => u !== unitOf.get(g[0]!)).sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
}

// ---- Calls ----
const stubModule = (rel: string) => rel.replace(/\.pyi?$/, '').replace(/\/__init__$/, '').split('/').join('.')
const stubTrees = new Map<string, Promise<{ rootNode: Node }>>()
/** The qualified name of the declaration at a line of a stub or installed module: its enclosing classes, then its own name. */
async function nameAt(file: string, line: number, character: number): Promise<string | null> {
  let t = stubTrees.get(file)
  if (!t) { t = parser('python').then((p) => p.parse(fs.readFileSync(file, 'utf8'))!); stubTrees.set(file, t) }
  let node: Node | null = (await t).rootNode.descendantForPosition({ row: line, column: character })
  const chain: string[] = []
  let own: string | null = null
  for (; node; node = node.parent) {
    if (node.type === 'function_definition' || node.type === 'class_definition') {
      const n = node.childForFieldName('name')!.text
      if (own === null) own = n; else chain.unshift(n)
    }
  }
  return own === null ? null : [...chain, own].join('.')
}

type Found = { file: string; start: { line: number; character: number } }
/** Where Pyright says a name is defined, or null when it answered nothing in time. The file must be open: Pyright answers nothing in a closed one. */
async function definitionsOf(file: string, name: Node): Promise<Found[] | null> {
  const before = timedOut
  const raw = await request<Location | Location[] | null>('textDocument/definition', { textDocument: { uri: `file://${path.join(workspace, file)}` }, position: { line: name.startPosition.row, character: name.startPosition.column } })
  if (timedOut > before) return null
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((l) => ({ file: decodeURIComponent((l.targetUri ?? l.uri ?? '').replace(/^file:\/\//, '')), start: (l.targetSelectionRange ?? l.range)!.start }))
}
const inRepository = (l: Found) => l.file.startsWith(workspace + '/') && pythonFiles.has(path.relative(workspace, l.file))
/** The workspace declaration a definition names, if it names a class or function. */
const declaredAt = async (l: Found) => (inRepository(l) ? (await readFacts(path.relative(workspace, l.file))).byName.get(`${l.start.line}:${l.start.character}`) : undefined)
const fileOf = (id: string) => id.slice(0, id.lastIndexOf('#'))

const openFiles = new Map<string, number>()
/** Runs fn with the file open in Pyright; opened and closed once however many callers nest. */
async function inOpenFile<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const uri = `file://${path.join(workspace, file)}`, { text } = await readFacts(file)
  const n = openFiles.get(file) ?? 0
  if (!n) notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text } })
  openFiles.set(file, n + 1)
  try { return await fn() } finally {
    const left = openFiles.get(file)! - 1
    if (left) openFiles.set(file, left)
    else { openFiles.delete(file); notify('textDocument/didClose', { textDocument: { uri } }) }
  }
}

type Resolution = { resolution: 'resolved'; target: { symbol: string } } | { resolution: 'resolved_external'; target: { external: { module: string; name: string } } } | { resolution: 'unresolved'; reason: string; detail?: Record<string, string> } | { resolution: 'candidate'; target?: undefined; candidates: string[] }

async function resolveCall(file: string, f: FileFacts, call: Node): Promise<Resolution> {
  const fn = call.childForFieldName('function')!
  const name = fn.type === 'identifier' ? fn : fn.type === 'attribute' ? fn.childForFieldName('attribute') : null
  if (!name) {
    const inner = fn.type === 'call' ? fn.childForFieldName('function') : null
    return { resolution: 'unresolved', reason: inner?.text === 'getattr' ? 'dynamic_element_access' : 'chained_callee' }
  }
  const locations = await definitionsOf(file, name)
  if (!locations) return { resolution: 'unresolved', reason: 'outside_capability', detail: { why: 'pyright_timeout' } }
  if (!locations.length) return { resolution: 'unresolved', reason: fn.type === 'attribute' ? 'untyped_receiver' : 'unknown_name' }
  const inWorkspace = locations.filter(inRepository)
  if (inWorkspace.length) {
    const ids = [...new Set(await Promise.all(inWorkspace.map(declaredAt)))].filter((x): x is string => !!x)
    if (ids.length === 1) return { resolution: 'resolved', target: { symbol: ids[0]! } }
    if (ids.length > 1) return { resolution: 'candidate', candidates: ids }
    // The name leads to a variable, a parameter or an attribute, not a declaration: what it holds is not known statically.
    return { resolution: 'unresolved', reason: 'untyped_receiver' }
  }
  const first = locations[0]!
  const external = async (module: string) => ({ resolution: 'resolved_external' as const, target: { external: { module, name: (await nameAt(first.file, first.start.line, first.start.character)) ?? name.text } } })
  if (first.file.startsWith(path.join(typeshed, 'stdlib') + '/')) return external(stubModule(path.relative(path.join(typeshed, 'stdlib'), first.file)))
  if (first.file.startsWith(path.join(typeshed, 'stubs') + '/')) {
    // A bundled stub only describes a package; unless the package is installed, the code it calls is not here.
    const [dist, ...rest] = path.relative(path.join(typeshed, 'stubs'), first.file).split('/')
    const module = stubModule(rest.join('/'))
    if (!installed.has(module.split('.')[0]!)) return { resolution: 'unresolved', reason: 'dependency_missing', detail: { package: dist! } }
    return external(module)
  }
  const installedAt = [sitePackages, shadow].find((r) => r && first.file.startsWith(r + '/'))
  if (installedAt) return external(stubModule(path.relative(installedAt, first.file)))
  return { resolution: 'unresolved', reason: 'outside_capability' }
}

// ---- Classes: each base a workspace class by Pyright, or else the path its file's imports give it ----
const bindings = new WeakMap<FileFacts, Map<string, string>>()
/** What each name an absolute import binds stands for: `models` is `django.db.models` after `from django.db import models`. */
function imported(f: FileFacts): Map<string, string> {
  let m = bindings.get(f)
  if (m) return m
  m = new Map()
  for (const n of f.tree.rootNode.descendantsOfType(['import_statement', 'import_from_statement'])) {
    const from = n.type === 'import_from_statement' ? n.childForFieldName('module_name')! : null
    if (from?.type === 'relative_import') continue
    for (const c of n.childrenForFieldName('name')) {
      const name = (c.type === 'aliased_import' ? c.childForFieldName('name')! : c).text
      const alias = c.type === 'aliased_import' ? c.childForFieldName('alias')!.text : from ? name : name.split('.')[0]!
      m.set(alias, from ? `${from.text}.${name}` : c.type === 'aliased_import' ? name : alias)
    }
  }
  bindings.set(f, m)
  return m
}

/** The dotted path a name or attribute chain stands for through its file's absolute imports: `models.Model` is `django.db.models.Model`. */
function dotted(f: FileFacts, n: Node): string | undefined {
  const parts: string[] = []
  for (; n.type === 'attribute'; n = n.childForFieldName('object')!) parts.unshift(n.childForFieldName('attribute')!.text)
  const bound = n.type === 'identifier' ? imported(f).get(n.text) : undefined
  return bound === undefined ? undefined : [bound, ...parts].join('.')
}

/** The workspace class a name refers to, by Pyright; the file must be open. */
async function classAt(file: string, name: Node): Promise<string | undefined> {
  for (const id of await Promise.all(((await definitionsOf(file, name)) ?? []).map(declaredAt))) if (id && (await readFacts(fileOf(id))).classes.has(id)) return id
  return undefined
}

type Base = { node: Node; symbol?: string; external?: string }
const bases = new Map<string, Promise<Base[]>>()
/** A class's bases. A package that is not installed leaves Pyright nothing to resolve, so its classes are named by the imports. */
function basesOf(id: string): Promise<Base[]> {
  let b = bases.get(id)
  if (!b) {
    b = (async () => {
      const file = fileOf(id), f = await readFacts(file)
      const nodes = f.classes.get(id)!.childForFieldName('superclasses')?.namedChildren.filter((c) => c.type === 'identifier' || c.type === 'attribute') ?? []
      if (!nodes.length) return []
      return inOpenFile(file, () => Promise.all(nodes.map(async (node): Promise<Base> => {
        const symbol = await classAt(file, node.type === 'attribute' ? node.childForFieldName('attribute')! : node)
        return symbol ? { node, symbol } : { node, external: dotted(f, node) }
      })))
    })()
    bases.set(id, b)
  }
  return b
}

/** Every base outside the workspace a class derives from, directly or through its workspace bases. */
async function ancestry(id: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(id)) return []
  seen.add(id)
  const out: string[] = []
  for (const b of await basesOf(id)) out.push(...(b.symbol ? await ancestry(b.symbol, seen) : b.external ? [b.external] : []))
  return out
}

const packageUse = new Map<string, Promise<boolean>>()
/** Whether any file imports a package, so a repository that never names it pays no Pyright request for that package's rules. */
function importsPackage(pkg: RegExp): Promise<boolean> {
  let p = packageUse.get(pkg.source)
  if (!p) { p = Promise.all([...pythonFiles].map(readFacts)).then((all) => all.some((f) => [...imported(f).values()].some((v) => pkg.test(v)))); packageUse.set(pkg.source, p) }
  return p
}

const positional = (call: Node) => call.childForFieldName('arguments')?.namedChildren.filter((c) => !['keyword_argument', 'comment', 'list_splat', 'dictionary_splat'].includes(c.type)) ?? []
const calleeName = (call: Node) => { const fn = call.childForFieldName('function')!; return fn.type === 'attribute' ? fn.childForFieldName('attribute')! : fn }

// ---- Pulumi (A8, A25): the resources a program constructs, related to the resources they read and depend on ----
const PULUMI_BASE = /^pulumi\.(CustomResource|ComponentResource|ProviderResource)$|^pulumi_\w+\./
/** A string literal as written between its quotes, so `f"{name}-content"` reads `{name}-content`; any other expression as written. */
const asWritten = (n: Node) => (n.type === 'string' ? n.children.filter((c) => c.type !== 'string_start' && c.type !== 'string_end').map((c) => c.text).join('') : n.text)
const resourcesByFile = new Map<string, Promise<Map<number, Sym>>>()
/**
 * The resources a file constructs, by the start of each call: a class of a provider package (`pulumi_aws`, `pulumi_random`...) named
 * through the imports, so no package need be installed, or a workspace class deriving from a Pulumi resource. Each is named as its URN
 * and the TypeScript rules name it, type then name (`aws.s3.Bucket::logs`), a workspace class's type being the class's own name.
 */
function resourcesIn(file: string): Promise<Map<number, Sym>> {
  let r = resourcesByFile.get(file)
  if (!r) {
    r = (async () => {
      const out = new Map<number, Sym>()
      if (!(await importsPackage(/^pulumi/))) return out
      const f = await readFacts(file)
      // A class whose name ends in Args holds a resource's arguments; it is not a resource.
      const candidates = f.tree.rootNode.descendantsOfType('call').filter((c) => positional(c).length && calleeName(c).type === 'identifier' && /^[A-Z]/.test(calleeName(c).text) && !/Args(Dict)?$/.test(calleeName(c).text))
      const tokens = await inOpenFile(file, () => Promise.all(candidates.map(async (call) => {
        const via = dotted(f, call.childForFieldName('function')!)
        if (via?.startsWith('pulumi_')) return via.slice('pulumi_'.length)
        const cls = await classAt(file, calleeName(call))
        return cls && (await ancestry(cls)).some((b) => PULUMI_BASE.test(b)) ? (await readFacts(fileOf(cls))).classes.get(cls)!.childForFieldName('name')!.text : undefined
      })))
      for (const [k, call] of candidates.entries()) {
        const token = tokens[k], name = asWritten(positional(call)[0]!)
        if (token) out.set(call.startIndex, { local_id: `${file}#resource#${token}::${name}#${f.at[call.startIndex]}`, path: file, kind: 'resource', name, qualified_name: `${moduleOf(file)}:${token}::${name}`, range: rangeOf(f, call), signature: `resource "${token}"` })
      }
      return out
    })()
    resourcesByFile.set(file, r)
  }
  return r
}

/** The resource a name holds, when Pyright finds it assigned the call that constructs one; the file must be open. */
async function resourceNamed(file: string, name: Node): Promise<string | undefined> {
  for (const l of ((await definitionsOf(file, name)) ?? []).filter(inRepository)) {
    const at = path.relative(workspace, l.file), def = (await readFacts(at)).tree.rootNode.descendantForPosition({ row: l.start.line, column: l.start.character })
    const assignment = def?.parent
    const right = assignment?.type === 'assignment' && assignment.childForFieldName('left')!.equals(def!) ? assignment.childForFieldName('right') : null
    const resource = right?.type === 'call' ? (await resourcesIn(at)).get(right.startIndex) : undefined
    if (resource) return resource.local_id
  }
  return undefined
}

/** A resource references each resource whose outputs its arguments read, and depends on each its options' `depends_on` names. */
async function resourceFacts(file: string, f: FileFacts, call: Node, source: string): Promise<unknown[]> {
  const first = positional(call)[0]!, reads: Array<[Node, 'references' | 'depends_on']> = []
  for (const a of call.childForFieldName('arguments')!.namedChildren) {
    if (a.equals(first) || a.type === 'comment') continue
    const value = a.type === 'keyword_argument' ? a.childForFieldName('value')! : a
    const options = a.type === 'keyword_argument' ? a.childForFieldName('name')!.text === 'opts' : value.type === 'call' && calleeName(value).text.endsWith('ResourceOptions')
    if (!options) reads.push([value, 'references'])
    else for (const k of value.type === 'call' ? value.childForFieldName('arguments')?.namedChildren ?? [] : []) if (k.type === 'keyword_argument' && k.childForFieldName('name')!.text === 'depends_on') reads.push([k.childForFieldName('value')!, 'depends_on'])
  }
  const out: unknown[] = []
  for (const [node, type] of reads) {
    // A name read, not a member or keyword name: `logs` in `logs.arn`, never `arn`.
    const names = (node.type === 'identifier' ? [node] : node.descendantsOfType('identifier')).filter((n) => !(n.parent?.type === 'attribute' && n.parent.childForFieldName('attribute')!.equals(n)) && !(n.parent?.type === 'keyword_argument' && n.parent.childForFieldName('name')!.equals(n)))
    const targets = await Promise.all(names.map((n) => resourceNamed(file, n)))
    for (const [k, n] of names.entries()) {
      const target = targets[k]
      if (!target || target === source) continue
      // The site is the output read, such as `logs.arn`, short of a method called on it.
      let site = n
      while (site.parent?.type === 'attribute' && site.parent.childForFieldName('object')!.equals(site) && !(site.parent.parent?.type === 'call' && site.parent.parent.childForFieldName('function')!.equals(site.parent))) site = site.parent
      out.push({ type, origin: 'framework_adapter', source: { symbol: source }, site: { path: file, range: rangeOf(f, site) }, resolution: 'resolved', target: { symbol: target } })
    }
  }
  return out
}

// ---- Tables (A9): SQLAlchemy and Django entity-to-table mappings, in the shapes the Entity Framework rules give ----
/** One mapping: an entity (a class, or the name a Table is assigned to), the construct that maps it, and its table or why none is known. */
type Mapping = { entity: string; file: string; site: Node; rule: string } & ({ table: string; inferred?: string } | { why: string })
const DJANGO_MODEL = new Set(['django.db.models.Model', 'django.db.models.base.Model'])
const literal = (n: Node): { table: string } | { why: string } => { const table = stringLiteral(n); return table === null ? { why: 'the table name is not a string literal' } : { table } }
/** SQLAlchemy Core's `Table("name", metadata, ...)`: a callee named Table with the name and at least a metadata or a column after it. */
// shortcut: the callee is not checked to be SQLAlchemy's; check the imports if another library's two-argument Table turns up.
const tableCall = (n: Node | null) => (n?.type === 'call' && calleeName(n).text === 'Table' && positional(n).length >= 2 ? literal(positional(n)[0]!) : undefined)
/** What a class body assigns, by name: `__tablename__`, or `db_table` in a Django Meta. */
function assigned(cls: Node): Map<string, Node> {
  const out = new Map<string, Node>()
  for (const s of cls.childForFieldName('body')?.namedChildren ?? []) {
    const a = s.type === 'expression_statement' ? s.namedChildren[0] : undefined
    const left = a?.type === 'assignment' ? a.childForFieldName('left') : null, right = a?.type === 'assignment' ? a.childForFieldName('right') : null
    if (left?.type === 'identifier' && right) out.set(left.text, right)
  }
  return out
}
/** Django's app label for a model in an app's models.py or models/ package: the name of the directory that holds it. */
// shortcut: only classes in a models module are tried as Django models, so a model declared elsewhere is missed; widen if one shows up.
const appLabel = (file: string) => /(?:^|\/)([^/]+)\/models(?:\.py|\/.+\.py)$/.exec(file)?.[1]

/** A Django model's table: Meta.db_table, else `<app_label>_<model>`. An abstract model has none; a proxy shares its parent's, through inherits. */
async function djangoTable(file: string, id: string, cls: Node, app: string): Promise<Mapping | undefined> {
  const meta = cls.childForFieldName('body')?.namedChildren.find((c) => c.type === 'class_definition' && c.childForFieldName('name')!.text === 'Meta')
  const options = meta ? assigned(meta) : new Map<string, Node>()
  if (options.get('abstract')?.text === 'True' || options.get('proxy')?.text === 'True') return undefined
  if (!(await ancestry(id)).some((b) => DJANGO_MODEL.has(b))) return undefined
  const dbTable = options.get('db_table'), label = options.get('app_label'), name = cls.childForFieldName('name')!
  if (dbTable) return { entity: id, file, site: dbTable.parent!, rule: 'db_table', ...literal(dbTable) }
  if (label?.type === 'string') return { entity: id, file, site: name, rule: 'django_convention', table: `${stringValue(label)}_${name.text.toLowerCase()}` }
  return { entity: id, file, site: name, rule: 'django_convention', table: `${app}_${name.text.toLowerCase()}`, inferred: 'Django names the table <app_label>_<model>; the app label is taken as the directory that holds the models, and an app config may set another' }
}

/**
 * Every entity-to-table mapping in the repository. A table is one symbol, declared at its first mapping site in path order, and a
 * mapping may sit in another file than that site, so these are workspace facts. A declarative class without `__tablename__` that
 * inherits a mapped class shares its table (single-table inheritance) and is reported through the inherits relationship alone.
 */
async function tables(): Promise<{ symbols: Sym[]; relationships: unknown[] }> {
  const files = [...pythonFiles].sort(), django = await importsPackage(/^django(\.|$)/)
  const variables: Sym[] = [], mappings: Mapping[] = []
  // Where a module-level name is assigned a Table, so a class's `__table__ = orders` finds it.
  const tableAt = new Map<string, { table: string } | { why: string }>()
  for (const file of files) {
    const f = await readFacts(file)
    for (const a of f.tree.rootNode.descendantsOfType('assignment')) {
      const left = a.childForFieldName('left')!, right = a.childForFieldName('right'), table = tableCall(right)
      if (left.type !== 'identifier' || !table || a.parent?.parent?.type !== 'module') continue
      const id = `${file}#${a.startIndex}`
      variables.push({ local_id: id, path: file, kind: 'variable', name: left.text, qualified_name: `${moduleOf(file)}:${left.text}`, range: rangeOf(f, a), signature: null })
      mappings.push({ entity: id, file, site: right!, rule: 'table', ...table })
      tableAt.set(`${file}:${left.startPosition.row}:${left.startPosition.column}`, table)
    }
  }
  const tableNamed = (file: string, n: Node) => inOpenFile(file, async () => {
    for (const l of (n.type === 'identifier' ? (await definitionsOf(file, n)) ?? [] : []).filter(inRepository)) {
      const table = tableAt.get(`${path.relative(workspace, l.file)}:${l.start.line}:${l.start.character}`)
      if (table) return table
    }
    return { why: 'the table is not a Table(...) assigned to a module-level name' }
  })
  for (const file of files) {
    const f = await readFacts(file), app = django ? appLabel(file) : undefined
    for (const [id, cls] of f.classes) {
      const own = assigned(cls), tablename = own.get('__tablename__'), table = own.get('__table__')
      const m: Mapping | undefined = tablename ? { entity: id, file, site: tablename.parent!, rule: 'tablename', ...literal(tablename) }
        : table ? { entity: id, file, site: table.parent!, rule: 'table_attribute', ...(tableCall(table) ?? await tableNamed(file, table)) }
        : app ? await djangoTable(file, id, cls, app) : undefined
      if (m) mappings.push(m)
    }
  }
  mappings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.site.startIndex - b.site.startIndex))
  const symbols: Sym[] = [...variables], relationships: unknown[] = [], declared = new Set<string>()
  for (const m of mappings) {
    const site = { path: m.file, range: rangeOf(await readFacts(m.file), m.site) }
    if ('why' in m) { relationships.push({ type: 'maps_to', origin: 'framework_adapter', source: { symbol: m.entity }, site, resolution: 'unresolved', reason: 'outside_capability', detail: { rule: m.rule, why: m.why } }); continue }
    const table = `fw#table#${m.table}`
    if (!declared.has(table)) { declared.add(table); symbols.push({ local_id: table, path: m.file, kind: 'table', name: m.table, qualified_name: m.table, range: site.range, signature: null }) }
    relationships.push({ type: 'maps_to', origin: 'framework_adapter', source: { symbol: m.entity }, site, resolution: 'resolved', target: { symbol: table }, detail: { rule: m.rule, ...(m.inferred ? { inferred: m.inferred } : {}) } })
  }
  return { symbols, relationships }
}

// ---- Entry points (A9, A7): FastAPI, Flask and Django routes and Celery tasks, in the shapes the ASP.NET Core and hosted-service rules give ----
/** What routes or tasks hang off: an application, a router, a blueprint, a URLconf module, or a Celery app; `own` is its own prefix, null when not a literal. */
type Container = { kind: 'fastapi' | 'router' | 'flask' | 'blueprint' | 'urls' | 'celery'; own: string | null; file: string }
/** What each framework constructor makes, by the dotted path its file's imports give the callee, and the argument that holds its prefix. */
const CONSTRUCTORS = new Map<string, { kind: Container['kind']; prefix?: string }>([
  ['fastapi.FastAPI', { kind: 'fastapi' }], ['fastapi.APIRouter', { kind: 'router', prefix: 'prefix' }], ['fastapi.routing.APIRouter', { kind: 'router', prefix: 'prefix' }],
  ['flask.Flask', { kind: 'flask' }], ['flask.Blueprint', { kind: 'blueprint', prefix: 'url_prefix' }], ['celery.Celery', { kind: 'celery' }],
])
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
/** An endpoint as the ASP.NET Core rules name it: `<int:id>`, `<id>` and a path converter become `{id:int}`, `{id}` and the catch-all `{*rest}`, slashes single and trimmed. */
function endpointOf(verb: string, route: string): string {
  const path = route.replace(/<(?:(\w+):)?(\w+)>/g, (_, conv: string | undefined, name: string) => (conv === 'path' ? `{*${name}}` : conv ? `{${name}:${conv}}` : `{${name}}`))
    .replace(/\{(\w+):path\}/g, '{*$1}').replace(/\/+/g, '/').replace(/^\/|\/$/g, '')
  return `${verb} ${path || '/'}`
}
const keyword = (call: Node, name: string) => call.childForFieldName('arguments')?.namedChildren.find((a) => a.type === 'keyword_argument' && a.childForFieldName('name')!.text === name)?.childForFieldName('value') ?? undefined
/** A prefix argument: undefined when absent, null when not a literal. */
const prefixOf = (n: Node | undefined) => (n === undefined ? undefined : stringLiteral(n))
/** The name Pyright is asked about for a name or a member access. */
const lastName = (n: Node) => (n.type === 'attribute' ? n.childForFieldName('attribute')! : n)

type Route = { container: Container; file: string; site: Node; rule: string; route: string; targets: Array<{ verb: string; handler: string }>; why?: string }
type Mount = { parent: Container; child: Container; prefix: string | null | undefined }
type Mounted = { path: string; inferred?: string } | { why: string }

/**
 * Every route and task in the repository. A route exposes its handler as `VERB path`, its path joined from every include_router,
 * register_blueprint or include() that mounts its router, blueprint or URLconf; a router or blueprint that nothing the rules read mounts
 * is taken as mounted at the root, and says so. A Django view serves every verb (ANY), except a class-based view with methods named for
 * verbs, which Django dispatches each verb to. A Celery task is a job that runs its function.
 */
async function entryPoints(): Promise<{ symbols: Sym[]; relationships: unknown[] }> {
  if (!(await importsPackage(/^(fastapi|flask|django|celery)(\.|$)/))) return { symbols: [], relationships: [] }
  const files = [...pythonFiles].sort()
  // Each framework object by where its name is assigned, as Pyright reports a definition: `file:line:column`.
  const containers = new Map<string, Container>(), urlconfs = new Map<string, Container>(), roots = new Set<string>()
  for (const file of files) {
    const f = await readFacts(file)
    for (const a of f.tree.rootNode.descendantsOfType('assignment')) {
      const left = a.childForFieldName('left')!, right = a.childForFieldName('right')
      const made = right?.type === 'call' ? CONSTRUCTORS.get(dotted(f, right.childForFieldName('function')!) ?? '') : undefined
      const own = made?.prefix ? prefixOf(keyword(right!, made.prefix)) : undefined
      if (left.type === 'identifier' && made) containers.set(`${file}:${left.startPosition.row}:${left.startPosition.column}`, { kind: made.kind, own: own === undefined ? '' : own, file })
    }
    const root = f.constants.get('ROOT_URLCONF'), rootFile = root ? moduleFile(root) : null
    if (rootFile) roots.add(rootFile)
  }
  const containerAt = async (file: string, n: Node) => {
    for (const l of ((await definitionsOf(file, lastName(n))) ?? []).filter(inRepository)) {
      const c = containers.get(`${path.relative(workspace, l.file)}:${l.start.line}:${l.start.character}`)
      if (c) return c
    }
    return undefined
  }
  const declarationOf = async (file: string, n: Node) => (await Promise.all(((await definitionsOf(file, lastName(n))) ?? []).map(declaredAt))).find((id) => id)
  /** A Django view's handlers: a class's own methods named for verbs, each for its verb, else the class or function for every verb. */
  const viewTargets = async (id: string) => {
    const f = await readFacts(fileOf(id)), view = f.symbols.find((s) => s.local_id === id)!
    const own = f.classes.has(id) ? f.symbols.filter((s) => s.kind === 'method' && HTTP_VERBS.has(s.name) && s.qualified_name === `${view.qualified_name}.${s.name}`) : []
    return own.length ? own.map((s) => ({ verb: s.name.toUpperCase(), handler: s.local_id })) : [{ verb: 'ANY', handler: id }]
  }

  const routes: Route[] = [], mounts: Mount[] = [], includes: Array<{ parent: Container; file: string; prefix: string | null }> = [], jobs: Array<{ file: string; site: Node; rule: string; fn: Sym }> = []
  for (const file of files) {
    const f = await readFacts(file)
    const fn = (def: Node) => f.symbols.find((s) => s.local_id === `${file}#${def.startIndex}`)!
    const decorators = f.tree.rootNode.descendantsOfType('decorated_definition').filter((d) => d.childForFieldName('definition')!.type === 'function_definition')
      .flatMap((d) => d.namedChildren.filter((c) => c.type === 'decorator').map((c) => ({ def: d.childForFieldName('definition')!, expr: c.namedChildren[0]! })))
    const registrations = f.tree.rootNode.descendantsOfType('call').filter((c) => c.childForFieldName('function')!.type === 'attribute' && ['include_router', 'register_blueprint'].includes(calleeName(c).text) && positional(c).length)
    const patterns = f.tree.rootNode.namedChildren.flatMap((s) => {
      const a = s.type === 'expression_statement' ? s.namedChildren[0] : undefined
      const right = a?.type === 'assignment' || a?.type === 'augmented_assignment' ? a.childForFieldName('right') : null
      return a?.childForFieldName('left')?.text === 'urlpatterns' && right?.type === 'list' ? right.namedChildren.filter((p) => p.type === 'call' && ['django.urls.path', 'django.urls.re_path'].includes(dotted(f, p.childForFieldName('function')!) ?? '')) : []
    })
    if (!decorators.length && !registrations.length && !patterns.length) continue
    await inOpenFile(file, async () => {
      for (const { def, expr } of decorators) {
        const call = expr.type === 'call' ? expr : null, callee = call ? call.childForFieldName('function')! : expr
        if (dotted(f, callee) === 'celery.shared_task') { jobs.push({ file, site: expr, rule: 'shared_task', fn: fn(def) }); continue }
        const method = callee.type === 'attribute' ? callee.childForFieldName('attribute')!.text : ''
        if (method !== 'task' && method !== 'route' && method !== 'api_route' && !HTTP_VERBS.has(method)) continue
        const container = await containerAt(file, callee.childForFieldName('object')!)
        if (container?.kind === 'celery' && method === 'task') { jobs.push({ file, site: expr, rule: 'celery_task', fn: fn(def) }); continue }
        if (!call || method === 'task' || !container || container.kind === 'celery') continue
        const route = stringLiteral(positional(call)[0]), methods = keyword(call, 'methods')
        const listed = methods ? (['list', 'tuple', 'set'].includes(methods.type) ? methods.namedChildren.filter((c) => c.type !== 'comment').map(stringLiteral) : [null]) : []
        const verbs = HTTP_VERBS.has(method) ? [method] : listed.length ? listed : ['GET']
        const why = route === null ? 'the route is not a string literal' : verbs.includes(null) ? 'the methods are not string literals' : undefined
        routes.push({ container, file, site: expr, rule: container.kind === 'flask' || container.kind === 'blueprint' ? 'flask_route' : 'fastapi_route', route: route ?? '', targets: verbs.map((v) => ({ verb: (v ?? '').toUpperCase(), handler: fn(def).local_id })), ...(why ? { why } : {}) })
      }
      for (const call of registrations) {
        const callee = call.childForFieldName('function')!
        const [parent, child] = [await containerAt(file, callee.childForFieldName('object')!), await containerAt(file, positional(call)[0]!)]
        if (parent && child) mounts.push({ parent, child, prefix: prefixOf(keyword(call, calleeName(call).text === 'include_router' ? 'prefix' : 'url_prefix')) })
      }
      if (!patterns.length) return
      const urls: Container = { kind: 'urls', own: '', file }
      urlconfs.set(file, urls)
      for (const p of patterns) {
        const [route, view] = positional(p), regex = dotted(f, p.childForFieldName('function')!) === 'django.urls.re_path'
        if (!route || !view) continue
        if (view.type === 'call' && dotted(f, view.childForFieldName('function')!) === 'django.urls.include') {
          const module = stringLiteral(positional(view)[0]), included = module ? moduleFile(module) : null
          if (included) includes.push({ parent: urls, file: included, prefix: stringLiteral(route) })
          continue
        }
        // `Detail.as_view()` routes to the class it is called on.
        const callee = view.type === 'call' ? view.childForFieldName('function')! : null
        const id = await declarationOf(file, callee?.type === 'attribute' && lastName(callee).text === 'as_view' ? callee.childForFieldName('object')! : view)
        if (!id) continue
        const why = regex ? 're_path takes a regular expression, which the rules do not read as a route' : stringLiteral(route) === null ? 'the route is not a string literal' : undefined
        routes.push({ container: urls, file, site: p, rule: regex ? 'django_re_path' : 'django_path', route: stringLiteral(route) ?? '', targets: await viewTargets(id), ...(why ? { why } : {}) })
      }
    })
  }
  for (const i of includes) { const child = urlconfs.get(i.file); if (child) mounts.push({ parent: i.parent, child, prefix: i.prefix }) }

  const unmounted = 'no include_router or register_blueprint the rules read mounts it, so it is taken as mounted at the root'
  const mountedAt = (c: Container, seen: Container[] = []): Mounted[] => {
    if (seen.includes(c)) return []
    const by = mounts.filter((m) => m.child === c)
    if (!by.length) {
      if (c.own === null) return [{ why: 'a route prefix is not a string literal' }]
      if (c.kind === 'urls') return roots.size && !roots.has(c.file) ? [{ why: 'no include() the rules read reaches this URLconf, and ROOT_URLCONF names another' }] : [{ path: '' }]
      return [c.kind === 'router' || c.kind === 'blueprint' ? { path: c.own, inferred: unmounted } : { path: c.own }]
    }
    return by.flatMap((m) => mountedAt(m.parent, [...seen, c]).map((p): Mounted => {
      // register_blueprint's url_prefix replaces the blueprint's own; include_router's goes before the router's.
      const own = c.kind === 'blueprint' && m.prefix !== undefined ? '' : c.own
      return 'why' in p ? p : m.prefix === null || own === null ? { why: 'a route prefix is not a string literal' } : { ...p, path: `${p.path}/${m.prefix ?? ''}/${own}` }
    }))
  }

  const symbols: Sym[] = [], relationships: unknown[] = [], declared = new Set<string>(), related = new Set<string>()
  const declare = (sym: Sym) => { if (!declared.has(sym.local_id)) { declared.add(sym.local_id); symbols.push(sym) } }
  const relate = (fact: object) => { const k = JSON.stringify(fact); if (!related.has(k)) { related.add(k); relationships.push(fact) } }
  for (const r of routes) {
    const site = { path: r.file, range: rangeOf(await readFacts(r.file), r.site) }
    for (const m of r.why ? [{ why: r.why }] : mountedAt(r.container)) {
      for (const t of r.targets) {
        if ('why' in m) { relate({ type: 'exposes', origin: 'framework_adapter', source: { symbol: t.handler }, site, resolution: 'unresolved', reason: 'outside_capability', detail: { rule: r.rule, why: m.why } }); continue }
        const endpoint = endpointOf(t.verb, `${m.path}/${r.route}`), id = `fw#endpoint#${endpoint}`
        declare({ local_id: id, path: r.file, kind: 'endpoint', name: endpoint, qualified_name: endpoint, range: site.range, signature: null })
        relate({ type: 'exposes', origin: 'framework_adapter', source: { symbol: id }, site, resolution: 'resolved', target: { symbol: t.handler }, detail: { rule: r.rule, ...(m.inferred ? { inferred: m.inferred } : {}) } })
      }
    }
  }
  for (const j of jobs) {
    const site = { path: j.file, range: rangeOf(await readFacts(j.file), j.site) }, id = `fw#job#${j.fn.qualified_name}`
    declare({ local_id: id, path: j.file, kind: 'job', name: j.fn.name, qualified_name: j.fn.qualified_name, range: site.range, signature: null })
    relate({ type: 'runs', origin: 'framework_adapter', source: { symbol: id }, site, resolution: 'resolved', target: { symbol: j.fn.local_id }, detail: { rule: j.rule } })
  }
  return { symbols, relationships }
}

/** Starts Pyright and completes the LSP handshake; called at initialize and again at every restart. */
async function startSession() {
  startPyright()
  const root = `file://${workspace}`
  await request('initialize', { processId: process.pid, rootUri: root, workspaceFolders: [{ uri: root, name: 'workspace' }], capabilities: { workspace: { configuration: true }, textDocument: { definition: {} } } })
  notify('initialized', {})
  notify('workspace/didChangeConfiguration', { settings: { python: { analysis: settings() } } })
}

/** Files analysed by the current Pyright; a long session answers ever more slowly on untyped code, so it is replaced after this many. */
const SESSION_FILES = 40
let sessionFiles = 0

async function analyse(file: string) {
  if (sessionFiles >= SESSION_FILES) {
    server.kill(); buffer = Buffer.alloc(0); pending.clear(); openFiles.clear(); sessionFiles = 0
    await startSession()
    send({ jsonrpc: '2.0', method: 'log', params: { level: 'debug', message: `Pyright restarted before ${file}` } })
  }
  sessionFiles++
  return waitingOnPyright(file, () => inOpenFile(file, () => analyseWithPyright(file)))
}

/** The core's timeout measures silence: while Pyright works, which on its first file in a large workspace can take minutes, say so. */
async function waitingOnPyright<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const keepalive = setInterval(() => send({ jsonrpc: '2.0', method: 'log', params: { level: 'debug', message: `waiting on Pyright for ${what}` } }), 15000)
  try { return await fn() } finally { clearInterval(keepalive) }
}

async function analyseWithPyright(file: string) {
  const f = await readFacts(file)
  const relationships: unknown[] = []
  const within = (n: Node) => f.symbols.filter((s) => s.kind !== 'module' && s.range.start_byte <= f.at[n.startIndex]! && f.at[n.endIndex]! <= s.range.end_byte).sort((a, b) => b.range.start_byte - a.range.start_byte)[0]?.local_id ?? `${file}#module`
  const calls = f.tree.rootNode.descendantsOfType('call')
  // Definitions are asked for a chunk at a time: Pyright answers each chunk in turn, and a progress line between chunks keeps the
  // core's silence timeout at bay on a file with hundreds of calls while the machine is busy.
  const resolved: Resolution[] = []
  for (let i = 0; i < calls.length; i += 50) {
    resolved.push(...await Promise.all(calls.slice(i, i + 50).map((call) => resolveCall(file, f, call))))
    if (i + 50 < calls.length) send({ jsonrpc: '2.0', method: 'log', params: { level: 'debug', message: `${file}: ${i + 50} of ${calls.length} calls` } })
  }
  const endpoints = new Map<string, Sym>()
  for (const [k, call] of calls.entries()) {
    const r = resolved[k]!
    const site = { path: file, range: rangeOf(f, call) }
    const endpoint = httpEndpoint(f, call)
    if (endpoint) {
      let sym = endpoints.get(endpoint)
      if (!sym) { sym = { local_id: `${file}#endpoint#${endpoint}`, path: file, kind: 'endpoint', name: endpoint.split(' ')[1]!, qualified_name: endpoint, range: rangeOf(f, call), signature: null }; endpoints.set(endpoint, sym) }
      relationships.push({ type: 'dispatches_to', origin: 'framework_adapter', source: { symbol: within(call) }, site, resolution: 'resolved', target: { symbol: sym.local_id }, detail: { direction: 'outbound', rule: 'http_client' } })
    }
    // A call that does not resolve keeps the name it calls and its argument count, which find its likely targets by name.
    const fn = call.childForFieldName('function'), named = fn?.type === 'attribute' ? fn.childForFieldName('attribute') : fn
    const unbound = { ...(named?.type === 'identifier' ? { callee: named.text } : {}), arity: String(call.childForFieldName('arguments')?.namedChildCount ?? 0) }
    relationships.push(r.resolution === 'candidate'
      ? { type: 'calls', origin: 'semantic_resolver', source: { symbol: within(call) }, site, resolution: 'candidate', candidates: r.candidates, detail: unbound }
      : r.resolution === 'unresolved'
        ? { type: 'calls', origin: 'semantic_resolver', source: { symbol: within(call) }, site, ...r, detail: { ...r.detail, ...unbound } }
        : { type: 'calls', origin: 'semantic_resolver', source: { symbol: within(call) }, site, ...r })
  }
  const refs = importRefs(file, f)
  for (const r of refs) for (const to of targets(r)) relationships.push({ type: 'imports', origin: 'semantic_resolver', source: { file }, site: { path: file, range: rangeOf(f, r.node) }, resolution: 'resolved', target: { file: to } })
  for (const id of f.classes.keys()) {
    for (const b of await basesOf(id)) if (b.symbol) relationships.push({ type: 'inherits', origin: 'semantic_resolver', source: { symbol: id }, site: { path: file, range: rangeOf(f, b.node) }, resolution: 'resolved', target: { symbol: b.symbol } })
  }
  const resources = await resourcesIn(file)
  let resourceReferences = 0
  for (const call of calls) {
    const resource = resources.get(call.startIndex)
    if (!resource) continue
    const facts = await resourceFacts(file, f, call, resource.local_id)
    resourceReferences += facts.length
    relationships.push(...facts)
  }
  const syntax = f.tree.rootNode.hasError ? 'partial' : 'complete'
  const unresolved = resolved.some((r) => r.resolution === 'unresolved' || r.resolution === 'candidate')
  const stuck = resolved.filter((r) => r.resolution === 'unresolved' && r.detail?.why === 'pyright_timeout').length
  if (stuck) send({ jsonrpc: '2.0', method: 'log', params: { level: 'warning', message: `${file}: Pyright answered nothing within ${REQUEST_MS / 1000} s for ${stuck} calls; they are unresolved` } })
  // Only imports of repository files are reported, so imports are partial wherever a file imports anything else.
  const external = refs.some((r) => !targets(r).length)
  // Only references between Pulumi resources are reported, so a file that has them says references are partial.
  return { symbols: [...f.symbols, ...endpoints.values(), ...resources.values()], relationships, result: { path: file, status: 'ok', capabilities: { text: 'complete', syntax, symbols: 'complete', imports: external ? 'partial' : 'complete', references: resourceReferences ? 'partial' : 'unsupported', resolved_calls: unresolved ? 'partial' : 'complete', framework: endpoints.size || resources.size ? 'partial' : 'unsupported' } } }
}

/** The repository's installed packages, read from a virtual environment's site-packages, never by running its interpreter (A2). */
function findSitePackages(root: string | undefined): string | null {
  if (!root) return null
  for (const venv of ['.venv', 'venv']) {
    const lib = path.join(root, venv, 'lib')
    if (!fs.existsSync(lib)) continue
    for (const py of fs.readdirSync(lib).filter((d) => d.startsWith('python')).sort()) {
      const sp = path.join(lib, py, 'site-packages')
      if (fs.existsSync(sp)) return sp
    }
  }
  return null
}

/** site-packages as Pyright is shown it: links to every entry but the .pth files. Pyright searches a .pth file's directories ahead of any
 *  extra path, and an editable install of the repository's own package names a directory of the original checkout, outside the
 *  workspace. Each such directory is searched in the workspace instead, ahead of the installed packages. */
function searchPaths(sp: string, repositoryRoot: string): string[] {
  shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'proofmesh-site-'))
  process.on('exit', () => fs.rmSync(shadow!, { recursive: true, force: true }))
  const root = fs.realpathSync(repositoryRoot), editable: string[] = []
  for (const e of fs.readdirSync(sp).sort()) {
    if (!e.endsWith('.pth')) { fs.symlinkSync(path.join(sp, e), path.join(shadow, e)); continue }
    for (const line of fs.readFileSync(path.join(sp, e), 'utf8').split('\n').map((l) => l.trim())) {
      // shortcut: a .pth directory outside the repository is dropped, so what it holds resolves as outside_capability; add it as a search path if that matters.
      if (!path.isAbsolute(line) || !fs.existsSync(line)) continue
      const rel = path.relative(root, fs.realpathSync(line))
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) editable.push(path.join(workspace, rel))
    }
  }
  return [...editable, shadow]
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const req = JSON.parse(line)
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: req.id, result })
  try {
    if (req.method === 'initialize') {
      await Parser.init()
      workspace = req.params.workspace
      pythonFiles = new Set((req.params.files as Array<{ path: string; language: string }>).filter((x) => x.language === 'python').map((x) => x.path))
      sitePackages = findSitePackages(req.params.repository_root)
      const distributions = sitePackages ? fs.readdirSync(sitePackages).filter((d) => d.endsWith('.dist-info')).map((d) => d.replace(/\.dist-info$/, '')).sort() : []
      installed = new Set(sitePackages ? fs.readdirSync(sitePackages).filter((d) => !d.includes('.') || d.endsWith('.py')).map((d) => d.replace(/\.py$/, '')) : [])
      extraPaths = sitePackages ? searchPaths(sitePackages, req.params.repository_root) : []
      await startSession()
      reply({
        adapter: { id: 'python', version: VERSION, protocol_version: '1.1', languages: ['python'], toolchain: { ...toolchain(['python']), pyright: pyrightVersion } },
        capabilities: { symbols: true, imports: true, resolved_calls: true }, external_inputs: distributions.map((d) => `pypi:${d.replace(/-(?=[^-]*$)/, '/')}`), units: await units(),
      })
    } else if (req.method === 'workspace') {
      // A mistake in the table or entry-point rules costs their facts, not the index.
      const out = { symbols: [] as unknown[], relationships: [] as unknown[], file_results: [], diagnostics: [] as unknown[] }
      for (const [what, rules] of [['table mappings', tables], ['entry points', entryPoints]] as const) {
        const t = await waitingOnPyright(`the ${what}`, rules).catch((e: Error) => e)
        if (t instanceof Error) out.diagnostics.push({ level: 'error', message: `could not read ${what}: ${t.message}` })
        else { out.symbols.push(...t.symbols); out.relationships.push(...t.relationships) }
      }
      reply(out)
    } else if (req.method === 'analyze') {
      const out = { symbols: [] as unknown[], relationships: [] as unknown[], file_results: [] as unknown[], diagnostics: [] as unknown[] }
      for (const p of req.params.paths as string[]) {
        try {
          const r = await analyse(p)
          out.symbols.push(...r.symbols); out.relationships.push(...r.relationships); out.file_results.push(r.result)
          // Progress: the core's timeout measures silence, and Pyright may take seconds over a large file.
          send({ jsonrpc: '2.0', method: 'log', params: { level: 'debug', message: `analysed ${p}` } })
        } catch (e) {
          out.file_results.push({ path: p, status: 'failed', capabilities: { text: 'complete', syntax: 'failed' } })
          out.diagnostics.push({ level: 'error', message: `could not analyse ${p}: ${(e as Error).message}` })
        }
      }
      reply(out)
    } else if (req.method === 'shutdown') {
      reply({})
      server?.kill()
      process.exit(0)
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: (e as Error).message } })
  }
})
