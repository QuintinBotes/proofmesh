import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ProofmeshError } from '../src/core/errors.js'
import { check } from '../src/core/schemas.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { openSnapshot } from '../src/meshstore/snapshot.js'
import { fixtureRepo, tmpDir, tool } from './helpers.js'
import { writeLinkFile } from './helpers-links.js'

type Member = { repository_id: string; snapshot_id: string; name: string; fn: [string, string]; key: string; symbols: number; files_indexed: number }

/** Two indexed TypeScript repositories in one workspace, each with one function symbol picked as a link end. */
async function workspace() {
  const d = tmpDir()
  initDataDir(d)
  const members: Member[] = []
  for (const [fixture, name] of [['ts-invoicing', 'alpha'], ['ts-packages', 'beta']] as const) {
    const repo = tmpDir(`pm-eco-${name}-`)
    fs.cpSync(fixtureRepo(fixture), repo, { recursive: true })
    const c = Catalog.open(d)
    const id = c.addRepository(repo, name).id
    c.close()
    const { snapshotId } = await indexRepository(d, id)
    members.push({ repository_id: id, snapshot_id: snapshotId, name, ...inSnapshot(d, snapshotId, (db) => ({
      fn: [(db.prepare("select id, qualified_name from symbol where kind = 'function' order by qualified_name limit 1").get() as { id: string; qualified_name: string }).id, (db.prepare("select qualified_name from symbol where kind = 'function' order by qualified_name limit 1").get() as { qualified_name: string }).qualified_name] as [string, string],
      key: (db.prepare("select stable_key from symbol where kind = 'function' order by qualified_name limit 1").get() as { stable_key: string }).stable_key,
      symbols: (db.prepare('select count(*) as n from symbol').get() as { n: number }).n,
      files_indexed: (db.prepare("select count(*) as n from file where disposition = 'indexed'").get() as { n: number }).n,
    })) })
  }
  const c = Catalog.open(d)
  c.addToWorkspace('shop', members.map((m) => m.repository_id), 'test')
  c.close()
  return { d, members, repos: members.map((m) => m.repository_id) }
}
function inSnapshot<T>(d: string, snapshotId: string, fn: (db: Database.Database) => T): T {
  const c = Catalog.open(d)
  try { const db = openSnapshot(c, c.snapshot(snapshotId)!); try { return fn(db) } finally { db.close() } } finally { c.close() }
}
const links = (a: Member, b: Member) => [
  { type: 'calls_endpoint', rule: 'http_route', source: [a.repository_id, a.fn[0]] as [string, string], target: [b.repository_id, b.fn[0]] as [string, string], confidence: 1, resolution: 'resolved' as const },
  { type: 'calls_endpoint', rule: 'http_route', source: [a.repository_id, a.fn[0]] as [string, string], confidence: 0.6, resolution: 'candidate' as const, reason: 'ambiguous', candidates: [[b.repository_id, b.fn[0], 0.6] as [string, string, number]] },
  { type: 'calls_endpoint', rule: 'http_route', source: [a.repository_id, a.fn[0]] as [string, string], confidence: 1, resolution: 'unresolved' as const, reason: 'no_match' },
  { type: 'messages', rule: 'messaging', source: [b.repository_id, b.fn[0]] as [string, string], target: [a.repository_id, a.fn[0]] as [string, string], confidence: 1, resolution: 'resolved' as const },
]
const fail = (f: () => unknown) => { try { f() } catch (e) { return e as ProofmeshError } throw new Error('expected a ProofmeshError') }

