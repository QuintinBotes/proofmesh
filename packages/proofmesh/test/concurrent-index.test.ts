import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { busyTimeoutMs } from '../src/core/busy.js'
import { acquireIndexLock, lockFile, takeGcLock } from '../src/meshstore/index-lock.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { FactCache } from '../src/indexer/fact-cache.js'
import { CLI, cli, copyFixture, tmpDir, tool } from './helpers.js'
import { writeLinkFile } from './helpers-links.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const GATED = path.join(import.meta.dirname, 'fake-adapters', 'gated.mjs')

type Run = { child: ChildProcess; out: { stdout: string; stderr: string }; exited: Promise<number | null> }

/** A copy of the gated adapter in its own directory: the run it serves analyses once a file named `open` appears there. */
function gate() {
  const dir = tmpDir('pm-gated-'), entry = path.join(dir, 'gated.mjs')
  fs.copyFileSync(GATED, entry)
  return { entry, open: () => fs.writeFileSync(path.join(dir, 'open'), '') }
}

function startIndex(d: string, repo: string, adapter: string, extra: string[] = [], env: Record<string, string> = {}): Run {
  const child = spawn(process.execPath, [CLI, '--data-dir', d, 'index', repo, ...extra], { env: { ...process.env, PROOFMESH_TS_ADAPTER: adapter, ...env } })
  const out = { stdout: '', stderr: '' }
  child.stdout.on('data', (b) => (out.stdout += b))
  child.stderr.on('data', (b) => (out.stderr += b))
  return { child, out, exited: new Promise<number | null>((resolve) => child.on('exit', resolve)) }
}

/** Waits for a condition the runs themselves make true, and stops at once if one of them has already ended. */
async function until(what: string, found: () => boolean, ...runs: Run[]): Promise<void> {
  let ended = false
  for (const r of runs) void r.exited.then(() => { ended = true })
  for (let i = 0; i < 1200 && !ended; i++) { if (found()) return; await sleep(50) }
  if (found()) return
  throw new Error(`${what} never happened${ended ? '; a run ended first:\n' + runs.map((r) => r.out.stderr).join('\n---\n') : ''}`)
}

const analysing = (d: string, repoId: string) => () => {
  const c = Catalog.open(d)
  try { return c.openJobs(repoId).some((j) => j.phase?.startsWith('analyze')) } finally { c.close() }
}

function setup(repos = 1) {
  const d = tmpDir()
  initDataDir(d)
  const roots = Array.from({ length: repos }, () => copyFixture())
  const c = Catalog.open(d)
  const ids = roots.map((r, i) => c.addRepository(r, `repo${i}`).id)
  c.close()
  return { d, roots, ids }
}

const jobsOf = (d: string, repoId: string) => {
  const c = Catalog.open(d)
  try { return (c.db.prepare("select state, result from index_job where repository_id = ? order by requested_at, id").all(repoId) as Array<{ state: string; result: string | null }>).map((j) => ({ state: j.state, status: j.result ? (JSON.parse(j.result) as { status: string }).status : null })) } finally { c.close() }
}
const published = (d: string, repoId: string) => {
  const c = Catalog.open(d)
  try { return (c.db.prepare("select count(*) as n from snapshot where repository_id = ? and state = 'published'").get(repoId) as { n: number }).n } finally { c.close() }
}

describe('FR322 two repositories in one data directory index at once', () => {
  it('both publish, each query stays scoped to its repository, and the workspace sees both', async () => {
    const { d, roots, ids } = setup(2)
    const gates = [gate(), gate()]
    const runs = roots.map((r, i) => startIndex(d, r, gates[i]!.entry))
    await until('both indexes analysing at once', () => ids.every((id) => analysing(d, id)()), ...runs)
    gates.forEach((g) => g.open())
    for (const r of runs) expect(await r.exited, r.out.stderr).toBe(0)
    const snaps = ids.map((id) => (tool(d, 'workspace_status', { repository_id: id }) as any).snapshot)
    expect(snaps.map((s) => s.repository_id)).toEqual(ids)
    expect(new Set(snaps.map((s) => s.id)).size).toBe(2)
    ids.forEach((id) => expect(published(d, id)).toBe(1))
    const c = Catalog.open(d)
    c.addToWorkspace('both', ids, 'test')
    c.close()
    // The gated adapter reports no symbols, so the link ends are ids the link file takes as written.
    const members = ids.map((id, i) => ({ repository_id: id, snapshot_id: snaps[i].id, name: `repo${i}` }))
    writeLinkFile(d, 'both', members, [{ type: 'calls_endpoint', rule: 'http_route', source: [ids[0]!, 'sym_a'], target: [ids[1]!, 'sym_b'], confidence: 1, resolution: 'resolved' }])
    const eco = tool(d, 'get_ecosystem', { workspace: 'both' }).data as { members: Array<{ repository_id: string; current: boolean }> }
    expect(eco.members.map((m) => [m.repository_id, m.current]).sort()).toEqual(ids.map((id) => [id, true]).sort())
  }, 240000)
})

