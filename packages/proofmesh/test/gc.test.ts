import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { sealedPath } from '../src/meshstore/snapshot.js'
import { cli, copyFixture, indexedDataDir, tool } from './helpers.js'

const published = (d: string) => { const c = Catalog.open(d); try { return c.publishedSnapshots(c.repositories()[0]!.id).map((s) => s.id) } finally { c.close() } }
const index = (d: string, repo: string) => { const r = cli(['--data-dir', d, 'index', repo]); expect(r.status, r.stderr).toBe(0); return /snapshot (snap_\w+) published/.exec(r.stdout)![1]! }
const objects = (d: string) => { const root = path.join(d, 'objects', 'sha256'); return fs.readdirSync(root).flatMap((a) => fs.readdirSync(path.join(root, a)).flatMap((b) => fs.readdirSync(path.join(root, a, b)))) }

describe('FR051 retention retires old snapshots and unreferenced evidence, never current, pinned or linked ones', () => {
  it('keeps the newest N plus pinned and current, deletes only what nothing references, and a dry run changes nothing', async () => {
    const repo = copyFixture()
    const { dataDir } = await indexedDataDir(repo)
    const ids = [published(dataDir)[0]!]
    for (let i = 1; i <= 3; i++) { fs.appendFileSync(path.join(repo, 'packages/format/src/currency.ts'), `\n// edit ${i}\n`); ids.push(index(dataDir, repo)) }
    expect(new Set(ids).size).toBe(4)
    expect(cli(['--data-dir', dataDir, 'snapshot', 'pin', ids[0]!]).stdout).toMatch(/pinned/)
    const before = objects(dataDir).length
    const dry = cli(['--data-dir', dataDir, 'gc', '--keep', '1', '--dry-run'])
    expect(dry.stdout).toMatch(`would retire ${ids[1]}`)
    expect(dry.stdout).toMatch(`would retire ${ids[2]}`)
    expect(dry.stdout).not.toMatch(ids[0]!)
    expect(dry.stdout).not.toMatch(ids[3]!)
    expect(published(dataDir).length).toBe(4)
    expect(objects(dataDir).length).toBe(before)
    const gc = cli(['--data-dir', dataDir, 'gc', '--keep', '1'])
    expect(gc.status, gc.stderr).toBe(0)
    expect(published(dataDir).sort()).toEqual([ids[0], ids[3]].sort())
    expect(fs.existsSync(sealedPath(dataDir, ids[1]!))).toBe(false)
    expect(fs.existsSync(sealedPath(dataDir, ids[0]!))).toBe(true)
    // The three edited versions of currency.ts were referenced only by the retired snapshots; the pinned one's objects stay.
    expect(objects(dataDir).length).toBe(before - 2)
    expect(tool(dataDir, 'find_symbols', { text: 'invoiceTotal', snapshot_id: ids[0] }).snapshot!.id).toBe(ids[0])
    expect(tool(dataDir, 'find_symbols', { text: 'invoiceTotal' }).snapshot!.id).toBe(ids[3])
    const c = Catalog.open(dataDir)
    try {
      expect(c.snapshot(ids[1]!)!.state).toBe('retired')
      expect(() => c.retire(ids[3]!)).toThrow(/current/)
      expect(() => c.retire(ids[0]!)).toThrow(/pinned/)
      c.addToWorkspace('w', [c.repositories()[0]!.id], 't')
      c.recordLinkFile({ id: 'link_test', workspace: 'w', digest: 'd', members: [{ repository_id: c.repositories()[0]!.id, snapshot_id: ids[0]! }] })
      expect(() => c.retire(ids[0]!)).toThrow(/link file member/)
    } finally { c.close() }
  }, 240000)

  it('refuses to run while an index lease is live', async () => {
    const { dataDir } = await indexedDataDir()
    fs.mkdirSync(path.join(dataDir, 'locks'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'locks', 'index-repo_x.lock'), JSON.stringify({ pid: 1, host: 'elsewhere', started_at: new Date().toISOString() }))
    const r = cli(['--data-dir', dataDir, 'gc'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/holds an index lock/)
  })
})
