import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { cli, tmpDir, tool, withSnapshot } from './helpers.js'

const FILES = 6
/** A repository of `.fake` files indexed one per batch by an adapter that dies during the analyze call after the first `limit`. */
function setup(limit?: number) {
  const d = tmpDir(), repo = tmpDir('pm-rs-'), adapter = tmpDir('pm-rsa-')
  for (let i = 0; i < FILES; i++) fs.writeFileSync(path.join(repo, `f${i}.fake`), `file ${i}\n`)
  const script = path.join(adapter, 'dies-after.mjs')
  fs.copyFileSync(path.join(import.meta.dirname, 'fake-adapters', 'dies-after.mjs'), script)
  const limitTo = (n?: number) => (n === undefined ? fs.rmSync(path.join(adapter, 'limit'), { force: true }) : fs.writeFileSync(path.join(adapter, 'limit'), String(n)))
  limitTo(limit)
  for (const args of [['init'], ['repo', 'add', repo], ['adapter', 'add', script, '--id', 'dying', '--extension', '.fake=dying']]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  const index = (...flags: string[]) => cli(['--data-dir', d, 'index', repo, ...flags], { PROOFMESH_INDEX_BATCH: '1' })
  const calls = () => (fs.existsSync(path.join(adapter, 'calls.log')) ? fs.readFileSync(path.join(adapter, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]).flat() : [])
  const reset = () => fs.rmSync(path.join(adapter, 'calls.log'), { force: true })
  return { d, repo, limitTo, index, calls, reset }
}
const facts = (d: string) => (new Database(path.join(d, 'cache', 'facts.db'), { readonly: true }).prepare('select count(*) as n from fact').get() as { n: number }).n
const current = (d: string) => { const c = Catalog.open(d); try { return c.currentSnapshot(c.repositories()[0]!.id) } finally { c.close() } }
/** What a snapshot says of its files and symbols, without the ids that depend on the data directory. */
const content = (d: string) => withSnapshot(d, (db) => JSON.stringify([db.prepare('select path, disposition, disposition_detail, capabilities from file order by path').all(), db.prepare('select qualified_name, kind from symbol order by qualified_name').all()]))

describe('FR335 to FR339 the facts of finished batches survive a failed index, and the next index resumes from them', () => {
  it('FR335: the facts of every batch that finished are in the fact cache when the index fails', () => {
    const s = setup(3)
    expect(s.index().status).toBe(1)
    expect(facts(s.d)).toBe(3)
  })

  it('FR336: an identical rerun re-analyses only the files that did not finish, and seals what a clean index seals', () => {
    const clean = setup()
    expect(clean.index().status).toBe(0)
    const s = setup(3)
    expect(s.index().status).toBe(1)
    s.reset(); s.limitTo(undefined)
    const rerun = s.index()
    expect(rerun.status).toBe(0)
    expect(s.calls()).toHaveLength(FILES - 3)
    expect(rerun.stdout).toMatch(/resumed from checkpoint: 3 of 6 batches/)
    expect(content(s.d)).toBe(content(clean.d))
  })

  it('FR337: after a file is edited, the rerun replays the finished files that did not change from the cache and analyses the edited one and the unfinished ones', () => {
    const s = setup(3)
    expect(s.index().status).toBe(1)
    fs.writeFileSync(path.join(s.repo, 'f0.fake'), 'edited\n')
    s.reset(); s.limitTo(undefined)
    const rerun = s.index()
    expect(rerun.status).toBe(0)
    expect(s.calls().sort()).toEqual(['f0.fake', 'f3.fake', 'f4.fake', 'f5.fake'])
    expect(rerun.stdout).toContain('reused the facts of 2 of 6 files')
  })

  it('FR338: a failure says that the finished batches are kept and that indexing again resumes them', () => {
    const s = setup(3)
    const failed = s.index()
    expect(failed.status).toBe(1)
    expect(failed.stderr).toMatch(/3 of 6 batches? (are|were) kept/)
    expect(failed.stderr).toContain('index again to resume')
  })

  it('FR339: a failed index leaves the previous snapshot current and reports the batches its checkpoint holds, finished adapters and cached ones included', () => {
    const s = setup()
    expect(s.index().status).toBe(0)
    const before = current(s.d)
    fs.writeFileSync(path.join(s.repo, 'f1.fake'), 'edited\n')
    fs.writeFileSync(path.join(s.repo, 'f4.fake'), 'edited\n')
    s.reset(); s.limitTo(1)
    const failed = s.index()
    expect(failed.status).toBe(1)
    expect(current(s.d)).toEqual(before)
    expect(failed.stderr).toContain('4 of 6 batches were kept')
  })
})

describe('FR340 to FR346 index --allow-partial publishes what was analysed and says what is missing', () => {
  it('FR340: without the flag a failing adapter still fails the index and publishes nothing', () => {
    const s = setup(3)
    expect(s.index().status).toBe(1)
    expect(current(s.d) ?? null).toBeNull()
  })

  it('FR341: with the flag the index publishes; the files the adapter did not reach are failed with the reason, the others are indexed', () => {
    const s = setup(3)
    const r = s.index('--allow-partial')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/partial snapshot: adapter dying failed, 3 of 6 files are missing/)
    withSnapshot(s.d, (db) => {
      const rows = db.prepare("select path, disposition, disposition_detail as detail from file where path like '%.fake' order by path").all() as Array<{ path: string; disposition: string; detail: string | null }>
      expect(rows.filter((x) => x.disposition === 'indexed').map((x) => x.path)).toEqual(['f0.fake', 'f1.fake', 'f2.fake'])
      expect(rows.filter((x) => x.disposition === 'failed').map((x) => [x.path, x.detail])).toEqual(['f3.fake', 'f4.fake', 'f5.fake'].map((p) => [p, 'adapter_died']))
    })
  })

  it('FR342: the snapshot records which adapter failed, why without its stderr, and which files are missing', () => {
    const s = setup(3)
    expect(s.index('--allow-partial').status).toBe(0)
    withSnapshot(s.d, (db) => {
      const partial = JSON.parse((db.prepare("select value from meta where key = 'partial'").get() as { value: string }).value)
      expect(partial.adapters).toEqual(['dying'])
      expect(partial.missing).toBe(3)
      expect(partial.paths).toEqual(['f3.fake', 'f4.fake', 'f5.fake'])
      expect(partial.reason).toContain('exited with code 3')
    })
  })

  it('FR343: every query answer from a partial snapshot says it is partial, also in the compact envelope; a complete snapshot says nothing', () => {
    const s = setup(3)
    expect(s.index('--allow-partial').status).toBe(0)
    for (const envelope of [undefined, 'compact']) {
      const env = tool(s.d, 'workspace_status', envelope ? { envelope } : {})
      expect(env.limitations.join('\n')).toMatch(/partial: adapter dying failed, 3 of 6 files are missing/)
    }
    const whole = setup()
    expect(whole.index().status).toBe(0)
    expect(tool(whole.d, 'workspace_status', {}).limitations.join('\n')).not.toMatch(/partial/)
  })

  it('FR344: the job result says the snapshot is partial and names the adapter and the missing count', () => {
    const s = setup(3)
    expect(s.index('--allow-partial').status).toBe(0)
    const c = Catalog.open(s.d)
    try {
      const job = JSON.parse((c.db.prepare("select result from index_job where state = 'succeeded'").get() as { result: string }).result)
      expect(job.partial).toEqual({ adapters: ['dying'], missing: 3, files: 6 })
    } finally { c.close() }
  })

  it('FR345: indexing again after a partial snapshot asks the adapter again, replays the finished files from the cache and publishes a complete snapshot', () => {
    const s = setup(3)
    expect(s.index('--allow-partial').status).toBe(0)
    const partialId = current(s.d)!.id
    s.reset(); s.limitTo(undefined)
    const r = s.index('--allow-partial')
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('partial snapshot')
    expect(current(s.d)!.id).not.toBe(partialId)
    expect(s.calls().sort()).toEqual(['f3.fake', 'f4.fake', 'f5.fake'])
    withSnapshot(s.d, (db) => expect((db.prepare("select count(*) as n from file where disposition = 'failed'").get() as { n: number }).n).toBe(0))
  })

  it('FR346: the facts of the files the adapter died on are not cached, so a rerun does not replay a failure', () => {
    const s = setup(3)
    expect(s.index('--allow-partial').status).toBe(0)
    expect(facts(s.d)).toBe(3)
  })
})
