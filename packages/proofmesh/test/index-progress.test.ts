import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { progressReporter } from '../src/cli/progress.js'
import { AdapterProcess } from '../src/indexer/adapter-host.js'
import type { IndexJob } from '../src/meshstore/catalog.js'
import type { ProofmeshError } from '../src/core/errors.js'
import { CLI, cli, copyFixture, tmpDir, tool } from './helpers.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('#28 index progress: a line per phase change, and the latest again every interval', () => {
  afterEach(() => { vi.useRealTimers() })

  it('a long phase repeats its latest progress each interval, and stop() reports how long each phase took', () => {
    vi.useFakeTimers({ now: 0 })
    const lines: string[] = []
    const report = progressReporter((l) => lines.push(l), 60000)
    report.update({ phase: 'discover', done: 0, total: 0 })
    vi.advanceTimersByTime(2000)
    report.update({ phase: 'capture', done: 0, total: 30000 })
    vi.advanceTimersByTime(1000)
    report.update({ phase: 'capture', done: 1000, total: 30000 })
    report.update({ phase: 'initialize', adapter: 'csharp', done: 0, total: 28000 })
    vi.advanceTimersByTime(150000)
    report.update({ phase: 'analyze', adapter: 'csharp', language: 'csharp', done: 0, total: 28000 })
    report.update({ phase: 'analyze', adapter: 'csharp', language: 'csharp', done: 200, total: 28000 })
    vi.advanceTimersByTime(30000)
    expect(report.stop()).toEqual([{ phase: 'discover', ms: 2000 }, { phase: 'capture', ms: 1000 }, { phase: 'initialize csharp', ms: 150000 }, { phase: 'analyze csharp', ms: 30000 }])
    vi.advanceTimersByTime(120000)
    expect(lines).toEqual([
      '[0s] discover',
      '[2s] capture 0/30000',
      '[3s] initialize csharp 0/28000',
      '[1m00s] initialize csharp 0/28000 (still running)',
      '[2m00s] initialize csharp 0/28000 (still running)',
      '[2m33s] analyze csharp 0/28000',
      '[3m00s] analyze csharp 200/28000 (csharp: 7.4 files/s, about 62m33s left) (still running)',
    ])
  })
})

describe('#36 a phase that blocks the event loop still prints once a minute', () => {
  afterEach(() => { vi.useRealTimers() })

  it('an update a whole interval after the last line prints, though no timer could fire', () => {
    vi.useFakeTimers({ now: 0 })
    const lines: string[] = []
    const report = progressReporter((l) => lines.push(l), 60000)
    report.update({ phase: 'write', done: 0, total: 100000 })
    for (const [at, done] of [[30000, 25000], [61000, 50000], [90000, 75000], [125000, 100000]] as const) {
      vi.setSystemTime(at)
      report.update({ phase: 'write', done, total: 100000 })
    }
    report.stop()
    expect(lines).toEqual(['[0s] write 0/100000', '[1m01s] write 50000/100000', '[2m05s] write 100000/100000'])
  })
})

describe('#28 adapter memory: the host samples each adapter process and keeps the peak', () => {
  it.skipIf(process.platform === 'win32')('records a peak resident set size while the adapter runs', async () => {
    const a = new AdapterProcess(path.join(import.meta.dirname, 'fake-adapters', 'slow.mjs'), 60000, 20)
    try {
      for (let i = 0; i < 250 && !(a.peakRssKb! > 1024); i++) await sleep(20)
      expect(a.peakRssKb).toBeGreaterThan(1024)
    } finally {
      await a.shutdown()
    }
  })
})

