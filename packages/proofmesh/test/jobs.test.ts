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

describe('FR740 a finished index job is never read as interrupted (#130)', () => {
  it('the index records its outcome while it holds the lease, and get_job reads a running row again once the lease is free', async () => {
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

describe('FR840 an index whose host dies by a signal or a non-zero exit is failed with a reason (#158)', () => {
  it('FR840 scenario 1: SIGKILL of the index host mid-index fails the job with an error naming the signal, not interrupted with none', async () => {
    const { spawn } = await import('node:child_process')
    const path = await import('node:path')
    const { CLI } = await import('./helpers.js')
    const { Catalog } = await import('../src/meshstore/catalog.js')
    const repo = tmpDir('pm-killed-')
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(repo, `f${i}.ts`), `export const x${i} = ${i}\n`)
    const d = tmpDir()
    cli(['--data-dir', d, 'init']); cli(['--data-dir', d, 'repo', 'add', repo])
    // 600 ms a file, one file a batch: the index runs long enough to be killed partway.
    const env = { ...process.env, PROOFMESH_TS_ADAPTER: path.join(import.meta.dirname, 'fake-adapters', 'slow.mjs'), PROOFMESH_INDEX_BATCH: '1' }
    const outer = spawn(process.execPath, [CLI, '--data-dir', d, 'index', repo], { env, stdio: 'ignore' })
    const exited = new Promise<number | null>((r) => outer.on('close', (code) => r(code)))
    const c = Catalog.open(d)
    const row = () => c.db.prepare('select id, state, owner, error from index_job').get() as { id: string; state: string; owner: string | null; error: string | null } | undefined
    for (let i = 0; i < 300 && row()?.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 50))
    // The row's owner is the host that holds the lease: the inner process, not the outer one this test started.
    const host = Number(/^pid:(\d+)@/.exec(row()!.owner!)![1])
    expect(host).not.toBe(outer.pid)
    process.kill(host, 'SIGKILL')
    expect(await exited).toBe(137)
    const job = c.job(row()!.id)!
    c.close()
    expect(job.state).toBe('failed')
    expect(job.error).toMatch(/SIGKILL/)
  }, 60000)
})

describe('FR870 status names the last index job that failed, and why (#167)', () => {
  const KILLED = "the index host was killed by SIGKILL before it recorded the job's outcome"
  const failJob = async (d: string, repoId: string) => {
    const { Catalog } = await import('../src/meshstore/catalog.js')
    const c = Catalog.open(d)
    const id = c.createJob(repoId, 'test')
    c.updateJob(id, { state: 'failed', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), error: KILLED })
    c.close()
    return id
  }

  it('FR870 FR872: with no snapshot and a failed last job, status --json (its refusal as JSON on stdout) and every tool refuse naming the job and its error; with no job at all, run "proofmesh index" first', async () => {
    const repo = tmpDir('pm-failed-')
    fs.writeFileSync(`${repo}/a.ts`, 'export const a = 1\n')
    const d = tmpDir()
    cli(['--data-dir', d, 'init'])
    const repoId = cli(['--data-dir', d, 'repo', 'add', repo]).stdout.trim()
    const never = cli(['--data-dir', d, 'status', repoId, '--json'])
    expect(never.status).toBe(1)
    expect(never.stderr).toContain('SNAPSHOT_UNAVAILABLE: no published snapshot for this repository; run "proofmesh index" first')
    const job = await failJob(d, repoId)
    const r = cli(['--data-dir', d, 'status', repoId, '--json'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`SNAPSHOT_UNAVAILABLE: no published snapshot for this repository; last index job ${job} failed at `)
    expect(r.stderr).toContain(KILLED)
    expect(r.stderr).not.toContain('first')
    const err = JSON.parse(r.stdout).error
    expect(err.code).toBe('SNAPSHOT_UNAVAILABLE')
    expect(err.details).toMatchObject({ job_id: job, job_state: 'failed', job_error: KILLED })
    // The plain text status, the --fresh check the plugin reads and any snapshot tool say the same.
    expect(cli(['--data-dir', d, 'status', repoId]).stderr).toContain(`last index job ${job} failed at `)
    const fresh = cli(['--data-dir', d, 'status', repoId, '--fresh', '--json'])
    expect(fresh.stderr).toContain(KILLED)
    expect(JSON.parse(fresh.stdout).error.details).toMatchObject({ job_id: job, job_state: 'failed', job_error: KILLED })
    expect(() => tool(d, 'find_symbols', { repository_id: repoId, text: 'a' })).toThrow(KILLED)
    // A command with its own refusal, tests --json, prints the error JSON too.
    expect(JSON.parse(cli(['--data-dir', d, 'tests', repoId, 'a.ts', '--json']).stdout).error.details).toMatchObject({ job_id: job, job_error: KILLED })
    const { Catalog } = await import('../src/meshstore/catalog.js')
    const c = Catalog.open(d)
    // An open job is named before a failed one, by status --fresh as by the tools.
    const open = c.createJob(repoId, 'test')
    expect(cli(['--data-dir', d, 'status', repoId, '--fresh']).stderr).toContain(`index job ${open} is queued; poll it with get_job`)
    // A job whose process stopped before it recorded anything reads interrupted, with that as its reason.
    c.updateJob(open, { state: 'running', started_at: new Date().toISOString(), progress_at: new Date().toISOString(), owner: 'pid:1@nowhere' })
    expect(cli(['--data-dir', d, 'status', repoId]).stderr).toContain(`last index job ${open} interrupted: its process stopped before it recorded an outcome; run "proofmesh index" again`)
    c.close()
  }, 30000)

  it('FR871: a snapshot older than a failed last job still answers, with the failure named in status, its --fresh check and the workspace_status limitations', async () => {
    const { dataDir: d, repoId, snapshotId } = await indexedDataDir(copyFixture())
    expect(tool(d, 'workspace_status').limitations.join('\n')).not.toContain('last index job')
    expect(JSON.parse(cli(['--data-dir', d, 'status', repoId, '--fresh', '--json']).stdout).failed_job).toBeNull()
    const job = await failJob(d, repoId)
    const env = tool(d, 'workspace_status')
    expect(env.snapshot!.id).toBe(snapshotId)
    expect(env.limitations).toContainEqual(expect.stringMatching(new RegExp(`^Warning: last index job ${job} failed at \\S+: ${KILLED}; this answer is from snapshot ${snapshotId}, which an earlier index published\\.$`)))
    const text = cli(['--data-dir', d, 'status', repoId])
    expect(text.status).toBe(0)
    expect(text.stdout).toMatch(new RegExp(`^last index job ${job} failed at \\S+: ${KILLED}$`, 'm'))
    expect(JSON.parse(cli(['--data-dir', d, 'status', repoId, '--json']).stdout).limitations.join('\n')).toContain(`last index job ${job} failed at `)
    expect(JSON.parse(cli(['--data-dir', d, 'status', repoId, '--fresh', '--json']).stdout).failed_job).toMatchObject({ id: job, state: 'failed', error: KILLED })
    // An index that succeeds afterwards is the last job, and the warning goes.
    expect(cli(['--data-dir', d, 'index', repoId]).status).toBe(0)
    expect(tool(d, 'workspace_status').limitations.join('\n')).not.toContain('last index job')
    expect(cli(['--data-dir', d, 'status', repoId]).stdout).not.toContain('last index job')
    // An index --no-wait refused while that index ran was requested after it but ended before it: it is not the last job.
    const { Catalog } = await import('../src/meshstore/catalog.js')
    const c = Catalog.open(d)
    const refused = c.createJob(repoId, 'test')
    c.updateJob(refused, { state: 'failed', finished_at: '2000-01-01T00:00:00.000Z', error: 'already being indexed' })
    c.close()
    expect(tool(d, 'workspace_status').limitations.join('\n')).not.toContain('last index job')
  }, 60000)
})
