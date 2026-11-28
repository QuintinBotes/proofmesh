import fs from 'node:fs'
import path from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { expect, it } from 'vitest'
import { sha256File } from '../src/core/hash.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { sealedPath } from '../src/meshstore/snapshot.js'
import { fixtureRepo, indexedDataDir, tmpDir } from './helpers.js'
import { mcpClient } from './mcp-client.js'

it('FR3003 isolates an unsaved edit, its callers, test reach and evidence across real MCP connections', async () => {
  const root = tmpDir(), fixture = fixtureRepo('session-edit')
  fs.cpSync(fixture, root, { recursive: true })
  const { dataDir, repoId, snapshotId } = await indexedDataDir(root)
  // Only the sealed test called choose. Reading the live worktree would silently lose that test path.
  fs.writeFileSync(path.join(root, 'consumer.test.ts'), 'export function testChoose() { return 0 }')
  const digest = () => {
    const catalog = Catalog.open(dataDir)
    try { return [sha256File(path.join(root, 'targets.ts')), sha256File(path.join(root, 'consumer.test.ts')), sha256File(sealedPath(dataDir, snapshotId)), catalog.currentSnapshot(repoId)?.id] }
    finally { catalog.close() }
  }
  const before = digest(), base_hash = before[0]!
  const edited = fs.readFileSync(path.join(fixture, '..', 'edited.txt'), 'utf8')
  const apply = { path: 'targets.ts', snapshot_id: snapshotId, base_hash, content: edited }
  const writer = await mcpClient(dataDir, '--editor'), reader = await mcpClient(dataDir, '--editor')
  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const response = await c.callTool({ name, arguments: args })
    expect(response.isError, JSON.stringify(response.structuredContent)).toBeFalsy()
    return response.structuredContent as Record<string, any>
  }
  const symbol = async (c: Client, name: string) => {
    const answer = await call(c, 'find_symbols', { text: name, envelope: 'full' })
    return answer.data.symbols.find((s: any) => s.name === name)
  }
  const outbound = async (c: Client) => {
    const s = await symbol(c, 'choose')
    const answer = await call(c, 'get_relationships', { subject_id: s.id, direction: 'out', envelope: 'full' })
    const edge = answer.data.relationships[0]
    const proof = await call(c, 'read_evidence', { evidence_ids: edge.evidence_ids })
    return { callee: edge.other.name, text: proof.data.evidence[0].text, edit: proof.edit, snapshot: proof.snapshot.id }
  }
  try {
    expect((await writer.listTools()).tools.map(t => t.name)).toContain('apply_edit')
    expect((await call(writer, 'apply_edit', apply)).edit).toMatchObject({ revision: 1, base_snapshot_id: snapshotId, repository_id: repoId })
    const active = await outbound(writer)
    expect(active).toMatchObject({ callee: 'B', text: 'B()', edit: { revision: 1, path: 'targets.ts', base_hash } })
    expect(await outbound(reader)).toMatchObject({ callee: 'A', text: 'A()', edit: undefined, snapshot: snapshotId })
    expect(await symbol(writer, 'obsolete')).toBeUndefined()
    expect(await symbol(reader, 'obsolete')).toBeDefined()
    const choose = await symbol(writer, 'choose')
    const callers = await call(writer, 'get_relationships', { subject_id: choose.id, direction: 'in', envelope: 'full' })
    expect(callers.data.relationships).toContainEqual(expect.objectContaining({ other: expect.objectContaining({ name: 'testChoose', path: 'consumer.test.ts' }) }))
    const b = await symbol(writer, 'B')
    const tests = await call(writer, 'find_tests', { subject_ids: [b.id], envelope: 'full' })
    expect(tests.data.tests.map((t: any) => t.path)).toContain('consumer.test.ts')
    const stale = await writer.callTool({ name: 'apply_edit', arguments: { ...apply, base_hash: '0'.repeat(64) } })
    expect(stale.structuredContent).toMatchObject({ error: { code: 'STALE_INPUT', details: { expected_hash: base_hash } } })
    expect((await outbound(writer)).snapshot).toBe(active.snapshot)
    const next = await call(writer, 'apply_edit', { ...apply, content: edited.replace('return B()', 'return A()') })
    expect(next.edit.revision).toBe(2)
    expect(await outbound(writer)).toMatchObject({ callee: 'A', text: 'A()', edit: { revision: 2 } })
    const lean = await writer.callTool({ name: 'find_symbols', arguments: { text: 'choose' } })
    expect(lean.content).toEqual([expect.objectContaining({ text: expect.stringContaining(`revision 2 of ${snapshotId}`) })])
    await call(writer, 'discard_edit', {})
    expect(await outbound(writer)).toMatchObject({ callee: 'A', edit: undefined, snapshot: snapshotId })
    await call(writer, 'apply_edit', apply)
    expect(digest()).toEqual(before)
  } finally {
    await writer.close()
    await reader.close()
  }
  const reopened = await mcpClient(dataDir, '--editor')
  try { expect(await outbound(reopened)).toMatchObject({ callee: 'A', edit: undefined, snapshot: snapshotId }) }
  finally { await reopened.close() }
  expect(digest()).toEqual(before)
})
