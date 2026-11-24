import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startViewServer, type ViewServer } from '../src/http/server.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { buildLinkFile } from '../src/links/index.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { copyFixture, indexedDataDir, ROOT } from './helpers.js'
import { mcpClient } from './mcp-client.js'

// Observatory reads four routes that are not MCP tools (FR055). Each test shows the route answers with data an MCP client gets from
// the tools on the same snapshot; where no tool lists something the route lists, the test title says so.
let d: string, repoId: string, s: ViewServer, client: Client, cookie: string

function request(method: string, p: string, body?: unknown): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers: { host: `127.0.0.1:${s.port}`, origin: s.url, 'content-type': 'application/json', cookie } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}
// Two repositories are registered, so every route and tool is asked about one by id, as Observatory does once drilled in.
const route = async (method: string, p: string, body?: Record<string, unknown>) => { const r = await request(method, p, body && { repository_id: repoId, ...body }); expect(r.status, `${p}: ${r.body}`).toBe(200); return r.body }
const UNSCOPED = new Set(['list_workspaces', 'list_repositories', 'get_ecosystem'])
const mcp = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: { ...args, ...(UNSCOPED.has(name) ? {} : { repository_id: repoId }), envelope: 'full' } })
  expect(r.isError, `${name}: ${JSON.stringify(r.content)}`).toBeFalsy()
  return r.structuredContent as any
}

/** The Galaxy payload as galaxy.ts lays it out: u32 header length, the JSON header, padding to four bytes, then each section at its offset. */
function decodeGalaxy(gz: Buffer) {
  const buf = zlib.gunzipSync(gz)
  const length = buf.readUInt32LE(0)
  const header = JSON.parse(buf.subarray(4, 4 + length).toString('utf8'))
  const base = 4 + length + ((4 - ((4 + length) % 4)) % 4)
  const section = (offset: number) => base + offset
  const links: Array<[number, number]> = []
  for (let i = 0; i < header.links; i++) links.push([buf.readUInt32LE(section(header.offsets.links) + 8 * i), buf.readUInt32LE(section(header.offsets.links) + 8 * i + 4)])
  const kind = [...buf.subarray(section(header.offsets.kind), section(header.offsets.kind) + header.nodes)].map((k) => header.kinds[k] as string)
  const names = buf.subarray(section(header.offsets.names), section(header.offsets.names) + header.names_bytes).toString('utf8').split('\n')
  return { header, links, kind, names }
}
const areaOf = (p: string) => { const dirs = p.split('/').slice(0, -1); return dirs.length ? dirs.slice(0, 3).join('/') : '(root)' }

beforeAll(async () => {
  const repo = copyFixture()
  ;({ dataDir: d, repoId } = await indexedDataDir(repo))
  // A second published snapshot, so the snapshot list has history to agree on.
  fs.appendFileSync(path.join(repo, 'packages', 'billing', 'src', 'invoice.ts'), '\nexport function invoiceCount(lines: unknown[]): number { return lines.length }\n')
  await indexRepository(d, repoId)
  // A workspace needs two members to be linked.
  const catalog = Catalog.open(d)
  const twinId = catalog.addRepository(copyFixture(), 'twin').id
  catalog.close()
  await indexRepository(d, twinId)
  const c = Catalog.open(d)
  try { c.addToWorkspace('pair', [repoId, twinId], 'test'); buildLinkFile(c, d, 'pair') } finally { c.close() }
  s = await startViewServer(d, 0)
  client = await mcpClient(d)
  const r = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/session', headers: { host: `127.0.0.1:${s.port}`, origin: s.url, 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(String(res.headers['set-cookie']).split(';')[0]!) })
    req.on('error', reject)
    req.end(JSON.stringify({ token: s.issueToken() }))
  })
  cookie = r
}, 180000)
afterAll(async () => { await s?.close(); await client?.close() })

