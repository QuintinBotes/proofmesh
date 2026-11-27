import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sha256File } from '../src/core/hash.js'
import { decodeScip, newProbe, readDocument, scanScip, type ScipDocument } from '../src/scip/decode.js'
import { loadIndexes, type LoadProbe } from '../src/scip/load.js'
import { documentBytes, encode, metadataBytes, type Doc, type Occ } from './helpers-scip.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { cli, tmpDir, withSnapshot } from './helpers.js'

describe('FR164 the index is read document by document, in memory that grows with its definitions, not its size', () => {
  const CHUNK = 64 * 1024
  /** A synthetic index written to disk a megabyte at a time: `docs` documents, each with one definition and `refs` references to others. */
  function synthetic(docs: number, refs: number): { file: string; bytes: number } {
    const file = path.join(tmpDir('pm-scip-big-'), 'big.scip'), fd = fs.openSync(file, 'w')
    let pending: number[] = [...metadataBytes('/synthetic', 'synthetic')], bytes = 0
    const flush = () => { fs.writeSync(fd, Uint8Array.from(pending)); bytes += pending.length; pending = [] }
    for (let i = 0; i < docs; i++) {
      const own = `scip-go gomod x v1 \`x/p${i % 500}\`/F${i}().`
      const occurrences: Occ[] = [{ symbol: own, range: [0, 5, 10], enclosing: [0, 0, 3, 1], def: true }]
      for (let r = 0; r < refs; r++) occurrences.push({ symbol: `scip-go gomod x v1 \`x/p${(i + r) % 500}\`/F${(i + r + 1) % docs}().`, range: [1 + r, 2, 8] })
      pending.push(...documentBytes({ path: `p${i % 500}/f${i}.go`, language: 'go', typed: true, occurrences, symbols: [{ symbol: own, kind: 17 }] }))
      if (pending.length > 1 << 20) flush()
    }
    flush(); fs.closeSync(fd)
    return { file, bytes }
  }

  it('FR164 scenario 7: the reader holds one document and a bounded buffer however big the index, and its facts equal a whole read of a small one', () => {
    const small = synthetic(2000, 6), big = synthetic(16000, 6)
    const scan = (file: string) => { const probe = newProbe(); const seen: ScipDocument[] = []; const digest = scanScip(file, { document: (doc) => { seen.push({ ...doc, occurrences: doc.occurrences.slice(0, 1) }) } }, { chunkBytes: CHUNK, probe }); return { probe, digest, seen } }
    const a = scan(small.file), b = scan(big.file)
    expect(b.probe.bytesRead).toBe(big.bytes)
    expect(big.bytes).toBeGreaterThan(7 * small.bytes)
    for (const [r, f] of [[a, small], [b, big]] as const) {
      expect(r.digest).toBe(sha256File(f.file))
      expect(r.probe.maxDocumentsHeld).toBe(1)
      expect(r.probe.maxBufferedBytes).toBeLessThanOrEqual(r.probe.largestMessage + 2 * CHUNK)
    }
    // The buffer does not grow with the file: eight times the documents, and it differs by a few bytes of the largest document's own size.
    expect(b.probe.maxBufferedBytes - a.probe.maxBufferedBytes).toBeLessThan(1024)
    expect(b.probe.documents).toBe(16000)
    // The same documents as reading the whole file at once.
    const whole = decodeScip(fs.readFileSync(small.file))
    expect(a.seen).toEqual(whole.documents.map((doc) => ({ ...doc, occurrences: doc.occurrences.slice(0, 1) })))
    expect(a.probe.documents).toBe(whole.documents.length)
  }, 120000)

  it('FR164 the reader reads a document that spans many tiny chunks, and a varint that crosses one', () => {
    const docs: Doc[] = [{ path: 'a.go', language: 'go', typed: true, occurrences: [{ symbol: 'scip-go gomod x v1 a/F().', range: [0, 5, 6], enclosing: [0, 0, 2, 1], def: true }], symbols: [{ symbol: 'scip-go gomod x v1 a/F().', kind: 17 }] }, { path: 'b.go', language: 'go', typed: false, occurrences: [{ symbol: 'local 0', range: [1, 2, 3] }] }]
    const file = path.join(tmpDir('pm-scip-tiny-'), 'tiny.scip')
    fs.writeFileSync(file, encode('/r', 'tiny', docs))
    const whole = decodeScip(fs.readFileSync(file)), got: ScipDocument[] = []
    for (const chunkBytes of [1, 2, 3, 7]) { got.length = 0; scanScip(file, { document: (doc) => { got.push(doc) } }, { chunkBytes }); expect(got).toEqual(whole.documents) }
  })

  it('FR164 a truncated index, and documents with no metadata before them, are errors that name the problem', () => {
    const dir = tmpDir('pm-scip-bad-'), ok = encode('/r', 't', [{ path: 'a.go', language: 'go', typed: true, occurrences: [] }])
    const cut = path.join(dir, 'cut.scip'); fs.writeFileSync(cut, ok.subarray(0, ok.length - 3))
    expect(() => scanScip(cut, { document: () => {} })).toThrow(/truncated/)
    const headless = path.join(dir, 'headless.scip'); fs.writeFileSync(headless, Uint8Array.from(documentBytes({ path: 'a.go', language: 'go', typed: true, occurrences: [] })))
    expect(() => scanScip(headless, { document: () => {} })).toThrow(/before its metadata/)
  })

  it('FR164 the adapter keeps definitions only: 100,000 definitions held, and every other occurrence read and dropped', () => {
    const docs = 100000, refs = 6, { file, bytes } = synthetic(docs, refs)
    const routed = new Set(Array.from({ length: docs }, (_, i) => `p${i % 500}/f${i}.go`))
    const probe = Object.assign(newProbe(), { retainedOccurrences: 0 }) as LoadProbe
    const loaded = loadIndexes([{ name: 'big', path: file, sha256: sha256File(file) }], routed, '/synthetic', probe)
    expect(loaded.routed.size).toBe(docs)
    // Memory grows with definitions: every definition is kept, and no reference of the docs * refs the index holds.
    expect(probe.retainedOccurrences).toBe(docs)
    expect([...loaded.routed.values()].every((doc) => doc.definitions.length === 1 && doc.info.size === 1)).toBe(true)
    expect(probe.maxDocumentsHeld).toBe(1)
    expect(probe.bytesRead).toBe(bytes)
    expect(probe.maxBufferedBytes).toBeLessThanOrEqual(probe.largestMessage + 2 * probe.chunkBytes)
    expect(probe.maxBufferedBytes).toBeLessThan(bytes / 20)
    // A routed document is read again alone, by where the scan found it.
    const one = loaded.routed.get('p7/f7.go')!
    expect(one.at.length).toBeLessThan(2000)
  }, 240000)

  it('FR164 an index file that changed after it was named is refused, as before', () => {
    const { file } = synthetic(10, 1), hash = crypto.createHash('sha256').update('not this file').digest('hex')
    expect(() => loadIndexes([{ name: 'big', path: file, sha256: hash }], new Set(), '/synthetic')).toThrow(/changed after it was added/)
  })

  it('FR164 a length no file could hold is refused before anything is allocated, whatever its size', () => {
    const varint = (n: bigint): number[] => { const out: number[] = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b) } while (n); return out }
    for (const length of [3_000_000_000n, 2n ** 40n, 2n ** 63n]) {
      const file = path.join(tmpDir('pm-scip-huge-'), 'huge.scip')
      fs.writeFileSync(file, Uint8Array.from([0x12, ...varint(length), ...Array(16).fill(7)]))
      const probe = newProbe()
      expect(() => scanScip(file, { document: () => {} }, { chunkBytes: CHUNK, probe }), String(length)).toThrow(/truncated or corrupt at offset 0/)
      expect(probe.maxBufferedBytes).toBeLessThan(2 * CHUNK)
    }
    // A length that fits the file's size but is longer than the bytes left is refused the same way, at its own offset.
    const ok = encode('/r', 't', [{ path: 'a.go', language: 'go', typed: true, occurrences: [] }]), file = path.join(tmpDir('pm-scip-huge-'), 'short.scip')
    fs.writeFileSync(file, ok.subarray(0, ok.length - 1))
    expect(() => scanScip(file, { document: () => {} })).toThrow(/truncated or corrupt at offset \d+/)
  })

  it('FR164 reads that return a few bytes at a time give the same documents, in the same bound', () => {
    const { file } = synthetic(300, 40), whole = decodeScip(fs.readFileSync(file)), got: ScipDocument[] = [], probe = newProbe()
    const real = fs.readSync
    const spy = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buf: NodeJS.ArrayBufferView, off: number, len: number, pos: number | null) => real(fd, buf, off, Math.min(len, 5), pos)) as typeof fs.readSync)
    try { scanScip(file, { document: (doc) => { got.push(doc) } }, { chunkBytes: 4096, probe }) } finally { spy.mockRestore() }
    expect(got).toEqual(whole.documents)
    expect(probe.maxBufferedBytes).toBeLessThanOrEqual(probe.largestMessage + 2 * 4096)
  })

  it('FR164 one document many times the chunk size is held alone, and the buffer is bounded by it plus two chunks', () => {
    const occurrences: Occ[] = Array.from({ length: 150000 }, (_, i) => ({ symbol: `scip-go gomod x v1 \`x/p\`/F${i % 1000}().`, range: [i, 2, 8] }))
    const file = path.join(tmpDir('pm-scip-one-'), 'one.scip')
    fs.writeFileSync(file, encode('/r', 'one', [{ path: 'huge.go', language: 'go', typed: true, occurrences }, { path: 'small.go', language: 'go', typed: true, occurrences: [] }]))
    const probe = newProbe(), counts: number[] = []
    scanScip(file, { document: (doc) => { counts.push(doc.occurrences.length) } }, { chunkBytes: CHUNK, probe })
    expect(counts).toEqual([150000, 0])
    expect(probe.largestMessage).toBeGreaterThan(50 * CHUNK)
    expect(probe.maxDocumentsHeld).toBe(1)
    expect(probe.maxBufferedBytes).toBeLessThanOrEqual(probe.largestMessage + 2 * CHUNK)
    expect(probe.maxBufferedBytes).toBeGreaterThanOrEqual(probe.largestMessage)
  })

  it('FR164 a document read again by offset is refused when the file changed, and when the document at that offset is another one', () => {
    const file = path.join(tmpDir('pm-scip-again-'), 'again.scip'), docs: Doc[] = [{ path: 'a.go', language: 'go', typed: true, occurrences: [] }, { path: 'b.go', language: 'go', typed: true, occurrences: [] }]
    fs.writeFileSync(file, encode('/r', 't', docs))
    const at: Array<{ offset: number; length: number }> = []
    scanScip(file, { document: (_doc, where) => { at.push(where) } })
    const stamp = fs.statSync(file), expected = (p: string) => ({ path: p, size: stamp.size, mtimeMs: stamp.mtimeMs })
    expect(readDocument(file, at[1]!, expected('b.go')).path).toBe('b.go')
    expect(() => readDocument(file, at[1]!, expected('a.go'))).toThrow(/is not the document/)
    fs.writeFileSync(file, encode('/r', 'rewritten', docs.slice().reverse()))
    expect(() => readDocument(file, at[1]!, expected('b.go'))).toThrow(/changed/)
  })
})

