import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { indexRepository } from '../src/indexer/coordinator.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import type { ProofmeshError } from '../src/core/errors.js'
import { indexedDataDir, tmpDir, tool } from './helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })

describe('AC20 FR015 limits', () => {
  it('clamps values above the server maxima and reports both', () => {
    const env = tool(d, 'find_symbols', { text: 'format', limits: { max_rows: 5000, max_depth: 99 } })
    expect(env.limits.requested).toEqual({ max_rows: 5000, max_depth: 99 })
    expect(env.limits.applied).toEqual({ timeout_ms: 10000, max_rows: 1000, max_bytes: 65536, max_depth: 12 })
    expect(env.limitations).toEqual(expect.arrayContaining(['Requested max_rows 5000 exceeds the server maximum; applied 1000.', 'Requested max_depth 99 exceeds the server maximum; applied 12.']))
  })

  it('rejects an unknown freshness mode as INVALID_ARGUMENT', () => {
    expect(() => tool(d, 'workspace_status', { freshness: 'eventual' })).toThrow('invalid input')
  })

  it('max_bytes shrinks list results and reports it', () => {
    const budget = Buffer.byteLength(JSON.stringify(tool(d, 'workspace_status'))) - 600
    const env = tool(d, 'workspace_status', { limits: { max_bytes: budget } })
    expect(Buffer.byteLength(JSON.stringify(env))).toBeLessThanOrEqual(budget)
    expect(env.completion.stop_reasons).toContain('max_bytes')
  })

  it('a call with the wrong property names is refused with the names the tool accepts', () => {
    expect(() => tool(d, 'find_symbols', { query: 'x' } as any)).toThrow(/must have required property 'text'; find_symbols accepts repository_id, /)
  })

  it('every envelope states the reference limitation of its snapshot', () => {
    expect(tool(d, 'workspace_status').limitations).toContain('References other than calls and imports are recorded only where an adapter supports them (C# uses of repository declarations, TypeScript uses of repository types); elsewhere a missing reference is not evidence of no use.')
  })
})

describe('FR015 a query answers from exactly the repository, snapshot and path it names, or refuses', () => {
  const refusal = (run: () => unknown) => { try { run() } catch (e) { return (e as ProofmeshError).code } return 'answered' }
  const paths = (env: ReturnType<typeof tool>) => (env.data.files as Array<{ path: string }>).map((f) => f.path)
  const names = (input: Record<string, unknown>) => (tool(d, 'find_symbols', input).data.symbols as Array<{ qualified_name: string }>).map((s) => s.qualified_name)

  it('a pinned older snapshot answers as itself, and a snapshot of another repository is refused, never swapped for one in scope', async () => {
    const data = tmpDir()
    initDataDir(data)
    const a = tmpDir('pm-scope-a-'), b = tmpDir('pm-scope-b-')
    fs.writeFileSync(path.join(a, 'a.txt'), 'a\n')
    fs.writeFileSync(path.join(b, 'b.txt'), 'b\n')
    const c = Catalog.open(data)
    const repoA = c.addRepository(a).id, repoB = c.addRepository(b).id
    c.close()
    const older = (await indexRepository(data, repoA)).snapshotId
    fs.writeFileSync(path.join(a, 'later.txt'), 'later\n')
    const current = (await indexRepository(data, repoA)).snapshotId
    const other = (await indexRepository(data, repoB)).snapshotId

    const pinned = tool(data, 'workspace_status', { repository_id: repoA, snapshot_id: older, files: {} })
    expect([pinned.snapshot!.id, paths(pinned)]).toEqual([older, ['a.txt']])
    const latest = tool(data, 'workspace_status', { repository_id: repoA, files: {} })
    expect([latest.snapshot!.id, paths(latest)]).toEqual([current, ['a.txt', 'later.txt']])
    expect(refusal(() => tool(data, 'workspace_status', { repository_id: repoA, snapshot_id: other }))).toBe('SNAPSHOT_UNAVAILABLE')
    expect(() => tool(data, 'workspace_status', { repository_id: repoA, snapshot_id: other })).toThrow(new RegExp(`snapshot ${other} belongs to repository repo_[0-9a-z]+ .*not ${repoA}`))
    expect(refusal(() => tool(data, 'workspace_status', { snapshot_id: other }))).toBe('INVALID_ARGUMENT')
  }, 120000)

  it('a path prefix answers from that prefix alone, and from nothing when it matches nothing', () => {
    expect(names({ text: 'formatAmount' })).toEqual(['packages/format/src/currency:formatAmount', 'packages/legacy/src/format:formatAmount'])
    expect(names({ text: 'formatAmount', path_prefix: 'packages/legacy/' })).toEqual(['packages/legacy/src/format:formatAmount'])
    expect(names({ text: 'formatAmount', path_prefix: 'packages/nowhere/' })).toEqual([])
    expect(tool(d, 'find_symbols', { text: 'formatAmount', path_prefix: 'packages/nowhere/' }).limitations).toContain('No indexed file is under path_prefix packages/nowhere/; the search covered nothing.')
    expect(tool(d, 'search_sources', { text: 'formatAmount', path_prefix: 'packages/nowhere/' }).data).toMatchObject({ hits: [], files_scanned: 0, files_total: 0 })
  })
})