describe('#28 a CLI index is an index job that status and MCP report while it runs', () => {
  it('names a first index in the no-snapshot refusal, shows a later one with its phase, ends it with phase durations and adapter memory, and a killed run reads interrupted', async () => {
    const d = tmpDir(), repo = copyFixture(), adapters = tmpDir('pm-gated-')
    const gated = path.join(adapters, 'gated.mjs'), gate = path.join(adapters, 'open')
    fs.copyFileSync(path.join(import.meta.dirname, 'fake-adapters', 'gated.mjs'), gated)
    for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const user = os.userInfo().username
    const start = () => {
      const child = spawn(process.execPath, [CLI, '--data-dir', d, 'index', repo], { env: { ...process.env, PROOFMESH_TS_ADAPTER: gated, PROOFMESH_TEST_PROGRESS_INTERVAL_MS: '60000' } })
      const out = { stdout: '', stderr: '' }
      child.stdout.on('data', (b) => (out.stdout += b))
      child.stderr.on('data', (b) => (out.stderr += b))
      return { child, out, exited: new Promise<number | null>((resolve) => child.on('exit', resolve)) }
    }
    const until = async <T>(found: () => T | undefined): Promise<T> => {
      for (let i = 0; i < 600; i++) { const v = found(); if (v !== undefined) return v; await sleep(100) }
      throw new Error('the index never reached analyze')
    }
    const jobs = () => tool(d, 'workspace_status', { limits: { max_rows: 1 } }).data.jobs as IndexJob[]
    const analysing = () => until(() => { const open = jobs(); return open[0]?.phase?.startsWith('analyze') ? open : undefined })
    const refusal = () => { try { tool(d, 'workspace_status', {}) } catch (e) { return e as ProofmeshError } throw new Error('a snapshot exists') }

    const first = start()
    const refused = await until(() => { const e = refusal(); return e.message.includes('analyze') ? e : undefined })
    const firstId = (refused.details as { job_id: string }).job_id
    expect(refused.message).toBe(`no published snapshot for this repository; index job ${firstId} is running (analyze typescript 0/6); poll it with get_job`)
    expect(cli(['--data-dir', d, 'status']).stderr).toContain(`index job ${firstId} is running (analyze typescript 0/6)`)
    fs.writeFileSync(gate, '')
    expect(await first.exited, first.out.stderr).toBe(0)
    expect(first.out.stderr.replace(/^\[\d+s\] /gm, '')).toBe('discover\ncapture 0/10\nprepare\ninitialize typescript 0/7\ninitialize build 0/1\nanalyze typescript 0/6\nanalyze build 0/1\nwrite\ncheck\nseal\n')
    expect(first.out.stdout).toMatch(new RegExp(`^phases discover \\d+s, capture \\d+s, prepare \\d+s, initialize typescript \\d+s, initialize build \\d+s, analyze typescript \\d+s, analyze build \\d+s, write \\d+s, check \\d+s, seal \\d+s \\(job ${firstId}\\)\\nadapter seconds per file typescript \\d+\\.\\d\\d, build \\d+\\.\\d\\d\\nadapter peak memory typescript \\d+ MiB, build \\d+ MiB\\n$`, 'm'))
    expect(tool(d, 'get_job', { job_id: firstId }).data.job).toMatchObject({ state: 'succeeded', phase: 'done', requested_by: user, finished_at: expect.any(String), error: null })
    expect(jobs()).toEqual([])

    fs.rmSync(gate)
    fs.appendFileSync(path.join(repo, 'packages/format/src/currency.ts'), '\nexport const ZERO = 0\n')
    const second = start()
    const [job] = await analysing()
    expect(job).toMatchObject({ state: 'running', requested_by: user, phase: 'analyze typescript', started_at: expect.any(String), finished_at: null, error: null })
    expect(tool(d, 'get_job', { job_id: job!.id }).data.job).toMatchObject({ id: job!.id, state: 'running', phase: 'analyze typescript' })
    expect(cli(['--data-dir', d, 'status']).stdout).toContain(`index job ${job!.id} running since ${job!.started_at} by ${user}: analyze typescript ${job!.done}/${job!.total}\n`)
    second.child.kill('SIGKILL')
    await second.exited
    expect(tool(d, 'get_job', { job_id: job!.id }).data.job).toMatchObject({ state: 'interrupted', phase: 'analyze typescript' })
    expect(jobs()).toEqual([])
    expect(cli(['--data-dir', d, 'status']).stdout).not.toContain('index job')
  }, 180000)
})
