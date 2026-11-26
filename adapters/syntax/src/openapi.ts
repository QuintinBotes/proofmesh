// OpenAPI 3 and Swagger 2 documents (FR253, FR254): the endpoints they declare, one per path and verb, read from captured text and never
// fetched or resolved ($ref is not followed). JSON arrives as a tree from the build adapter's reader; YAML is read here, as the subset an
// API description uses: block mappings and sequences, quoted and plain scalars, block scalars, flow collections kept as opaque values.
// shortcut: no anchors, merge keys, tags or multi-document streams; a document that needs them is read as far as it goes and its
// path items it cannot see are simply not declared. Take a YAML grammar when descriptions outgrow that.
import { ParseError } from './jvm.js'

/** A node of a parsed document with where it sits; the shape the JSON reader of build.ts produces too. */
export type DocNode = { kind: 'object' | 'array' | 'string' | 'other'; start: number; end: number; value?: string; members?: Array<{ key: string; start: number; value: DocNode }>; items?: DocNode[] }
export type OpenApiEndpoint = { name: string; operationId?: string; start: number; end: number }

type Line = { indent: number; text: string; at: number; end: number }

/** The text before a ` #` comment that is not inside a quote. */
function uncomment(s: string): string {
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) { if (c === '\\' && quote === '"') i++; else if (c === quote) quote = '' } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(s[i - 1]!))) quote = c
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i)
  }
  return s
}

/** A scalar as written: a quoted string unquoted, a plain one as is; a value starting with a flow bracket, anchor, alias or tag is opaque. */
function scalar(text: string, start: number, end: number): DocNode {
  const q = text[0]
  if (q === '"' || q === "'") {
    const close = text.lastIndexOf(q)
    if (close < 1) throw new ParseError('unterminated quoted string', start)
    return { kind: 'string', start, end, value: q === '"' ? safeJson(text.slice(0, close + 1), start) : text.slice(1, close).replace(/''/g, "'") }
  }
  if (/^[[{&*!]/.test(text)) return { kind: 'other', start, end }
  return { kind: 'string', start, end, value: text }
}
const safeJson = (t: string, at: number): string => { try { return JSON.parse(t) as string } catch { throw new ParseError('invalid escape in a quoted string', at) } }

/** The key of a `key: value` line, as its end index in the text and its unquoted name; undefined when the line has no key. */
function keyOf(text: string): { key: string; rest: number } | undefined {
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0]
    let i = 1
    while (i < text.length && (text[i] !== q || (q === "'" && text[i + 1] === "'" && ++i))) i += text[i] === '\\' && q === '"' ? 2 : 1
    const m = /^\s*:(\s|$)/.exec(text.slice(i + 1))
    return i < text.length && m ? { key: q === '"' ? safeJson(text.slice(0, i + 1), 0) : text.slice(1, i).replace(/''/g, "'"), rest: i + 1 + m[0].length } : undefined
  }
  const m = /^(.*?):(\s+|$)/.exec(text)
  return m && m[1] ? { key: m[1].trim(), rest: m[0].length } : undefined
}

