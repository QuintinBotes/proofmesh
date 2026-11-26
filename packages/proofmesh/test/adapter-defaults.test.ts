import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdapterBudgetError, AdapterProcess, adapterBudgetMb, PROTOCOL_VERSION } from '../src/indexer/adapter-host.js'
import { indexRepository, type IndexResult } from '../src/indexer/coordinator.js'
import { diedOfHeap } from '../src/cli/host-heap.js'
import { hostHeapMb, machineMemoryMb } from '../src/indexer/memory.js'
import { Registry } from '../src/indexer/languages.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { CLI, cli, FIXTURE, ROOT, tmpDir, tool } from './helpers.js'

const GB = 1024 ** 3
const fake = (name: string) => path.join(import.meta.dirname, 'fake-adapters', name)
const memlang = fake('memlang.mjs')
const registry = (config: Record<string, unknown>) => new Registry([{ id: 'memlang', languages: new Set(['memlang']), extensions: { '.mem': 'memlang' }, isConfig: () => false, entry: () => memlang, unavailable: () => 'adapter_unavailable:memlang', config: () => config as Record<string, number> }])

const ENV = ['PROOFMESH_ADAPTER_MEMORY_MB', 'PROOFMESH_HOST_MEMORY_MB', 'PROOFMESH_TEST_HARNESS', 'PROOFMESH_TEST_TOTALMEM_MB', 'PROOFMESH_TEST_ADAPTER_RSS_SAMPLE_MS', 'PROOFMESH_INDEX_BATCH']
afterEach(() => { for (const k of ENV) delete process.env[k] })

async function index(files: number, config: Record<string, unknown>, env: Record<string, string> = {}): Promise<IndexResult> {
  const repo = tmpDir('pm-defaults-')
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(repo, `f${String(i).padStart(2, '0')}.mem`), `def fn${i}\n`)
  const d = tmpDir()
  initDataDir(d)
  const c = Catalog.open(d)
  c.addRepository(repo)
  c.close()
  Object.assign(process.env, { PROOFMESH_TEST_ADAPTER_RSS_SAMPLE_MS: '20', PROOFMESH_INDEX_BATCH: '12', ...env })
  return indexRepository(d, repo, undefined, registry(config))
}
const cheap = { mb_per_file: 1, huge_mb: 1, hold_over_mb: 1e9 }
const machine = (gb: number) => ({ PROOFMESH_TEST_HARNESS: '1', PROOFMESH_TEST_TOTALMEM_MB: String(gb * 1024) })

describe('FR350 the adapter budget defaults to half of physical memory, between 8 and 32 GB, and an explicit setting wins', () => {
  it('FR350 scenario 1: a 48 GB machine with no setting gets 24 GB and a 16 GB machine gets 8 GB', () => {
    expect(adapterBudgetMb({}, 48 * GB)).toBe(24576)
    expect(adapterBudgetMb({}, 16 * GB)).toBe(8192)
  })
  it('FR350: the rule is bounded at 8 GB below and 32 GB above, and the host heap follows it', () => {
    expect([4, 8, 32, 64, 128].map((g) => machineMemoryMb(g * GB))).toEqual([8192, 8192, 16384, 32768, 32768])
    expect(hostHeapMb(48 * GB)).toEqual({ mb: 24576, source: 'machine' })
  })
  it('FR350: the repository setting and PROOFMESH_ADAPTER_MEMORY_MB beat the machine, the repository setting first', () => {
    process.env.PROOFMESH_ADAPTER_MEMORY_MB = '1000'
    expect(adapterBudgetMb({}, 48 * GB)).toBe(1000)
    expect(adapterBudgetMb({ adapter_memory_mb: 500 }, 48 * GB)).toBe(500)
  })
})

