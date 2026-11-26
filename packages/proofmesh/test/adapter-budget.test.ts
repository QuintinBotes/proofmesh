import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdapterBudgetError, AdapterProcess, PROTOCOL_VERSION } from '../src/indexer/adapter-host.js'
import { indexRepository, testMs, type IndexResult } from '../src/indexer/coordinator.js'
import { Registry } from '../src/indexer/languages.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { cli, copyFixture, ROOT, tmpDir, tool, withSnapshot } from './helpers.js'

const memlang = path.join(import.meta.dirname, 'fake-adapters', 'memlang.mjs')
/** What each file or batch costs the fake adapter, in MB: a batch of four or more small files needs more than the budget of 128 MB. */
const MODEL = { mb_per_file: 30, huge_mb: 400, hold_over_mb: 100 }
const registry = (config: Record<string, number> = MODEL) => new Registry([{ id: 'memlang', languages: new Set(['memlang']), extensions: { '.mem': 'memlang' }, isConfig: () => false, entry: () => memlang, unavailable: () => 'adapter_unavailable:memlang', config: () => config }])

const ENV = ['PROOFMESH_ADAPTER_MEMORY_MB', 'PROOFMESH_TEST_ADAPTER_RSS_SAMPLE_MS', 'PROOFMESH_INDEX_BATCH']
afterEach(() => { for (const k of ENV) delete process.env[k] })

