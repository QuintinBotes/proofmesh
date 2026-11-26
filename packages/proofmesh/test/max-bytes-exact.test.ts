import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { openSnapshot } from '../src/meshstore/snapshot.js'
import { LEAN, runTool } from '../src/query/tools.js'
import type { ProofmeshError } from '../src/core/errors.js'
import { fixtureRepo, indexedDataDir, indexedRepo, ROOT, tmpDir, withSnapshot } from './helpers.js'
import { writeLinkFile } from './helpers-links.js'

type Call = { name: string; input: Record<string, unknown>; dataDir: string }
/** What the caller receives: a lean answer is its text, every other answer its JSON. */
const sent = (a: ReturnType<typeof runTool>) => Buffer.byteLength(a.envelope === 'lean' ? a.text! : JSON.stringify(a))
const refusal = (call: Call, max_bytes: number) => {
  try { runTool(call.dataDir, call.name, { ...call.input, limits: { ...(call.input.limits as object | undefined), max_bytes } }) } catch (e) { return e as ProofmeshError }
  return null
}

/** FR330 FR331: a cut answer is at most max_bytes, whole, or the call is refused. */
function holdsBudget(call: Call): { cut: boolean } {
  const full = runTool(call.dataDir, call.name, call.input)
  const size = sent(full)
  let cut = false
  // From just under the full answer down to a few bytes: every budget is held or refused, never exceeded.
  for (const budget of [size - 1, size - 12, size - 40, Math.floor(size * 0.9), Math.floor(size * 0.7), Math.floor(size * 0.5), Math.floor(size * 0.3), 2500, 900]) {
    if (budget < 1) continue
    const input = { ...call.input, limits: { ...(call.input.limits as object | undefined), max_bytes: budget } }
    let a: ReturnType<typeof runTool>
    try { a = runTool(call.dataDir, call.name, input) } catch (e) {
      expect((e as ProofmeshError).details.detail, `${call.name} at ${budget}: ${(e as Error).message}`).toBe('max_bytes_too_small')
      continue
    }
    expect(sent(a), `${call.name} within max_bytes ${budget}`).toBeLessThanOrEqual(budget)
    if (a.completion.stop_reasons.includes('max_bytes')) {
      expect(a.completion.truncated, `${call.name} at ${budget} says it was cut`).toBe(true)
      cut = true
    }
  }
  return { cut }
}