describe('FR351 the index summary and get_job show the budget each adapter ran under and where it came from', () => {
  it('FR351 scenario 1: indexing on a 48 GB machine reports 24576 MB from the machine, and on 16 GB 8192 MB', async () => {
    expect((await index(2, cheap, machine(48))).adapterBudgets).toEqual({ memlang: { mb: 24576, source: 'machine' } })
    expect((await index(2, cheap, machine(16))).adapterBudgets).toEqual({ memlang: { mb: 8192, source: 'machine' } })
  })
  it('FR351 scenario 2: the CLI summary says the budget and the host heap, and get_job carries the budget in its plan and result', () => {
    const d = tmpDir()
    cli(['--data-dir', d, 'init']); cli(['--data-dir', d, 'repo', 'add', FIXTURE])
    const r = cli(['--data-dir', d, 'index', FIXTURE], { PROOFMESH_TS_ADAPTER: fake('linelang.mjs'), ...machine(48) })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^adapter memory budget typescript 24576 MB \(half of this machine's memory, 8 to 32 GB\)(, .*)?$/m)
    expect(r.stdout).toMatch(/^index host heap 24576 MB/m)
    const id = /\(job (\S+)\)/.exec(r.stdout)![1]!
    const job = (tool(d, 'get_job', { job_id: id }).data as { job: { plan: Record<string, unknown>; result: Record<string, unknown> } }).job
    expect(job.plan.typescript).toMatchObject({ budget_mb: 24576, budget_source: 'machine' })
    expect(job.result.memory).toMatchObject({ host_heap_mb: 24576, adapter_budgets: { typescript: { mb: 24576, source: 'machine' } } })
  })
})

describe('FR352 an adapter whose project load alone passes its budget is reported at once, with no restart', () => {
  const LOAD = { ...cheap, load_mb: 300 }
  it('FR352 scenario 1: the load peak fails the adapter once, with no halving restart, and every file fails with memory_budget', async () => {
    const log = path.join(tmpDir('pm-log-'), 'init.log')
    const r = await index(12, { ...LOAD, init_log: log }, { PROOFMESH_ADAPTER_MEMORY_MB: '128' })
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(r.memoryRestarts).toHaveLength(1)
    expect(r.memoryRestarts![0]).toMatchObject({ adapter: 'memlang', budget_mb: 128, files: 12, action: 'adapter_failed', at_load: true })
    expect(r.memoryRestarts![0]!.peak_rss_mb).toBeGreaterThan(128)
    expect(r.counts.failed).toBe(12)
  }, 120000)
  it('FR353 scenario 1: the error names the load peak, the budget and the setting to raise', async () => {
    const a = new AdapterProcess(memlang, 60000, 20, 'memlang', undefined, 128)
    try {
      const e = await a.initialize({ protocol_version: PROTOCOL_VERSION, workspace: tmpDir('pm-ws-'), analysis_mode: 'no_execution', files: [], config: LOAD }).then(() => undefined, (x: unknown) => x as AdapterBudgetError)
      expect(e).toBeInstanceOf(AdapterBudgetError)
      expect(e!.atLoad).toBe(true)
      expect(e!.message).toMatch(/needed \d+ MB to load the project, over its memory budget of 128 MB \(load peak \d+ MB; raise it with adapter_memory_mb\)/)
      expect(e!.peakRssKb).toBeGreaterThan(128 * 1024)
    } finally { await a.shutdown() }
  })
  it('FR353 scenario 2: the CLI prints the load peak and the command that raises the budget', () => {
    const d = tmpDir()
    cli(['--data-dir', d, 'init']); cli(['--data-dir', d, 'repo', 'add', FIXTURE])
    const r = cli(['--data-dir', d, 'index', FIXTURE], { PROOFMESH_TS_ADAPTER: fake('loadheavy.mjs'), PROOFMESH_ADAPTER_MEMORY_MB: '128', PROOFMESH_TEST_ADAPTER_RSS_SAMPLE_MS: '50' })
    expect(r.stdout).toMatch(/needed \d+ MB to load the project, over its memory budget of 128 MB.*with no restart.*proofmesh repo config <repository> --adapter typescript --memory-mb/)
  })
})

describe('FR354 the index host runs under a heap from the machine rule, and a host out of memory is a named error', () => {
  const flood = (n: number, rels: number) => {
    const repo = tmpDir('pm-flood-')
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(repo, `f${i}.ts`), `// rels ${rels}\nexport const x${i} = ${i}\n`)
    return repo
  }
  const run = (repo: string, env: Record<string, string>) => {
    const d = tmpDir()
    cli(['--data-dir', d, 'init']); cli(['--data-dir', d, 'repo', 'add', repo])
    return { d, ...cli(['--data-dir', d, 'index', repo], { PROOFMESH_TS_ADAPTER: fake('flood.mjs'), PROOFMESH_INDEX_BATCH: '1', ...env }) }
  }
  it('FR354 scenario 1: the host heap is the rule\'s value, shown in the summary, and an explicit PROOFMESH_HOST_MEMORY_MB wins', () => {
    const repo = flood(2, 1)
    const rule = run(repo, machine(48))
    expect(rule.status).toBe(0)
    expect(rule.stdout).toContain('host heap 24576 MB')
    expect(run(repo, { PROOFMESH_HOST_MEMORY_MB: '2048' }).stdout).toContain('host heap 2048 MB')
  })
  it('FR355 scenario 1: relationships past the heap fail the index with a named host out-of-memory error and a failed job, not a crash', () => {
    const r = run(flood(30, 6000), { PROOFMESH_HOST_MEMORY_MB: '64' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/the index host ran out of memory at its heap limit of 64 MB; raise it with PROOFMESH_HOST_MEMORY_MB/)
    const c = Catalog.open(r.d)
    const job = c.db.prepare('select state, error from index_job').get() as { state: string; error: string }
    c.close()
    expect(job.state).toBe('failed')
    expect(job.error).toContain('PROOFMESH_HOST_MEMORY_MB')
  }, 120000)
})

describe('FR356 the synthetic large-tier script generates N projects and M files and records the host and adapter peaks', () => {
  it('FR356 scenario 1: a small run reports its size, the budget line and the host peak', () => {
    const out = path.join(tmpDir('pm-synth-'), 'result.json')
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bench', 'graph-bench', 'synthetic-large.mjs'), '--projects', '3', '--files', '7', '--sample-ms', '50', '--adapter', fake('flood.mjs'), '--out', out], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME! } })
    expect(r.status, r.stderr).toBe(0)
    const result = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(result).toMatchObject({ projects: 3, files: 7, exit_code: 0, failure: null })
    expect(result.host_peak_mb).toBeGreaterThan(0)
    expect(result.adapter_peak_mb).toBeGreaterThan(0)
    expect(result.memory_line).toMatch(/^adapter memory budget /)
  }, 120000)
})

describe('FR357 a syntax fallback that starts mid-run is held to a budget, shown with the others, and an overrun fails its files by name', () => {
  it('FR357 scenario 1: a fallback whose load passes its budget marks its files memory_budget, shows its budget, and does not fail the index', async () => {
    const repo = tmpDir('pm-fb-')
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(repo, `f${i}.ts`), `export const x${i} = ${i}\n`)
    const d = tmpDir()
    initDataDir(d)
    const c = Catalog.open(d); c.addRepository(repo); c.close()
    Object.assign(process.env, { PROOFMESH_ADAPTER_MEMORY_MB: '128', PROOFMESH_TEST_ADAPTER_RSS_SAMPLE_MS: '20' })
    const spec = (id: string, entry: string, fallback: boolean) => ({ id, languages: new Set(['typescript']), extensions: { '.ts': 'typescript' }, isConfig: () => false, entry: () => entry, unavailable: () => `adapter_unavailable:${id}`, ...(fallback ? { fallback } : {}) })
    const r = await indexRepository(d, repo, undefined, new Registry([spec('typescript', fake('crashing.mjs'), true), { ...spec('syntax', fake('loadheavy.mjs'), false), languages: new Set(['syntax']), extensions: {} }]))
    expect(r.memoryRestarts).toHaveLength(1)
    expect(r.memoryRestarts![0]).toMatchObject({ adapter: 'syntax-fallback', budget_mb: 128, at_load: true, files: 3 })
    expect(r.counts.failed).toBe(3)
    expect(r.adapterBudgets['syntax-fallback']).toEqual({ mb: 128, source: 'setting' })
  }, 120000)
})

