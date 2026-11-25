// The SCIP adapter (A24, A27): serves the facts of SCIP indexes a person named, for the files the core routes to it. It reads each
// index file, one document at a time, and checks it still has the hash recorded when it was named; it never runs an indexer.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { syntaxSymbols, type Spans, type SyntaxFile } from './syntax-spans.js'
import { DEFINITION, readDocument, type ScipOccurrence, type ScipRange, type ScipSymbol } from './decode.js'
import { loadIndexes, type RoutedDocument } from './load.js'

const VERSION = '0.1.0'
type Range = { start_byte: number; end_byte: number; start_line: number; end_line: number }
type Definition = { local_id: string; path: string; qualified: string; kind?: string; range: Range; named: Range; occurrence: ScipOccurrence; info?: ScipSymbol }

const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`)
let workspace = ''
let documents = new Map<string, RoutedDocument>()
const definitions = new Map<string, Definition>()
/** The same definitions by file, so analysing a file does not walk every definition of the index. */
const definitionsIn = new Map<string, Definition[]>()
const routedFiles = new Map<string, SyntaxFile>()
/** Symbols an index defines in a file that is not routed to this adapter: a stale one, or one a first-party adapter analyses. */
let elsewhere = new Set<string>()
/** The kinds the index gives symbols it does not define (FR162). */
let externalKinds = new Map<string, number>()
/** The syntax tier is the one the package resolves; a test points these at a stand-in that is slow or silent. */
const SYNTAX = { entry: process.env.PROOFMESH_TEST_SYNTAX_ENTRY, timeout: Number(process.env.PROOFMESH_TEST_SYNTAX_TIMEOUT_MS) || undefined }
/** The packages those symbols sit in, and the file of each package a routed definition sits in (FR163). */
const elsewherePackages = new Set<string>()
const packageFiles = new Map<string, string>()
/** Files with a definition whose declaration span could not be taken from the syntax tier, and why ('' while none failed). */
const narrow = new Map<string, string>()

/** One descriptor of a SCIP symbol: a name and its suffix, such as `Cart` and `#` for a type. */
type Descriptor = { name: string; suffix: string }
/** The descriptors of a global SCIP symbol, after its scheme, manager, package name and version; spaces in those are doubled. */
function parseSymbol(symbol: string): { pkg: string; manager: string; descriptors: Descriptor[] } | undefined {
  if (symbol.startsWith('local ')) return undefined
  const head: string[] = []
  let i = 0
  while (head.length < 4) {
    let token = ''
    for (; i < symbol.length; i++) {
      if (symbol[i] === ' ') { if (symbol[i + 1] === ' ') { token += ' '; i++ } else break } else token += symbol[i]
    }
    head.push(token)
    i++
    if (i > symbol.length) return undefined
  }
  const descriptors: Descriptor[] = []
  const s = symbol.slice(i)
  for (let k = 0; k < s.length;) {
    if (s[k] === '[' || s[k] === '(') {
      const close = s.indexOf(s[k] === '[' ? ']' : ')', k)
      if (close < 0) return undefined
      descriptors.push({ name: s.slice(k + 1, close), suffix: s[k]! })
      k = close + 1
      continue
    }
    let name = ''
    if (s[k] === '`') {
      for (k++; k < s.length; k++) { if (s[k] === '`') { if (s[k + 1] === '`') { name += '`'; k++ } else break } else name += s[k] }
      k++
    } else while (k < s.length && /[\w$+-]/.test(s[k]!)) name += s[k++]
    const suffix = s[k]
    if (suffix === '(') {
      const close = s.indexOf(').', k)
      if (close < 0) return undefined
      descriptors.push({ name, suffix: '().' })
      k = close + 2
    } else if (suffix && '/#.:!'.includes(suffix)) { descriptors.push({ name, suffix }); k++ }
    else return undefined
  }
  return { pkg: head[2] !== '.' ? head[2]! : head[0]!, manager: head[1]!, descriptors }
}

