// The Terraform adapter (A8, A25): static HCL through Tree-sitter, never `terraform init`. A module is a directory. Its
// resources, data sources, variables, locals, outputs and module calls are symbols named by their Terraform address, and each
// reference resolves within its module, or to a local child module's output; remote modules are reported unresolved.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Node, Tree } from 'web-tree-sitter'
import { Parser } from 'web-tree-sitter'
import { byteOffsets, lastLine, parser, send, toolchain, type Range } from './common.js'

const VERSION = '0.1.0'
type Sym = { local_id: string; path: string; kind: string; name: string; qualified_name: string; range: Range; signature: string | null }
type Parsed = { file: string; text: string; at: Uint32Array; tree: Tree }
type Module = { dir: string; files: Parsed[]; symbols: Map<string, Sym>; children: Map<string, string | null> }

let workspace = ''
let files: string[] = []
const parsed = new Map<string, Parsed>()
const modules = new Map<string, Module>()
// Names whose first segment is a Terraform built-in, never a symbol in the module.
const BUILT_IN_ROOTS = new Set(['count', 'each', 'path', 'self', 'terraform'])
const META = new Set(['source', 'version', 'providers', 'count', 'for_each', 'depends_on', 'lifecycle', 'provider'])

const dirOf = (file: string) => path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)
const label = (dir: string) => dir || 'root'
const text = (n: Node) => n.type === 'string_lit' ? n.namedChildren.filter((c) => c.type === 'template_literal').map((c) => c.text).join('') : n.text

async function parse(file: string): Promise<Parsed> {
  let p = parsed.get(file)
  if (!p) {
    const t = fs.readFileSync(path.join(workspace, file), 'utf8')
    p = { file, text: t, at: byteOffsets(t), tree: (await parser('hcl')).parse(t)! }
    parsed.set(file, p)
  }
  return p
}

const blocks = (p: Parsed) => p.tree.rootNode.namedChildren.find((c) => c.type === 'body')?.namedChildren.filter((c) => c.type === 'block') ?? []
const labels = (b: Node) => b.namedChildren.filter((c) => c.type === 'string_lit').map(text)
const body = (b: Node) => b.namedChildren.find((c) => c.type === 'body')
const attributes = (b: Node) => body(b)?.namedChildren.filter((c) => c.type === 'attribute') ?? []
const attrName = (a: Node) => a.namedChildren[0]!.text

/** A module block's source: the string its source attribute holds. */
function sourceOf(b: Node): string {
  const a = attributes(b).find((x) => attrName(x) === 'source')
  const lit = a?.descendantsOfType('string_lit')[0]
  return lit ? text(lit) : ''
}

function rangeOf(p: Parsed, n: Node): Range {
  return { start_byte: p.at[n.startIndex]!, end_byte: Math.max(p.at[n.endIndex]!, p.at[n.startIndex]! + 1), start_line: n.startPosition.row + 1, end_line: n.endPosition.row + 1 }
}

/** The symbols one block declares: a resource, data source, variable, output or module call, or each local of a locals block. */
function declarations(p: Parsed, b: Node): Array<{ node: Node; kind: string; address: string; signature: string }> {
  const type = b.namedChildren[0]!.text, l = labels(b)
  if (type === 'resource' && l.length === 2) return [{ node: b, kind: 'resource', address: `${l[0]}.${l[1]}`, signature: `resource "${l[0]}"` }]
  if (type === 'data' && l.length === 2) return [{ node: b, kind: 'resource', address: `data.${l[0]}.${l[1]}`, signature: `data "${l[0]}"` }]
  if (type === 'variable' && l.length === 1) return [{ node: b, kind: 'variable', address: `var.${l[0]}`, signature: 'variable' }]
  if (type === 'output' && l.length === 1) return [{ node: b, kind: 'output', address: `output.${l[0]}`, signature: 'output' }]
  if (type === 'locals') return attributes(b).map((a) => ({ node: a, kind: 'variable', address: `local.${attrName(a)}`, signature: 'local' }))
  if (type === 'module' && l.length === 1) return [{ node: b, kind: 'module_call', address: `module.${l[0]}`, signature: `module "${sourceOf(b)}"` }]
  return []
}

