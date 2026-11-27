import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cli, copyFixture, indexedDataDir, tmpDir, tool } from './helpers.js'

const poll = async (d: string, id: string) => {
  for (let i = 0; i < 240; i++) {
    const job = (tool(d, 'get_job', { job_id: id }).data as any).job
    if (job.state !== 'queued' && job.state !== 'running') return job
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('job did not finish')
}

describe('request_index and get_job: background indexing with progress', () => {
  it('runs an index job to the published snapshot, and returns the open job instead of starting a second', async () => {
    const d = tmpDir(), repo = copyFixture()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    fs.appendFileSync(`${repo}/packages/format/src/currency.ts`, '\nexport const ZERO = 0\n')
    const first = tool(d, 'request_index', {}).data as any
    const second = tool(d, 'request_index', {}) as any
    expect(first.started).toBe(true)
    expect(second.data.job.id).toBe(first.job.id)
    expect(second.limitations).toContain('An index job for this repository is already queued or running; its ID is returned instead of a second job.')
    const done = await poll(d, first.job.id)
    expect(done).toMatchObject({ state: 'succeeded', phase: 'done', error: null })
    expect(done.result.status).toBe('published')
    expect(done.result.snapshot_id).toBe((tool(d, 'workspace_status', { limits: { max_rows: 1 } }) as any).snapshot.id)
    // #36: the plan said it was incremental and how much it re-analysed; the finished job keeps real counts and its timing.
    // The TypeScript adapter analyses the program as one unit, so an edit re-analyses all six files: a full run, and the plan says so.
    // The build adapter (FR129) also reads the unchanged package.json, whose cached file result is replayed.
    expect(done.plan).toEqual({ build: { mode: 'incremental', analyse: 0, reuse: 1, budget_mb: expect.any(Number), budget_source: 'machine' }, typescript: { mode: 'full', analyse: 6, reuse: 0, budget_mb: expect.any(Number), budget_source: 'machine' } })
    expect(done.result.reuse).toEqual({ reused: 1, analysed: 6 })
    expect({ done: done.done, total: done.total }).toEqual({ done: done.result.counts.indexed, total: done.result.counts.indexed })
    expect(done.progress_at).toEqual(expect.any(String))
    expect(done.elapsed_ms).toBeGreaterThanOrEqual(0)
  }, 240000)

  it('#36 a job over two independent C# projects plans an incremental run after an edit to one', async () => {
    const path = await import('node:path')
    const { ROOT } = await import('./helpers.js')
    const d = tmpDir(), repo = tmpDir('pm-repo-')
    fs.cpSync(path.join(ROOT, 'fixtures', 'cs-inherited', 'repo'), repo, { recursive: true })
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    fs.appendFileSync(path.join(repo, 'src', 'Tools', 'Cli.cs'), '\n// edited\n')
    const job = await poll(d, (tool(d, 'request_index', {}).data as any).job.id)
    // The state and error first, so a job that did not succeed says how it ended (#130).
    expect({ state: job.state, error: job.error }).toEqual({ state: 'succeeded', error: null })
    expect(job.plan).toEqual({ csharp: { mode: 'incremental', analyse: 1, reuse: 1, budget_mb: expect.any(Number), budget_source: 'machine' } })
    expect(job.result.reuse).toEqual({ reused: 1, analysed: 1 })
  }, 240000)

  it('an unknown job is not found', async () => {
    const { dataDir } = await indexedDataDir()
    expect(() => tool(dataDir, 'get_job', { job_id: 'job_missing' })).toThrow('no index job job_missing for this repository')
  })
})

describe('a finished index job is never read as interrupted (#130)', () => {
  it('FR740 the index records its outcome while it holds the lease, and get_job reads a running row again once the lease is free', async () => {
    const { Catalog, initDataDir, LEASE_OWNER } = await import('../src/meshstore/catalog.js')
    const { indexRepository } = await import('../src/indexer/coordinator.js')
    const d = tmpDir()
    initDataDir(d)
    const catalog = Catalog.open(d)
    const repo = catalog.addRepository(copyFixture())
    // Who held the lease when each outcome was handed over: this process, both for a published index and for one that failed after taking it.
    const seen: Array<[string, string | undefined]> = []
    const onSettled = (o: { result: unknown } | { error: unknown }) => { seen.push(['result' in o ? 'result' : 'error', catalog.leaseHolder(repo.id)?.owner]) }
    await indexRepository(d, repo.id, undefined, undefined, undefined, false, { onSettled })
    await expect(indexRepository(d, repo.id, undefined, undefined, 'no-such-commit', true, { onSettled })).rejects.toThrow()
    expect(seen).toEqual([['result', LEASE_OWNER], ['error', LEASE_OWNER]])
    expect(catalog.leaseHolder(repo.id)).toBeUndefined()
    // The index settles its row and frees the lease between get_job's read of the row and its look at the lease: the job reads succeeded.
    const job = catalog.createJob(repo.id, 'test')
    catalog.updateJob(job, { state: 'running', started_at: new Date().toISOString(), owner: LEASE_OWNER })
    const leaseHolder = catalog.leaseHolder.bind(catalog)
    catalog.leaseHolder = (id?: string) => { catalog.updateJob(job, { state: 'succeeded', finished_at: new Date().toISOString() }); return leaseHolder(id) }
    expect(catalog.job(job)!.state).toBe('succeeded')
    // A row still running once the lease is gone was interrupted.
    catalog.leaseHolder = leaseHolder
    catalog.updateJob(job, { state: 'running' })
    expect(catalog.job(job)!.state).toBe('interrupted')
    catalog.close()
  })
})

describe('the index lock of a process that died is free at once', () => {
  it('a dead holder on this host blocks nothing and its job reads interrupted; a live holder still blocks', async () => {
    const { spawnSync } = await import('node:child_process')
    const os = await import('node:os')
    const path = await import('node:path')
    const { Catalog, initDataDir } = await import('../src/meshstore/catalog.js')
    const { acquireIndexLock, lockFile } = await import('../src/meshstore/index-lock.js')
    const d = tmpDir()
    initDataDir(d)
    const catalog = Catalog.open(d)
    const repo = catalog.addRepository(tmpDir())
    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    const deadOwner = `pid:${dead}@${os.hostname()}`
    fs.mkdirSync(path.join(d, 'locks'))
    fs.writeFileSync(lockFile(d, repo.id), JSON.stringify({ pid: dead, host: os.hostname(), started_at: new Date().toISOString() }))
    const job = catalog.requestJob(repo.id, 'test')
    catalog.updateJob(job.id, { state: 'running', started_at: new Date().toISOString(), owner: deadOwner })
    expect(catalog.job(job.id)!.state).toBe('interrupted')
    const held = await acquireIndexLock(d, repo.id, 'repo', { wait: false })
    expect(catalog.leaseHolder(repo.id)!.owner).toBe(`pid:${process.pid}@${os.hostname()}`)
    await expect(acquireIndexLock(d, repo.id, 'repo', { wait: false })).rejects.toThrow('already being indexed')
    held.release()
    expect(catalog.leaseHolder(repo.id)).toBeUndefined()
    catalog.close()
  })
})
