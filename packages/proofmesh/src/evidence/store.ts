import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../core/hash.js'

const OBJECT_HASH = /^[0-9a-f]{64}$/

export type Integrity = { status: 'verified' } | { status: 'failed'; actual_hash: string } | { status: 'unavailable' }

/** Content-addressed evidence objects. An object is stored and verified before anything may reference it. */
export class EvidenceStore {
  constructor(private readonly dataDir: string) {}

  objectPath(hash: string): string {
    if (!OBJECT_HASH.test(hash)) throw new Error(`${JSON.stringify(hash)} is not a sha256 object hash`)
    return path.join(this.dataDir, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash)
  }

  /** Objects written with durable 'later', which flush() makes durable. */
  private unsynced: string[] = []
  /** Directories this store has made, so each is made once (#32). */
  private made = new Set<string>()
  private mkdir(dir: string): void {
    if (!this.made.has(dir)) { fs.mkdirSync(dir, { recursive: true }); this.made.add(dir) }
  }

  /**
   * durable false skips the fsync: for copies of files still in the working tree, whose every read is checked against the hash anyway.
   * durable 'later' defers it to flush(), which runs every deferred fsync off the main thread: an index captures thousands of files, and
   * one fsync after each was most of its capture time (#32). Whatever references such an object awaits flush() before it is published.
   */
  put(content: Uint8Array, durable: boolean | 'later' = true): string {
    const hash = sha256(content)
    const target = this.objectPath(hash)
    if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === hash) {
      // Another run may have put it 'later' and stopped before its flush: what cites it here makes it durable too.
      if (durable === 'later') this.unsynced.push(target)
      return hash
    }
    const tmpDir = path.join(this.dataDir, 'objects', 'tmp')
    this.mkdir(tmpDir)
    this.mkdir(path.dirname(target))
    const tmp = path.join(tmpDir, `${hash}.${process.pid}.${Date.now()}`)
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeSync(fd, content)
      if (durable === true) fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (sha256(fs.readFileSync(tmp)) !== hash) throw new Error(`object ${hash} failed verification after write`)
    fs.chmodSync(tmp, 0o444)
    fs.renameSync(tmp, target)
    if (durable === 'later') this.unsynced.push(target)
    return hash
  }

  /** Makes every object put with durable 'later' so far, written or found, durable: an fsync of each, a few at a time on the thread pool. */
  async flush(): Promise<void> {
    const paths = this.unsynced
    this.unsynced = []
    for (let i = 0; i < paths.length; i += 64) {
      await Promise.all(paths.slice(i, i + 64).map(async (p) => {
        const fh = await fs.promises.open(p, 'r')
        try { await fh.sync() } finally { await fh.close() }
      }))
    }
  }

  read(hash: string): Buffer | undefined {
    if (!OBJECT_HASH.test(hash)) return undefined
    const p = this.objectPath(hash)
    return fs.existsSync(p) ? fs.readFileSync(p) : undefined
  }

  size(hash: string): number | undefined {
    if (!OBJECT_HASH.test(hash)) return undefined
    const p = this.objectPath(hash)
    return fs.existsSync(p) ? fs.statSync(p).size : undefined
  }

  verify(hash: string): { integrity: Integrity; content?: Buffer } {
    const content = this.read(hash)
    if (!content) return { integrity: { status: 'unavailable' } }
    const actual = sha256(content)
    return actual === hash ? { integrity: { status: 'verified' }, content } : { integrity: { status: 'failed', actual_hash: actual } }
  }
}
