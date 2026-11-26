import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { progressReporter } from '../src/cli/progress.js'
import { indexRepository, type Progress } from '../src/indexer/coordinator.js'
import { discover } from '../src/indexer/discovery.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { lockFile } from '../src/meshstore/index-lock.js'
import type { ProofmeshError } from '../src/core/errors.js'
import { CLI, tmpDir, tool } from './helpers.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A repository of plain text files, `dirs` directories of 100 each: nothing for an adapter, so an index of it is discovery and bookkeeping. */
function textRepo(dirs: number): string {
  const repo = tmpDir('pm-repo-')
  for (let d = 0; d < dirs; d++) {
    fs.mkdirSync(path.join(repo, `d${d}`))
    for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(repo, `d${d}`, `f${f}.txt`), `${d}/${f}\n`)
  }
  return repo
}

function registered(repo: string): { d: string; id: string } {
  const d = tmpDir()
  initDataDir(d)
  const c = Catalog.open(d)
  try { return { d, id: c.addRepository(repo).id } } finally { c.close() }
}

/**
 * A `git` first on PATH that ignores SIGTERM and never answers until a file named `open` appears beside it. It writes its pid first,
 * which is the gate: once the pid is there, discovery is waiting on git.
 */
function stuckGit() {
  const dir = tmpDir('pm-git-'), pidFile = path.join(dir, 'git.pid')
  fs.writeFileSync(path.join(dir, 'git'), [
    `#!${process.execPath}`,
    "const fs = require('node:fs'), path = require('node:path')",
    "process.on('SIGTERM', () => {})",
    "fs.writeFileSync(path.join(__dirname, 'git.pid'), String(process.pid))",
    "setInterval(() => { if (fs.existsSync(path.join(__dirname, 'open'))) process.exit(128) }, 20)",
    '',
  ].join('\n'), { mode: 0o755 })
  return {
    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    pid: () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) || undefined : undefined),
    open: () => fs.writeFileSync(path.join(dir, 'open'), ''),
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** Polls a condition the processes under test make true; the bound is a liveness limit, not a timing assertion. */
async function until(found: () => boolean, polls = 600): Promise<boolean> {
  for (let i = 0; i < polls; i++) { if (found()) return true; await sleep(50) }
  return found()
}

function startIndex(d: string, repo: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [CLI, '--data-dir', d, 'index', repo], { env: { ...process.env, ...env } })
  const out = { stderr: '' }
  child.stderr.on('data', (b) => (out.stderr += b))
  let code: number | null | undefined
  const exited = new Promise<number | null>((resolve) => child.on('exit', (c, s) => { code = c ?? (s ? -1 : null); resolve(code) }))
  return { child, out, exited, done: () => code !== undefined }
}

describe('FR370 discover reports the files it has found so far', () => {
  afterEach(() => { vi.useRealTimers() })

  it('an index reports discover progress every 1000 files found, not only its start', async () => {
    const { d, id } = registered(textRepo(25))
    const seen: Progress[] = []
    await indexRepository(d, id, (p) => seen.push(p))
    expect(seen.filter((p) => p.phase === 'discover').map((p) => p.done)).toEqual([0, 1000, 2000])
  })

  it('the progress line and a job\'s phase name the files found when the stage has no total', () => {
    vi.useFakeTimers({ now: 0 })
    const lines: string[] = []
    const report = progressReporter((l) => lines.push(l), 60000)
    report.update({ phase: 'discover', done: 0, total: 0 })
    report.update({ phase: 'discover', done: 1000, total: 0 })
    vi.advanceTimersByTime(60000)
    report.stop()
    expect(lines).toEqual(['[0s] discover', '[1m00s] discover 1000 files found (still running)'])

    const { d, id } = registered(textRepo(1))
    const c = Catalog.open(d)
    const job = c.createJob(id, 'test')
    c.updateJob(job, { phase: 'discover', done: 1000, total: 0, progress_at: new Date().toISOString() })
    c.close()
    let refusal: ProofmeshError | undefined
    try { tool(d, 'workspace_status', {}) } catch (e) { refusal = e as ProofmeshError }
    expect(refusal?.message).toBe(`no published snapshot for this repository; index job ${job} is queued (discover 1000 files found); poll it with get_job`)
  })
})

describe('FR371 a signal or a cancel during discover stops the index and releases its lock', () => {
  it('the event loop runs while discover walks, so a cancel there ends the index before capture, with no lock or staging left', async () => {
    const { d, id } = registered(textRepo(25))
    const stop = new AbortController(), phases: string[] = []
    let ranIn: string[] | undefined
    const run = indexRepository(d, id, (p) => {
      phases.push(p.phase)
      // The first callback the loop runs after discover starts: with a walk that never yields, it runs only after capture.
      if (p.phase === 'discover' && p.done === 0) setImmediate(() => { ranIn = [...new Set(phases)]; stop.abort() })
    }, undefined, undefined, false, { signal: stop.signal })
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ranIn).toEqual(['discover'])
    expect([...new Set(phases)]).toEqual(['discover'])
    expect(fs.existsSync(lockFile(d, id))).toBe(false)
    expect(fs.readdirSync(path.join(d, 'staging'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('SIGTERM to the CLI while discover waits on git exits 143, releases the lock and leaves no git behind', async () => {
    const repo = textRepo(1), { d, id } = registered(repo), git = stuckGit()
    const run = startIndex(d, repo, { PATH: git.PATH })
    try {
      expect(await until(() => git.pid() !== undefined || run.done()), run.out.stderr).toBe(true)
      const pid = git.pid()!
      expect(fs.existsSync(lockFile(d, id))).toBe(true)
      run.child.kill('SIGTERM')
      expect(await until(run.done, 200), `the index ignored SIGTERM:\n${run.out.stderr}`).toBe(true)
      expect(await run.exited).toBe(143)
      expect(fs.existsSync(lockFile(d, id))).toBe(false)
      expect(await until(() => !alive(pid), 200)).toBe(true)
    } finally {
      git.open()
      run.child.kill('SIGKILL')
    }
  }, 120000)
})

describe('FR372 the git child of discovery is bounded', () => {
  it.skipIf(process.platform === 'win32')('git that never answers and ignores SIGTERM is killed at its timeout, and the index fails naming it', async () => {
    const repo = textRepo(1), { d, id } = registered(repo), git = stuckGit()
    const run = startIndex(d, repo, { PATH: git.PATH, PROOFMESH_TEST_GIT_TIMEOUT_MS: '300' })
    try {
      expect(await until(run.done), `the index waited on git forever:\n${run.out.stderr}`).toBe(true)
      expect(await run.exited).not.toBe(0)
      expect(run.out.stderr).toMatch(/git ls-files did not answer within 0\.3 s in .+; discovery cannot tell which files git ignores/)
      expect(await until(() => !alive(git.pid()!), 200)).toBe(true)
      expect(fs.existsSync(lockFile(d, id))).toBe(false)
    } finally {
      git.open()
      run.child.kill('SIGKILL')
    }
  }, 120000)

  it('without git on PATH nothing is ignored, as outside a work tree', () => {
    const repo = textRepo(1), keep = process.env.PATH
    try {
      process.env.PATH = tmpDir('pm-nogit-')
      expect(discover(repo).filter((f) => f.status === 'excluded')).toEqual([])
      expect(discover(repo)).toHaveLength(100)
    } finally {
      process.env.PATH = keep
    }
  })
})