describe('FR055 Observatory is built only on what other clients can get: its non-tool routes agree with the MCP tools', () => {
  it('FR055 /api/v1/galaxy and /api/v1/galaxy/symbol: every point is a symbol find_symbols returns with the same name and kind, and every line a resolved relationship get_relationships returns', async () => {
    const g = decodeGalaxy(await route('POST', '/api/v1/galaxy', {}))
    const ids = await Promise.all(g.names.map(async (_, i) => JSON.parse((await route('POST', '/api/v1/galaxy/symbol', { index: i })).toString()).id as string))
    expect(ids.length).toBeGreaterThan(5)

    // Every qualified name holds a ':' between its file and its name, so this pages through every symbol of the snapshot.
    const symbols = new Map<string, { qualified_name: string; kind: string }>()
    for (let cursor: string | null = null, first = true; first || cursor; first = false) {
      const env = await mcp('find_symbols', { text: ':', limits: { max_rows: 200 }, ...(cursor ? { cursor } : {}) })
      for (const x of env.data.symbols) if (x.kind !== 'module') symbols.set(x.id, { qualified_name: x.qualified_name, kind: x.kind })
      cursor = env.completion.next_cursor
    }
    expect(new Map(ids.map((id, i) => [id, { qualified_name: g.names[i]!, kind: g.kind[i]! }]))).toEqual(symbols)

    const types = (JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'tools', 'get_relationships.input.schema.json'), 'utf8')).properties.types.items.enum as string[]).filter((t) => t !== 'contains')
    const inGalaxy = new Set(ids), viaMcp = new Set<string>()
    for (const id of ids) {
      const env = await mcp('get_relationships', { subject_id: id, direction: 'out', types, resolutions: ['resolved'], limits: { max_rows: 1000 } })
      expect(env.completion.truncated).toBe(false)
      for (const r of env.data.relationships) if (r.other.kind === 'symbol' && r.other.id !== id && inGalaxy.has(r.other.id)) viaMcp.add(`${id} -> ${r.other.id}`)
    }
    expect(new Set(g.links.map(([a, b]) => `${ids[a]} -> ${ids[b]}`))).toEqual(viaMcp)
    expect(viaMcp.size).toBeGreaterThan(0)
  })

  it('FR055 /api/v1/galaxy areas: files by disposition, call sites and unresolved calls, and the reasons files were not analysed, all as workspace_status gives them', async () => {
    const { header } = decodeGalaxy(await route('POST', '/api/v1/galaxy', {}))
    const status = await mcp('workspace_status', { files: {}, limits: { max_rows: 1000 } })
    expect(status.completion.truncated).toBe(false)
    const KEY: Record<string, string> = { indexed: 'indexed', unsupported: 'unsupported', excluded_by_rule: 'excluded', failed: 'failed', pending: 'pending' }
    const byArea = new Map<string, { files: Record<string, number>; gaps: Map<string, number> }>()
    for (const f of status.data.files as Array<{ path: string; disposition: string; detail: string | null }>) {
      const a = byArea.get(areaOf(f.path)) ?? { files: { indexed: 0, unsupported: 0, excluded: 0, failed: 0, pending: 0 } as Record<string, number>, gaps: new Map<string, number>() }
      a.files[KEY[f.disposition]!]!++
      if (f.disposition !== 'indexed') a.gaps.set(f.detail ?? f.disposition, (a.gaps.get(f.detail ?? f.disposition) ?? 0) + 1)
      byArea.set(areaOf(f.path), a)
    }
    expect(Object.fromEntries(header.areas.map((a: any) => [a.name, a.files]))).toEqual(Object.fromEntries([...byArea].map(([name, a]) => [name, a.files])))
    for (const a of header.areas) for (const [reason, n] of a.gaps) expect(byArea.get(a.name)!.gaps.get(reason), `${a.name} ${reason}`).toBe(n)
    const sum = (k: 'sites' | 'unresolved') => header.areas.reduce((n: number, a: any) => n + a.calls[k], 0)
    expect({ sites: sum('sites'), unresolved: sum('unresolved') }).toEqual({ sites: status.data.calls.sites, unresolved: status.data.calls.unresolved })
    expect(status.data.calls.sites).toBeGreaterThan(0)
  })

  it('FR055 /api/v1/snapshots: each listed snapshot\'s id, analysis mode, publication time, commit and current flag are what workspace_status and list_repositories say, and the route is list_snapshots\' data', async () => {
    const listed = JSON.parse((await route('POST', '/api/v1/snapshots', {})).toString()).snapshots as Array<{ id: string; published_at: string; analysis_mode: string; current: boolean; git: { commit?: string } | null }>
    expect(listed).toEqual((await mcp('list_snapshots', { repository_id: repoId })).data.snapshots)
    expect(listed).toHaveLength(2)
    const current = (await mcp('list_repositories', {})).data.repositories.find((r: { id: string }) => r.id === repoId).snapshot.id
    for (const snap of listed) {
      const env = await mcp('workspace_status', { snapshot_id: snap.id, limits: { max_rows: 1 } })
      expect({ id: snap.id, analysis_mode: snap.analysis_mode, published_at: snap.published_at, commit: snap.git?.commit ?? null, current: snap.current })
        .toEqual({ id: env.snapshot.id, analysis_mode: env.snapshot.analysis_mode, published_at: env.snapshot.published_at, commit: env.snapshot.commit, current: env.snapshot.id === current })
    }
    expect(listed.filter((x) => x.current).map((x) => x.id)).toEqual([current])
    const [newer, older] = listed
    expect((await mcp('compare_snapshots', { base_snapshot_id: older!.id, snapshot_id: newer!.id })).data.symbols.added.map((x: { qualified_name: string }) => x.qualified_name)).toContain('packages/billing/src/invoice:invoiceCount')
  })

  it('FR055 /api/workspaces: each workspace\'s members are the ones get_ecosystem returns, named as list_repositories names them, and the route is list_workspaces\' data', async () => {
    const workspaces = JSON.parse((await route('GET', '/api/workspaces')).toString()).workspaces as Array<{ name: string; members: Array<{ repository_id: string; name: string }> }>
    expect(workspaces).toEqual((await mcp('list_workspaces', {})).data.workspaces)
    expect(workspaces.map((w) => w.name)).toEqual(['pair'])
    expect(workspaces[0]!.members).toHaveLength(2)
    const names = new Map((await mcp('list_repositories', {})).data.repositories.map((r: { id: string; name: string }) => [r.id, r.name]))
    for (const w of workspaces) {
      const eco = await mcp('get_ecosystem', { workspace: w.name })
      expect(w.members).toEqual(eco.data.members.map((m: { repository_id: string; name: string }) => ({ repository_id: m.repository_id, name: m.name })))
      for (const m of w.members) expect(names.get(m.repository_id)).toBe(m.name)
    }
  })
})
