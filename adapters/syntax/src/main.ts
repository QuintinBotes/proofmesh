// The Tree-sitter syntax tier (A6, A23): declarations and call sites for languages no semantic adapter covers, read through
// each grammar's tags query. It never guesses a call's target: every call site is reported unresolved, with the name it calls.
// An import, and a supertype a type declares, is unresolved too, and a table a SQL statement names is a candidate only when the same file declares it. A Prisma
// schema has no tags query: prisma.ts reads its models.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Parser, Query, type Node } from 'web-tree-sitter'
import { byteOffsets, grammarsDir, language, lastLine, manifest, parser, send, toolchain, type Range } from './common.js'
import { prismaFacts } from './prisma.js'
import { callFacts } from './scope.js'

const VERSION = '0.1.0'
const SYNTAX_LANGUAGES = Object.keys(manifest).filter((l) => l !== 'hcl')
// Tags kinds this tier keeps; variables, fields and properties are mostly locals and parameters, so they are left out. Proofmesh's
// own queries name a property declared in a type's body `member`, and a database table or view `table`.
const KINDS: Record<string, string> = { function: 'function', method: 'method', class: 'class', object: 'class', interface: 'interface', module: 'namespace', type: 'type_alias', enum: 'enum', constant: 'variable', macro: 'function', struct: 'struct', member: 'property', table: 'table' }
// A database object is named by its schema-qualified identity, unquoted; a name the grammar could not parse names nothing.
const dbName = (n: Node) => (n.hasError ? null : n.text.split('.').map((p) => p.replace(/^["`[](.*)["`\]]$/, '$1')))

// The languages whose qualified name starts with the package or namespace the source declares; every other language's starts with the file path (FR146).
const PACKAGE_NODES: Record<string, string> = { java: 'package_declaration', kotlin: 'package_header', scala: 'package_clause', php: 'namespace_definition' }
type Package = { node: Node; name: string; braced: boolean }
const packagesOf = (lang: string, root: Node): Package[] => root.descendantsOfType(PACKAGE_NODES[lang]!).map((node) => ({ node, name: (/^(?:package|namespace)\s*([\w.\\]*)/.exec(node.text)?.[1] ?? '').replace(/\\/g, '.'), braced: !!node.childForFieldName('body') }))
// The packages a declaration sits in: braced ones around it, and the unbraced ones before it (Scala chains them, PHP's last one replaces the rest).
function packageParts(lang: string, packages: Package[], at: Node): string[] {
  const around = packages.filter((p) => p.braced && p.node.startIndex <= at.startIndex && at.endIndex <= p.node.endIndex)
  const before = packages.filter((p) => !p.braced && p.node.endIndex <= at.startIndex)
  const parts = lang === 'php' ? (around.length ? around : before.slice(-1)) : [...before, ...around]
  return parts.map((p) => p.name).filter(Boolean)
}
// A callable's parameter types as its declaration writes them: a default value is no part of one, varargs keep their dots, qualifiers
// and a pointer or reference mark stay with the type, and Go's `a, b int` is two parameters.
function parameterTypes(node: Node): string {
  const list = node.childForFieldName('parameters') ?? node.namedChildren.find((c) => /parameters?$|parameter_list$/.test(c.type))
  return (list?.namedChildren ?? []).filter((p) => /parameter/.test(p.type) && p.type !== 'self_parameter').flatMap((p) => {
    if (p.type === 'spread_parameter') return [`${p.namedChildren[0]?.text ?? ''}...`]
    const type = p.childForFieldName('type') ?? p.namedChildren.find((c) => /type$/.test(c.type))
    if (!type) return ['']
    const qualifiers = p.namedChildren.filter((c) => c.type === 'type_qualifier').map((c) => c.text)
    const mark = p.childForFieldName('declarator')?.text.match(/^[*&\s]*/)?.[0].replace(/\s/g, '') ?? ''
    const text = `${p.type === 'variadic_parameter_declaration' ? '...' : ''}${[...qualifiers, type.text].join(' ')}${mark}`.replace(/\s+/g, ' ')
    return Array(p.type === 'parameter_declaration' ? Math.max(1, p.childrenForFieldName('name').length) : 1).fill(text) as string[]
  }).join(',')
}
// A function_declarator is a definition when a function body hangs from it, and a prototype otherwise.
const isDefinition = (n: Node) => { let p = n.parent; while (p && /^(pointer|reference|parenthesized)_declarator$/.test(p.type)) p = p.parent; return p?.type === 'function_definition' }

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

// `callees` is for the SCIP importer, which joins a call site to the index's occurrence at the callee name (FR161): it asks the private method
// `analyze_calls`, which the public protocol does not name, and gets the name's byte range in each call's detail.
async function analyse(file: string, callees = false) {
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
  const calls: Array<{ name: string; site: Range; node: Node; at: Range; facts: Record<string, string> }> = []
  const imports: Array<{ node: Node; detail?: Record<string, string> }> = []
  const supertypes: Array<{ type: string; relation?: string; node: Node }> = []
  const tables: Array<{ name: Node; parts: string[] }> = []
  const locals: Array<{ node: Node; name: string }> = []
  for (const m of query.matches(tree.rootNode)) {
    const name = m.captures.find((c) => c.name === 'name')?.node
    const def = m.captures.find((c) => c.name.startsWith('definition.'))
    const role = (r: string) => m.captures.find((c) => c.name === r)?.node
    // A Java `new T()` is a call of T, and the only reference.class the tags query matches on an object creation (a superclass is the other).
    const created = role('reference.class')?.type === 'object_creation_expression' ? role('reference.class') : undefined
    const ref = role('reference.call') ?? created
    // An import statement, and a supertype a type names, need no @name: the module and the supertype are their own captures.
    const statement = role('import')
    if (statement) {
      const spec = role('import.module'), alias = role('import.alias')
      // A wildcard import's module runs to its `*`, as written.
      const detail = spec ? { module: text.slice(spec.startIndex, (role('import.wildcard') ?? spec).endIndex).replace(/^["`](.*)["`]$/s, '$1'), ...(alias ? { alias: alias.text } : {}), ...(lang === 'java' && /^import\s+static\b/.test(statement.text) ? { static: 'true' } : {}) } : undefined
      imports.push({ node: statement, ...(detail ? { detail } : {}) })
      continue
    }
    const heritage = m.captures.find((c) => /^(inherits|implements)(\.|$)/.test(c.name))
    if (heritage) {
      const [type, relation] = heritage.name.split('.')
      supertypes.push({ type: type!, ...(relation ? { relation } : {}), node: heritage.node })
      continue
    }
    if (!name) continue
    if (def && KINDS[def.name.slice('definition.'.length)]) {
      const id = `${file}#${def.node.startIndex}`, kind = KINDS[def.name.slice('definition.'.length)]!
      // A node two patterns match is one definition; a method beats a plain function (Rust matches both inside an impl).
      const seen = symbols.find((s) => s.local_id === id)
      // A Go type_spec is also matched as the struct or interface it declares, which is the more exact kind.
      if (seen) { if (kind === 'method' || (seen.kind === 'type_alias' && (kind === 'struct' || kind === 'interface'))) seen.kind = kind; continue }
      const parts = kind === 'table' ? dbName(name) : null
      if (kind === 'table' && (!parts || symbols.some((s) => s.kind === 'table' && s.qualified_name === parts.join('.')))) continue
      defs.push({ id, node: def.node, qualified: name.text })
      symbols.push({ local_id: id, path: file, kind, name: parts?.at(-1) ?? name.text, qualified_name: parts?.join('.') ?? '', range: range(def.node), signature: null })
    } else if (ref) {
      const [first, last] = name.startIndex <= ref.startIndex ? [name, ref] : [ref, name]
      // A Java call's arguments are the capture; the invocation is their parent.
      const call = lang === 'java' && ref.type === 'argument_list' ? ref.parent! : ref
      calls.push({ name: name.text, site: range(first, last.endIndex >= first.endIndex ? last : first), node: ref, at: range(name), facts: callFacts(lang, call, name) })
    } else if (role('reference.table')) {
      const parts = dbName(name)
      if (parts) tables.push({ name, parts })
    } else if (role('scope')) {
      // A trait impl is named under its type and the trait, so `impl Display for X` and `impl Debug for X` keep their `fmt` apart.
      const scope = role('scope')!, trait = scope.type === 'impl_item' ? scope.childForFieldName('trait') : null
      scopes.push({ node: scope, qualified: name.text.replace(/<[^<>]*>/g, '').replace(/::/g, '.') + (trait ? `.<${trait.text.replace(/<.*$/s, '').split('::').at(-1)}>` : '') })
    }
    else if (role('local')) locals.push({ node: role('local')!.parent!, name: name.text.toLowerCase() })
  }
  // A definition's qualified name is the module, then the definitions it sits inside, then its own name; a table keeps its own. Java, Kotlin,
  // Scala and PHP start from the package or namespace the source declares instead (FR146).
  const within = (inner: Node, outer: Node) => outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex && outer !== inner
  const packages = PACKAGE_NODES[lang] ? packagesOf(lang, tree.rootNode) : null
  const members = symbols.slice(1).filter((s) => s.kind !== 'table').map((s) => {
    const d = defs.find((x) => x.id === s.local_id)!
    // A package declaration is a definition in some grammars: it is the package, not a member of the ones around it.
    const chain = [...defs, ...scopes].filter((o) => within(d.node, o.node) && o.node.type !== PACKAGE_NODES[lang]).sort((a, b) => a.node.startIndex - b.node.startIndex).map((o) => o.qualified)
    const parts = [...chain, d.qualified]
    const own = packages?.find((p) => p.node.startIndex <= d.node.startIndex && d.node.endIndex <= p.node.endIndex && d.node.type === PACKAGE_NODES[lang])
    s.qualified_name = !packages ? `${module}:${parts.join('.')}` : own ? [...packageParts(lang, packages.filter((p) => p !== own), own.node), own.name].join('.') : [...packageParts(lang, packages, d.node), ...parts].join('.')
    return { s, d, types: parameterTypes(d.node) }
  })
  const byName = new Map<string, typeof members>()
  for (const n of members) if (n.s.kind === 'function' || n.s.kind === 'method') byName.set(String(n.s.qualified_name), [...(byName.get(String(n.s.qualified_name)) ?? []), n])
  for (const group of byName.values()) {
    // A C or C++ prototype and the definition with the same parameters are one symbol, declared at the definition.
    const dropped = lang === 'c' || lang === 'cpp' ? group.filter((n) => !isDefinition(n.d.node) && group.some((o) => isDefinition(o.d.node) && o.types === n.types)) : []
    for (const n of dropped) { symbols.splice(symbols.indexOf(n.s), 1); defs.splice(defs.indexOf(n.d), 1) }
    // Declarations of one name that remain, overloads and the like, are told apart by their parameter types.
    const rest = group.filter((n) => !dropped.includes(n))
    if (rest.length > 1) for (const n of rest) n.s.qualified_name = `${n.s.qualified_name}(${n.types})`
  }
  const enclosing = (n: Node) => defs.filter((d) => within(n, d.node) || d.node === n).sort((a, b) => b.node.startIndex - a.node.startIndex)[0]?.id ?? moduleId
  const relationships: Array<Record<string, unknown>> = calls.map((c) => ({ type: 'calls', origin: 'syntax', source: { symbol: enclosing(c.node) }, site: { path: file, range: c.site }, resolution: 'unresolved', reason: 'outside_capability', detail: { callee: c.name, ...c.facts, ...(callees ? { callee_start: String(c.at.start_byte), callee_end: String(c.at.end_byte) } : {}) } }))
  for (const i of imports) relationships.push({ type: 'imports', origin: 'syntax', source: { file }, site: { path: file, range: range(i.node) }, resolution: 'unresolved', reason: 'outside_capability', ...(i.detail ? { detail: i.detail } : {}) })
  // A supertype is named, never resolved (FR117): the constrained-resolution slice binds it.
  for (const h of supertypes) relationships.push({ type: h.type, origin: 'syntax', source: { symbol: enclosing(h.node) }, site: { path: file, range: range(h.node) }, resolution: 'unresolved', reason: 'outside_capability', detail: { name: h.node.text, ...(h.relation ? { relation: h.relation } : {}) } })
  // A table this file declares under the name a query uses is a candidate; any other is named and left unresolved.
  const references = tables.filter((t) => !locals.some((l) => t.parts.length === 1 && l.name === t.parts[0]!.toLowerCase() && within(t.name, l.node)))
  for (const t of references) {
    const key = (s: Record<string, unknown>) => String(t.parts.length > 1 ? s.qualified_name : s.name).toLowerCase()
    const declared = symbols.find((s) => s.kind === 'table' && key(s) === t.parts.join('.').toLowerCase())
    relationships.push({ type: 'references', origin: 'syntax', source: { symbol: enclosing(t.name) }, site: { path: file, range: range(t.name) }, ...(declared ? { resolution: 'candidate', candidates: [declared.local_id] } : { resolution: 'unresolved', reason: 'outside_capability' }), detail: { name: t.parts.join('.') } })
  }
  // Imports and references are partial wherever the language names any: this tier resolves neither.
  const named = (capture: string, found: number) => (!query.captureNames.includes(capture) ? 'unsupported' : found ? 'partial' : 'complete')
  return { symbols, relationships, result: { path: file, status: 'ok', capabilities: { text: 'complete', syntax, symbols: 'partial', imports: query.captureNames.includes('import') ? 'partial' : 'unsupported', references: named('reference.table', references.length), resolved_calls: 'unsupported' } } }
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
    } else if (req.method === 'analyze' || req.method === 'analyze_calls') {
      const out = { symbols: [] as unknown[], relationships: [] as unknown[], file_results: [] as unknown[], diagnostics: [] as unknown[] }
      for (const p of req.params.paths as string[]) {
        try {
          const r = await analyse(p, req.method === 'analyze_calls')
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
