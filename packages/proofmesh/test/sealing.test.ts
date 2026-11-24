import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { sha256File } from '../src/core/hash.js'
import { cli, copyFixture, FIXTURE, indexedDataDir, tmpDir } from './helpers.js'

const current = (dataDir: string) => {
  const c = Catalog.open(dataDir)
  try {
    const repo = c.repositories()[0]!
    return c.currentSnapshot(repo.id)
  } finally {
    c.close()
  }
}

describe('sealing and publication', () => {
  it('AC08 the sealed file is read only, matches its digest, and is current', async () => {
    const { dataDir, snapshotId } = await indexedDataDir()
    const file = path.join(dataDir, 'snapshots', `${snapshotId}.db`)
    expect(fs.statSync(file).mode & 0o777).toBe(0o444)
    const snap = current(dataDir)!
    expect(snap.id).toBe(snapshotId)
    expect(snap.state).toBe('published')
    expect(sha256File(file)).toBe(snap.store_digest)
  })

  for (const point of ['before_rename', 'after_rename']) {
    it(`AC09 FR011 SC008 a crash ${point.replace('_', ' ')} keeps the previous snapshot current and queryable`, () => {
      const repo = copyFixture()
      const d = tmpDir()
      cli(['--data-dir', d, 'init'])
      cli(['--data-dir', d, 'repo', 'add', repo])
      expect(cli(['--data-dir', d, 'index', repo]).status).toBe(0)
      const before = current(d)!.id
      fs.appendFileSync(path.join(repo, 'packages/format/src/currency.ts'), '\nexport function extra(): number {\n  return 1;\n}\n')
      const crashed = cli(['--data-dir', d, 'index', repo], { PROOFMESH_FAULT_POINT: point })
      expect(crashed.status).toBe(70)
      expect(current(d)!.id).toBe(before)
      const status = cli(['--data-dir', d, 'status', '--json'])
      expect(status.status).toBe(0)
      expect(JSON.parse(status.stdout).snapshot.id).toBe(before)
    })
  }

  it('AC10 a modified sealed file is refused with digest_mismatch by the next process', async () => {
    const { dataDir, snapshotId } = await indexedDataDir()
    const file = path.join(dataDir, 'snapshots', `${snapshotId}.db`)
    fs.chmodSync(file, 0o644)
    const fd = fs.openSync(file, 'r+')
    const b = Buffer.alloc(1)
    fs.readSync(fd, b, 0, 1, 200)
    b[0] = b[0]! ^ 0xff
    fs.writeSync(fd, b, 0, 1, 200)
    fs.closeSync(fd)
    const r = cli(['--data-dir', dataDir, 'status', '--json'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('SNAPSHOT_UNAVAILABLE')
    expect(r.stderr).toContain('does not match its recorded digest')
  })

  it('AC11 re-indexing unchanged inputs reuses the published snapshot and writes no file', () => {
    const d = tmpDir()
    cli(['--data-dir', d, 'init'])
    cli(['--data-dir', d, 'repo', 'add', FIXTURE])
    const first = cli(['--data-dir', d, 'index', FIXTURE]).stdout
    const files = fs.readdirSync(path.join(d, 'snapshots'))
    const second = cli(['--data-dir', d, 'index', FIXTURE])
    expect(second.stdout).toContain(`${first.match(/snap_[0-9a-f]+/)![0]} unchanged`)
    expect(fs.readdirSync(path.join(d, 'snapshots'))).toEqual(files)
  })
})