/** A symbol's name in its language's own dotted form: namespaces, types and members, without parameters. */
const dotted = (ds: Descriptor[]) => ds.filter((d) => d.suffix !== '[' && d.suffix !== '(').map((d) => d.name).join('.')
/** The languages whose qualified name is the dotted package form; the others name a declaration `<path without extension>:<containers>.<name>` (FR146). */
const PACKAGE_LANGUAGES = new Set(['java', 'kotlin', 'scala', 'php', 'csharp'])
/**
 * The name the syntax tier would give a definition it has no declaration for (a field, a parameter): the same form, from the
 * descriptors. A definition the syntax tier does declare takes that declaration's name instead, so an overload suffix agrees.
 */
function qualifiedName(language: string, file: string, ds: Descriptor[]): string {
  const members = ds.filter((d) => d.suffix !== '[' && d.suffix !== '(' && d.suffix !== '/')
  return PACKAGE_LANGUAGES.has(language) || !members.length ? dotted(ds) : `${file.replace(/\.[^./]+$/, '')}:${members.map((d) => d.name).join('.')}`
}

const KINDS: Record<number, string> = {
  7: 'class', 54: 'class', 33: 'class', 26: 'method', 80: 'method', 66: 'method', 17: 'function', 25: 'function', 21: 'interface', 53: 'interface',
  49: 'struct', 11: 'enum', 15: 'field', 41: 'property', 18: 'property', 45: 'property', 9: 'constructor', 30: 'namespace', 35: 'package',
  29: 'module', 55: 'type_alias', 61: 'variable', 8: 'variable',
}
/** The kind the indexer named, or else the one its last descriptor implies. */
function kindOf(info: ScipSymbol | undefined, ds: Descriptor[]): string {
  if (info && KINDS[info.kind]) return KINDS[info.kind]!
  const last = ds[ds.length - 1]!, parent = ds[ds.length - 2]
  if (last.suffix === '#') return 'class'
  if (last.suffix === '().') return parent?.suffix === '#' ? 'method' : 'function'
  if (last.suffix === '/') return 'namespace'
  if (last.suffix === '!') return 'function'
  return parent?.suffix === '#' ? 'field' : 'variable'
}

/** Byte offsets of SCIP positions in a file, in the document's position encoding; an unspecified encoding is read as UTF-16, as LSP does. */
function positions(text: string, encoding: number) {
  const lines = text.split('\n'), starts: number[] = []
  let at = 0
  for (const l of lines) { starts.push(at); at += Buffer.byteLength(l) + 1 }
  const size = Buffer.byteLength(text)
  const offset = (line: number, char: number): number | undefined => {
    const l = lines[line]
    if (l === undefined) return undefined
    if (encoding === 1) return char <= Buffer.byteLength(l) ? starts[line]! + char : undefined
    const prefix = encoding === 3 ? [...l].slice(0, char).join('') : l.slice(0, char)
    if ((encoding === 3 ? [...l].length : l.length) < char) return undefined
    return starts[line]! + Buffer.byteLength(prefix)
  }
  return (r: ScipRange): Range | undefined => {
    const start = offset(r.startLine, r.startChar), end = offset(r.endLine, r.endChar)
    if (start === undefined || end === undefined || end <= start || end > size) return undefined
    return { start_byte: start, end_byte: end, start_line: r.startLine + 1, end_line: r.endLine + 1 }
  }
}

/** The ecosystem prefix of an external module, as the build adapter names them (FR127); Go's standard library is one module. */
const ECOSYSTEMS: Record<string, string> = { gomod: 'go', maven: 'maven', cargo: 'cargo', npm: 'npm' }
const GO_STD = 'github.com/golang/go/src'
function externalModule(parsed: { pkg: string; manager: string }): string {
  return parsed.manager === 'gomod' && parsed.pkg === GO_STD ? 'go:std' : `${ECOSYSTEMS[parsed.manager] ?? parsed.manager}:${parsed.pkg}`
}
/** A package's identity: its package name and the namespace descriptors a symbol in it starts with. */
const packageKey = (pkg: string, ds: Descriptor[]) => `${pkg}|${ds.filter((d, i) => ds.slice(0, i + 1).every((x) => x.suffix === '/')).map((d) => d.name).join('/')}`
/** The member kinds: a relationship between two of them is an override, between two types an implementation or inheritance (FR162). */
const MEMBER_KINDS = new Set(['method', 'property', 'field', 'constructor'])
const CALLABLE_KINDS = new Set(['function', 'method', 'constructor'])
const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'enum'])