export function parseYaml(text: string): DocNode {
  const lines: Line[] = []
  let at = 0
  for (const raw of text.split('\n')) {
    const lineAt = at
    at += raw.length + 1
    const line = raw.replace(/\r$/, '')
    const indent = /^ */.exec(line)![0].length
    if (/^\s*\t/.test(line.slice(0, indent + 1))) throw new ParseError('a tab cannot indent a line in YAML', lineAt)
    const body = uncomment(line.slice(indent)).trimEnd()
    if (!body || (indent === 0 && /^(---|\.\.\.)(\s|$)/.test(body) && !body.slice(3).trim())) continue
    lines.push({ indent, text: body, at: lineAt + indent, end: lineAt + line.length })
  }
  let i = 0
  /** The end offset of whatever the value starting at `lines[from]` consumed: the last line of it. */
  const endOf = (from: number) => lines[Math.max(from, i - 1)]!.end
  const block = (indent: number): DocNode => {
    const first = lines[i]!
    if (first.text === '-' || first.text.startsWith('- ')) return sequence(indent)
    return mapping(indent)
  }
  const sequence = (indent: number): DocNode => {
    const items: DocNode[] = [], start = lines[i]!.at
    while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.text === '-' || lines[i]!.text.startsWith('- '))) {
      const l = lines[i]!, rest = l.text.slice(1).trimStart()
      if (!rest) { i++; items.push(i < lines.length && lines[i]!.indent > indent ? block(lines[i]!.indent) : { kind: 'other', start: l.at, end: l.end }); continue }
      const shift = l.text.length - rest.length
      if (keyOf(rest) && !/^[[{]/.test(rest)) {
        // `- key: v`: the item is a mapping whose first line sits after the dash.
        lines[i] = { indent: indent + shift, text: rest, at: l.at + shift, end: l.end }
        items.push(mapping(indent + shift))
      } else { i++; items.push(scalar(rest, l.at + shift, l.end)) }
    }
    return { kind: 'array', start, end: endOf(0), items }
  }
  const mapping = (indent: number): DocNode => {
    const members: NonNullable<DocNode['members']> = [], start = lines[i]!.at
    while (i < lines.length && lines[i]!.indent === indent && !(lines[i]!.text === '-' || lines[i]!.text.startsWith('- '))) {
      const l = lines[i]!, k = keyOf(l.text)
      if (!k) throw new ParseError(`expected "key: value", found ${JSON.stringify(l.text.slice(0, 40))}`, l.at)
      if (members.some((m) => m.key === k.key)) throw new ParseError(`duplicate key ${JSON.stringify(k.key)}`, l.at)
      const rest = l.text.slice(k.rest).trim(), valueAt = l.at + k.rest
      i++
      let value: DocNode
      if (!rest) {
        const next = lines[i]
        if (next && next.indent > indent) value = block(next.indent)
        else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) value = sequence(indent)
        else value = { kind: 'other', start: valueAt, end: l.end }
      } else if (/^[|>]/.test(rest)) {
        while (i < lines.length && lines[i]!.indent > indent) i++
        value = { kind: 'other', start: valueAt, end: endOf(i - 1) }
      } else if (/^[[{]/.test(rest)) {
        // A flow collection may span lines: read on until its brackets balance.
        const depth = (s: string) => [...s.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '')].reduce((n, c) => n + ('[{'.includes(c) ? 1 : ']}'.includes(c) ? -1 : 0), 0)
        let open = depth(rest)
        while (open > 0 && i < lines.length) open += depth(lines[i++]!.text)
        if (open !== 0) throw new ParseError('unclosed flow collection', valueAt)
        value = rest === '{}' ? { kind: 'object', start: valueAt, end: l.end, members: [] } : rest === '[]' ? { kind: 'array', start: valueAt, end: l.end, items: [] } : { kind: 'other', start: valueAt, end: endOf(i - 1) }
      } else {
        value = scalar(rest, valueAt, l.end)
        // A plain scalar continues on the lines indented under it.
        while (i < lines.length && lines[i]!.indent > indent) i++
        value.end = endOf(i - 1)
      }
      members.push({ key: k.key, start: l.at, value })
    }
    if (i < lines.length && lines[i]!.indent > indent) throw new ParseError('unexpected indentation', lines[i]!.at)
    return { kind: 'object', start, end: endOf(0), members }
  }
  if (!lines.length) return { kind: 'other', start: 0, end: 1 }
  const root = block(lines[0]!.indent)
  if (i < lines.length) throw new ParseError('content after the document', lines[i]!.at)
  return root
}

const VERBS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])
const member = (n: DocNode | undefined, key: string) => (n?.kind === 'object' ? n.members!.find((m) => m.key === key) : undefined)
/** The path component of a server URL or `basePath`, without a trailing slash: `https://example.com/v1/` is `/v1`, a bare host is empty. */
const basePathOf = (url: string) => (/^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(url)?.[1] ?? (url.startsWith('/') ? url : '')).replace(/[?#].*$/, '').replace(/\/+$/, '')

/**
 * The endpoints a parsed document declares, or undefined when it is no OpenAPI or Swagger document (a JSON or YAML file that merely has such a name).
 * The path of each is joined to the document's base path (Swagger `basePath`, the path of an OpenAPI server URL; one endpoint per distinct base when
 * the servers differ), written as the C# and Python rules write theirs: verb, then the path without outer slashes.
 */
export function openApiEndpoints(root: DocNode): { endpoints: OpenApiEndpoint[]; skipped: number } | undefined {
  const version = member(root, 'openapi') ?? member(root, 'swagger')
  if (!version || version.value.kind !== 'string' || !/^[23]\./.test(version.value.value ?? '')) return undefined
  const servers = member(root, 'servers')?.value, bp = member(root, 'basePath')?.value
  const bases = [...new Set([...(bp?.kind === 'string' ? [basePathOf(bp.value!)] : []), ...(servers?.kind === 'array' ? servers.items!.flatMap((s) => { const u = member(s, 'url')?.value; return u?.kind === 'string' ? [basePathOf(u.value!)] : [] }) : [])])].slice(0, 5)
  const paths = member(root, 'paths')?.value
  const endpoints: OpenApiEndpoint[] = []
  let skipped = 0
  if (paths?.kind !== 'object') return { endpoints, skipped }
  for (const p of paths.members!) {
    if (p.key.startsWith('x-')) continue
    // A path item that is a $ref lives in another document, which is not followed.
    if (p.value.kind !== 'object' || member(p.value, '$ref')) skipped++
    if (p.value.kind !== 'object') continue
    for (const v of p.value.members!) {
      if (!VERBS.has(v.key)) continue
      const id = member(v.value, 'operationId')?.value
      for (const base of bases.length ? bases : ['']) {
        const joined = `${base}/${p.key}`.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')
        endpoints.push({ name: `${v.key.toUpperCase()} ${joined || '/'}`, ...(id?.kind === 'string' && id.value ? { operationId: id.value } : {}), start: v.start, end: Math.max(v.value.end, v.start + 1) })
      }
    }
  }
  return { endpoints, skipped }
}
