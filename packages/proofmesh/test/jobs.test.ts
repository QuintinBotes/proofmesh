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
    expect(done.plan).toEqual({ typescript: { mode: 'full', analyse: 6, reuse: 0 } })
    expect(done.result.reuse).toEqual({ reused: 0, analysed: 6 })
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
    expect(job.plan).toEqual({ csharp: { mode: 'incremental', analyse: 1, reuse: 1 } })
    expect(job.result.reuse).toEqual({ reused: 1, analysed: 1 })
  }, 240000)

  it('an unknown job is not found', async () => {
    const { dataDir } = await indexedDataDir()
    expect(() => tool(dataDir, 'get_job', { job_id: 'job_missing' })).toThrow('no index job job_missing for this repository')
  })
})

describe('the index lease of a process that died is free at once', () => {
  it('a dead holder on this host blocks nothing and its job reads interrupted; a live holder still blocks', async () => {
    const { spawnSync } = await import('node:child_process')
    const os = await import('node:os')
    const { Catalog, initDataDir } = await import('../src/meshstore/catalog.js')
    const d = tmpDir()
    initDataDir(d)
    const catalog = Catalog.open(d)
    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    const deadOwner = `pid:${dead}@${os.hostname()}`
    catalog.acquireLease(deadOwner)
    const repo = catalog.addRepository(tmpDir())
    const job = catalog.requestJob(repo.id, 'test')
    catalog.updateJob(job.id, { state: 'running', started_at: new Date().toISOString(), owner: deadOwner })
    expect(catalog.job(job.id)!.state).toBe('interrupted')
    expect(() => catalog.acquireLease('pid:1@elsewhere')).not.toThrow()
    catalog.releaseLease('pid:1@elsewhere')
    catalog.acquireLease(`pid:${process.pid}@${os.hostname()}`)
    expect(() => catalog.acquireLease('pid:2@elsewhere')).toThrow(`another index job (pid:${process.pid}@${os.hostname()}) holds the lease`)
  })
})