/** A module directory's symbol table, and where each of its module calls points: a local directory, or null when remote. */
async function moduleAt(dir: string): Promise<Module> {
  let m = modules.get(dir)
  if (m) return m
  m = { dir, files: [], symbols: new Map(), children: new Map() }
  modules.set(dir, m)
  for (const f of files.filter((x) => dirOf(x) === dir).sort()) {
    const p = await parse(f)
    m.files.push(p)
    for (const b of blocks(p)) {
      for (const d of declarations(p, b)) {
        m.symbols.set(d.address, { local_id: `${f}#${d.node.startIndex}`, path: f, kind: d.kind, name: d.address, qualified_name: `${label(dir)}:${d.address}`, range: rangeOf(p, d.node), signature: d.signature })
      }
      if (b.namedChildren[0]!.text === 'module') {
        const raw = sourceOf(b)
        const local = raw.startsWith('./') || raw.startsWith('../') ? path.posix.normalize(path.posix.join(dir, raw)) : null
        m.children.set(labels(b)[0]!, local && files.some((x) => dirOf(x) === local) ? local : null)
      }
    }
  }
  return m
}

/** Every traversal in a subtree, as its segments and its node, skipping the ones inside a nested expression's own traversal. */
function traversals(n: Node, skip: (attr: Node) => boolean): Array<{ segments: string[]; node: Node }> {
  const out: Array<{ segments: string[]; node: Node }> = []
  const walk = (x: Node) => {
    if (x.type === 'attribute' && skip(x)) return
    if (x.type === 'expression') {
      const kids = x.namedChildren
      if (kids[0]?.type === 'variable_expr') {
        const segments = [kids[0].text]
        for (const k of kids.slice(1)) { if (k.type !== 'get_attr') break; segments.push(k.namedChildren[0]!.text) }
        if (segments.length > 1) out.push({ segments, node: x })
      }
    }
    for (const c of x.namedChildren) walk(c)
  }
  walk(n)
  return out
}

type Target = { resolved: true; symbol: string } | { resolved: false; reason: string; name: string } | null

/** What a traversal names: a symbol of this module, a local child module's output, or nothing this adapter models. */
async function resolve(m: Module, segments: string[]): Promise<Target> {
  const [root, a, b] = segments
  const local = (address: string) => { const s = m.symbols.get(address); return s ? { resolved: true as const, symbol: s.local_id } : { resolved: false as const, reason: 'unknown_name', name: address } }
  if (BUILT_IN_ROOTS.has(root!)) return null
  if (root === 'var' || root === 'local') return local(`${root}.${a}`)
  if (root === 'data') return b ? local(`data.${a}.${b}`) : null
  if (root === 'module') {
    if (!m.symbols.has(`module.${a}`)) return { resolved: false, reason: 'unknown_name', name: `module.${a}` }
    const child = m.children.get(a!)
    if (b && child) {
      const out = (await moduleAt(child)).symbols.get(`output.${b}`)
      return out ? { resolved: true, symbol: out.local_id } : { resolved: false, reason: 'unknown_name', name: `module.${a}.${b}` }
    }
    return local(`module.${a}`)
  }
  // A resource type has a provider prefix, as aws_s3_bucket does; anything else is an object key or a function argument.
  return root!.includes('_') ? local(`${root}.${a}`) : null
}

