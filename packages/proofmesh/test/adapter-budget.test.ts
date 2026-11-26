import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdapterBudgetError, AdapterProcess, PROTOCOL_VERSION } from '../src/indexer/adapter-host.js'
import { indexRepository, type IndexResult } from '../src/indexer/coordinator.js'
import { Registry } from '../src/indexer/languages.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { ROOT, tmpDir, tool, withSnapshot } from './helpers.js'

const memlang = path.join(import.meta.dirname, 'fake-adapters', 'memlang.mjs')
/** What each file or batch costs the fake adapter, in MB: a batch of four or more small files needs more than the budget of 128 MB. */
const MODEL = { mb_per_file: 30, huge_mb: 400, hold_over_mb: 100 }
const registry = (config: Record<string, number> = MODEL) => new Registry([{ id: 'memlang', languages: new Set(['memlang']), extensions: { '.mem': 'memlang' }, isConfig: () => false, entry: () => memlang, unavailable: () => 'adapter_unavailable:memlang', config: () => config }])

const ENV = ['PROOFMESH_ADAPTER_MEMORY_MB', 'PROOFMESH_ADAPTER_RSS_SAMPLE_MS', 'PROOFMESH_INDEX_BATCH']
afterEach(() => { for (const k of ENV) delete process.env[k] })

async function index(files: string[], budgetMb: number | undefined, config?: Record<string, number>): Promise<{ d: string; r: IndexResult }> {
  const repo = tmpDir('pm-budget-')
  files.forEach((f, i) => fs.writeFileSync(path.join(repo, f), `def fn${i}\n`))
  const d = tmpDir()
  initDataDir(d)
  const c = Catalog.open(d)
  c.addRepository(repo)
  c.close()
  if (budgetMb) process.env.PROOFMESH_ADAPTER_MEMORY_MB = String(budgetMb)
  process.env.PROOFMESH_ADAPTER_RSS_SAMPLE_MS = '20'
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
    const a = new AdapterProcess(memlang, 60000, 20, 'memlang', 128)
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
    expect(r.memoryRestarts ?? []).toEqual([])
  }, 120000)
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