describe('FR531 a 1 GB index with 100,000 definitions is named and indexed with the SCIP adapter under 600 MB of resident memory', () => {
  const varint = (n: number): Buffer => { const out: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b) } while (n); return Buffer.from(out) }
  const field = (no: number, v: Buffer) => Buffer.concat([varint(no * 8 + 2), varint(v.length), v])

  it('FR531 scenario 7: the adapter\'s peak resident memory, sampled by the host through the whole index, stays under 600 MB', async () => {
    const FILES = 1000, PER_FILE = 100, MB = 1024 * 1024
    const repo = fs.realpathSync(tmpDir('pm-scip-gb-')), indexDir = tmpDir('pm-scip-gb-index-'), file = path.join(indexDir, 'big.scip'), d = tmpDir()
    try {
      fs.writeFileSync(path.join(repo, 'go.mod'), 'module example.com/big\n\ngo 1.22\n')
      // Each definition carries ten kilobytes of hover documentation, as indexers record for a symbol: the bulk of the index, read and dropped.
      const documentation = Buffer.from('Documentation of a generated function, as an indexer records it for hover. '.repeat(142))
      const fd = fs.openSync(file, 'w')
      let bytes = 0
      const write = (b: Uint8Array) => { fs.writeSync(fd, b); bytes += b.length }
      write(Uint8Array.from(metadataBytes(repo, 'synthetic')))
      for (let i = 0; i < FILES; i++) {
        const rel = `p${i}/f.go`, lines = [`package p${i}`, '']
        const occurrences: Occ[] = [], infos: Buffer[] = []
        for (let j = 0; j < PER_FILE; j++) {
          const line = lines.length, symbol = `scip-go gomod example.com/big v1 \`example.com/big/p${i}\`/F${j}().`
          lines.push(`func F${j}() int {`, `\treturn ${j}`, '}', '')
          occurrences.push({ symbol, range: [line, 5, 5 + `F${j}`.length], enclosing: [line, 0, line + 2, 1], def: true })
          infos.push(field(3, Buffer.concat([field(1, Buffer.from(symbol)), varint(5 * 8), varint(17), field(3, documentation)])))
        }
        fs.mkdirSync(path.join(repo, `p${i}`))
        fs.writeFileSync(path.join(repo, rel), lines.join('\n'))
        // The document's own fields as the helper writes them (after its tag and length), then its symbol information.
        const head = Buffer.from(documentBytes({ path: rel, language: 'go', typed: true, occurrences }))
        let k = 1
        while (head[k]! & 0x80) k++
        write(field(2, Buffer.concat([head.subarray(k + 1), ...infos])))
      }
      fs.closeSync(fd)
      expect(bytes).toBeGreaterThanOrEqual(1024 * MB)
      for (const args of [['init'], ['repo', 'add', repo], ['scip', 'add', repo, file]]) { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0) }
      process.env.PROOFMESH_TEST_ADAPTER_RSS_SAMPLE_MS = '50'
      const r = await indexRepository(d, repo)
      expect(r.status).toBe('published')
      // Every definition was read.
      const n = withSnapshot(d, (db) => (db.prepare("select count(*) as n from symbol s join file f on f.id = s.file_id where f.path like 'p%/f.go' and s.kind = 'function'").get() as { n: number }).n)
      expect(n).toBe(FILES * PER_FILE)
      // The host sampled the adapter's process group (the adapter and the syntax tier it starts) every 50 ms and at the end of every batch.
      const peak = r.adapterPeakRssKb.scip
      expect(peak, 'the host could not sample the adapter\'s resident memory (is ps available?)').toBeGreaterThan(0)
      expect(peak! / 1024).toBeLessThan(600)
    } finally {
      delete process.env.PROOFMESH_TEST_ADAPTER_RSS_SAMPLE_MS
      // Never leave a gigabyte behind.
      for (const dir of [indexDir, repo, d]) fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 600000)
})