describe('FR323 FR324 one index of a repository at a time', () => {
  it('a second index of the same repository waits, then reports the first one\'s snapshot unchanged, and exactly one job publishes', async () => {
    const { d, roots, ids } = setup()
    const g = gate()
    const first = startIndex(d, roots[0]!, g.entry)
    await until('the first index analysing', analysing(d, ids[0]!), first)
    const second = startIndex(d, roots[0]!, g.entry)
    await until('the second index waiting', () => second.out.stderr.includes('waiting for the index'), first, second)
    // The lock is held by the index host the CLI starts under its own heap, not by the process that was spawned.
    expect(second.out.stderr).toContain(`pid ${holderPid(d, ids[0]!)}`)
    g.open()
    for (const r of [first, second]) expect(await r.exited, r.out.stderr).toBe(0)
    expect(published(d, ids[0]!)).toBe(1)
    expect(jobsOf(d, ids[0]!).map((j) => j.status).sort()).toEqual(['published', 'unchanged'])
    expect(second.out.stdout).toMatch(/^snapshot snap_\w+ unchanged/m)
  }, 240000)

  it('--no-wait refuses with INDEX_IN_PROGRESS, naming the running index\'s pid and start time, and the first still publishes', async () => {
    const { d, roots, ids } = setup()
    const g = gate()
    const first = startIndex(d, roots[0]!, g.entry)
    await until('the first index analysing', analysing(d, ids[0]!), first)
    const lock = JSON.parse(fs.readFileSync(path.join(d, 'locks', `index-${ids[0]}.lock`), 'utf8')) as { pid: number; started_at: string }
    const second = cli(['--data-dir', d, 'index', roots[0]!, '--no-wait'])
    expect(second.status).toBe(1)
    expect(second.stderr).toContain('INDEX_IN_PROGRESS')
    expect(second.stderr).toContain(`pid ${lock.pid}`)
    expect(second.stderr).toContain(lock.started_at)
    g.open()
    expect(await first.exited, first.out.stderr).toBe(0)
    expect(published(d, ids[0]!)).toBe(1)
    expect(jobsOf(d, ids[0]!).map((j) => j.state).sort()).toEqual(['failed', 'succeeded'])
  }, 240000)
})

