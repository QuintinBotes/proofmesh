import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../core/hash.js'

export type Integrity = { status: 'verified' } | { status: 'failed'; actual_hash: string } | { status: 'unavailable' }

/** Content-addressed evidence objects. An object is stored and verified before anything may reference it. */
export class EvidenceStore {
  constructor(private readonly dataDir: string) {}

  objectPath(hash: string): string {
    return path.join(this.dataDir, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash)
  }

  put(content: Uint8Array): string {
    const hash = sha256(content)
    const target = this.objectPath(hash)
    if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === hash) return hash
    const tmpDir = path.join(this.dataDir, 'objects', 'tmp')
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = path.join(tmpDir, `${hash}.${process.pid}.${Date.now()}`)
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeSync(fd, content)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (sha256(fs.readFileSync(tmp)) !== hash) throw new Error(`object ${hash} failed verification after write`)
    fs.chmodSync(tmp, 0o444)
    fs.renameSync(tmp, target)
    return hash
  }

  read(hash: string): Buffer | undefined {
    const p = this.objectPath(hash)
    return fs.existsSync(p) ? fs.readFileSync(p) : undefined
  }

  size(hash: string): number | undefined {
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