async function initialize(params: { workspace: string; repository_root?: string; files: Array<{ path: string; content_hash: string; language: string }>; config?: { indexes?: Array<{ name: string; path: string; sha256: string }> } }) {
  workspace = params.workspace
  for (const f of params.files) routedFiles.set(f.path, f)
  const indexes = params.config?.indexes ?? []
  const root = fs.realpathSync(params.repository_root ?? workspace)
  // The index is read a document at a time: only each routed document's definitions stay in memory (FR164).
  const loaded = loadIndexes(indexes, new Set(routedFiles.keys()), root)
  documents = loaded.routed
  elsewhere = loaded.elsewhere
  externalKinds = loaded.kinds
  for (const s of elsewhere) { const parsed = parseSymbol(s); if (parsed?.descriptors.length) elsewherePackages.add(packageKey(parsed.pkg, parsed.descriptors)) }
  const tools = loaded.tools
  // A file with a definition is parsed by the syntax tier: its declaration gives the definition its name, kind and span, so every tier names
  // and measures one declaration alike (FR148). One whose definition has no enclosing range depends on it for the span alone.
  const defined = params.files.filter((f) => documents.get(f.path)?.definitions.some((o) => o.range))
  const bare = defined.filter((f) => documents.get(f.path)!.definitions.some((o) => !o.enclosing && o.range))
  const spans = await syntaxSymbols(defined, workspace, SYNTAX.entry, SYNTAX.timeout)
  const parsedBy = spans.symbols
  // A file whose spans could not be widened says so: its symbols are partial, and a line in a body may have no enclosing symbol.
  for (const f of bare) narrow.set(f.path, spans.problem ? `syntax_tier_${spans.problem}` : spans.unsupported.includes(f.path) ? `language_not_in_syntax_tier:${f.language}` : '')
  // Every definition first, so a reference in one file can name a symbol another file defines.
  for (const [p, doc] of documents) {
    const range = positions(fs.readFileSync(path.join(workspace, p), 'utf8'), doc.positionEncoding)
    for (const o of doc.definitions) {
      const parsed = !definitions.has(o.symbol) ? parseSymbol(o.symbol) : undefined
      const named = o.range ? range(o.range) : undefined
      let r = parsed && parsed.descriptors.length ? range(o.enclosing ?? o.range!) : undefined
      if (!parsed || !r || !o.range || !named) continue
      // The narrowest declaration of that name which holds the name's own span.
      const name = parsed.descriptors.filter((x) => x.suffix !== '[' && x.suffix !== '(').at(-1)!.name
      const decl = (parsedBy.get(p) ?? []).filter((x) => x.kind !== 'module' && x.name === name && x.range.start_byte <= named.start_byte && named.end_byte <= x.range.end_byte)
        .sort((a, b) => (a.range.end_byte - a.range.start_byte) - (b.range.end_byte - b.range.start_byte))[0]
      if (decl) r = decl.range
      else if (!o.enclosing && !narrow.get(p)) narrow.set(p, 'declaration_not_found')
      const made: Definition = { local_id: `${p}#${o.symbol}`, path: p, qualified: decl?.qualified_name ?? qualifiedName(doc.language, p, parsed.descriptors), ...(decl ? { kind: decl.kind } : {}), range: r, named, occurrence: o, info: doc.info.get(o.symbol) }
      definitions.set(o.symbol, made)
      if (!definitionsIn.has(p)) definitionsIn.set(p, [])
      definitionsIn.get(p)!.push(made)
      const key = parsed.descriptors[0]!.suffix === '/' ? packageKey(parsed.pkg, parsed.descriptors) : undefined
      if (key && (!packageFiles.has(key) || p < packageFiles.get(key)!)) packageFiles.set(key, p)
    }
  }
  return {
    adapter: { id: 'scip', version: VERSION, protocol_version: '1.0', languages: [...new Set([...documents.values()].map((d) => d.language || 'unknown'))].sort(), toolchain: tools },
    capabilities: { symbols: true, references: true, resolved_calls: true }, external_inputs: indexes.map((ix) => `scip:${ix.name}/${ix.sha256}`).sort(),
  }
}

