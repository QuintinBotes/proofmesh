import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { asProofmeshError } from '../src/core/errors.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { CLI, copyFixture, tmpDir } from './helpers.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const GATED = path.join(import.meta.dirname, 'fake-adapters', 'gated.mjs')
const HARNESS = { PROOFMESH_TEST_HARNESS: '1' }

type Run = { child: ChildProcess; out: { stderr: string }; exited: Promise<number | null> }

function gate() {
  const dir = tmpDir('pm-gated-'), entry = path.join(dir, 'gated.mjs')
  fs.copyFileSync(GATED, entry)
  return { entry, open: () => fs.writeFileSync(path.join(dir, 'open'), '') }
}

function startIndex(d: string, repo: string, adapter: string, env: Record<string, string> = {}): Run {
  const child = spawn(process.execPath, [CLI, '--data-dir', d, 'index', repo], { env: { ...process.env, PROOFMESH_TS_ADAPTER: adapter, ...HARNESS, ...env } })
  const out = { stderr: '' }
  child.stderr.on('data', (b) => (out.stderr += b))
  return { child, out, exited: new Promise<number | null>((resolve) => child.on('exit', resolve)) }
}

/** Waits for a condition the runs make true; stops at once if a run ends first. */
async function until(what: string, found: () => boolean, ...runs: Run[]): Promise<void> {
  let ended = false
  for (const r of runs) void r.exited.then(() => { ended = true })
  for (let i = 0; i < 1200 && !ended; i++) { if (found()) return; await sleep(50) }
  if (found()) return
  throw new Error(`${what} never happened${ended ? '; a run ended first:\n' + runs.map((r) => r.out.stderr).join('\n---\n') : ''}`)
}

/** Holds a write lock on a database from another process until `release` exists. `fresh` makes the file in rollback-journal mode and holds it exclusively, as a first creator would. */
function hold(db: string, release: string, fresh = false) {
  const script = fresh
    ? `const D=require('better-sqlite3'),fs=require('fs');const db=new D(process.argv[1]);db.exec('create table seed(x)');db.exec('begin exclusive');console.log('held');const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);db.exec('rollback');db.close()}},20)`
    : `const D=require('better-sqlite3'),fs=require('fs');const db=new D(process.argv[1]);db.pragma('journal_mode = WAL');db.exec('begin immediate');console.log('held');const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);db.exec('rollback');db.close()}},20)`
  const child = spawn(process.execPath, ['-e', script, db, release], { cwd: import.meta.dirname })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return new Promise<{ release: () => void; exited: Promise<void> }>((resolve, reject) => {
    child.stdout.once('data', () => resolve({ release: () => fs.writeFileSync(release, ''), exited }))
    void exited.then(() => reject(new Error('lock holder exited')))
  })
}

function setup(repos: number) {
  const d = tmpDir()
  initDataDir(d)
  fs.mkdirSync(path.join(d, 'cache'), { recursive: true })
  const roots = Array.from({ length: repos }, () => copyFixture())
  const c = Catalog.open(d)
  const ids = roots.map((r, i) => c.addRepository(r, `repo${i}`).id)
  c.close()
  return { d, roots, ids }
}
const releaseFile = () => path.join(tmpDir('pm-release-'), 'release')
const analysing = (d: string, id: string) => () => { const c = Catalog.open(d); try { return c.openJobs(id).some((j) => j.phase?.startsWith('analyze')) } finally { c.close() } }
const publishedCount = (d: string, id: string) => { const c = Catalog.open(d); try { return (c.db.prepare("select count(*) as n from snapshot where repository_id = ? and state = 'published'").get(id) as { n: number }).n } finally { c.close() } }

describe('FR360 two indexes forced to write the catalog and the fact cache at the same moment both publish', () => {
  it(`every time (${process.env.PROOFMESH_STRESS_RUNS ?? 1} run(s) in this process)`, async () => {
    for (let n = 0; n < Number(process.env.PROOFMESH_STRESS_RUNS ?? 1); n++) {
      const { d, roots, ids } = setup(2)
      const gates = [gate(), gate()]
      // The job rows and the fact cache's first creation are held busy before either run starts, so both meet the contention at the same point.
      const catalogHold = await hold(path.join(d, 'catalog.db'), releaseFile())
      const factsHold = await hold(path.join(d, 'cache', 'facts.db'), releaseFile(), true)
      const runs = roots.map((r, i) => startIndex(d, r, gates[i]!.entry, { PROOFMESH_BUSY_TIMEOUT_MS: '500' }))
      await until('both runs retrying a catalog write', () => runs.every((r) => r.out.stderr.includes('"db":"catalog.db"')), ...runs)
      catalogHold.release()
      await until('both runs retrying the fact cache', () => runs.every((r) => r.out.stderr.includes('"db":"facts.db"')), ...runs)
      factsHold.release()
      await until('both runs analysing at once', () => ids.every((id) => analysing(d, id)()), ...runs)
      gates.forEach((g) => g.open())
      for (const r of runs) expect(await r.exited, r.out.stderr).toBe(0)
      await Promise.all([catalogHold.exited, factsHold.exited])
      ids.forEach((id) => expect(publishedCount(d, id)).toBe(1))
    }
  }, 3_600_000)
})

describe('FR361 a database another run is creating or writing is waited for, never an internal error', () => {
  it('the fact cache opened while another run holds it in rollback mode waits and the index succeeds', async () => {
    const { d, roots } = setup(1)
    const g = gate()
    g.open()
    const factsHold = await hold(path.join(d, 'cache', 'facts.db'), releaseFile(), true)
    const run = startIndex(d, roots[0]!, g.entry, { PROOFMESH_BUSY_TIMEOUT_MS: '500' })
    try {
      await until('a retry on the fact cache', () => run.out.stderr.includes('"db":"facts.db"'), run)
    } finally { factsHold.release() }
    expect(await run.exited, run.out.stderr).toBe(0)
    expect(run.out.stderr).not.toContain('INTERNAL_ERROR')
  }, 240000)

})

describe('FR363 a busy error from any connection is BUSY, never INTERNAL_ERROR', () => {
  it('names a connection with no retry of its own BUSY', () => {
    const e = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    expect(asProofmeshError(e).code).toBe('BUSY')
    expect(asProofmeshError(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED_SHAREDCACHE' })).code).toBe('BUSY')
    expect(asProofmeshError(new Error('other')).code).toBe('INTERNAL_ERROR')
  })
})

describe('FR362 a write still contended past the retry budget is a BUSY error naming the database and statement', () => {
  it.each([
    ['catalog.db', 'insert into index_job', false],
    ['facts.db', 'pragma journal_mode = WAL', true],
  ])('%s', async (db, statement, fresh) => {
    const { d, roots } = setup(1)
    const g = gate()
    g.open()
    const file = db === 'catalog.db' ? path.join(d, 'catalog.db') : path.join(d, 'cache', 'facts.db')
    const holder = await hold(file, releaseFile(), fresh)
    const run = startIndex(d, roots[0]!, g.entry, { PROOFMESH_BUSY_TIMEOUT_MS: '20' })
    try {
      expect(await run.exited).toBe(1)
    } finally { holder.release() }
    expect(run.out.stderr).toMatch(/proofmesh: BUSY: .*\S/)
    expect(run.out.stderr).not.toContain('INTERNAL_ERROR')
    expect(run.out.stderr).toContain(`${db} stayed busy`)
    expect(run.out.stderr).toContain(statement)
  }, 240000)
})
