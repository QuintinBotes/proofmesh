import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostNodeArgs } from '../src/cli/host-heap.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { AdapterProcess, PROTOCOL_VERSION, typescriptAdapterPath } from '../src/indexer/adapter-host.js'
import { NODE_GC_FLAGS } from '../src/indexer/memory.js'
import { createStagingStore } from '../src/meshstore/snapshot.js'
import { indexedRepo, tmpDir, withSnapshot } from './helpers.js'

// #32: a cold build in less memory and time, with the same facts. Each check counts flags, fsyncs, pages or facts, never a wall clock.
afterEach(() => vi.restoreAllMocks())

describe('FR1240 every Node process of an index starts under GC flags that keep its resident set near its live data', () => {
  it('FR1240 scenario 1: a JavaScript adapter starts with the GC flags, then its budget, so a heap flag of its own would come last', async () => {
    const a = new AdapterProcess(path.join(import.meta.dirname, 'fake-adapters', 'exec-argv.mjs'), 60000, 3000, 'argv', undefined, 512)
    try {
      const init = await a.initialize({ protocol_version: PROTOCOL_VERSION, workspace: tmpDir('pm-ws-'), analysis_mode: 'no_execution', files: [], config: {} })
      expect(JSON.parse(init.adapter.toolchain.exec_argv!)).toEqual([...NODE_GC_FLAGS, '--max-old-space-size=512'])
    } finally { await a.shutdown() }
  })
  it('FR1240 scenario 2: the index host starts with the GC flags, then the heap the rule chose, then the flags the person gave', () => {
    expect(hostNodeArgs(2048)).toEqual([...NODE_GC_FLAGS, '--max-old-space-size=2048', ...process.execArgv])
    expect(NODE_GC_FLAGS).toEqual(['--max-semi-space-size=4', '--heap-growing-percent=25'])
  })
})

describe('FR1241 capture makes its objects durable off the main thread, before the snapshot that cites them is sealed', () => {
  it('FR1241 scenario 1: a deferred put fsyncs nothing; flush fsyncs each object it wrote once, and an object already stored is not written again', async () => {
    const store = new EvidenceStore(tmpDir())
    const syncs = vi.spyOn(fs, 'fsyncSync'), opens = vi.spyOn(fs.promises, 'open')
    const hashes = ['a', 'b', 'c'].map((t) => store.put(Buffer.from(t), 'later'))
    store.put(Buffer.from('a'), 'later')
    expect(syncs).not.toHaveBeenCalled()
    await store.flush()
    expect(opens.mock.calls.map((c) => c[0])).toEqual(hashes.map((h) => store.objectPath(h)))
    await store.flush()
    expect(opens).toHaveBeenCalledTimes(3)
    expect(store.read(hashes[1]!)!.toString()).toBe('b')
  })
  it('FR1241 scenario 2: an index makes as many synchronous fsyncs for 40 files as for 2 (the sealed file and its directory), and flushes every captured object', async () => {
    const counts: number[] = []
    for (const n of [2, 40]) {
      const files = Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}.py`, `def f${i}():\n    return ${i}\n`]))
      const syncs = vi.spyOn(fs, 'fsyncSync'), flush = vi.spyOn(EvidenceStore.prototype, 'flush'), opens = vi.spyOn(fs.promises, 'open')
      const { dataDir } = await indexedRepo(files)
      counts.push(syncs.mock.calls.length)
      expect(flush).toHaveBeenCalledTimes(1)
      const objects = opens.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith(path.join(dataDir, 'objects')))
      expect(objects.length).toBe(n)
      expect(withSnapshot(dataDir, (db) => (db.prepare("select count(*) n from file where disposition = 'indexed'").get() as { n: number }).n)).toBe(n)
      vi.restoreAllMocks()
    }
    expect(counts).toEqual([2, 2])
  }, 120000)
})

describe('FR1242 the TypeScript adapter keeps a byte map only for a file with non-ASCII text, and every range stays on the bytes as stored', () => {
  it('FR1242 scenario 1: ASCII text with and without a byte order mark, and text with a character outside the BMP, give the declarations their bytes', async () => {
    const files = {
      'plain.ts': 'export function one() { return 1 }\nexport class Two {}\n',
      'marked.ts': '\uFEFFexport function three() { return 3 }\nexport const four = 4\n',
      'wide.ts': "export const face = '\u{1F600}'\nexport function five() { return 'é' }\n",
    }
    const { repo, dataDir } = await indexedRepo(files)
    const slices = withSnapshot(dataDir, (db) => (db.prepare("select f.path, s.qualified_name as name, s.start_byte as start, s.end_byte as end from symbol s join file f on f.id = s.file_id where s.kind <> 'module' order by f.path, s.start_byte").all() as Array<{ path: string; name: string; start: number; end: number }>)
      .map((s) => [s.name, fs.readFileSync(path.join(repo, s.path)).subarray(s.start, s.end).toString('utf8')]))
    expect(slices).toEqual([
      ['marked:three', 'export function three() { return 3 }'],
      ['marked:four', 'export const four = 4'],
      ['plain:one', 'export function one() { return 1 }'],
      ['plain:Two', 'export class Two {}'],
      ['wide:face', "export const face = '\u{1F600}'"],
      ['wide:five', "export function five() { return 'é' }"],
    ])
  }, 120000)
})

describe('FR1243 the TypeScript adapter writes a reply as one line, a part at a time, from each file\'s facts made into text as the file is read', () => {
  it('FR1243 scenario 1: a reply of more than a megabyte arrives whole, with every symbol and call of the file', async () => {
    const n = 3000, ws = tmpDir('pm-ws-')
    fs.writeFileSync(path.join(ws, 'chain.ts'), Array.from({ length: n }, (_, i) => `export function f${i}(): number { return ${i ? `f${i - 1}() + 1` : '0'} }\n`).join(''))
    const a = new AdapterProcess(typescriptAdapterPath())
    try {
      await a.initialize({ protocol_version: PROTOCOL_VERSION, workspace: ws, analysis_mode: 'no_execution', files: [{ path: 'chain.ts', content_hash: 'x', language: 'typescript' }], config: {} })
      const r = await a.analyze(['chain.ts'])
      expect(Buffer.byteLength(JSON.stringify(r))).toBeGreaterThan(1 << 20)
      expect(r.symbols.filter((s) => s.kind === 'function')).toHaveLength(n)
      expect(r.relationships.filter((x) => x.type === 'calls' && x.resolution === 'resolved')).toHaveLength(n - 1)
      expect(r.file_results).toEqual([expect.objectContaining({ path: 'chain.ts', status: 'ok' })])
    } finally { await a.shutdown() }
  }, 120000)
})

describe('FR1244 a staging snapshot keeps a page cache large enough for its indexes', () => {
  it('FR1244 scenario 1: the staging store holds up to 64 MB of pages, which changes no byte of the file', () => {
    const db = createStagingStore(path.join(tmpDir(), 'staging', 'snapshot.db'))
    try { expect(db.pragma('cache_size', { simple: true })).toBe(-65536) } finally { db.close() }
  })
})