type Parsed = NonNullable<ReturnType<typeof parseSymbol>>
/** How a relationship to an index symbol resolves: to the definition here, to one a first-party adapter holds, or to a package outside. */
function resolution(symbol: string, parsed: Parsed, target: Definition | undefined) {
  return target ? { resolution: 'resolved', target: { symbol: target.local_id } }
    // Defined in this repository, in a file whose facts come from another adapter, so the index's symbol has no counterpart here.
    : elsewhere.has(symbol) ? { resolution: 'unresolved', reason: 'outside_capability', detail: { symbol: dotted(parsed.descriptors) } }
    : { resolution: 'resolved_external', target: { external: { module: parsed.pkg, name: dotted(parsed.descriptors) } } }
}
const kindOfDefinition = (d: Definition) => d.kind ?? kindOf(d.info, parseSymbol(d.occurrence.symbol)!.descriptors)

/**
 * What a call site's callee occurrence calls (FR161, FR167, FR168): a function or method, or a type, which is a constructor call (to the
 * type's constructor symbol where the index has one, else to the type). A variable or field that holds a function is no call target.
 */
function calleeOf(symbol: string): { symbol: string; parsed: Parsed; target: Definition | undefined } | undefined {
  const parsed = parseSymbol(symbol)
  if (!parsed || !parsed.descriptors.length) return undefined
  const target = definitions.get(symbol), last = parsed.descriptors.at(-1)!.suffix
  if (target) {
    const kind = kindOfDefinition(target)
    if (CALLABLE_KINDS.has(kind)) return { symbol, parsed, target }
    if (!TYPE_KINDS.has(kind)) return undefined
    const ctor = `${symbol}\`<init>\`().`
    return { symbol: definitions.has(ctor) ? ctor : symbol, parsed, target: definitions.get(ctor) ?? target }
  }
  return last === '().' || last === '#' || last === '!' ? { symbol, parsed, target } : undefined
}

