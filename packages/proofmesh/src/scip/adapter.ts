// The SCIP adapter (A24, A27): serves the facts of SCIP indexes a person named, for the files the core routes to it. It reads each
// index file and checks it still has the hash recorded when it was named; it never runs an indexer.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { syntaxSymbols } from './syntax-spans.js'
import { decodeScip, DEFINITION, repositoryPath, type ScipDocument, type ScipOccurrence, type ScipRange, type ScipSymbol } from './decode.js'

const VERSION = '0.1.0'
type Range = { start_byte: number; end_byte: number; start_line: number; end_line: number }
type Definition = { local_id: string; path: string; qualified: string; range: Range; occurrence: ScipOccurrence; info?: ScipSymbol }

const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`)
let workspace = ''
const documents = new Map<string, ScipDocument>()
const definitions = new Map<string, Definition>()
/** Symbols an index defines in a file that is not routed to this adapter: a stale one, or one a first-party adapter analyses. */
const elsewhere = new Set<string>()
/** Files with a definition whose declaration span could not be taken from the syntax tier, and why ('' while none failed). */
const narrow = new Map<string, string>()

/** One descriptor of a SCIP symbol: a name and its suffix, such as `Cart` and `#` for a type. */
type Descriptor = { name: string; suffix: string }
/** The descriptors of a global SCIP symbol, after its scheme, manager, package name and version; spaces in those are doubled. */
function parseSymbol(symbol: string): { pkg: string; descriptors: Descriptor[] } | undefined {
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
  return { pkg: head[2] !== '.' ? head[2]! : head[0]!, descriptors }
}

/** A symbol's name in its language's own dotted form: namespaces, types and members, without parameters. */
const dotted = (ds: Descriptor[]) => ds.filter((d) => d.suffix !== '[' && d.suffix !== '(').map((d) => d.name).join('.')

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

async function initialize(params: { workspace: string; repository_root?: string; files: Array<{ path: string; content_hash: string; language: string }>; config?: { indexes?: Array<{ name: string; path: string; sha256: string }> } }) {
  workspace = params.workspace
  const routed = new Set(params.files.map((f) => f.path))
  const indexes = params.config?.indexes ?? []
  const tools: Record<string, string> = {}
  const root = fs.realpathSync(params.repository_root ?? workspace)
  for (const ix of indexes) {
    const bytes = fs.readFileSync(ix.path)
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== ix.sha256) throw new Error(`the SCIP index ${ix.name} changed after it was added; add it again: proofmesh scip add`)
    const index = decodeScip(bytes)
    tools[`scip:${ix.name}`] = `${index.tool.name} ${index.tool.version}`.trim()
    for (const doc of index.documents) {
      const p = repositoryPath(index, doc, root)
      if (p && routed.has(p) && !documents.has(p)) documents.set(p, doc)
      else for (const o of doc.occurrences) if (o.roles & DEFINITION) elsewhere.add(o.symbol)
    }
  }
  // A file with a definition that has no enclosing range is parsed by the syntax tier, for the span of that declaration.
  const bare = params.files.filter((f) => { const doc = documents.get(f.path); return doc?.occurrences.some((o) => o.roles & DEFINITION && !o.enclosing && o.range) })
  const spans = await syntaxSymbols(bare, workspace)
  const parsedBy = spans.symbols
  // A file whose spans could not be widened says so: its symbols are partial, and a line in a body may have no enclosing symbol.
  for (const f of bare) narrow.set(f.path, spans.problem ? `syntax_tier_${spans.problem}` : spans.unsupported.includes(f.path) ? `language_not_in_syntax_tier:${f.language}` : '')
  // Every definition first, so a reference in one file can name a symbol another file defines.
  for (const [p, doc] of documents) {
    const range = positions(fs.readFileSync(path.join(workspace, p), 'utf8'), doc.positionEncoding)
    const info = new Map(doc.symbols.map((s) => [s.symbol, s]))
    for (const o of doc.occurrences) {
      const parsed = (o.roles & DEFINITION) && !definitions.has(o.symbol) ? parseSymbol(o.symbol) : undefined
      let r = parsed && parsed.descriptors.length ? range(o.enclosing ?? o.range!) : undefined
      if (!parsed || !r || !o.range) continue
      if (!o.enclosing) {
        // The narrowest declaration of that name which holds the name's own span.
        const name = parsed.descriptors.filter((x) => x.suffix !== '[' && x.suffix !== '(').at(-1)!.name
        const decl = (parsedBy.get(p) ?? []).filter((x) => x.kind !== 'module' && x.name === name && x.range.start_byte <= r!.start_byte && r!.end_byte <= x.range.end_byte)
          .sort((a, b) => (a.range.end_byte - a.range.start_byte) - (b.range.end_byte - b.range.start_byte))[0]
        if (decl) r = decl.range
        else if (!narrow.get(p)) narrow.set(p, 'declaration_not_found')
      }
      definitions.set(o.symbol, { local_id: `${p}#${o.symbol}`, path: p, qualified: dotted(parsed.descriptors), range: r, occurrence: o, info: info.get(o.symbol) })
    }
  }
  return {
    adapter: { id: 'scip', version: VERSION, protocol_version: '1.0', languages: [...new Set([...documents.values()].map((d) => d.language || 'unknown'))].sort(), toolchain: tools },
    capabilities: { symbols: true, references: true }, external_inputs: indexes.map((ix) => `scip:${ix.name}/${ix.sha256}`).sort(),
  }
}

