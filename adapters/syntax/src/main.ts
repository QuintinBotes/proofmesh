// The Tree-sitter syntax tier (A6, A23): declarations and call sites for languages no semantic adapter covers, read through
// each grammar's tags query. It never guesses a call's target: every call site is reported unresolved, with the name it calls.
// An import is unresolved too, and a table a SQL statement names is a candidate only when the same file declares it. A Prisma
// schema has no tags query: prisma.ts reads its models.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Parser, Query, type Node } from 'web-tree-sitter'
import { byteOffsets, grammarsDir, language, lastLine, manifest, parser, send, toolchain, type Range } from './common.js'
import { prismaFacts } from './prisma.js'

const VERSION = '0.1.0'
const SYNTAX_LANGUAGES = Object.keys(manifest).filter((l) => l !== 'hcl')
// Tags kinds this tier keeps; variables, fields and properties are mostly locals and parameters, so they are left out. Proofmesh's
// own queries name a property declared in a type's body `member`, and a database table or view `table`.
const KINDS: Record<string, string> = { function: 'function', method: 'method', class: 'class', object: 'class', interface: 'interface', module: 'namespace', type: 'type_alias', enum: 'enum', constant: 'variable', macro: 'function', struct: 'struct', member: 'property', table: 'table' }
// A database object is named by its schema-qualified identity, unquoted; a name the grammar could not parse names nothing.
const dbName = (n: Node) => (n.hasError ? null : n.text.split('.').map((p) => p.replace(/^["`[](.*)["`\]]$/, '$1')))

let workspace = ''
const languageOf = new Map<string, string>()
const queries = new Map<string, Promise<Query>>()

function tags(name: string): Promise<Query> {
  let q = queries.get(name)
  if (!q) {
    q = language(name).then((l) => new Query(l, fs.readFileSync(path.join(grammarsDir, `${name}.scm`), 'utf8')))
    queries.set(name, q)
  }
  return q
}

async function analyse(file: string) {
  const text = fs.readFileSync(path.join(workspace, file), 'utf8')
  const at = byteOffsets(text)
  const lang = languageOf.get(file)!
  const tree = (await parser(lang)).parse(text)!
  const range = (start: Node, end: Node = start): Range => ({ start_byte: at[start.startIndex]!, end_byte: Math.max(at[end.endIndex]!, at[start.startIndex]! + 1), start_line: start.startPosition.row + 1, end_line: end.endPosition.row + 1 })
  const module = file.replace(/\.[^./]+$/, '')
  const moduleId = `${file}#module`
  // An empty file has no byte to cite, so it has no symbol.
  const symbols: Array<Record<string, unknown>> = text ? [{ local_id: moduleId, path: file, kind: 'module', name: path.posix.basename(module), qualified_name: module, range: { start_byte: 0, end_byte: at[text.length]!, start_line: 1, end_line: lastLine(text) }, signature: null }] : []
  const syntax = tree.rootNode.hasError ? 'partial' : 'complete'
  if (lang === 'prisma') {
    const r = prismaFacts(tree.rootNode, file, module, range)
    symbols.push(...r.symbols)
    return { symbols, relationships: r.relationships, result: { path: file, status: 'ok', capabilities: { text: 'complete', syntax, symbols: 'partial', imports: 'unsupported', references: r.unresolved ? 'partial' : 'complete', resolved_calls: 'unsupported', framework: 'complete' } } }
  }
  const query = await tags(lang)
  const defs: Array<{ id: string; node: Node; qualified: string }> = []
  // An extension's members are named after the type it extends, which it does not declare.
  const scopes: Array<{ node: Node; qualified: string }> = []
  const calls: Array<{ name: string; site: Range; node: Node }> = []
  const imports: Node[] = []
  const tables: Array<{ name: Node; parts: string[] }> = []
  const locals: Array<{ node: Node; name: string }> = []
  for (const m of query.matches(tree.rootNode)) {
    const name = m.captures.find((c) => c.name === 'name')?.node
    const def = m.captures.find((c) => c.name.startsWith('definition.'))
    const role = (r: string) => m.captures.find((c) => c.name === r)?.node
    const ref = role('reference.call')
    if (!name) continue
    if (def && KINDS[def.name.slice('definition.'.length)]) {
      const id = `${file}#${def.node.startIndex}`, kind = KINDS[def.name.slice('definition.'.length)]!
      // A node two patterns match is one definition; a method beats a plain function (Rust matches both inside an impl).
      const seen = symbols.find((s) => s.local_id === id)
      if (seen) { if (kind === 'method') seen.kind = 'method'; continue }
      const parts = kind === 'table' ? dbName(name) : null
      if (kind === 'table' && (!parts || symbols.some((s) => s.kind === 'table' && s.qualified_name === parts.join('.')))) continue
      defs.push({ id, node: def.node, qualified: name.text })
      symbols.push({ local_id: id, path: file, kind, name: parts?.at(-1) ?? name.text, qualified_name: parts?.join('.') ?? '', range: range(def.node), signature: null })
    } else if (ref) {
      const [first, last] = name.startIndex <= ref.startIndex ? [name, ref] : [ref, name]
      calls.push({ name: name.text, site: range(first, last.endIndex >= first.endIndex ? last : first), node: ref })
    } else if (role('reference.table')) {
      const parts = dbName(name)
      if (parts) tables.push({ name, parts })
    } else if (role('scope')) scopes.push({ node: role('scope')!, qualified: name.text })
    else if (role('import')) imports.push(role('import')!)
    else if (role('local')) locals.push({ node: role('local')!.parent!, name: name.text.toLowerCase() })
  }
  // A definition's qualified name is the module, then the definitions it sits inside, then its own name; a table keeps its own.
  const within = (inner: Node, outer: Node) => outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex && outer !== inner
  for (const s of symbols.slice(1)) {
    if (s.kind === 'table') continue
    const d = defs.find((x) => x.id === s.local_id)!
    const chain = [...defs, ...scopes].filter((o) => within(d.node, o.node)).sort((a, b) => a.node.startIndex - b.node.startIndex).map((o) => o.qualified)
    s.qualified_name = `${module}:${[...chain, d.qualified].join('.')}`
  }
  const enclosing = (n: Node) => defs.filter((d) => within(n, d.node) || d.node === n).sort((a, b) => b.node.startIndex - a.node.startIndex)[0]?.id ?? moduleId
  const relationships: Array<Record<string, unknown>> = calls.map((c) => ({ type: 'calls', origin: 'syntax', source: { symbol: enclosing(c.node) }, site: { path: file, range: c.site }, resolution: 'unresolved', reason: 'outside_capability', detail: { callee: c.name } }))
  for (const i of imports) relationships.push({ type: 'imports', origin: 'syntax', source: { file }, site: { path: file, range: range(i) }, resolution: 'unresolved', reason: 'outside_capability' })
  // A table this file declares under the name a query uses is a candidate; any other is named and left unresolved.
  const references = tables.filter((t) => !locals.some((l) => t.parts.length === 1 && l.name === t.parts[0]!.toLowerCase() && within(t.name, l.node)))
  for (const t of references) {
    const key = (s: Record<string, unknown>) => String(t.parts.length > 1 ? s.qualified_name : s.name).toLowerCase()
    const declared = symbols.find((s) => s.kind === 'table' && key(s) === t.parts.join('.').toLowerCase())
    relationships.push({ type: 'references', origin: 'syntax', source: { symbol: enclosing(t.name) }, site: { path: file, range: range(t.name) }, ...(declared ? { resolution: 'candidate', candidates: [declared.local_id] } : { resolution: 'unresolved', reason: 'outside_capability' }), detail: { name: t.parts.join('.') } })
  }
  // Imports and references are partial wherever the language names any: this tier resolves neither.
  const named = (capture: string, found: number) => (!query.captureNames.includes(capture) ? 'unsupported' : found ? 'partial' : 'complete')
  return { symbols, relationships, result: { path: file, status: 'ok', capabilities: { text: 'complete', syntax, symbols: 'partial', imports: named('import', imports.length), references: named('reference.table', references.length), resolved_calls: 'unsupported' } } }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const req = JSON.parse(line)
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: req.id, result })
  try {
    if (req.method === 'initialize') {
      await Parser.init()
      workspace = req.params.workspace
      for (const f of req.params.files) languageOf.set(f.path, f.language)
      // Each file's facts depend on that file alone, so each is its own unit and only changed files are parsed again (A16).
      reply({ adapter: { id: 'syntax', version: VERSION, protocol_version: '1.0', languages: SYNTAX_LANGUAGES, toolchain: toolchain(SYNTAX_LANGUAGES) }, capabilities: { syntax: true, symbols: true, resolved_calls: false }, external_inputs: [], units: req.params.files.map((f: { path: string }) => ({ id: f.path, files: [f.path] })) })
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
          out.diagnostics.push({ level: 'error', message: `could not parse ${p}: ${(e as Error).message}` })
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