async function analyse(file: string) {
  const p = await parse(file)
  const m = await moduleAt(dirOf(file))
  const fileId = `${file}#file`
  // An empty file has no byte to cite, so it has no symbol.
  const symbols: Sym[] = p.text ? [{ local_id: fileId, path: file, kind: 'module', name: path.posix.basename(file), qualified_name: file.replace(/\.tf$/, ''), range: { start_byte: 0, end_byte: p.at[p.text.length]!, start_line: 1, end_line: lastLine(p.text) }, signature: null }] : []
  const relationships: unknown[] = []
  const relate = (type: string, source: string, site: Node, t: Exclude<Target, null>) => relationships.push(t.resolved
    ? { type, origin: 'configuration_adapter', source: { symbol: source }, site: { path: file, range: rangeOf(p, site) }, resolution: 'resolved', target: { symbol: t.symbol } }
    : { type, origin: 'configuration_adapter', source: { symbol: source }, site: { path: file, range: rangeOf(p, site) }, resolution: 'unresolved', reason: t.reason, detail: { name: t.name } })
  for (const b of blocks(p)) {
    const decls = declarations(p, b)
    for (const d of decls) symbols.push(m.symbols.get(d.address)!)
    // A locals block declares one symbol per local; any other block is one symbol, or none, as a provider block is.
    const owners = b.namedChildren[0]!.text === 'locals' ? decls.map((d) => ({ id: m.symbols.get(d.address)!.local_id, node: d.node })) : [{ id: decls[0] ? m.symbols.get(decls[0].address)!.local_id : fileId, node: b }]
    for (const owner of owners) {
      for (const t of traversals(owner.node, (a) => attrName(a) === 'depends_on' || (b.namedChildren[0]!.text === 'module' && attrName(a) === 'source'))) {
        const target = await resolve(m, t.segments)
        if (target) relate('references', owner.id, t.node, target)
      }
    }
    for (const a of attributes(b).filter((x) => attrName(x) === 'depends_on')) {
      for (const t of traversals(a.namedChildren[1]!, () => false)) {
        const target = await resolve(m, t.segments)
        if (target) relate('depends_on', owners[0]!.id, t.node, target)
      }
    }
    if (b.namedChildren[0]!.text === 'module' && decls[0]) {
      const name = labels(b)[0]!, child = m.children.get(name)
      const source = attributes(b).find((x) => attrName(x) === 'source') ?? b
      if (child) for (const f of (await moduleAt(child)).files.filter((x) => x.text)) relate('depends_on', m.symbols.get(`module.${name}`)!.local_id, source, { resolved: true, symbol: `${f.file}#file` })
      // A remote module is fetched by terraform init, which this adapter never runs.
      else relate('depends_on', m.symbols.get(`module.${name}`)!.local_id, source, { resolved: false, reason: 'dependency_missing', name: sourceOf(b) })
    }
  }
  const syntax = p.tree.rootNode.hasError ? 'partial' : 'complete'
  return { symbols, relationships, result: { path: file, status: 'ok', capabilities: { text: 'complete', syntax, symbols: 'complete', references: 'complete', imports: 'unsupported', resolved_calls: 'unsupported' } } }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const req = JSON.parse(line)
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: req.id, result })
  try {
    if (req.method === 'initialize') {
      await Parser.init()
      workspace = req.params.workspace
      files = (req.params.files as Array<{ path: string; language: string }>).filter((f) => f.language === 'terraform').map((f) => f.path)
      // A module's facts depend on its own files and on the local modules it calls, so each directory is a unit (A16).
      const dirs = [...new Set(files.map(dirOf))].sort()
      const units = []
      for (const dir of dirs) {
        const m = await moduleAt(dir)
        units.push({ id: label(dir), files: m.files.map((f) => f.file), depends_on: [...new Set([...m.children.values()].filter((c): c is string => c !== null))].map(label).sort() })
      }
      reply({ adapter: { id: 'terraform', version: VERSION, protocol_version: '1.0', languages: ['terraform'], toolchain: toolchain(['hcl']) }, capabilities: { symbols: true, references: true }, external_inputs: [], units })
    } else if (req.method === 'workspace') {
      reply({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
    } else if (req.method === 'analyze') {
      const out = { symbols: [] as unknown[], relationships: [] as unknown[], file_results: [] as unknown[], diagnostics: [] as unknown[] }
      for (const p of req.params.paths as string[]) {
        try {
          const r = await analyse(p)
          out.symbols.push(...r.symbols); out.relationships.push(...r.relationships); out.file_results.push(r.result)
        } catch (e) {
          out.file_results.push({ path: p, status: 'failed', capabilities: { text: 'complete', syntax: 'failed' } })
          out.diagnostics.push({ level: 'error', message: `could not read ${p}: ${(e as Error).message}` })
        }
      }
      reply(out)
    } else if (req.method === 'shutdown') {
      reply({})
      process.exit(0)
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: (e as Error).message } })
  }
})