describe('A11 A28 get_ecosystem: a workspace as nodes and links, from one sealed link file and its member snapshots', () => {
  it('reports members, links aggregated per pair and type, and unmatched client facts as boundaries, exactly as the link file says', async () => {
    const { d, members: [a, b] } = await workspace()
    const record = writeLinkFile(d, 'shop', [a!, b!], links(a!, b!), { http_route: '1', messaging: '1' })
    const env = tool(d, 'get_ecosystem', { workspace: 'shop' })
    expect(check('envelope.schema.json', env)).toBeUndefined()
    expect(check('tools/get_ecosystem.data.schema.json', env.data)).toBeUndefined()
    expect(env.snapshot).toEqual({ id: record.id, repository_id: 'ws_shop', analysis_mode: 'no_execution', published_at: record.sealed_at, members: [{ repository_id: a!.repository_id, snapshot_id: a!.snapshot_id }, { repository_id: b!.repository_id, snapshot_id: b!.snapshot_id }] })
    // beta's two package.json files name ts-packages and @fx/util, so the build adapter declares two projects (FR124); alpha's name none.
    const member = (m: Member) => ({ repository_id: m.repository_id, name: m.name, snapshot_id: m.snapshot_id, current: true, symbols: m.symbols, files_indexed: m.files_indexed, endpoints: 0, channels: 0, projects: m.name === 'beta' ? 2 : 0 })
    expect(env.data).toEqual({
      workspace: { name: 'shop', link_file_id: record.id, sealed_at: record.sealed_at, rules: { http_route: '1', messaging: '1' } },
      members: [member(a!), member(b!)].sort((x, y) => (x.repository_id < y.repository_id ? -1 : 1)),
      links: [
        { source_repository_id: a!.repository_id, target_repository_id: b!.repository_id, type: 'calls_endpoint', resolved: 1, candidate: 1, min_confidence: 0.6, max_confidence: 1, sample: [
          { link_id: 'lk_0000', source: a!.fn[1], source_key: a!.key, target: b!.fn[1], target_key: b!.key, confidence: 1, rule: 'http_route' }, { link_id: 'lk_0001', source: a!.fn[1], source_key: a!.key, target: b!.fn[1], target_key: b!.key, confidence: 0.6, rule: 'http_route' },
        ] },
        { source_repository_id: b!.repository_id, target_repository_id: a!.repository_id, type: 'messages', resolved: 1, candidate: 0, min_confidence: 1, max_confidence: 1, sample: [{ link_id: 'lk_0003', source: b!.fn[1], source_key: b!.key, target: a!.fn[1], target_key: a!.key, confidence: 1, rule: 'messaging' }] },
      ].sort((x, y) => (x.source_repository_id < y.source_repository_id ? -1 : 1)),
      boundaries: [{ repository_id: a!.repository_id, type: 'calls_endpoint', count: 1, sample: [{ link_id: 'lk_0002', source: a!.fn[1], source_key: a!.key, reason: 'no_match' }] }],
    })
    expect(env.unresolved).toEqual({ count: 1, scope: 'query', sample: [], by_reason: { no_match: 1 } })
    expect(env.coverage!.files_discovered).toBeGreaterThan(0)
    expect(env.limitations.some((l) => l.includes('1 client fact matched nothing'))).toBe(true)
    expect(tool(d, 'get_ecosystem', { workspace: 'shop', link_file_id: record.id }).snapshot!.id).toBe(record.id)
  }, 240000)

  it('a re-indexed member is marked current: false until the workspace is linked again, and the pinned link file still answers', async () => {
    const { d, members: [a, b] } = await workspace()
    const record = writeLinkFile(d, 'shop', [a!, b!], links(a!, b!))
    const repo = Catalog.open(d).repository(a!.repository_id).root
    fs.appendFileSync(path.join(repo, 'packages/format/src/currency.ts'), '\n// changed\n')
    const after = await indexRepository(d, a!.repository_id)
    expect(after.snapshotId).not.toBe(a!.snapshot_id)
    const env = tool(d, 'get_ecosystem', { workspace: 'shop' })
    expect(env.snapshot!.id).toBe(record.id)
    expect((env.data as { members: Array<{ repository_id: string; current: boolean; snapshot_id: string }> }).members.map((m) => [m.repository_id, m.snapshot_id, m.current])).toEqual([[a!.repository_id, a!.snapshot_id, false], [b!.repository_id, b!.snapshot_id, true]].sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)))
  }, 240000)

  it('refuses an unknown workspace, a workspace without a link file, a link file of another workspace, strict freshness, and a tampered file', async () => {
    const { d, members: [a, b] } = await workspace()
    expect(fail(() => tool(d, 'get_ecosystem', { workspace: 'nope' })).code).toBe('NOT_FOUND')
    expect(fail(() => tool(d, 'get_ecosystem', { workspace: 'shop' }))).toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE', details: { detail: 'none' } })
    const record = writeLinkFile(d, 'shop', [a!, b!], links(a!, b!))
    const c = Catalog.open(d); c.addToWorkspace('other', [a!.repository_id], 'test'); c.close()
    expect(fail(() => tool(d, 'get_ecosystem', { workspace: 'other', link_file_id: record.id }))).toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
    expect(fail(() => tool(d, 'get_ecosystem', { workspace: 'shop', freshness: 'strict' }))).toMatchObject({ code: 'INVALID_ARGUMENT' })
    const tampered = writeLinkFile(d, 'shop', [a!, b!], links(a!, b!), { http_route: '2' })
    const file = path.join(d, 'links', `${tampered.id}.db`)
    fs.chmodSync(file, 0o644); fs.appendFileSync(file, Buffer.alloc(4096))
    expect(fail(() => tool(d, 'get_ecosystem', { workspace: 'shop', link_file_id: tampered.id }))).toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE', details: { detail: 'digest_mismatch' } })
  }, 240000)
})
