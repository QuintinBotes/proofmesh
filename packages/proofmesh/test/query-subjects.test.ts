// Claims and trace (#50): the subjects of each MCP query (symbol ids and repository paths, never source text), recorded in the
// local catalog beside the query records only where a person turned recording on, grouped by the MCP server's session id, and
// purged with the query records.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { cli, fixtureRepo, indexedDataDir, tmpDir, tool } from './helpers.js'
import { mcpClient } from './mcp-client.js'

type Entry = { seq: number; kind: string; tool: string; path?: string; symbol_id?: string; query_id?: string; snapshot_id?: string; outcome: string }
type Dependent = { id: string; name: string; path: string; depth: number }
type Trail = { session_id: string; recording: boolean; entries: Entry[]; changed: Array<{ id: string; name: string; never_seen: Dependent[]; searched_only: Dependent[]; opened: Dependent[] }> }

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: { envelope: 'compact', ...args } })
  if (r.isError) throw new Error(JSON.stringify(r.content))
  return r.structuredContent as { snapshot: { id: string }; data: Record<string, unknown>; limitations: string[] }
}

/** Snapshot A of the invoicing sample, then B: formatAmount's body changed and dispatch deleted. */
async function setup() {
  const repo = tmpDir('pm-subjects-repo-')
  fs.cpSync(fixtureRepo('ts-invoicing'), repo, { recursive: true })
  const { dataDir, repoId, snapshotId: a } = await indexedDataDir(repo)
  const edit = (file: string, from: RegExp | string, to: string) => fs.writeFileSync(path.join(repo, file), fs.readFileSync(path.join(repo, file), 'utf8').replace(from, to))
  edit('packages/format/src/currency.ts', 'toFixed(2)', 'toFixed(3)')
  edit('packages/api/src/handler.ts', /\nexport function dispatch[\s\S]*$/, '\n')
  const indexed = cli(['--data-dir', dataDir, 'index', repoId])
  expect(indexed.status, indexed.stderr).toBe(0)
  const b = /snapshot (snap_\w+) published/.exec(indexed.stdout)![1]!
  return { repo, dataDir, repoId, a, b }
}

/** The scripted session: search, open, diff, impact and a claim, over one stdio MCP connection. */
async function session(dataDir: string, a: string) {
  const client = await mcpClient(dataDir, '--tools', 'all')
  try {
    await call(client, 'find_symbols', { text: 'invoiceTotal' })
    await call(client, 'get_symbol', { symbol_id: { name: 'handleInvoice', path: 'packages/api/src/handler.ts' } })
    await call(client, 'compare_snapshots', { base_snapshot_id: a })
    const formatAmount = ((await call(client, 'find_symbols', { text: 'formatAmount', path_prefix: 'packages/format' })).data.symbols as Array<{ id: string; path: string }>).find((s) => s.path === 'packages/format/src/currency.ts')!.id
    await call(client, 'analyze_impact', { subject_ids: [formatAmount] })
    await call(client, 'verify_claim', { claim: { statement: 'handleInvoice calls invoiceTotal.', proposition: { type: 'relationship', source: 'function:packages/api/src/handler:handleInvoice', relationship: 'calls', target: 'function:packages/billing/src/invoice:invoiceTotal' } } })
    const records = (await call(client, 'list_queries', {})).data.records as Array<{ tool: string; session_id?: string }>
    return { records, client }
  } catch (e) {
    await client.close()
    throw e
  }
}

const subjectRows = (dataDir: string) => {
  const c = Catalog.open(dataDir)
  try { return c.db.prepare('select * from query_subject').all() as Array<Record<string, unknown>> } finally { c.close() }
}