describe('FR330 FR331 FR332 FR333 FR334 a cut answer is at most max_bytes, note and flags included, or the call is refused (fixtures/change-reach, ts-invoicing)', () => {
  let d: string
  const calls: Array<Omit<Call, 'dataDir'> & { cuts: boolean }> = []
  beforeAll(async () => {
    const repo = fs.realpathSync(tmpDir('pm-maxbytes-'))
    const fx = path.join(ROOT, 'fixtures', 'change-reach')
    fs.cpSync(path.join(fx, 'base'), repo, { recursive: true })
    fs.copyFileSync(path.join(fx, 'tsconfig.json'), path.join(repo, 'tsconfig.json'))
    ;({ dataDir: d } = await indexedDataDir(repo))
    const id = (q: string) => withSnapshot(d, (db) => (db.prepare('select id from symbol where qualified_name = ?').get(q) as { id: string }).id)
    const mean = id('src/stats:mean'), source = id('test/analyst.test:analystScoreDoubles')
    calls.push(
      { name: 'find_symbols', input: { text: 'a' }, cuts: true },
      { name: 'workspace_status', input: {}, cuts: true },
      { name: 'get_relationships', input: { subject_id: mean, direction: 'in' }, cuts: true },
      { name: 'analyze_impact', input: { subject_ids: [mean], limits: { max_depth: 3 } }, cuts: true },
      { name: 'find_tests', input: { subject_ids: [mean] }, cuts: true },
      { name: 'trace_paths', input: { source_id: source, target_id: mean }, cuts: true },
      { name: 'search_sources', input: { text: 'export' }, cuts: true },
      { name: 'get_overview', input: {}, cuts: true },
      { name: 'get_symbol', input: { symbol_id: mean }, cuts: false },
      { name: 'get_claims', input: {}, cuts: false },
      { name: 'get_memory', input: { symbol_id: mean }, cuts: false },
      { name: 'list_queries', input: {}, cuts: false },
    )
    for (const name of [...LEAN]) for (const c of calls.filter((x) => x.name === name)) calls.push({ ...c, cuts: c.cuts && name !== 'trace_paths' && name !== 'find_tests', input: { ...c.input, envelope: 'lean' } })
  }, 240000)

  it('FR330 FR332 every tool that takes max_bytes answers within it at every budget, cut or whole, and says it was cut', () => {
    for (const c of calls) {
      const { cut } = holdsBudget({ ...c, dataDir: d })
      if (c.cuts) expect(cut, `${c.name} ${JSON.stringify(c.input.envelope ?? '')} was cut at some budget`).toBe(true)
    }
  }, 240000)

  it('FR331 FR332 a max_bytes too small for the envelope and its note is refused with max_bytes_too_small, never answered over budget', () => {
    for (const c of calls) {
      const e = refusal({ ...c, dataDir: d }, 40)
      expect(e?.code, `${c.name} ${JSON.stringify(c.input.envelope ?? '')} at 40 bytes`).toBe('INVALID_ARGUMENT')
      expect(e?.details.detail).toBe('max_bytes_too_small')
    }
  })

  it('FR333 search_sources drops whole files and its cursor continues at the first dropped one: no hit is skipped or repeated', async () => {
    // Twelve files of a few matches each, so a page holds several whole files and the cut falls between them.
    const { dataDir: d } = await indexedRepo(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/f${String(i).padStart(2, '0')}.ts`, Array.from({ length: 2 + (i % 3) }, (_, j) => `export const needle${i}x${j} = ${j}`).join('\n') + '\n'])))
    const all = (runTool(d, 'search_sources', { text: 'needle', limits: { max_bytes: 1048576, max_rows: 1000 } }).data as { hits: Array<{ path: string; line: number }> }).hits
    // A budget that holds the envelope and the largest file's hits, so each page is whole files.
    const perFile = new Map<string, number>()
    for (const h of all) perFile.set(h.path, (perFile.get(h.path) ?? 0) + Buffer.byteLength(JSON.stringify(h)) + 1)
    const budget = sent(runTool(d, 'search_sources', { text: 'zzz-no-match' })) + Math.max(...perFile.values()) + 500
    expect(Buffer.byteLength(JSON.stringify(all))).toBeGreaterThan(budget)
    const got: Array<{ path: string; line: number }> = []
    let cursor: string | undefined, pages = 0
    do {
      const a = runTool(d, 'search_sources', { text: 'needle', limits: { max_bytes: budget }, ...(cursor ? { cursor } : {}) })
      expect(sent(a)).toBeLessThanOrEqual(budget)
      got.push(...(a.data as { hits: typeof all }).hits)
      cursor = a.completion.next_cursor ?? undefined
      pages++
    } while (cursor && pages < 100)
    expect(pages).toBeGreaterThan(1)
    expect(got).toEqual(all)
  }, 240000)

  it('FR334 get_ecosystem holds max_bytes with its note and flags, or is refused', async () => {
    const dd = tmpDir()
    initDataDir(dd)
    const members: Array<{ repository_id: string; snapshot_id: string; name: string; fns: string[] }> = []
    for (const [fixture, name] of [['ts-invoicing', 'alpha'], ['ts-packages', 'beta']] as const) {
      const repo = tmpDir(`pm-eco-${name}-`)
      fs.cpSync(fixtureRepo(fixture), repo, { recursive: true })
      const c = Catalog.open(dd)
      const rid = c.addRepository(repo, name).id
      c.close()
      const { snapshotId } = await indexRepository(dd, rid)
      const c2 = Catalog.open(dd)
      const db = openSnapshot(c2, c2.snapshot(snapshotId)!)
      const fns = (db.prepare("select id from symbol where kind = 'function' order by qualified_name limit 6").all() as Array<{ id: string }>).map((f) => f.id)
      db.close(); c2.close()
      members.push({ repository_id: rid, snapshot_id: snapshotId, name, fns })
    }
    const c = Catalog.open(dd)
    c.addToWorkspace('shop', members.map((m) => m.repository_id), 'test')
    c.close()
    const links = members.flatMap((m) => (['calls_endpoint', 'messages'] as const).flatMap((type) => m.fns.map((fn) => ({ type, rule: type === 'messages' ? 'messaging' : 'http_route', source: [m.repository_id, fn] as [string, string], confidence: 1, resolution: 'unresolved' as const, reason: 'no_match' }))))
    writeLinkFile(dd, 'shop', members, links as never, { http_route: '1', messaging: '1' })
    const call = { name: 'get_ecosystem', input: { workspace: 'shop' }, dataDir: dd }
    expect(holdsBudget(call).cut).toBe(true)
    expect(refusal(call, 40)?.details.detail).toBe('max_bytes_too_small')
  }, 240000)
})
