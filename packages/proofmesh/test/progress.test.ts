import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterLine, progressReporter, type AdapterLine } from '../src/cli/progress.js'
import { Catalog, type IndexJob } from '../src/meshstore/catalog.js'
import { CLI, cli, copyFixture, tmpDir, tool } from './helpers.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('FR273 an index shows, at least every interval, each running adapter with its language, files done and total, files a second and an estimate', () => {
  afterEach(() => { vi.useRealTimers() })

  it('FR273 scenario 1: with the interval injected, a running adapter gets a line every interval, and the estimate follows its rate', () => {
    vi.useFakeTimers({ now: 0 })
    const lines: string[] = [], ticks: Array<AdapterLine | undefined> = []
    const report = progressReporter((l) => lines.push(l), 5000, () => ticks.push(report.current()))
    report.update({ phase: 'analyze', adapter: 'csharp', language: 'csharp', done: 0, total: 1000 })
    vi.advanceTimersByTime(5000)
    report.update({ phase: 'analyze', adapter: 'csharp', language: 'csharp', done: 200, total: 1000 })
    vi.advanceTimersByTime(5000)
    report.update({ phase: 'analyze', adapter: 'python', language: 'python', done: 0, total: 40 })
    vi.advanceTimersByTime(5000)
    report.stop()
    expect(lines).toEqual([
      '[0s] analyze csharp 0/1000',
      '[5s] analyze csharp 0/1000 (csharp: 0 files/s, no estimate yet) (still running)',
      '[10s] analyze csharp 200/1000 (csharp: 20 files/s, about 40s left) (still running)',
      '[10s] analyze python 0/40',
      '[15s] analyze python 0/40 (python: 0 files/s, no estimate yet) (still running)',
    ])
    expect(ticks.map((t) => t?.adapter)).toEqual(['csharp', 'csharp', 'python'])
  })

  it('FR273 scenario 2: the line holds figures only, never source text', () => {
    expect(adapterLine({ phase: 'analyze', adapter: 'csharp', language: 'csharp', done: 10, total: 100 }, 5000)).toEqual({ adapter: 'csharp', language: 'csharp', done: 10, total: 100, files_per_second: 2, eta_seconds: 45 })
    expect(adapterLine({ phase: 'write', done: 10, total: 100 }, 5000)).toBeUndefined()
  })
})

describe('FR274 get_job returns the figures the index prints, while the adapter is still running', () => {
  it('FR274 scenario 1: a CLI index stopped part way through its files shows the adapter, language, done, total, rate and estimate on stderr and in get_job', async () => {
    const d = tmpDir(), repo = copyFixture(), adapters = tmpDir('pm-gated-')
    const entry = path.join(adapters, 'gated-after-first.mjs'), gate = path.join(adapters, 'open')
    fs.copyFileSync(path.join(import.meta.dirname, 'fake-adapters', 'gated-after-first.mjs'), entry)
    for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const child = spawn(process.execPath, [CLI, '--data-dir', d, 'index', repo], { env: { ...process.env, PROOFMESH_TS_ADAPTER: entry, PROOFMESH_INDEX_BATCH: '2', PROOFMESH_TEST_PROGRESS_INTERVAL_MS: '100' } })
    let stderr = ''
    child.stderr.on('data', (b) => (stderr += b))
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    try {
      let job: IndexJob | undefined
      for (let i = 0; i < 600 && !job?.adapters?.typescript?.eta_seconds; i++) {
        await sleep(100)
        const catalog = Catalog.open(d)
        const open = (() => { try { return catalog.openJobs(catalog.repositories()[0]!.id) } finally { catalog.close() } })()
        job = open[0] ? (tool(d, 'get_job', { job_id: open[0].id }).data.job as IndexJob) : undefined
      }
      expect(job?.state).toBe('running')
      expect(tool(d, 'get_job', { job_id: job!.id }).limitations.join(' ')).toContain('refreshes progress_at every 5 seconds')
      expect(job!.adapters!.typescript).toMatchObject({ adapter: 'typescript', language: 'typescript+javascript+vue+svelte', done: 2, total: 6 })
      expect(job!.adapters!.typescript!.files_per_second).toBeGreaterThan(0)
      expect(job!.adapters!.typescript!.eta_seconds).toBeGreaterThanOrEqual(0)
      for (let i = 0; i < 100 && !/analyze typescript 2\/6 \(/.test(stderr); i++) await sleep(100)
      expect(stderr).toMatch(/analyze typescript 2\/6 \(typescript\+javascript\+vue\+svelte: [\d.]+ files\/s, about \d+s left\) \(still running\)/)
    } finally {
      fs.writeFileSync(gate, '')
      await exited
    }
  }, 120000)
})

describe('FR274 a job heartbeat moves in every phase, and lists only the adapters that are running', () => {
  it('FR274 scenario 2: progress_at keeps moving while an adapter initializes, and a finished job lists no adapter', async () => {
    const d = tmpDir(), repo = copyFixture(), adapters = tmpDir('pm-gated-')
    const entry = path.join(adapters, 'gated-after-first.mjs'), gate = path.join(adapters, 'open')
    fs.copyFileSync(path.join(import.meta.dirname, 'fake-adapters', 'gated-after-first.mjs'), entry)
    fs.writeFileSync(path.join(adapters, 'hold-init'), '')
    for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const child = spawn(process.execPath, [CLI, '--data-dir', d, 'index', repo], { env: { ...process.env, PROOFMESH_TS_ADAPTER: entry, PROOFMESH_TEST_PROGRESS_INTERVAL_MS: '100' } })
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    const read = (): IndexJob | undefined => {
      const catalog = Catalog.open(d)
      try { const open = catalog.openJobs(catalog.repositories()[0]!.id); return open[0] } finally { catalog.close() }
    }
    const seen = new Set<string | null>()
    let jobId = ''
    try {
      for (let i = 0; i < 300 && seen.size < 3; i++) {
        await sleep(100)
        const job = read()
        if (job?.phase?.startsWith('initialize')) { seen.add(job.progress_at); jobId = job.id }
      }
      expect(seen.size).toBeGreaterThanOrEqual(3)
    } finally {
      fs.writeFileSync(gate, '')
      expect(await exited).toBe(0)
    }
    expect((tool(d, 'get_job', { job_id: jobId }).data.job as IndexJob).adapters).toEqual({})
  }, 120000)
})

describe('FR276 the index summary gives seconds per analysed file for each adapter', () => {
  it('FR276 scenario 1: a CLI index prints the line, so a benchmark can record it', () => {
    const d = tmpDir(), repo = copyFixture()
    for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    expect(cli(['--data-dir', d, 'index', repo]).stdout).toMatch(/^adapter seconds per file typescript \d+\.\d\d/m)
  }, 120000)
})
