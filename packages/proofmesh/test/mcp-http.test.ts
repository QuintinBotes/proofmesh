import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TOOLS } from '../src/query/tools.js'
import { CLI, indexedDataDir, symbolId } from './helpers.js'
import { mcpClient } from './mcp-client.js'

let child: ReturnType<typeof spawn>, url = '', token = '', dataDir = '', snapshotId = ''
beforeAll(async () => {
  ;({ dataDir, snapshotId } = await indexedDataDir())
  child = spawn(process.execPath, [CLI, '--data-dir', dataDir, 'mcp', '--http', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise<void>((resolve) => readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    const u = /^MCP over Streamable HTTP: (\S+)$/.exec(line), t = /^Authorization: Bearer ([0-9a-f]+)$/.exec(line)
    if (u) url = u[1]!
    if (t) { token = t[1]!; resolve() }
  }))
})
afterAll(() => child?.kill())

async function httpClient(): Promise<Client> {
  const client = new Client({ name: 'proofmesh-tests', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}

describe('FR040 NFR002 MCP over Streamable HTTP on loopback', () => {
  it('serves the same tools as stdio to a client with the bearer token', async () => {
    const client = new Client({ name: 'proofmesh-tests', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('trace_paths')
    const r = await client.callTool({ name: 'find_symbols', arguments: { text: 'invoiceTotal', envelope: 'full' } }) as any
    expect(r.structuredContent.data.symbols[0].qualified_name).toBe('packages/billing/src/invoice:invoiceTotal')
    await client.close()
  })

  it('refuses a request without the token, and one whose Host is not this server', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401)
    const http = await import('node:http')
    const status = await new Promise<number>((resolve) => {
      const req = http.request(url, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}`, Host: 'evil.example:80' } }, (res) => resolve(res.statusCode!))
      req.end(body)
    })
    expect(status).toBe(403)
  })
})

describe('FR034 SC005 stdio and Streamable HTTP run the same application logic', () => {
  it('FR034 Streamable HTTP lists exactly the tools stdio lists, with the same descriptions and input schemas', async () => {
    const stdio = await mcpClient(dataDir), http = await httpClient()
    try {
      const [overStdio, overHttp] = [(await stdio.listTools()).tools, (await http.listTools()).tools]
      expect(overHttp.map((t) => t.name).sort()).toEqual([...TOOLS].sort())
      expect(overHttp).toEqual(overStdio)
    } finally {
      await stdio.close(); await http.close()
    }
  })

  it('SC005 the core scenario returns the same data from the same snapshot over stdio and over Streamable HTTP', async () => {
    const handle = symbolId(dataDir, 'packages/api/src/handler:handleInvoice'), total = symbolId(dataDir, 'packages/billing/src/invoice:invoiceTotal')
    const scenario = async (client: Client) => {
      const answers: Record<string, any> = {}
      const call = async (name: string, args: Record<string, unknown>) => {
        // The JSON envelope by name, since the query tools answer lean text by default; both transports must agree on it.
        const r = await client.callTool({ name, arguments: { ...args, envelope: 'full' } }) as any
        expect(r.isError, name).toBeFalsy()
        answers[name] = { snapshot: r.structuredContent.snapshot.id, data: r.structuredContent.data }
        return r.structuredContent
      }
      await call('workspace_status', {})
      await call('find_symbols', { text: 'invoiceTotal' })
      const relationships = await call('get_relationships', { subject_id: handle })
      await call('trace_paths', { source_id: handle, target_id: total })
      await call('read_evidence', { evidence_ids: relationships.evidence_ids })
      await call('verify_claim', { claim: { statement: 'handleInvoice calls invoiceTotal.', proposition: { type: 'relationship', source: handle, relationship: 'calls', target: total } } })
      // Each verification is its own recorded run; everything else must match.
      answers.verify_claim.data.run_id = 'a run of its own'
      return answers
    }
    const stdio = await mcpClient(dataDir), http = await httpClient()
    try {
      const viaStdio = await scenario(stdio), viaHttp = await scenario(http)
      expect(viaHttp).toEqual(viaStdio)
      expect(Object.values(viaStdio).map((a) => a.snapshot)).toEqual(Array(6).fill(snapshotId))
      expect([viaStdio.find_symbols.data.symbols[0].qualified_name, viaStdio.trace_paths.data.conclusion, viaStdio.verify_claim.data.verdict]).toEqual(['packages/billing/src/invoice:invoiceTotal', 'path_found', 'supported'])
      expect(viaStdio.read_evidence.data.evidence.map((e: any) => e.integrity.status)).toEqual(Array(viaStdio.read_evidence.data.evidence.length).fill('verified'))
      expect(viaStdio.read_evidence.data.evidence.length).toBeGreaterThan(0)
    } finally {
      await stdio.close(); await http.close()
    }
  })
})
