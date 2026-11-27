// A reader for SCIP indexes (github.com/sourcegraph/scip, scip.proto), limited to the fields Proofmesh ingests (A24).
// Proofmesh never runs an indexer: a person produces the file and names it with `proofmesh scip add`.

import crypto from 'node:crypto'
import fs from 'node:fs'

export type ScipRange = { startLine: number; startChar: number; endLine: number; endChar: number }
export type ScipOccurrence = { symbol: string; roles: number; range?: ScipRange; enclosing?: ScipRange }
/** A symbol's relationship to another; `implementation` is scip.proto's `is_implementation`, the only flag Proofmesh reads (FR162). */
export type ScipRelationship = { symbol: string; implementation: boolean }
export type ScipSymbol = { symbol: string; kind: number; displayName: string; signature: string | null; relationships: ScipRelationship[] }
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
  const s: ScipSymbol = { symbol: '', kind: 0, displayName: '', signature: null, relationships: [] }
  for (const [field, , v] of fields(b)) {
    if (field === 1) s.symbol = text(v)
    else if (field === 4) {
      const r: ScipRelationship = { symbol: '', implementation: false }
      for (const [f, , x] of fields(v as Uint8Array)) { if (f === 1) r.symbol = text(x); else if (f === 3) r.implementation = x !== 0 }
      if (r.symbol) s.relationships.push(r)
    } else if (field === 5) s.kind = v as number
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
    if (field === 1) Object.assign(index, metadata(v as Uint8Array))
    else if (field === 2) index.documents.push(document(v as Uint8Array))
  }
  return index
}

function metadata(b: Uint8Array): Pick<ScipIndex, 'projectRoot' | 'tool'> {
  const out = { projectRoot: '', tool: { name: '', version: '' } }
  for (const [f, , m] of fields(b)) {
    if (f === 3) out.projectRoot = text(m)
    else if (f === 2) for (const [t, , x] of fields(m as Uint8Array)) { if (t === 1) out.tool.name = text(x); else if (t === 2) out.tool.version = text(x) }
  }
  return out
}

/** What a streaming read counts, so a test can show the memory bound by numbers (FR164). */
export type ScanProbe = { chunkBytes: number; bytesRead: number; maxBufferedBytes: number; largestMessage: number; documents: number; documentsHeld: number; maxDocumentsHeld: number }
export const newProbe = (): ScanProbe => ({ chunkBytes: 0, bytesRead: 0, maxBufferedBytes: 0, largestMessage: 0, documents: 0, documentsHeld: 0, maxDocumentsHeld: 0 })
export const CHUNK_BYTES = 1 << 20
/** Where a document sits in the index file, so it can be read again alone. */
export type DocumentAt = { offset: number; length: number }

/**
 * Reads an index from disk one document at a time (FR164): the file is read in chunks, and only the bytes of the message being
 * decoded are held, never the whole file and never more than one decoded document. Returns the SHA-256 of every byte read.
 */