describe('FR325 a lock whose process is gone is taken over', () => {
  it('the next index says so, and publishes', () => {
    const { d, roots, ids } = setup()
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!
    fs.mkdirSync(path.join(d, 'locks'), { recursive: true })
    fs.writeFileSync(path.join(d, 'locks', `index-${ids[0]}.lock`), JSON.stringify({ pid: dead, host: os.hostname(), started_at: '2026-01-01T00:00:00.000Z' }))
    const r = cli(['--data-dir', d, 'index', roots[0]!, '--no-wait'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain(`took over the stale index lock of pid ${dead}`)
    expect(published(d, ids[0]!)).toBe(1)
    expect(fs.existsSync(path.join(d, 'locks', `index-${ids[0]}.lock`))).toBe(false)
  }, 240000)
})

/** Holds the write lock of a database from another process until `release` appears beside it. */
function holdWriteLock(db: string, release: string) {
  const script = `const D=require('better-sqlite3'),fs=require('fs');const db=new D(process.argv[1]);db.pragma('journal_mode = WAL');db.exec('begin immediate');console.log('held');const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);db.exec('rollback');db.close()}},20)`
  const child = spawn(process.execPath, ['-e', script, db, release], { cwd: import.meta.dirname })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return new Promise<{ exited: Promise<void> }>((resolve, reject) => { child.stdout.once('data', () => resolve({ exited })); void exited.then(() => reject(new Error('lock holder exited'))) })
}

describe('FR320 FR321 FR326 databases wait and retry on busy', () => {
  it('both databases use WAL and a busy timeout of a minute or more', () => {
    const d = tmpDir()
    initDataDir(d)
    const c = Catalog.open(d), f = new FactCache(d)
    try {
      expect(c.db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(c.db.pragma('busy_timeout', { simple: true })).toBeGreaterThanOrEqual(60000)
      expect((f as unknown as { db: Database.Database }).db.pragma('busy_timeout', { simple: true })).toBeGreaterThanOrEqual(60000)
    } finally { c.close(); f.close() }
  })

  it.each([['catalog.db', 'catalog', true], [path.join('cache', 'facts.db'), 'facts', true], [path.join('cache', 'facts.db'), 'facts first create table', false]])('a write contended beyond one busy wait retries and succeeds (%s, %s)', async (file, label, precreated) => {
    const { d, roots } = setup()
    fs.mkdirSync(path.join(d, 'cache'), { recursive: true })
    const g = gate(), release = path.join(tmpDir('pm-release-'), 'release')
    const index = () => startIndex(d, roots[0]!, g.entry, [], { PROOFMESH_BUSY_TIMEOUT_MS: '100', PROOFMESH_TEST_HARNESS: '1' })
    // The fact cache is first written when the index seals; hold its lock from before the run, and the catalog's too for the other case.
    if (precreated) new FactCache(d).close()
    g.open()
    const holder = await holdWriteLock(path.join(d, file), release)
    const run = index()
    try {
      await until(`a retry on the busy ${label} database`, () => run.out.stderr.includes('busy; retrying'), run)
    } finally {
      fs.writeFileSync(release, '')
    }
    expect(await run.exited, run.out.stderr).toBe(0)
    await holder.exited
    expect(run.out.stderr).not.toContain('SQLITE_BUSY')
  }, 240000)
})

describe('FR327 a reader keeps working while an index writes', () => {
  it('a query and the status command answer from the published snapshot during a later index', async () => {
    const { d, roots, ids } = setup()
    const g1 = gate()
    g1.open()
    expect(await startIndex(d, roots[0]!, g1.entry).exited).toBe(0)
    const before = (tool(d, 'workspace_status', {}) as any).snapshot.id
    fs.appendFileSync(path.join(roots[0]!, 'packages/format/src/currency.ts'), '\nexport const ZERO = 0\n')
    const g2 = gate()
    const run = startIndex(d, roots[0]!, g2.entry)
    await until('the index analysing', analysing(d, ids[0]!), run)
    for (let i = 0; i < 5; i++) expect((tool(d, 'workspace_status', {}) as any).snapshot.id).toBe(before)
    expect(cli(['--data-dir', d, 'status']).status).toBe(0)
    g2.open()
    expect(await run.exited, run.out.stderr).toBe(0)
    expect((tool(d, 'workspace_status', {}) as any).snapshot.id).not.toBe(before)
  }, 240000)
})

const lockPath = (d: string, id: string) => lockFile(d, id)
const holderPid = (d: string, id: string) => (JSON.parse(fs.readFileSync(path.join(d, 'locks', `index-${id}.lock`), 'utf8')) as { pid: number }).pid

describe('FR328 gc and an index exclude each other, and a wait can be cancelled', () => {
  it('an index admitted while gc runs waits for it (or with --no-wait is refused), and gc refuses while an index holds a lock', async () => {
    const { d, roots, ids } = setup()
    const g = gate()
    g.open()
    const gc = takeGcLock(d)
    const refused = cli(['--data-dir', d, 'index', roots[0]!, '--no-wait'])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('INDEX_IN_PROGRESS')
    expect(refused.stderr).toContain('a gc is running')
    expect(fs.existsSync(lockPath(d, ids[0]!))).toBe(false)
    const run = startIndex(d, roots[0]!, g.entry)
    await until('the index waiting for gc', () => run.out.stderr.includes('waiting for a gc'), run)
    expect(published(d, ids[0]!)).toBe(0)
    gc.release()
    expect(await run.exited, run.out.stderr).toBe(0)
    expect(published(d, ids[0]!)).toBe(1)
    const held = await acquireIndexLock(d, ids[0]!, 'repo', { wait: false })
    expect(cli(['--data-dir', d, 'gc', '--dry-run']).stderr).toContain('holds an index lock')
    held.release()
    expect(cli(['--data-dir', d, 'gc', '--dry-run']).status).toBe(0)
  }, 240000)

  it('aborting a queued wait ends it with CANCELLED, even once the lock frees', async () => {
    const { d, ids } = setup()
    const first = await acquireIndexLock(d, ids[0]!, 'repo', { wait: false })
    const abort = new AbortController()
    let waiting!: () => void
    const isWaiting = new Promise<void>((r) => (waiting = r))
    const second = acquireIndexLock(d, ids[0]!, 'repo', { signal: abort.signal, onNotice: (l) => l.startsWith('waiting') && waiting() }).then(() => 'acquired', (e) => e.code as string)
    await isWaiting
    abort.abort()
    first.release()
    expect(await second).toBe('CANCELLED')
  })
})

describe('FR329 lock robustness', () => {
  it('a lock whose pid is alive but belongs to another process (start time differs) is taken over', async () => {
    const { d, ids } = setup()
    fs.mkdirSync(path.join(d, 'locks'), { recursive: true })
    fs.writeFileSync(lockPath(d, ids[0]!), JSON.stringify({ pid: process.pid, host: os.hostname(), started_at: '2026-01-01T00:00:00.000Z', start: 'Thu Jan  1 00:00:00 1970' }))
    const notes: string[] = []
    const held = await acquireIndexLock(d, ids[0]!, 'repo', { wait: false, onNotice: (l) => notes.push(l) })
    expect(notes[0]).toContain(`took over the stale index lock of pid ${process.pid}`)
    held.release()
  })

  it('a lock with this process\'s own recorded start time stays live', async () => {
    const { d, ids } = setup()
    const first = await acquireIndexLock(d, ids[0]!, 'repo', { wait: false })
    const rec = JSON.parse(fs.readFileSync(lockPath(d, ids[0]!), 'utf8'))
    expect(rec.start).toEqual(expect.any(String))
    await expect(acquireIndexLock(d, ids[0]!, 'repo', { wait: false })).rejects.toThrow('already being indexed')
    first.release()
  })

  it('SIGINT while an index runs ends it with 130 and leaves no lock file', async () => {
    const { d, roots, ids } = setup()
    const g = gate()
    const run = startIndex(d, roots[0]!, g.entry)
    await until('the index analysing', analysing(d, ids[0]!), run)
    expect(fs.existsSync(lockPath(d, ids[0]!))).toBe(true)
    run.child.kill('SIGINT')
    expect(await run.exited).toBe(130)
    expect(fs.existsSync(lockPath(d, ids[0]!))).toBe(false)
  }, 240000)

  it('a job waiting behind a live lock keeps a heartbeat and stays queued however old its request is', async () => {
    const { d, roots, ids } = setup()
    const g = gate()
    const first = startIndex(d, roots[0]!, g.entry)
    await until('the first index analysing', analysing(d, ids[0]!), first)
    const second = startIndex(d, roots[0]!, g.entry)
    const jobs = () => { const c = Catalog.open(d); try { return c.openJobs(ids[0]!).filter((j) => j.state === 'queued') } finally { c.close() } }
    await until('the waiting job heartbeat', () => jobs().some((j) => j.progress_at !== null), first, second)
    const c = Catalog.open(d)
    const id = jobs()[0]!.id
    c.db.prepare('update index_job set requested_at = ? where id = ?').run('2026-01-01T00:00:00.000Z', id)
    expect(c.job(id)!.state).toBe('queued')
    c.close()
    g.open()
    for (const r of [first, second]) expect(await r.exited, r.out.stderr).toBe(0)
  }, 240000)

  it('the busy timeout override is read only in the harness, and only as a finite positive number, clamped', () => {
    const keep = { t: process.env.PROOFMESH_BUSY_TIMEOUT_MS, h: process.env.PROOFMESH_TEST_HARNESS }
    try {
      process.env.PROOFMESH_TEST_HARNESS = '1'
      const ms = (v: string) => { process.env.PROOFMESH_BUSY_TIMEOUT_MS = v; return busyTimeoutMs() }
      expect([ms('-1'), ms('0'), ms('abc'), ms('Infinity')]).toEqual([120000, 120000, 120000, 120000])
      expect([ms('50'), ms('99999999')]).toEqual([50, 600000])
      delete process.env.PROOFMESH_TEST_HARNESS
      expect(ms('50')).toBe(120000)
    } finally {
      for (const [k, v] of [['PROOFMESH_BUSY_TIMEOUT_MS', keep.t], ['PROOFMESH_TEST_HARNESS', keep.h]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  })
})
