// Physical ranges address the sealed JSON bytes. Cell positions address the independently decoded source.
import { findNodeAtLocation, parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser'

type Range = { start_byte: number; end_byte: number; start_line: number; end_line: number }
export type NotebookCell = ReturnType<typeof readCell>
const lowerBound = (values: number[], target: number) => {
  let lo = 0, hi = values.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (values[mid]! < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function readCell(node: JsonNode, ordinal: number, raw: string, byteAt: Uint32Array, physicalLines: number[], language: string) {
  const field = (key: string) => findNodeAtLocation(node, [key])
  const type = field('cell_type')?.value
  if (!['code', 'markdown', 'raw'].includes(type)) throw new Error(`invalid cell_type at cell ${ordinal}`)
  const idField = field('id')
  const id: string | null = idField?.type === 'string' ? idField.value : null
  if (idField && (id === null || !/^[a-zA-Z0-9_-]{1,64}$/.test(id))) throw new Error(`invalid id at cell ${ordinal}`)
  const source = field('source')
  if (!source || (source.type !== 'array' && source.type !== 'string')) throw new Error(`invalid source at cell ${ordinal}`)
  const parts = source.type === 'string' ? [source] : source.children ?? []
  const starts: number[] = [], ends: number[] = []
  let text = ''
  for (const token of parts) {
    if (token.type !== 'string') throw new Error(`non-string source at cell ${ordinal}`)
    text += token.value
    // JSON escapes encode exactly one UTF-16 unit, including each half of an escaped surrogate pair.
    for (let at = token.offset + 1; at < token.offset + token.length - 1;) {
      starts.push(byteAt[at]!)
      at += raw[at] === '\\' ? (raw[at + 1] === 'u' ? 6 : 2) : 1
      ends.push(byteAt[at]!)
    }
  }
  const span = (start_byte: number, end_byte: number): Range => ({
    start_byte, end_byte, start_line: lowerBound(physicalLines, start_byte + 1), end_line: lowerBound(physicalLines, end_byte + 1),
  })
  const whole = span(byteAt[source.offset]!, byteAt[source.offset + source.length]!)
  const range = (start: number, end: number) => span(starts[start] ?? whole.start_byte, ends[end - 1] ?? whole.end_byte)
  const lines = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1)
  const position = (offset: number) => {
    const line = lowerBound(lines, offset + 1)
    return { line, column: offset - lines[line - 1]! + 1 }
  }
  const magic = /^\s*%%([^\s]+)/.exec(text)?.[1]?.toLowerCase()
  const lineMagic = /^\s*%([a-z_]\w*)/i.exec(text)?.[1]
  let reason: string | undefined
  if (type === 'code') {
    if (magic && magic !== 'python' && magic !== 'python3') reason = 'unsupported_cell_magic:' + magic
    else if (lineMagic) reason = 'unsupported_line_magic:' + lineMagic
    else if (/^\s*!/.test(text)) reason = 'unsupported_shell_escape'
    else if (!magic && !/^python(?:\d+(?:\.\d+)*)?$/i.test(language)) reason = 'unsupported_kernel:' + (language || 'unknown')
  }
  // Blanking only the cell-magic header keeps all Python positions aligned with the original cell.
  const python = type === 'code' && !reason ? (magic ? text.replace(/^(\s*%%[^\n]*)/, m => m.replace(/[^\n]/g, ' ')) : text) : null
  const locate = (from: number, to: number) => {
    const a = lowerBound(starts, from), b = lowerBound(ends, to + 1)
    const start = position(a), end = position(b)
    return { address: { id, ordinal, cell_type: type as string, ...(reason ? { reason } : {}),
      start_line: start.line, start_column: start.column, end_line: end.line, end_column: end.column }, source: text.slice(a, b) }
  }
  return { id, key: id === null ? 'ordinal:' + ordinal : 'id:' + id, ordinal, type: type as string, reason, text, python, whole, range, locate }
}

export function readNotebook(raw: string) {
  const errors: ParseError[] = []
  const root = parseTree(raw, errors, { disallowComments: true, allowTrailingComma: false })
  if (errors.length || root?.type !== 'object') throw new Error('invalid notebook JSON')
  const get = (...path: string[]) => findNodeAtLocation(root, path)
  if (get('nbformat')?.value !== 4) throw new Error('unsupported notebook version (expected nbformat 4)')
  const nodes = get('cells')
  if (nodes?.type !== 'array') throw new Error('invalid notebook cells')
  const language = get('metadata', 'language_info', 'name')?.value ?? get('metadata', 'kernelspec', 'language')?.value ?? get('metadata', 'kernelspec', 'name')?.value ?? ''
  const byteAt = new Uint32Array(raw.length + 1), physicalLines = [0]
  let bytes = 0
  for (let i = 0; i < raw.length; i++) {
    const cp = raw.codePointAt(i)!
    byteAt[i] = bytes
    if (cp > 0xffff) byteAt[++i] = bytes
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (cp === 10) physicalLines.push(bytes)
  }
  byteAt[raw.length] = bytes
  const ids = new Set<string>()
  return (nodes.children ?? []).map((node, i) => {
    const cell = readCell(node, i + 1, raw, byteAt, physicalLines, String(language))
    if (cell.id !== null && ids.has(cell.id)) throw new Error('duplicate notebook cell id ' + cell.id)
    if (cell.id !== null) ids.add(cell.id)
    return cell
  })
}