export function scanScip(file: string, visit: { metadata?(m: Pick<ScipIndex, 'projectRoot' | 'tool'>): void; document(doc: ScipDocument, at: DocumentAt): void; external?(info: ScipSymbol): void }, options: { chunkBytes?: number; probe?: ScanProbe } = {}): string {
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES, probe = options.probe ?? newProbe()
  probe.chunkBytes = chunkBytes
  const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256'), size = fs.fstatSync(fd).size
  const corrupt = (why: string) => new Error(`the SCIP file is truncated or corrupt at offset ${fieldAt}: ${why}`)
  let buf = Buffer.alloc(0), store = buf, start = 0, fieldAt = 0, eof = false, sawMetadata = false
  /** Reads until `want` bytes are buffered, or the file ends. `want` was checked against the file's size, so one allocation holds it. */
  const ensure = (want: number): boolean => {
    if (buf.length >= want) return true
    if (eof) return false
    // One buffer for the wanted size and a chunk more, filled by as many reads as it takes, so short reads reallocate nothing. It is
    // kept while it is big enough: a new one for every message churns the allocator, which keeps what it freed resident (FR531).
    const need = Math.max(want, buf.length + chunkBytes)
    const next = store.length >= need ? store : (store = Buffer.allocUnsafe(need))
    // Buffer#copy is a memmove, so the bytes left over move to the front of the same buffer safely.
    buf.copy(next)
    let have = buf.length
    probe.maxBufferedBytes = Math.max(probe.maxBufferedBytes, next.length)
    while (have < want) {
      const n = fs.readSync(fd, next, have, next.length - have, null)
      if (!n) { eof = true; break }
      hash.update(next.subarray(have, have + n)); probe.bytesRead += n
      have += n
    }
    buf = next.subarray(0, have)
    return have >= want
  }
  const consume = (n: number) => { buf = buf.subarray(n); start += n }
  /** Steps over bytes the reader does not use, hashing them without keeping them. */
  const skip = (n: number) => {
    const have = Math.min(n, buf.length)
    consume(have)
    let rest = n - have
    const scratch = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(rest, 1)))
    while (rest > 0) {
      const got = fs.readSync(fd, scratch, 0, Math.min(scratch.length, rest), null)
      if (!got) throw new Error('the SCIP file is truncated')
      hash.update(scratch.subarray(0, got)); probe.bytesRead += got; rest -= got; start += got
    }
  }
  const varint = (): number => {
    for (let need = 1; need <= 10; need++) {
      if (!ensure(need)) throw new Error('the SCIP file is truncated')
      if (!(buf[need - 1]! & 0x80)) {
        let v = 0
        for (let i = 0; i < need; i++) v += (buf[i]! & 0x7f) * 2 ** (7 * i)
        if (v > Number.MAX_SAFE_INTEGER) throw corrupt('a number beyond 2^53')
        consume(need)
        return v
      }
    }
    throw new Error('the SCIP file has a varint longer than ten bytes')
  }
  try {
    while (ensure(1)) {
      fieldAt = start
      const key = varint(), field = Math.floor(key / 8), wire = key % 8
      if (wire === 0) varint()
      else if (wire === 1) skip(8)
      else if (wire === 5) skip(4)
      else if (wire === 2) {
        const length = varint()
        // A message cannot be longer than what is left of the file; refused before any buffer is made for it.
        if (start + length > size) throw corrupt(`a message of ${length} bytes, ${Math.max(0, size - start)} left in the file`)
        if (field !== 1 && field !== 2 && !(field === 3 && visit.external)) { skip(length); continue }
        if (!ensure(length)) throw new Error('the SCIP file is truncated')
        probe.largestMessage = Math.max(probe.largestMessage, length)
        const message = buf.subarray(0, length), at = { offset: start, length }
        if (field === 1) { sawMetadata = true; visit.metadata?.(metadata(message)) }
        else if (field === 3) visit.external!(symbolInformation(message))
        else {
          if (!sawMetadata) throw new Error('the SCIP file has a document before its metadata')
          probe.documents++; probe.maxDocumentsHeld = Math.max(probe.maxDocumentsHeld, ++probe.documentsHeld)
          try { visit.document(document(message), at) } finally { probe.documentsHeld-- }
        }
        consume(length)
      } else throw new Error(`the SCIP file has wire type ${wire}, which protobuf does not define`)
    }
  } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}

/** What an index file looked like when it was read, to refuse reading it again once it changed. */
export type Stamp = { size: number; mtimeMs: number }
export const stampOf = (file: string): Stamp => { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs } }

let again = Buffer.alloc(0)
/** One document of an index, read again by where `scanScip` found it; refused if the file changed or another document sits there. */
export function readDocument(file: string, at: DocumentAt, expected: Stamp & { path: string }): ScipDocument {
  const fd = fs.openSync(file, 'r')
  try {
    const st = fs.fstatSync(fd), changed = () => new Error(`the SCIP index ${file} changed after the adapter read it`)
    if (st.size !== expected.size || st.mtimeMs !== expected.mtimeMs || at.offset + at.length > st.size) throw changed()
    // One buffer, kept for the next read for the reason scanScip keeps its own; a document decodes to strings and numbers, never views of it.
    if (again.length < at.length) again = Buffer.allocUnsafe(at.length)
    const bytes = again.subarray(0, at.length)
    let have = 0
    while (have < at.length) {
      const n = fs.readSync(fd, bytes, have, at.length - have, at.offset + have)
      if (!n) throw changed()
      have += n
    }
    const doc = document(bytes)
    if (doc.path !== expected.path) throw new Error(`the SCIP index ${file} at offset ${at.offset} holds ${doc.path}, which is not the document ${expected.path} that was read there`)
    return doc
  } finally { fs.closeSync(fd) }
}

/** The repository path of a document: SCIP paths are relative to the index's project root, which may sit inside the repository. */
export function repositoryPath(index: Pick<ScipIndex, 'projectRoot'>, doc: ScipDocument, repositoryRoot: string): string | undefined {
  let root = index.projectRoot.startsWith('file://') ? decodeURIComponent(new URL(index.projectRoot).pathname).replace(/\/$/, '') : ''
  if (root && fs.existsSync(root)) root = fs.realpathSync(root)
  const prefix = root && (root === repositoryRoot || root.startsWith(repositoryRoot + '/')) ? root.slice(repositoryRoot.length + 1) : ''
  const joined = [prefix, doc.path].filter(Boolean).join('/').split('/').filter((s) => s && s !== '.')
  return joined.length && !joined.includes('..') ? joined.join('/') : undefined
}