function analyse(p: string) {
  const doc = documents.get(p)
  if (!doc) return { symbols: [], relationships: [], result: { path: p, status: 'failed', detail: 'not_in_scip_index', capabilities: { text: 'complete' } } }
  const text = fs.readFileSync(path.join(workspace, p), 'utf8'), range = positions(text, doc.positionEncoding)
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  const module = { local_id: `${p}#module`, path: p, kind: 'module', name: path.posix.basename(p), qualified_name: p.replace(/\.[^./]+$/, ''), range: { start_byte: 0, end_byte: Buffer.byteLength(text), start_line: 1, end_line: Math.max(1, lines) }, signature: null }
  const own = [...definitions.values()].filter((d) => d.path === p)
  const symbols = [...(text ? [module] : []), ...own.map((d) => {
    const ds = parseSymbol(d.occurrence.symbol)!.descriptors
    return { local_id: d.local_id, path: p, kind: kindOf(d.info, ds), name: ds.filter((x) => x.suffix !== '[' && x.suffix !== '(').at(-1)!.name, qualified_name: d.qualified, range: d.range, signature: d.info?.signature ?? null }
  })]
  const relationships: unknown[] = []
  // Occurrences of global symbols that could not be read, or whose ranges do not fit the file, make the file's facts partial.
  const unreadable = (o: ScipOccurrence) => !o.symbol.startsWith('local ') && !definitions.has(o.symbol)
  const skippedDefinitions = doc.occurrences.filter((o) => o.roles & DEFINITION && unreadable(o) && !elsewhere.has(o.symbol)).length
  let skipped = 0
  for (const o of doc.occurrences) {
    if (o.roles & DEFINITION) continue
    const parsed = parseSymbol(o.symbol), site = o.range && range(o.range)
    if (!parsed || !parsed.descriptors.length || !site) { if (!o.symbol.startsWith('local ')) skipped++; continue }
    // The innermost definition whose extent holds the reference is its source; failing that, the file.
    const source = own.filter((d) => d.range.start_byte <= site.start_byte && site.end_byte <= d.range.end_byte).sort((a, b) => b.range.start_byte - a.range.start_byte)[0]?.local_id ?? (text ? module.local_id : undefined)
    const target = definitions.get(o.symbol)
    if (!source || target?.local_id === source) continue
    relationships.push({
      type: 'references', origin: 'semantic_resolver', source: { symbol: source }, site: { path: p, range: site },
      ...(target ? { resolution: 'resolved', target: { symbol: target.local_id } }
        // Defined in this repository, in a file whose facts come from another adapter, so the index's symbol has no counterpart here.
        : elsewhere.has(o.symbol) ? { resolution: 'unresolved', reason: 'outside_capability', detail: { symbol: dotted(parsed.descriptors) } }
        : { resolution: 'resolved_external', target: { external: { module: parsed.pkg, name: dotted(parsed.descriptors) } } }),
    })
  }
  return {
    symbols, relationships,
    ...(narrow.get(p) ? { diagnostic: { level: 'warning', path: p, message: `definitions in ${p} span only their names: ${narrow.get(p)}` } } : {}),
    result: { path: p, status: 'ok', capabilities: { text: 'complete', syntax: 'unsupported', symbols: skippedDefinitions || narrow.get(p) ? 'partial' : 'complete', imports: 'unsupported', references: skipped ? 'partial' : 'complete', resolved_calls: 'unsupported' } },
  }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const req = JSON.parse(line)
  try {
    if (req.method === 'initialize') send({ jsonrpc: '2.0', id: req.id, result: await initialize(req.params) })
    else if (req.method === 'workspace') send({ jsonrpc: '2.0', id: req.id, result: { symbols: [], relationships: [], file_results: [], diagnostics: [] } })
    else if (req.method === 'analyze') {
      const out = { symbols: [] as unknown[], relationships: [] as unknown[], file_results: [] as unknown[], diagnostics: [] as unknown[] }
      for (const p of req.params.paths as string[]) { const r = analyse(p); out.symbols.push(...r.symbols); out.relationships.push(...r.relationships); out.file_results.push(r.result); if ('diagnostic' in r && r.diagnostic) out.diagnostics.push(r.diagnostic) }
      send({ jsonrpc: '2.0', id: req.id, result: out })
    } else if (req.method === 'shutdown') { send({ jsonrpc: '2.0', id: req.id, result: {} }); process.exit(0) }
  } catch (e) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: (e as Error).message } })
  }
})