describe('FR358 the host supervisor is told apart by a marker, not by a heap flag, and only V8\'s own fatal error is a host out-of-memory', () => {
  const flood = (n: number, rels: number) => {
    const repo = tmpDir('pm-flood-')
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(repo, `f${i}.ts`), `// rels ${rels}\nexport const x${i} = ${i}\n`)
    return repo
  }
  it('FR358 scenario 1: a CLI started with its own --max-old-space-size still gets the named host out-of-memory error', () => {
    const repo = flood(30, 6000), d = tmpDir()
    cli(['--data-dir', d, 'init']); cli(['--data-dir', d, 'repo', 'add', repo])
    const r = spawnSync(process.execPath, ['--max-old-space-size=64', CLI, '--data-dir', d, 'index', repo], { encoding: 'utf8', env: { ...process.env, PROOFMESH_TS_ADAPTER: fake('flood.mjs'), PROOFMESH_INDEX_BATCH: '1' } })
    expect(r.stderr).toMatch(/the index host ran out of memory at its heap limit of 64 MB/)
  }, 120000)
  it('FR358 scenario 2: V8\'s fatal error with an abort is a host out-of-memory; the same words with an ordinary exit, or without the fatal-error text, are not', () => {
    const v8 = 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory'
    expect(diedOfHeap(v8, null, 'SIGABRT')).toBe(true)
    expect(diedOfHeap(v8, 134, null)).toBe(true)
    expect(diedOfHeap(v8, 1, null)).toBe(false)
    expect(diedOfHeap('adapter x failed: JavaScript heap out of memory', null, 'SIGABRT')).toBe(false)
  })
})

describe('FR359 the host heap is always shown, and the synthetic script refuses a sample interval that is not positive', () => {
  it('FR359 scenario 1: an index of a repository with no analysable file still prints the host heap', () => {
    const repo = tmpDir('pm-empty-'), d = tmpDir()
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'nothing to analyse\n')
    cli(['--data-dir', d, 'init']); cli(['--data-dir', d, 'repo', 'add', repo])
    const r = cli(['--data-dir', d, 'index', repo], machine(48))
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^index host heap 24576 MB/m)
  }, 120000)
  it('FR359 scenario 2: --sample-ms 0 and --sample-ms abc are refused', () => {
    for (const v of ['0', 'abc', '-5']) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'bench', 'graph-bench', 'synthetic-large.mjs'), '--projects', '1', '--files', '1', '--sample-ms', v], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME! } })
      expect(r.status, v).toBe(2)
    }
  })
})