async function analyse(p: string, facts: Spans) {
  const ref = documents.get(p)
  if (!ref) return { symbols: [], relationships: [], diagnostics: [], result: { path: p, status: 'failed', detail: 'not_in_scip_index', capabilities: { text: 'complete' } } }
  let doc
  try { doc = readDocument(ref.index, ref.at, { ...ref.stamp, path: ref.scipPath }) } catch (e) {
    // An index rewritten since it was read must not be read at an old offset: the file fails, and says why.
    return { symbols: [], relationships: [], diagnostics: [{ level: 'error', path: p, message: (e as Error).message }], result: { path: p, status: 'failed', detail: 'scip_index_changed', capabilities: { text: 'complete' } } }
  }
  const text = fs.readFileSync(path.join(workspace, p), 'utf8'), range = positions(text, ref.positionEncoding)
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  const module = { local_id: `${p}#module`, path: p, kind: 'module', name: path.posix.basename(p), qualified_name: p.replace(/\.[^./]+$/, ''), range: { start_byte: 0, end_byte: Buffer.byteLength(text), start_line: 1, end_line: Math.max(1, lines) }, signature: null }
  const own = definitionsIn.get(p) ?? []
  const symbols = [...(text ? [module] : []), ...own.map((d) => {
    const ds = parseSymbol(d.occurrence.symbol)!.descriptors
    return { local_id: d.local_id, path: p, kind: d.kind ?? kindOf(d.info, ds), name: ds.filter((x) => x.suffix !== '[' && x.suffix !== '(').at(-1)!.name, qualified_name: d.qualified, range: d.range, signature: d.info?.signature ?? null }
  })]
  const relationships: unknown[] = []
  // Occurrences of global symbols that could not be read, or whose ranges do not fit the file, make the file's facts partial.
  const unreadable = (o: ScipOccurrence) => !o.symbol.startsWith('local ') && !definitions.has(o.symbol)
  const skippedDefinitions = doc.occurrences.filter((o) => o.roles & DEFINITION && unreadable(o) && !elsewhere.has(o.symbol)).length
  // The innermost definition whose extent holds a site is its source; failing that, the file.
  const sourceOf = (site: Range) => own.filter((d) => d.range.start_byte <= site.start_byte && site.end_byte <= d.range.end_byte).sort((a, b) => b.range.start_byte - a.range.start_byte)[0]?.local_id ?? (text ? module.local_id : undefined)

  // The syntax tier's read of this file: its call sites with the callee's range, and its import statements (FR161, FR163).
  const caps = facts.capabilities.get(p), syntax = facts.relationships.get(p) ?? []
  const siteKey = (r: { start_byte: number; end_byte: number }) => `${r.start_byte}:${r.end_byte}`
  const callSites = caps ? syntax.filter((r) => r.type === 'calls' && r.detail?.callee_start !== undefined) : []
  const statements = caps ? syntax.filter((r) => r.type === 'imports') : []
  const at = new Map<string, ScipOccurrence[]>(), sited = new Map<ScipOccurrence, Range>()
  for (const o of doc.occurrences) {
    const site = o.range && range(o.range)
    if (!site) continue
    sited.set(o, site)
    at.set(siteKey(site), [...(at.get(siteKey(site)) ?? []), o])
  }
  const consumed = new Set<ScipOccurrence>()
  let unmatched = 0
  for (const c of callSites) {
    const key = `${c.detail!.callee_start}:${c.detail!.callee_end}`, here = at.get(key) ?? []
    if (!here.length) { unmatched++; continue }
    // A definition and a reference at one name (a method value) are one callee: the reference is the call (FR167).
    const callee = here.filter((o) => !(o.roles & DEFINITION)).map((o) => ({ o, ...calleeOf(o.symbol) })).find((x): x is { o: ScipOccurrence; symbol: string; parsed: Parsed; target: Definition | undefined } => !!x.parsed)
    const source = callee && sourceOf(sited.get(callee.o)!)
    if (!callee || !source) continue
    consumed.add(callee.o)
    if (callee.target?.local_id === source) continue
    relationships.push({ type: 'calls', origin: 'semantic_resolver', source: { symbol: source }, site: { path: p, range: sited.get(callee.o)! }, ...resolution(callee.symbol, callee.parsed, callee.target) })
  }
  // An import statement is resolved through the index's occurrence of the package or type it names inside the statement (FR163).
  let unresolvedImports = 0
  for (const st of statements) {
    const inside = [...sited].filter(([o, r]) => !(o.roles & DEFINITION) && st.site.range.start_byte <= r.start_byte && r.end_byte <= st.site.range.end_byte && !o.symbol.startsWith('local ') && parseSymbol(o.symbol)?.descriptors.length)
    // The most specific symbol inside the statement, the last one on a tie: `import a.b.C` names the package `a/b/` and the type `a/b/C#`.
    const best = inside.map(([o, r]) => ({ o, r, parsed: parseSymbol(o.symbol)! })).sort((a, b) => b.parsed.descriptors.length - a.parsed.descriptors.length || b.r.start_byte - a.r.start_byte)[0]
    const base = { type: 'imports', source: { file: p }, site: st.site }
    if (!best) { unresolvedImports++; relationships.push({ ...base, origin: 'syntax', resolution: 'unresolved', reason: 'import_unresolved', ...(st.detail ? { detail: { ...(st.detail.module ? { module: st.detail.module } : {}), ...(st.detail.alias ? { alias: st.detail.alias } : {}) } } : {}) }); continue }
    const file = definitions.get(best.o.symbol)?.path ?? packageFiles.get(packageKey(best.parsed.pkg, best.parsed.descriptors))
    relationships.push({ ...base, origin: 'semantic_resolver', ...(file ? { resolution: 'resolved', target: { file } }
      : elsewhere.has(best.o.symbol) || elsewherePackages.has(packageKey(best.parsed.pkg, best.parsed.descriptors)) ? { resolution: 'unresolved', reason: 'outside_capability', detail: { module: dotted(best.parsed.descriptors) } }
      : { resolution: 'resolved_external', target: { external: { module: externalModule(best.parsed), name: dotted(best.parsed.descriptors) } } }) })
  }
  // The index's relationships between definitions: a member overrides, a type implements an interface or inherits a type (FR162).
  for (const d of own) {
    const kind = kindOfDefinition(d)
    for (const rel of d.info?.relationships ?? []) {
      const parsed = rel.implementation && rel.symbol !== d.occurrence.symbol ? parseSymbol(rel.symbol) : undefined
      if (!parsed || !parsed.descriptors.length) continue
      const target = definitions.get(rel.symbol)
      // A target the index defines has the kind the syntax tier gave it; an outside one, the kind the index records for it, if any (FR162).
      const outside = target ? undefined : KINDS[externalKinds.get(rel.symbol) ?? 0]
      const type = MEMBER_KINDS.has(kind) ? 'overrides' : (target ? kindOfDefinition(target) : outside) === 'interface' ? 'implements' : 'inherits'
      const resolved = resolution(rel.symbol, parsed, target)
      relationships.push({ type, origin: 'semantic_resolver', source: { symbol: d.local_id }, site: { path: p, range: d.named }, ...resolved, ...(type === 'inherits' && resolved.resolution === 'resolved_external' && !outside ? { detail: { kind: 'unknown' } } : {}) })
    }
  }
  let skipped = 0
  for (const o of doc.occurrences) {
    if (o.roles & DEFINITION || consumed.has(o)) continue
    const parsed = parseSymbol(o.symbol), site = sited.get(o)
    if (!parsed || !parsed.descriptors.length || !site) { if (!o.symbol.startsWith('local ')) skipped++; continue }
    const source = sourceOf(site)
    const target = definitions.get(o.symbol)
    if (!source || target?.local_id === source) continue
    relationships.push({ type: 'references', origin: 'semantic_resolver', source: { symbol: source }, site: { path: p, range: site }, ...resolution(o.symbol, parsed, target) })
  }
  // A file the syntax tier did not answer in time is partial, so a later run can read it again; one it never could read is unsupported.
  const late = facts.unanswered.includes(p), problem = facts.problem ? `syntax_tier_${facts.problem}` : ''
  return {
    symbols, relationships,
    diagnostics: [
      ...(narrow.get(p) ? [{ level: 'warning', path: p, message: `definitions in ${p} span only their names: ${narrow.get(p)}` }] : []),
      ...(late ? [{ level: 'warning', path: p, message: `call sites and imports in ${p} are only partly read: ${problem}` }] : problem && !caps ? [{ level: 'warning', path: p, message: `call sites and imports in ${p} are not read: ${problem}` }] : []),
      ...(unmatched ? [{ level: 'warning', path: p, message: `${unmatched} of ${callSites.length} call sites in ${p} match no occurrence in the index, so they are not recorded as calls` }] : []),
    ],
    result: {
      path: p, status: 'ok',
      capabilities: {
        text: 'complete', syntax: 'unsupported', symbols: skippedDefinitions || narrow.get(p) ? 'partial' : 'complete',
        imports: late ? 'partial' : !caps || caps.imports === 'unsupported' ? 'unsupported' : unresolvedImports ? 'partial' : 'complete', references: skipped ? 'partial' : 'complete',
        resolved_calls: late ? 'partial' : !caps ? 'unsupported' : unmatched ? 'partial' : 'complete',
      },
    },
  }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const req = JSON.parse(line)
  try {
    if (req.method === 'initialize') send({ jsonrpc: '2.0', id: req.id, result: await initialize(req.params) })
    else if (req.method === 'workspace') send({ jsonrpc: '2.0', id: req.id, result: { symbols: [], relationships: [], file_results: [], diagnostics: [] } })
    else if (req.method === 'analyze') {
      const out = { symbols: [] as unknown[], relationships: [] as unknown[], file_results: [] as unknown[], diagnostics: [] as unknown[] }
      const paths = req.params.paths as string[]
      // One syntax-tier process answers the call sites and imports of every file in the request.
      const facts = await syntaxSymbols(paths.filter((p) => documents.has(p)).map((p) => routedFiles.get(p)!), workspace, SYNTAX.entry, SYNTAX.timeout, 'analyze_calls', () => send({ jsonrpc: '2.0', method: 'log', params: { level: 'debug', message: 'the syntax tier answered a batch of call sites' } }))
      for (const p of paths) { const r = await analyse(p, facts); out.symbols.push(...r.symbols); out.relationships.push(...r.relationships); out.file_results.push(r.result); out.diagnostics.push(...r.diagnostics) }
      send({ jsonrpc: '2.0', id: req.id, result: out })
    } else if (req.method === 'shutdown') { send({ jsonrpc: '2.0', id: req.id, result: {} }); process.exit(0) }
  } catch (e) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: (e as Error).message } })
  }
})