async function index(files: string[], budgetMb: number | undefined, config?: Record<string, number>, repoBudgetMb?: number): Promise<{ d: string; r: IndexResult }> {
  const repo = tmpDir('pm-budget-')
  files.forEach((f, i) => fs.writeFileSync(path.join(repo, f), `def fn${i}\n`))
  const d = tmpDir()
  initDataDir(d)
  const c = Catalog.open(d)
  const added = c.addRepository(repo)
  if (repoBudgetMb) c.setAdapterConfig(added.id, 'memlang', { adapter_memory_mb: repoBudgetMb })
  c.close()
  if (budgetMb) process.env.PROOFMESH_ADAPTER_MEMORY_MB = String(budgetMb)
  process.env.PROOFMESH_TEST_ADAPTER_RSS_SAMPLE_MS = '20'
  process.env.PROOFMESH_INDEX_BATCH = '12'
  return { d, r: await indexRepository(d, repo, undefined, registry(config)) }
}
const facts = (d: string) => withSnapshot(d, (db) => ({
  symbols: db.prepare('select f.path, s.name, s.qualified_name, s.kind from symbol s join file f on f.id = s.file_id order by f.path, s.name').all(),
  files: db.prepare('select path, disposition, disposition_detail from file order by path').all(),
}))
const names = (n: number) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(2, '0')}.mem`)

describe('FR270 an adapter process is held to a memory budget the host enforces, and an overrun names the adapter, the budget and the peak', () => {
  it('FR270 scenario 1: an adapter whose resident memory passes its budget is stopped and the call fails with an AdapterBudgetError naming all three', async () => {
    const a = new AdapterProcess(memlang, 60000, 20, 'memlang', undefined, 128)
    try {
      await a.initialize({ protocol_version: PROTOCOL_VERSION, workspace: tmpDir('pm-ws-'), analysis_mode: 'no_execution', files: [], config: MODEL })
      const e = await a.analyze(['a.mem', 'b.mem', 'c.mem', 'd.mem']).then(() => undefined, (x: unknown) => x as AdapterBudgetError)
      expect(e).toBeInstanceOf(AdapterBudgetError)
      expect(e!.message).toContain('adapter memlang exceeded its memory budget of 128 MB')
      expect(e!.message).toMatch(/peak resident memory \d+ MB/)
      expect(e!.budgetMb).toBe(128)
      expect(e!.peakRssKb).toBeGreaterThan(128 * 1024)
      expect(a.restarts).toBe(0)
    } finally { await a.shutdown() }
  })
})

describe('FR270 the budget covers the whole process group, is checked at the end of every batch, and takes a kill by the kernel as an overrun', () => {
  const workspaces = new WeakMap<AdapterProcess, string>()
  const workspaceOf = (a: AdapterProcess) => workspaces.get(a)!
  const start = async (budget: number | undefined, config: Record<string, number>, sampleMs = 20) => {
    const ws = tmpDir('pm-ws-')
    const a = budget === undefined ? new AdapterProcess(memlang, 60000, sampleMs, 'memlang') : new AdapterProcess(memlang, 60000, sampleMs, 'memlang', undefined, budget)
    await a.initialize({ protocol_version: PROTOCOL_VERSION, workspace: ws, analysis_mode: 'no_execution', files: [], config })
    workspaces.set(a, ws)
    return a
  }
  const overrun = (p: Promise<unknown>) => p.then(() => undefined, (x: unknown) => x as Error)

  it('FR270 scenario 2: a child process of the adapter that allocates past the budget counts against it, though the adapter itself stays small', async () => {
    const a = await start(128, { ...MODEL, child_hold_mb: 400 })
    try {
      const e = await overrun(a.analyze(['a.mem']))
      expect(e).toBeInstanceOf(AdapterBudgetError)
      expect((e as AdapterBudgetError).peakRssKb).toBeGreaterThan(128 * 1024)
    } finally { await a.shutdown() }
  })

  it('FR270 scenario 3: a spike that polling would miss is caught at the end of the batch, before its results are accepted', async () => {
    const a = await start(128, { ...MODEL, reply_mb: 300 }, 600000)
    try {
      fs.writeFileSync(path.join(workspaceOf(a), 'a.mem'), 'def a\n')
      const e = await overrun(a.analyze(['a.mem']))
      expect(e).toBeInstanceOf(AdapterBudgetError)
      expect(e!.message).toContain('at the end of a batch')
      expect(e!.message).toContain('budget of 128 MB')
    } finally { await a.shutdown() }
  })

  it('FR270 scenario 4: with no budget given, an adapter takes the resolved one, so the conformance kit and adapter check honour PROOFMESH_ADAPTER_MEMORY_MB', async () => {
    process.env.PROOFMESH_ADAPTER_MEMORY_MB = '128'
    const a = await start(undefined, { ...MODEL, hold_over_mb: 100 })
    try {
      expect(await overrun(a.analyze(['a.mem', 'b.mem', 'c.mem', 'd.mem']))).toBeInstanceOf(AdapterBudgetError)
    } finally { await a.shutdown() }
  })

  it('FR271 scenario 2: an adapter the kernel kills with SIGKILL under a budget is an overrun, so the batch halves and the sealed facts are unchanged', async () => {
    const files = names(12), model = { mb_per_file: 1, huge_mb: 1, hold_over_mb: 1e9, die_over_files: 3 }
    const free = await index(files, undefined, { ...model, die_over_files: 1e9 })
    const killed = await index(files, 4096, model)
    expect(facts(killed.d)).toEqual(facts(free.d))
    expect(killed.r.memoryRestarts).toHaveLength(2)
    expect(killed.r.memoryRestarts![0]).toMatchObject({ adapter: 'memlang', budget_mb: 4096, files: 12, action: 'smaller_batches' })
  }, 120000)
})

describe('FR270 the budget is set per repository and adapter', () => {
  it('FR270 scenario 5: adapter_memory_mb in the repository configuration holds the adapter to its budget, with no environment setting', async () => {
    const { r } = await index(names(12), undefined, MODEL, 128)
    expect(r.memoryRestarts).toHaveLength(2)
    expect(r.memoryRestarts![0]).toMatchObject({ budget_mb: 128 })
  }, 120000)

  it('FR270 scenario 6: proofmesh repo config writes it, keeps the rest of the adapter configuration, and refuses what is not a whole number of MB', () => {
    const d = tmpDir(), repo = copyFixture()
    for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const c = Catalog.open(d)
    const id = c.repositories()[0]!.id
    c.setAdapterConfig(id, 'csharp', { other: 1 })
    c.close()
    expect(cli(['--data-dir', d, 'repo', 'config', id, '--adapter', 'csharp', '--memory-mb', '512']).status).toBe(0)
    expect(cli(['--data-dir', d, 'repo', 'config', id, '--adapter', 'csharp', '--memory-mb', '0']).status).not.toBe(0)
    expect(cli(['--data-dir', d, 'repo', 'config', id, '--adapter', 'csharp', '--memory-mb', 'lots']).status).not.toBe(0)
    const after = Catalog.open(d)
    try { expect(after.adapterConfig(id, 'csharp')).toEqual({ other: 1, adapter_memory_mb: 512 }) } finally { after.close() }
  })
})

describe('FR270 the sampling interval can be set only through the test marker, and is clamped', () => {
  it('FR270 scenario 7: PROOFMESH_TEST_ names are clamped to their range, and the earlier unmarked name is ignored', () => {
    const set = (v: string | undefined) => { if (v === undefined) delete process.env.PROOFMESH_TEST_X; else process.env.PROOFMESH_TEST_X = v }
    try {
      expect([undefined, '', '1', '500', '99999', 'abc'].map((v) => { set(v); return testMs('PROOFMESH_TEST_X', 50, 2000) })).toEqual([undefined, undefined, 50, 500, 2000, undefined])
    } finally { set(undefined) }
    process.env.PROOFMESH_ADAPTER_RSS_SAMPLE_MS = '1'
    try { expect(testMs('PROOFMESH_TEST_ADAPTER_RSS_SAMPLE_MS', 50, 2000)).toBeUndefined() } finally { delete process.env.PROOFMESH_ADAPTER_RSS_SAMPLE_MS }
  })
})

describe('FR271 an adapter over its budget is restarted with smaller batches before any file fails, and the facts sealed are the same', () => {
  it('FR271 scenario 1: under a budget that fits three files, an index restarts the adapter, seals the facts of an index without a budget, and names each restart', async () => {
    const files = names(12)
    const free = await index(files, undefined, { ...MODEL, hold_over_mb: 1e9 })
    const bounded = await index(files, 128)
    expect(bounded.r.counts).toEqual(free.r.counts)
    expect(facts(bounded.d)).toEqual(facts(free.d))
    expect(facts(bounded.d).files.every((f) => (f as { disposition: string }).disposition === 'indexed')).toBe(true)
    // 12 files need 360 MB, 6 need 180 MB, 3 need 90 MB: two restarts, the second already capped to batches of three.
    expect(bounded.r.memoryRestarts).toHaveLength(2)
    expect(bounded.r.memoryRestarts![0]).toMatchObject({ adapter: 'memlang', budget_mb: 128, files: 12, action: 'smaller_batches' })
    expect(bounded.r.memoryRestarts![0]!.peak_rss_mb).toBeGreaterThan(128)
    expect(free.r.memoryRestarts ?? []).toEqual([])
  }, 120000)

  it('FR277 scenario 1: a snapshot sealed under one budget is not the answer to an index under another, so raising a budget indexes again', async () => {
    const repo = tmpDir('pm-budget-')
    fs.writeFileSync(path.join(repo, 'a.mem'), 'def a\n')
    const d = tmpDir()
    initDataDir(d)
    const c = Catalog.open(d); c.addRepository(repo); c.close()
    process.env.PROOFMESH_ADAPTER_MEMORY_MB = '4096'
    const first = await indexRepository(d, repo, undefined, registry())
    expect((await indexRepository(d, repo, undefined, registry())).status).toBe('unchanged')
    process.env.PROOFMESH_ADAPTER_MEMORY_MB = '8192'
    const raised = await indexRepository(d, repo, undefined, registry())
    expect(raised.status).toBe('published')
    expect(raised.snapshotId).not.toBe(first.snapshotId)
  }, 120000)
})

describe('FR272 a file that alone exceeds the budget fails with memory_budget and the rest of the repository is analysed', () => {
  it('FR272 scenario 1: the huge file is failed, every other file is indexed, and the census counts it', async () => {
    const { d, r } = await index([...names(6), 'huge.mem'], 128, { ...MODEL, mb_per_file: 10 })
    const rows = facts(d).files as Array<{ path: string; disposition: string; disposition_detail: string | null }>
    expect(rows.filter((f) => f.disposition === 'failed')).toEqual([{ path: 'huge.mem', disposition: 'failed', disposition_detail: 'memory_budget' }])
    expect(rows.filter((f) => f.disposition === 'indexed')).toHaveLength(6)
    expect(r.counts).toMatchObject({ discovered: 7, indexed: 6, failed: 1 })
    const census = withSnapshot(d, (db) => JSON.parse((db.prepare("select value from meta where key = 'census'").get() as { value: string }).value) as Array<{ files: number; dispositions: { indexed: number; failed: number } }>)
    expect(census.reduce((n, row) => n + row.files, 0)).toBe(7)
    expect(census.reduce((n, row) => n + row.dispositions.failed, 0)).toBe(1)
    expect(withSnapshot(d, (db) => db.prepare("select count(*) as n from symbol s join file f on f.id = s.file_id where f.path = 'huge.mem'").get())).toEqual({ n: 0 })
    expect(tool(d, 'workspace_status', {}).data).toBeDefined()
  }, 120000)

  it('FR272 scenario 2: a budget below what the adapter needs to start fails all its files with memory_budget and restarts nothing', async () => {
    const { d, r } = await index(names(5), 128, { ...MODEL, init_mb: 400 })
    expect((facts(d).files as Array<{ disposition: string; disposition_detail: string | null }>).map((f) => [f.disposition, f.disposition_detail])).toEqual(Array(5).fill(['failed', 'memory_budget']))
    expect(r.counts).toMatchObject({ indexed: 0, failed: 5 })
    expect(r.memoryRestarts).toEqual([{ adapter: 'memlang', budget_mb: 128, peak_rss_mb: expect.any(Number), files: 5, action: 'adapter_failed' }])
  }, 120000)

  it('FR272 scenario 3: after a reindex under a budget its workspace step overruns, no file is answered from the cache of the earlier index', async () => {
    const repo = tmpDir('pm-budget-')
    names(6).forEach((f, i) => fs.writeFileSync(path.join(repo, f), `def fn${i}\n`))
    const d = tmpDir()
    initDataDir(d)
    const c = Catalog.open(d); c.addRepository(repo); c.close()
    process.env.PROOFMESH_ADAPTER_MEMORY_MB = '4096'
    expect((await indexRepository(d, repo, undefined, registry({ ...MODEL, hold_over_mb: 1e9 }))).counts).toMatchObject({ indexed: 6, failed: 0 })
    process.env.PROOFMESH_ADAPTER_MEMORY_MB = '128'
    process.env.PROOFMESH_TEST_ADAPTER_RSS_SAMPLE_MS = '50'
    const lower = await indexRepository(d, repo, undefined, registry({ ...MODEL, workspace_mb: 400 }))
    expect(lower.counts).toMatchObject({ indexed: 0, failed: 6 })
    expect((facts(d).files as Array<{ disposition_detail: string | null }>).every((f) => f.disposition_detail === 'memory_budget')).toBe(true)
    expect(lower.memoryRestarts).toEqual([{ adapter: 'memlang', budget_mb: 128, peak_rss_mb: expect.any(Number), files: 6, action: 'adapter_failed' }])
  }, 120000)
})

describe('FR272 a budget below what any file needs', () => {
  it('FR272 scenario 4: after a run of files that each pass the budget alone the adapter is given up on, so restarts are not one per file', async () => {
    const { d, r } = await index(names(40), 128, { ...MODEL, mb_per_file: 200 })
    expect((facts(d).files as Array<{ disposition: string; disposition_detail: string | null }>).every((f) => f.disposition === 'failed' && f.disposition_detail === 'memory_budget')).toBe(true)
    expect(r.memoryRestarts!.length).toBeLessThan(30)
    expect(r.memoryRestarts!.at(-1)).toMatchObject({ adapter: 'memlang', action: 'adapter_failed' })
  }, 180000)
})

describe('FR275 the benchmark has a large tier', () => {
  const script = path.join(ROOT, 'bench', 'graph-bench', 'run-large.sh')
  it('FR275 scenario 1: run-large.sh is valid shell, pins a repository commit, and reports each figure of the scenario with its median of three runs', () => {
    execFileSync('sh', ['-n', script])
    const text = fs.readFileSync(script, 'utf8')
    expect(text).toMatch(/COMMIT=[0-9a-f]{40}/)
    for (const figure of ['cold index', 'peak memory', 'store size', 're-analysed', 'median of 3', 'seconds per file']) expect(text.toLowerCase()).toContain(figure)
  })
})
