// A TOML reader for the build adapter (FR240): Cargo.toml and pyproject.toml as captured text, never evaluated. It yields the same node shape
// as the adapter's JSON reader, with where each key and value sit, so one set of helpers reads both. Dates and numbers are kept as opaque
// tokens: no manifest field this adapter reads is one.
import { ParseError } from './jvm.js'

/** A node of a JSON or TOML document with where it sits; a table is an `object`. */
export type JNode = { kind: 'object' | 'array' | 'string' | 'other'; start: number; end: number; value?: string; members?: Array<{ key: string; start: number; value: JNode }>; items?: JNode[] }

const MAX_DEPTH = 100
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

/** What TOML allows unquoted: a boolean, an integer, a float, or a date and time. */
const BARE = /^(true|false|[+-]?(inf|nan)|[+-]?(\d+(_\d+)*)(\.\d+(_\d+)*)?([eE][+-]?\d+(_\d+)*)?|0x[0-9A-Fa-f]+(_[0-9A-Fa-f]+)*|0o[0-7]+(_[0-7]+)*|0b[01]+(_[01]+)*|\d{4}-\d\d-\d\d([Tt ]\d\d:\d\d(:\d\d(\.\d+)?)?([Zz]|[+-]\d\d:\d\d)?)?|\d\d:\d\d(:\d\d(\.\d+)?)?)$/
export function parseToml(text: string): JNode {
  let i = 0
  const root: JNode = { kind: 'object', start: 0, end: text.length, members: [] }
  const ws = () => { while (text[i] === ' ' || text[i] === '\t') i++ }
  const comment = () => { if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++ }
  const eol = () => { ws(); comment(); if (i < text.length && text[i] !== '\n' && text[i] !== '\r') throw new ParseError(`unexpected ${JSON.stringify(text[i])} after a value`, i); while (text[i] === '\r') i++; if (text[i] === '\n') i++ }
  const blank = () => { for (;;) { ws(); comment(); if (text[i] === '\n' || text[i] === '\r') i++; else return } }

  const basic = (multi: boolean): string => {
    const start = i
    i += multi ? 3 : 1
    if (multi && text[i] === '\n') i++
    let out = ''
    for (;;) {
      if (i >= text.length) throw new ParseError('unterminated string', start)
      const c = text[i]!
      if (multi ? text.startsWith('"""', i) : c === '"') { i += multi ? 3 : 1; return out }
      if (c === '\n' && !multi) throw new ParseError('unterminated string', start)
      if (c === '\\') {
        const n = text[i + 1]
        if (n === 'u' || n === 'U') { const len = n === 'u' ? 4 : 8, hex = text.slice(i + 2, i + 2 + len); if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new ParseError('invalid unicode escape', i); try { out += String.fromCodePoint(parseInt(hex, 16)) } catch { throw new ParseError('invalid unicode escape', i) } i += 2 + len; continue }
        if (multi && (n === '\n' || n === ' ' || n === '\t' || n === '\r')) { i++; while (/\s/.test(text[i] ?? '')) i++; continue }
        if (n === undefined || !Object.hasOwn(ESCAPES, n)) throw new ParseError('invalid escape', i)
        out += ESCAPES[n]; i += 2; continue
      }
      out += c; i++
    }
  }
  const literal = (multi: boolean): string => {
    const start = i
    i += multi ? 3 : 1
    if (multi && text[i] === '\n') i++
    const close = multi ? "'''" : "'"
    const e = text.indexOf(close, i)
    if (e < 0 || (!multi && text.slice(i, e).includes('\n'))) throw new ParseError('unterminated string', start)
    const out = text.slice(i, e)
    i = e + close.length
    return out
  }
  const str = (): JNode => {
    const start = i
    const value = text.startsWith('"""', i) ? basic(true) : text[i] === '"' ? basic(false) : text.startsWith("'''", i) ? literal(true) : literal(false)
    return { kind: 'string', start, end: i, value }
  }

  const value = (depth: number): JNode => {
    if (depth > MAX_DEPTH) throw new ParseError('nested too deeply', i)
    const c = text[i]
    if (c === '"' || c === "'") return str()
    if (c === '[') {
      const node: JNode = { kind: 'array', start: i++, end: 0, items: [] }
      for (;;) {
        blank()
        if (text[i] === ']') { i++; break }
        node.items!.push(value(depth + 1))
        blank()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; break }
        throw new ParseError(`expected "," or "]", found ${text[i] === undefined ? 'the end' : JSON.stringify(text[i])}`, i)
      }
      node.end = i
      return node
    }
    if (c === '{') {
      const node: JNode = { kind: 'object', start: i++, end: 0, members: [] }
      ws()
      if (text[i] === '}') { i++; node.end = i; return node }
      for (;;) {
        ws()
        assign(node, depth + 1)
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; break }
        throw new ParseError(`expected "," or "}", found ${text[i] === undefined || text[i] === '\n' ? 'the end of the line' : JSON.stringify(text[i])}`, i)
      }
      node.end = i
      return node
    }
    const start = i
    while (i < text.length && !/[\s,\]}#]/.test(text[i]!)) i++
    if (i === start) throw new ParseError(`expected a value, found ${text[i] === undefined ? 'the end' : JSON.stringify(text[i])}`, i)
    // A date and a time may be separated by one space.
    if (/^\d{4}-\d\d-\d\d$/.test(text.slice(start, i)) && /^ \d\d:\d\d/.test(text.slice(i, i + 6))) { i++; while (i < text.length && !/[\s,\]}#]/.test(text[i]!)) i++ }
    if (!BARE.test(text.slice(start, i))) throw new ParseError(`invalid value ${JSON.stringify(text.slice(start, i))}`, start)
    return { kind: 'other', start, end: i }
  }

  /** A key path `a."b c".d`, each segment with where it starts. */
  const keyPath = (): Array<{ key: string; start: number }> => {
    const out: Array<{ key: string; start: number }> = []
    for (;;) {
      ws()
      const start = i
      if (text[i] === '"' || text[i] === "'") out.push({ key: str().value!, start })
      else {
        while (i < text.length && /[A-Za-z0-9_-]/.test(text[i]!)) i++
        if (i === start) throw new ParseError(`expected a key, found ${text[i] === undefined || text[i] === '\n' ? 'the end of the line' : JSON.stringify(text[i])}`, i)
        out.push({ key: text.slice(start, i), start })
      }
      ws()
      if (text[i] === '.') { i++; continue }
      return out
    }
  }
  /** The table `path` names under `table`, made if missing; a dotted key or header may pass through an array of tables (its last element). */
  const descend = (table: JNode, path: Array<{ key: string; start: number }>, endAt: () => number): JNode => {
    let at = table
    for (const seg of path) {
      let m = at.members!.find((x) => x.key === seg.key)
      if (!m) { m = { key: seg.key, start: seg.start, value: { kind: 'object', start: seg.start, end: seg.start, members: [] } }; at.members!.push(m) }
      let next = m.value
      if (next.kind === 'array' && next.items!.length && next.items!.every((x) => x.kind === 'object')) next = next.items!.at(-1)!
      if (next.kind !== 'object') throw new ParseError(`"${seg.key}" is a value, not a table`, seg.start)
      next.end = Math.max(next.end, endAt())
      at = next
    }
    return at
  }
  function assign(table: JNode, depth: number) {
    const path = keyPath()
    ws()
    if (text[i] !== '=') throw new ParseError(`expected "=" after "${path.at(-1)!.key}"`, i)
    i++
    ws()
    const parent = descend(table, path.slice(0, -1), () => i)
    const last = path.at(-1)!
    if (parent.members!.some((x) => x.key === last.key)) throw new ParseError(`"${last.key}" is defined twice`, last.start)
    parent.members!.push({ key: last.key, start: last.start, value: value(depth) })
  }

  let current = root
  for (;;) {
    blank()
    if (i >= text.length) break
    if (text[i] === '[') {
      const array = text[i + 1] === '['
      const headerAt = i
      i += array ? 2 : 1
      const path = keyPath()
      ws()
      if (!text.startsWith(array ? ']]' : ']', i)) throw new ParseError(`expected "${array ? ']]' : ']'}" to close the table header`, i)
      i += array ? 2 : 1
      eol()
      const parent = descend(root, path.slice(0, -1), () => i)
      const last = path.at(-1)!
      let m = parent.members!.find((x) => x.key === last.key)
      if (array) {
        if (!m) { m = { key: last.key, start: last.start, value: { kind: 'array', start: headerAt, end: i, items: [] } }; parent.members!.push(m) }
        if (m.value.kind !== 'array') throw new ParseError(`"${last.key}" is not an array of tables`, headerAt)
        current = { kind: 'object', start: headerAt, end: i, members: [] }
        m.value.items!.push(current)
        m.value.end = i
      } else {
        if (!m) { m = { key: last.key, start: last.start, value: { kind: 'object', start: last.start, end: i, members: [] } }; parent.members!.push(m) }
        if (m.value.kind !== 'object') throw new ParseError(`"${last.key}" is not a table`, headerAt)
        current = m.value
        current.end = Math.max(current.end, i)
      }
      continue
    }
    assign(current, 0)
    eol()
    // A table's extent grows with each key written under it, so its range ends at its last line.
    if (current !== root) current.end = Math.max(current.end, i)
  }
  return root
}
