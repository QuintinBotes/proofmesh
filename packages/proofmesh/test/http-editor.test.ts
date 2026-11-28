import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { sha256File } from '../src/core/hash.js'
import { serveHttp } from '../src/mcp/server.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { sealedPath } from '../src/meshstore/snapshot.js'
import { fixtureRepo, indexedDataDir, tmpDir } from './helpers.js'

let root: string, dataDir: string, snapshotId: string, repoId: string
beforeAll(async () => {
  root = tmpDir()
  fs.cpSync(fixtureRepo('session-edit'), root, { recursive: true })
  ;({ dataDir, snapshotId, repoId } = await indexedDataDir(root))
})
afterEach(() => vi.unstubAllEnvs())

async function connect(host: Awaited<ReturnType<typeof serveHttp>>) {
  const transport = new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { Authorization: `Bearer ${host.token}` } } })
  const client = new Client({ name: 'http-editor-test', version: '1' })
  await client.connect(transport)
  return { client, transport }
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args })
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy()
  return r.structuredContent as Record<string, any>
}
function apply(client: Client, callee: string) {
  const file = path.join(root, 'targets.ts')
  return call(client, 'apply_edit', { snapshot_id: snapshotId, path: 'targets.ts', base_hash: sha256File(file),
    content: fs.readFileSync(file, 'utf8').replace('choose() { return A()', `choose() { return ${callee}()`) })
}
async function evidence(client: Client) {
  const answer = await call(client, 'get_relationships', { subject_id: { name: 'choose', path: 'targets.ts' }, direction: 'out', envelope: 'full' })
  const edge = answer.data.relationships[0]
  const proof = await call(client, 'read_evidence', { evidence_ids: edge.evidence_ids })
  expect(proof.snapshot.id).toBe(answer.snapshot.id)
  expect(proof.edit).toEqual(answer.edit)
  return [edge.other.name, proof.data.evidence[0].text, answer.snapshot.id]
}
const privateGraphs = (dir: string) => fs.readdirSync(dir).filter(name => name.startsWith('proofmesh-edit-'))
function fingerprint() {
  const catalog = Catalog.open(dataDir)
  try { return [sha256File(path.join(root, 'targets.ts')), sha256File(sealedPath(dataDir, snapshotId)), catalog.currentSnapshot(repoId)?.id] }
  finally { catalog.close() }
}

it('FR3004 isolates three clients of one HTTP server and releases each private graph on discard or DELETE', async () => {
  const temp = tmpDir()
  vi.stubEnv('TMPDIR', temp)
  const before = fingerprint(), host = await serveHttp(dataDir, 'test', 0, ['core'], {})
  const [one, two, baseline] = await Promise.all([connect(host), connect(host), connect(host)])
  try {
    expect(new Set([one.transport.sessionId, two.transport.sessionId, baseline.transport.sessionId]).size).toBe(3)
    const [first, second] = await Promise.all([apply(one.client, 'B'), apply(two.client, 'obsolete')])
    expect(await evidence(one.client)).toEqual(['B', 'B()', first.snapshot_id])
    expect(await evidence(two.client)).toEqual(['obsolete', 'obsolete()', second.snapshot_id])
    expect(await evidence(baseline.client)).toEqual(['A', 'A()', snapshotId])
    expect(privateGraphs(temp)).toHaveLength(2)
    const stale = await one.client.callTool({ name: 'apply_edit', arguments: { snapshot_id: snapshotId, path: 'targets.ts', base_hash: '0'.repeat(64), content: '' } })
    expect(stale.structuredContent).toMatchObject({ error: { code: 'STALE_INPUT' } })
    expect(await evidence(one.client)).toEqual(['B', 'B()', first.snapshot_id])

    const headers = { Authorization: `Bearer ${host.token}`, 'mcp-session-id': two.transport.sessionId! }
    expect((await fetch(host.url, { method: 'DELETE', headers: { ...headers, Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(host.url, { method: 'DELETE', headers: { ...headers, Origin: 'https://example.org' } })).status).toBe(403)
    expect(await evidence(two.client)).toEqual(['obsolete', 'obsolete()', second.snapshot_id])
    await call(one.client, 'discard_edit', {})
    expect(await evidence(one.client)).toEqual(['A', 'A()', snapshotId])
    expect(privateGraphs(temp)).toHaveLength(1)
    await two.transport.terminateSession()
    expect(privateGraphs(temp)).toEqual([])
    const gone = await fetch(host.url, { method: 'DELETE', headers })
    expect(gone.status).toBe(404)
    expect((await gone.json()).error.message).toMatch(/initialize/i)
    expect(fingerprint()).toEqual(before)
  } finally {
    await Promise.all([one.client.close(), two.client.close(), baseline.client.close()])
    await host.close()
  }
})

it('FR3004 reclaims abandoned edits after inactivity and live edits at server shutdown', async () => {
  const temp = tmpDir()
  vi.stubEnv('TMPDIR', temp)
  const host = await serveHttp(dataDir, 'test', 0, ['core'], { idleMs: 1000 })
  try {
    const abandoned = await connect(host)
    await apply(abandoned.client, 'B')
    const id = abandoned.transport.sessionId!
    await abandoned.client.close()
    await vi.waitFor(() => expect(privateGraphs(temp)).toEqual([]), { timeout: 5000 })
    expect((await fetch(host.url, { method: 'DELETE', headers: { Authorization: `Bearer ${host.token}`, 'mcp-session-id': id } })).status).toBe(404)
    const live = await connect(host)
    try { await apply(live.client, 'B'); expect(privateGraphs(temp)).toHaveLength(1) }
    finally { await live.client.close() }
  } finally { await host.close() }
  expect(privateGraphs(temp)).toEqual([])
})