describe('#50 the subjects of each MCP query, recorded locally by session', () => {
  it('FR1940 FR1944 recording is off by default: no subject is written, the trail says recording is off and how to turn it on (SC-003)', async () => {
    const { dataDir, repoId, a } = await setup()
    const { records, client } = await session(dataDir, a)
    await client.close()
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((r) => r.session_id === undefined)).toBe(true)
    expect(subjectRows(dataDir)).toEqual([])
    const env = tool(dataDir, 'get_session_trail', { session_id: 'mcp_anything' })
    expect(env.data).toMatchObject({ recording: false, entries: [], changed: [] })
    expect(env.limitations.join('\n')).toContain(`proofmesh trail on ${repoId}`)
  }, 240000)

  it('FR1940 FR1941 FR1942 FR1943 with recording on, each step is kept in order with its tool, kind, snapshot and subjects, and the unopened dependents follow across snapshots', async () => {
    const { dataDir, repoId, a, b } = await setup()
    expect(cli(['--data-dir', dataDir, 'trail', 'on', repoId]).status).toBe(0)
    const { records, client } = await session(dataDir, a)
    try {
      // One session id for the connection, on every repository query it answered.
      const ids = new Set(records.map((r) => r.session_id))
      expect(ids.size).toBe(1)
      const sessionId = [...ids][0]!
      expect(sessionId).toMatch(/^mcp_[a-z2-7]{16}$/)
      const trail = await call(client, 'get_session_trail', { session_id: sessionId, snapshot_id: a })
      const data = trail.data as Trail
      const steps = [...new Map(data.entries.map((e) => [e.query_id, e])).values()].map((e) => [e.kind, e.tool, e.snapshot_id])
      expect(steps).toEqual([
        ['searched', 'find_symbols', b], ['opened', 'get_symbol', b], ['changed', 'compare_snapshots', a],
        ['searched', 'find_symbols', b], ['opened', 'analyze_impact', b], ['claimed', 'verify_claim', b],
      ])
      expect(data.entries.map((e) => e.seq)).toEqual(data.entries.map((_, i) => i + 1))
      // The diff's subjects are its base side: the changed formatAmount and the deleted dispatch, which exist in A.
      expect(data.changed.map((c) => c.name).sort()).toEqual(['dispatch', 'formatAmount'])
      const formatAmount = data.changed.find((c) => c.name === 'formatAmount')!
      // invoiceTotal was found by the first search, never opened; handleInvoice was opened in B, matched in A by its stable key.
      expect(formatAmount.searched_only.map((d) => d.name)).toEqual(['invoiceTotal'])
      expect(formatAmount.never_seen).toEqual([])
      // The three lists split the dependents whole, so a client can say how many of them the session never looked at.
      expect(formatAmount.opened.map((d) => d.name)).toEqual(['handleInvoice'])
      expect(trail.limitations.join('\n')).toMatch(/queried 2 snapshots/)

      // On B the deleted symbol is not in the snapshot, and the answer says where to look.
      const onB = await call(client, 'get_session_trail', { session_id: sessionId })
      expect((onB.data as Trail).changed.map((c) => c.name)).toEqual(['formatAmount'])
      expect(onB.limitations.join('\n')).toContain(`1 changed symbol is not in ${b}; pass snapshot_id ${a}`)
    } finally {
      await client.close()
    }
  }, 240000)

  it('FR1941 SC-002 no stored subject is more than a symbol id or a path in the snapshot, none holds a line of the sample, and a recorded query costs at most 200 bytes', async () => {
    const { repo, dataDir, repoId, a } = await setup()
    cli(['--data-dir', dataDir, 'trail', 'on', repoId])
    const { client } = await session(dataDir, a)
    await client.close()
    const rows = subjectRows(dataDir)
    expect(rows.length).toBeGreaterThanOrEqual(6)
    const c = Catalog.open(dataDir)
    const files = new Set<string>()
    for (const s of c.publishedSnapshots(repoId)) {
      const db = (await import('../src/meshstore/snapshot.js')).openSnapshot(c, s)
      for (const f of db.prepare('select path from file').all() as Array<{ path: string }>) files.add(f.path)
      db.close()
    }
    const lines = fs.readdirSync(repo, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(repo, f)).isFile())
      .flatMap((f) => fs.readFileSync(path.join(repo, f), 'utf8').split('\n')).map((l) => l.trim()).filter((l) => l.length > 8)
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['paths', 'query_id', 'session_id', 'snapshot_id', 'symbols'])
      for (const id of JSON.parse(String(row.symbols)) as string[]) expect(id).toMatch(/^sym_[0-9a-f]{24}$/)
      for (const p of JSON.parse(String(row.paths)) as string[]) expect([...files].some((f) => f === p || f.startsWith(`${p}/`)), p).toBe(true)
      for (const value of Object.values(row).filter((v): v is string => typeof v === 'string')) for (const l of lines) expect(value.includes(l), `${value} holds ${l}`).toBe(false)
    }
    // What the subjects add to the catalog file: their table's used bytes, per recorded query.
    const used = (c.db.prepare("select sum(pgsize - unused) n from dbstat where name like 'query_subject%' or name like 'sqlite_autoindex_query_subject%'").get() as { n: number }).n
    c.close()
    expect(used / rows.length).toBeLessThanOrEqual(200)
  }, 240000)

  it('FR1945 turned off, nothing more is recorded; gc past the retention and trail purge delete the subjects with the query records, and the trail says the session is no longer available', async () => {
    const { dataDir, repoId, a } = await setup()
    cli(['--data-dir', dataDir, 'trail', 'on', repoId])
    const first = await session(dataDir, a)
    await first.client.close()
    const n = subjectRows(dataDir).length
    expect(n).toBeGreaterThan(0)
    cli(['--data-dir', dataDir, 'trail', 'off', repoId])
    const second = await session(dataDir, a)
    await second.client.close()
    expect(subjectRows(dataDir)).toHaveLength(n)

    const sessionId = first.records.find((r) => r.session_id)!.session_id!
    expect(cli(['--data-dir', dataDir, 'gc']).stdout).toMatch(/and the subjects of 0 queries\n/)
    expect(subjectRows(dataDir)).toHaveLength(n)
    expect(cli(['--data-dir', dataDir, 'gc', '--records-days', '0']).stdout).toMatch(new RegExp(`and the subjects of ${n} queries\\n`))
    expect(subjectRows(dataDir)).toEqual([])
    const gone = tool(dataDir, 'get_session_trail', { session_id: sessionId })
    expect((gone.data as Trail).entries).toEqual([])
    expect(gone.limitations.join('\n')).toContain(`No step of session ${sessionId} is recorded`)

    cli(['--data-dir', dataDir, 'trail', 'on', repoId])
    const third = await session(dataDir, a)
    await third.client.close()
    const m = subjectRows(dataDir).length
    expect(cli(['--data-dir', dataDir, 'trail', 'purge', '--session', third.records.find((r) => r.session_id)!.session_id!]).stdout).toBe(`deleted 0 trail entries and the subjects of ${m} queries\n`)
    expect(subjectRows(dataDir)).toEqual([])
  }, 300000)
})
