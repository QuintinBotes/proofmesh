// A reader for SCIP indexes (github.com/sourcegraph/scip, scip.proto), limited to the fields Proofmesh ingests (A24).
// Proofmesh never runs an indexer: a person produces the file and names it with `proofmesh scip add`.

import fs from 'node:fs'

export type ScipRange = { startLine: number; startChar: number; endLine: number; endChar: number }
export type ScipOccurrence = { symbol: string; roles: number; range?: ScipRange; enclosing?: ScipRange }
export type ScipSymbol = { symbol: string; kind: number; displayName: string; signature: string | null }
export type ScipDocument = { path: string; language: string; positionEncoding: number; occurrences: ScipOccurrence[]; symbols: ScipSymbol[] }
export type ScipIndex = { projectRoot: string; tool: { name: string; version: string }; documents: ScipDocument[] }

export const DEFINITION = 0x1

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** A cursor over protobuf bytes that reads base-128 varints. */
function cursor(b: Uint8Array) {
  const c = {
    pos: 0,
    varint(): number {
      let v = 0, shift = 0, byte: number
      do {
        if (c.pos >= b.length) throw new Error('the SCIP file is truncated')
        byte = b[c.pos++]!
        v += (byte & 0x7f) * 2 ** shift
        shift += 7
      } while (byte & 0x80)
      return v
    },
  }
  return c
}

/** The fields of one protobuf message: field number, wire type, and a number (varint) or the bytes of a length-delimited value. */
function* fields(b: Uint8Array): Generator<[number, number, number | Uint8Array]> {
  const c = cursor(b), varint = c.varint
  while (c.pos < b.length) {
    const key = varint(), field = Math.floor(key / 8), wire = key % 8
    if (wire === 0) yield [field, wire, varint()]
    else if (wire === 2) {
      const len = varint()
      if (c.pos + len > b.length) throw new Error('the SCIP file is truncated')
      yield [field, wire, b.subarray(c.pos, c.pos + len)]
      c.pos += len
    } else if (wire === 1) c.pos += 8
    else if (wire === 5) c.pos += 4
    else throw new Error(`the SCIP file has wire type ${wire}, which protobuf does not define`)
  }
}

const text = (v: number | Uint8Array) => (typeof v === 'number' ? '' : utf8.decode(v))
/** A repeated int32 field: one varint, or packed varints back to back. */
function ints(wire: number, v: number | Uint8Array): number[] {
  if (wire === 0) return [v as number]
  const c = cursor(v as Uint8Array), out: number[] = []
  while (c.pos < (v as Uint8Array).length) out.push(c.varint())
  return out
}

/** A range from the deprecated packed form: three numbers on one line, or four. */
function packedRange(n: number[]): ScipRange | undefined {
  if (n.length === 3) return { startLine: n[0]!, startChar: n[1]!, endLine: n[0]!, endChar: n[2]! }
  if (n.length === 4) return { startLine: n[0]!, startChar: n[1]!, endLine: n[2]!, endChar: n[3]! }
  return undefined
}

function typedRange(b: Uint8Array, multi: boolean): ScipRange {
  const f = new Map<number, number>()
  for (const [field, , v] of fields(b)) if (typeof v === 'number') f.set(field, v)
  const at = (k: number) => f.get(k) ?? 0
  return multi ? { startLine: at(1), startChar: at(2), endLine: at(3), endChar: at(4) } : { startLine: at(1), startChar: at(2), endLine: at(1), endChar: at(3) }
}

function occurrence(b: Uint8Array): ScipOccurrence {
  const o: ScipOccurrence = { symbol: '', roles: 0 }
  let packed: number[] = [], packedEnclosing: number[] = [], typed: ScipRange | undefined, typedEnclosing: ScipRange | undefined
  for (const [field, wire, v] of fields(b)) {
    if (field === 1) packed = [...packed, ...ints(wire, v)]
    else if (field === 2) o.symbol = text(v)
    else if (field === 3) o.roles = v as number
    else if (field === 7) packedEnclosing = [...packedEnclosing, ...ints(wire, v)]
    else if (field === 8 || field === 9) typed = typedRange(v as Uint8Array, field === 9)
    else if (field === 10 || field === 11) typedEnclosing = typedRange(v as Uint8Array, field === 11)
  }
  // The typed form takes precedence over the deprecated packed one, as scip.proto says.
  const range = typed ?? packedRange(packed), enclosing = typedEnclosing ?? packedRange(packedEnclosing)
  if (range) o.range = range
  if (enclosing) o.enclosing = enclosing
  return o
}

function symbolInformation(b: Uint8Array): ScipSymbol {
  const s: ScipSymbol = { symbol: '', kind: 0, displayName: '', signature: null }
  for (const [field, , v] of fields(b)) {
    if (field === 1) s.symbol = text(v)
    else if (field === 5) s.kind = v as number
    else if (field === 6) s.displayName = text(v)
    else if (field === 7) for (const [f, , t] of fields(v as Uint8Array)) if (f === 5) s.signature = text(t)
  }
  return s
}

function document(b: Uint8Array): ScipDocument {
  const d: ScipDocument = { path: '', language: '', positionEncoding: 0, occurrences: [], symbols: [] }
  for (const [field, , v] of fields(b)) {
    if (field === 1) d.path = text(v)
    else if (field === 2) d.occurrences.push(occurrence(v as Uint8Array))
    else if (field === 3) d.symbols.push(symbolInformation(v as Uint8Array))
    else if (field === 4) d.language = text(v).toLowerCase()
    else if (field === 6) d.positionEncoding = v as number
  }
  return d
}

export function decodeScip(bytes: Uint8Array): ScipIndex {
  const index: ScipIndex = { projectRoot: '', tool: { name: '', version: '' }, documents: [] }
  for (const [field, , v] of fields(bytes)) {
    if (field === 1) {
      for (const [f, , m] of fields(v as Uint8Array)) {
        if (f === 3) index.projectRoot = text(m)
        else if (f === 2) for (const [t, , x] of fields(m as Uint8Array)) { if (t === 1) index.tool.name = text(x); else if (t === 2) index.tool.version = text(x) }
      }
    } else if (field === 2) index.documents.push(document(v as Uint8Array))
  }
  return index
}

/** The repository path of a document: SCIP paths are relative to the index's project root, which may sit inside the repository. */
export function repositoryPath(index: ScipIndex, doc: ScipDocument, repositoryRoot: string): string | undefined {
  let root = index.projectRoot.startsWith('file://') ? decodeURIComponent(new URL(index.projectRoot).pathname).replace(/\/$/, '') : ''
  if (root && fs.existsSync(root)) root = fs.realpathSync(root)
  const prefix = root && (root === repositoryRoot || root.startsWith(repositoryRoot + '/')) ? root.slice(repositoryRoot.length + 1) : ''
  const joined = [prefix, doc.path].filter(Boolean).join('/').split('/').filter((s) => s && s !== '.')
  return joined.length && !joined.includes('..') ? joined.join('/') : undefined
}
