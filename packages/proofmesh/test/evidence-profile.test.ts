import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, it } from 'vitest'
import { serveHttp } from '../src/mcp/server.js'
import { indexedDataDir } from './helpers.js'

it('FR421 the Diderot generic allowlist can follow a call to verified evidence over loopback HTTP', async () => {
  const { dataDir, snapshotId } = await indexedDataDir()
  const server = await serveHttp(dataDir, '0.1.0', 0, ['evidence'])
  const client = new Client({ name: 'generic-evidence-reader', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }))
    const { tools } = await client.listTools()
    const allowed = ['find_symbols', 'get_relationships', 'get_symbol', 'read_evidence']
    expect(tools.map((t) => t.name).sort()).toEqual(allowed)
    const selected = tools.filter((t) => allowed.includes(t.name) && t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true)
    expect(selected).toHaveLength(4)
    for (const t of selected) {
      expect(t.inputSchema.properties?.freshness).toEqual({ enum: ['snapshot'] })
      const r = await client.callTool({ name: t.name, arguments: { freshness: 'strict' } })
      expect(r.structuredContent).toMatchObject({ error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('strict freshness') } })
    }
    for (const name of ['request_index', 'save_memory', 'prepare_verification']) {
      const r = await client.callTool({ name, arguments: {} })
      expect(r.structuredContent).toMatchObject({ error: { details: { detail: 'tool_not_loaded' } } })
    }
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, snapshot_id: snapshotId, envelope: 'full' } })
      expect(r.isError, name).toBeFalsy()
      expect(r.structuredContent).toMatchObject({ snapshot: { id: snapshotId } })
      return (r.structuredContent as { data: unknown }).data
    }
    const found = await call('find_symbols', { text: 'handleInvoice' }) as { symbols: { id: string }[] }
    const source = found.symbols[0]!.id
    await call('get_symbol', { symbol_id: source })
    const related = await call('get_relationships', { subject_id: source, direction: 'out', types: ['calls'] }) as { relationships: { evidence_ids: string[] }[] }
    expect(related.relationships).toHaveLength(1)
    const cited = await call('read_evidence', { evidence_ids: related.relationships[0]!.evidence_ids })
    expect(cited).toMatchObject({ evidence: [expect.objectContaining({ path: 'packages/api/src/handler.ts', start_line: 5,
      text: expect.stringContaining('invoiceTotal(request.lines, "EUR")'), integrity: { status: 'verified' } })] })
  } finally {
    await client.close()
    await server.close()
  }
}, 120000)
