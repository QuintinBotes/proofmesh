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
import { gtestName, isRubySpec, rubyBlocks, scanRepository, testRoles, unitDependencies, withoutCycles } from './tests.js'

const VERSION = '0.1.0'
const SYNTAX_LANGUAGES = Object.keys(manifest).filter((l) => l !== 'hcl')
// Tags kinds this tier keeps; variables, fields and properties are mostly locals and parameters, so they are left out. Proofmesh's
// own queries name a property declared in a type's body `member`, and a database table or view `table`.
const KINDS: Record<string, string> = { function: 'function', method: 'method', class: 'class', object: 'class', interface: 'interface', module: 'namespace', type: 'type_alias', enum: 'enum', constant: 'variable', macro: 'function', struct: 'struct', member: 'property', table: 'table', constructor: 'constructor', field: 'field' }
// A database object is named by its schema-qualified identity, unquoted; a name the grammar could not parse names nothing.
const dbName = (n: Node) => (n.hasError ? null : n.text.split('.').map((p) => p.replace(/^["`[](.*)["`\]]$/, '$1')))

// The languages whose qualified name starts with the package or namespace the source declares; every other language's starts with the file path (FR146).
const PACKAGE_NODES: Record<string, string[]> = { java: ['package_declaration'], kotlin: ['package_header'], scala: ['package_clause'], php: ['namespace_definition'], csharp: ['namespace_declaration', 'file_scoped_namespace_declaration'] }
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

// A Ruby string without interpolation is its content, whatever delimits it (`"x"`, `'x'`, `%q(x)`).
const rubyString = (n: Node) => (n.type === 'string' && n.namedChildren.every((c) => c.type === 'string_content') ? n.namedChildren.map((c) => c.text).join('') : null)

// A Scala import is read whole: the path as written, then a wildcard, a renamed last name, or the selectors in braces as names.
function scalaImport(n: Node): Record<string, string> {
  const paths = n.childrenForFieldName('path'), tail = n.namedChildren.find((c) => !paths.some((p) => p.equals(c)))
  const written = (a: Node, b: Node) => n.text.slice(a.startIndex - n.startIndex, b.endIndex - n.startIndex).replace(/\s+/g, ' ')
  const base = paths.length ? written(paths[0]!, paths.at(-1)!) : ''
  // Several clauses (`import a._, b.C`) are one statement: its module is all of them as written.
  const last = n.namedChildren.at(-1)!
  if (tail && !tail.equals(last)) return { module: written(paths[0]!, last) }
  if (tail?.type === 'namespace_selectors') return { module: base, names: tail.text.replace(/^\{|\}$/g, '').replace(/\s+/g, ' ').trim() }
  if (tail?.type === 'namespace_wildcard') return { module: `${base}.${tail.text}` }
  if (tail?.type === 'as_renamed_identifier') return { module: `${base}.${tail.childForFieldName('name')!.text}`, alias: tail.childForFieldName('alias')!.text }
  return { module: base }
}
// A C or C++ callee written `a::b<T>` is called by its last name.
function lastName(n: Node): Node {
  for (;;) {
    const next = n.type === 'qualified_identifier' || n.type === 'template_function' || n.type === 'template_method' ? n.childForFieldName('name') : n.type === 'dependent_name' ? n.namedChildren[0] : null
    if (!next) return n
    n = next
  }
}
// An include inside `#if`, `#ifdef` or `#else` is conditional, unless the conditional is the file's include guard: `#ifndef X` then `#define X`, wrapping every other statement.
const isGuard = (p: Node) => p.type === 'preproc_ifdef' && /^#\s*ifndef\b/.test(p.text) && p.parent?.type === 'translation_unit' && p.parent.namedChildren.filter((c) => c.type !== 'comment').length === 1 && p.namedChildren[1]?.type === 'preproc_def' && p.namedChildren[1].childForFieldName('name')?.text === p.childForFieldName('name')?.text
const conditionalInclude = (n: Node) => { for (let p = n.parent; p; p = p.parent) if (/^preproc_(if|ifdef|elif|elifdef|else)$/.test(p.type) && !isGuard(p)) return true; return false }

let workspace = ''
const languageOf = new Map<string, string>()
const queries = new Map<string, Promise<Query>>()

// TypeScript, TSX and JavaScript are read by two grammars: `.ts` by TypeScript's, whose angle-bracket casts a JSX grammar cannot parse, and the rest by TSX's (FR310).
const grammarOf = (lang: string, file: string) => (lang !== 'typescript' && lang !== 'javascript' ? lang : /\.[mc]?ts$/.test(file) ? 'typescript' : 'tsx')
// Roslyn names a generic type with its parameters, `Box<T, U>`, and a member after it.
const GENERIC_TYPES = new Set(['class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration'])
const typeName = (lang: string, def: Node, name: Node) => {
  const list = lang === 'csharp' && GENERIC_TYPES.has(def.type) ? def.namedChildren.find((c) => c.type === 'type_parameter_list') : undefined
  return list ? `${name.text}<${list.namedChildren.map((p) => p.childForFieldName('name')?.text ?? '').join(', ')}>` : name.text
}
// Their precise tiers name overloads alike, so a key must not tell them apart by parameter types.
const OVERLOADS_ALIKE = new Set(['csharp', 'typescript', 'javascript'])

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
  const grammar = grammarOf(lang, file)
  const tree = (await parser(grammar)).parse(text)!
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
  const query = await tags(grammar)
  const defs: Array<{ id: string; node: Node; qualified: string }> = []
  // An extension's members are named after the type it extends, which it does not declare.
  const scopes: Array<{ node: Node; qualified: string }> = []
  const calls: Array<{ name: string; site: Range; node: Node; at: Range; facts: Record<string, string> }> = []
  const imports: Array<{ node: Node; detail?: Record<string, string> }> = []
  const supertypes: Array<{ type: string; relation?: string; node: Node; owner?: Node; conditional?: boolean }> = []
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
      const spec = role('import.module'), alias = role('import.alias'), names = role('import.names')
      // A wildcard import's module runs to its `*`, as written.
      const include = statement.type === 'preproc_include'
      const detail = lang === 'scala' ? scalaImport(statement) : spec ? { module: rubyString(spec) ?? text.slice(spec.startIndex, (role('import.wildcard') ?? spec).endIndex).replace(include ? /^[<"](.*)[>"]$/s : /^["'`](.*)["'`]$/s, '$1'), ...(include ? { system: String(spec.type === 'system_lib_string'), ...(conditionalInclude(statement) ? { conditional: 'true' } : {}) } : {}), ...(alias ? { alias: alias.text } : {}), ...(names ? { names: names.text.replace(/^\{|\}$/g, '').replace(/\s+/g, ' ').trim() } : {}), ...(lang === 'java' && /^import\s+static\b/.test(statement.text) ? { static: 'true' } : {}) } : undefined
      imports.push({ node: statement, ...(detail ? { detail } : {}) })
      continue
    }
    const heritage = m.captures.find((c) => /^(inherits|implements)(\.|$)/.test(c.name))
    if (heritage) {
      // A Scala package object is no symbol of this tier, so its `extends` has no declaring type to run from.
      let clause: Node | null = heritage.node
      while (clause && clause.type !== 'extends_clause') clause = clause.parent
      if (clause?.parent?.type === 'package_object') continue
      const [type, relation] = heritage.name.split('.')
      supertypes.push({ type: type!, ...(relation ? { relation } : {}), node: heritage.node, ...(role('owner') ? { owner: role('owner')! } : {}), ...(role('conditional') ? { conditional: true } : {}) })
      continue
    }
    if (!name) continue
    if (def && KINDS[def.name.slice('definition.'.length)]) {
      const id = `${file}#${def.node.startIndex}`, kind = KINDS[def.name.slice('definition.'.length)]!
      // A node two patterns match is one definition; a method beats a plain function (Rust matches both inside an impl).
      const seen = symbols.find((s) => s.local_id === id)
      // A Go type_spec is also matched as the struct or interface it declares, which is the more exact kind.
      if (seen) { if (kind === 'method' || (seen.kind === 'type_alias' && (kind === 'struct' || kind === 'interface')) || (seen.kind === 'class' && kind === 'struct') || (seen.kind === 'variable' && kind === 'function')) seen.kind = kind; continue }
      const parts = kind === 'table' ? dbName(name) : null
      if (kind === 'table' && (!parts || symbols.some((s) => s.kind === 'table' && s.qualified_name === parts.join('.')))) continue
      defs.push({ id, node: def.node, qualified: typeName(lang, def.node, name) })
      symbols.push({ local_id: id, path: file, kind, name: parts?.at(-1) ?? name.text, qualified_name: parts?.join('.') ?? '', range: range(def.node), signature: null })
    } else if (ref) {
      const callee = lastName(name)
      const [first, last] = name.startIndex <= ref.startIndex ? [name, ref] : [ref, name]
      // A Java call's arguments are the capture; the invocation is their parent.
      const call = lang === 'java' && ref.type === 'argument_list' ? ref.parent! : ref
      calls.push({ name: callee.text, site: range(first, last.endIndex >= first.endIndex ? last : first), node: ref, at: range(callee), facts: callFacts(lang, call, name) })
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
  // A googletest macro is named as it is written, `TEST(Calc, Adds)`. An RSpec example block has no declared name: it is named by its call and its
  // description, and a group block is a scope that names what it sits around (FR192).
  const examples = new Set<string>()
  if (lang === 'c' || lang === 'cpp') for (const d of defs) { const g = gtestName(d.node); if (g) { d.qualified = g; symbols.find((s) => s.local_id === d.id)!.name = g } }
  if (lang === 'ruby' && isRubySpec(file)) {
    const blocks = rubyBlocks(tree.rootNode)
    for (const e of blocks.examples) {
      const id = `${file}#${e.node.startIndex}`
      defs.push({ id, node: e.node, qualified: e.name })
      symbols.push({ local_id: id, path: file, kind: 'function', name: e.name, qualified_name: '', range: range(e.node), signature: null })
      examples.add(id)
    }
    for (const g of blocks.groups) scopes.push({ node: g.node, qualified: g.qualified })
  }
  // A definition's qualified name is the module, then the definitions it sits inside, then its own name; a table keeps its own. Java, Kotlin,
  // Scala and PHP start from the package or namespace the source declares instead (FR146).
  const within = (inner: Node, outer: Node) => outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex && outer !== inner
  const packages = PACKAGE_NODES[lang] ? packagesOf(lang, tree.rootNode) : null
  const members = symbols.slice(1).filter((s) => s.kind !== 'table').map((s) => {
    const d = defs.find((x) => x.id === s.local_id)!
    // A package declaration is a definition in some grammars: it is the package, not a member of the ones around it.
    const chain = [...defs, ...scopes].filter((o) => within(d.node, o.node) && !PACKAGE_NODES[lang]?.includes(o.node.type)).sort((a, b) => a.node.startIndex - b.node.startIndex).map((o) => o.qualified)
    const parts = [...chain, d.qualified]
    const own = packages?.find((p) => p.node.startIndex <= d.node.startIndex && d.node.endIndex <= p.node.endIndex && !!PACKAGE_NODES[lang]?.includes(d.node.type))
    s.qualified_name = !packages ? `${module}:${parts.join('.')}` : own ? [...packageParts(lang, packages.filter((p) => p !== own), own.node), own.name].join('.') : [...packageParts(lang, packages, d.node), ...parts].join('.')
    return { s, d, types: parameterTypes(d.node) }
  })
  const byName = new Map<string, typeof members>()
  for (const n of members) if ((n.s.kind === 'function' || n.s.kind === 'method') && !OVERLOADS_ALIKE.has(lang)) byName.set(String(n.s.qualified_name), [...(byName.get(String(n.s.qualified_name)) ?? []), n])
  for (const group of byName.values()) {
    // A C or C++ prototype and the definition with the same parameters are one symbol, declared at the definition.
    const dropped = lang === 'c' || lang === 'cpp' ? group.filter((n) => !isDefinition(n.d.node) && group.some((o) => isDefinition(o.d.node) && o.types === n.types)) : []
    for (const n of dropped) { symbols.splice(symbols.indexOf(n.s), 1); defs.splice(defs.indexOf(n.d), 1) }
    // Declarations of one name that remain, overloads and the like, are told apart by their parameter types.
    const rest = group.filter((n) => !dropped.includes(n))
    if (rest.length > 1) for (const n of rest) n.s.qualified_name = `${n.s.qualified_name}(${n.types})`
  }
  // The roles are set once the names are final: a test entry point, and test code that is none (FR193).
  const roles = testRoles(lang, file, text, defs, imports, examples)
  for (const s of symbols) { const r = roles.get(s.local_id as string); if (r) s.roles = r }
  // A C or C++ definition is tagged at its declarator, and the body it holds hangs from the function_definition above.
  const extent = (d: (typeof defs)[number]) => { let p = d.node.parent; while (p && /^(pointer|reference|parenthesized)_declarator$/.test(p.type)) p = p.parent; return (lang === 'c' || lang === 'cpp') && d.node.type === 'function_declarator' && p?.type === 'function_definition' ? p : d.node }
  const enclosing = (n: Node) => defs.filter((d) => within(n, extent(d)) || d.node === n).sort((a, b) => b.node.startIndex - a.node.startIndex)[0]?.id ?? moduleId
  const relationships: Array<Record<string, unknown>> = calls.map((c) => ({ type: 'calls', origin: 'syntax', source: { symbol: enclosing(c.node) }, site: { path: file, range: c.site }, resolution: 'unresolved', reason: 'outside_capability', detail: { callee: c.name, ...c.facts, ...(callees ? { callee_start: String(c.at.start_byte), callee_end: String(c.at.end_byte) } : {}) } }))
  // A preprocessor include's node runs through its line break, which is no part of the statement.
  const statementRange = (n: Node): Range => { const r = range(n), extra = n.type === 'preproc_include' ? n.text.slice(n.text.trimEnd().length) : ''; return { ...r, end_byte: r.end_byte - Buffer.byteLength(extra), end_line: r.end_line - (extra.match(/\n/g)?.length ?? 0) } }
  for (const i of imports) relationships.push({ type: 'imports', origin: 'syntax', source: { file }, site: { path: file, range: statementRange(i.node) }, resolution: 'unresolved', reason: 'outside_capability', ...(i.detail ? { detail: i.detail } : {}) })
  // A supertype is named, never resolved (FR117): the constrained-resolution slice binds it.
  // A Rust impl runs from the type it is for: the type this file declares under that name, else the file's module, with the type in `detail.for`.
  const typeKinds = new Set(['class', 'struct', 'enum', 'interface', 'type_alias'])
  // The modules a node sits in, outermost first. An owner written `b::T` is the `T` declared in `b` beside the impl; `crate`, `self` and `super` are read as Rust reads them.
  const modulesOf = (n: Node) => { const out: string[] = []; for (let p = n.parent; p; p = p.parent) if (p.type === 'mod_item') out.unshift(p.childForFieldName('name')?.text ?? ''); return out }
  const ownerOf = (impl: Node, written: string): string | undefined => {
    const segments = written.split('::').map((x) => x.trim()), name = segments.pop()!
    const kinds = (d: (typeof defs)[number]) => typeKinds.has(String(symbols.find((s) => s.local_id === d.id)?.kind))
    const named = defs.filter((d) => d.qualified === name && kinds(d))
    let path = modulesOf(impl)
    for (const [i, seg] of segments.entries()) { if (seg === 'crate' && i === 0) path = []; else if (seg === 'super') path = path.slice(0, -1); else if (seg !== 'self') path = [...path, seg] }
    const exact = named.filter((d) => modulesOf(d.node).join('::') === path.join('::'))
    // A bare name may also be one `use` brought in, so a single declaration of it is the owner; a written path must match, and an ambiguous one names none.
    return (exact.length === 1 ? exact[0] : !segments.length && !exact.length && named.length === 1 ? named[0] : undefined)?.id
  }
  for (const h of supertypes) {
    const written = h.owner?.text.replace(/<.*$/s, '').replace(/^[&\s]+/, '').trim()
    const declared = written ? ownerOf(h.node, written) : undefined
    // A Kotlin supertype's type arguments are no part of its name.
    relationships.push({ type: h.type, origin: 'syntax', source: { symbol: h.owner ? declared ?? moduleId : enclosing(h.node) }, site: { path: file, range: range(h.node) }, resolution: 'unresolved', reason: 'outside_capability', detail: { name: h.node.text.replace(/<.*$/s, ''), ...(h.relation ? { relation: h.relation } : {}), ...(h.conditional ? { conditional: 'true' } : {}), ...(written && !declared ? { for: written } : {}) } })
  }
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
      scanRepository(req.params.files, (p) => { try { return fs.readFileSync(path.join(workspace, p), 'utf8') } catch { return '' } })
      const deps = withoutCycles(new Map(req.params.files.map((f: { path: string; language: string }) => [f.path, unitDependencies(f.path, f.language)])))
      // Each file's facts depend on that file alone, so each is its own unit and only changed files are parsed again (A16).
      reply({ adapter: { id: 'syntax', version: VERSION, protocol_version: '1.1', languages: SYNTAX_LANGUAGES, toolchain: toolchain(SYNTAX_LANGUAGES) }, capabilities: { syntax: true, symbols: true, resolved_calls: false }, external_inputs: [], units: req.params.files.map((f: { path: string }) => ({ id: f.path, files: [f.path], ...(deps.get(f.path)?.length ? { depends_on: deps.get(f.path) } : {}) })) })
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
