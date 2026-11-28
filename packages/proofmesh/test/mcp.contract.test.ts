import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ProofmeshError } from '../src/core/errors.js'
import { check, loadSchema } from '../src/core/schemas.js'
import { queryHash } from '../src/query/cursor.js'
import { LEAN, PROFILE, runTool } from '../src/query/tools.js'
import { CLI, indexedDataDir, symbolId, tool } from './helpers.js'
import { mcpClient } from './mcp-client.js'

let d: string
let client: Client
beforeAll(async () => {
  ;({ dataDir: d } = await indexedDataDir())
  client = await mcpClient(d)
})
afterAll(async () => { await client?.close() })

const TOOLS = ['analyze_impact', 'compare_snapshots', 'find_cycles', 'find_entry_points', 'find_hubs', 'find_query_source', 'find_stale_mentions', 'find_symbols', 'find_tests', 'find_unused', 'get_claims', 'get_context_map', 'get_ecosystem', 'get_external_usage', 'get_findings', 'get_job', 'get_memory', 'get_overview', 'get_property_reads', 'get_relationships', 'get_session_trail', 'get_symbol', 'get_symbol_card', 'get_symbols_at', 'get_table_reach', 'get_verification', 'impact_completeness', 'list_queries', 'list_repositories', 'list_snapshots', 'list_workspaces', 'plan_move', 'plan_rename', 'prepare_verification', 'query_graph', 'read_evidence', 'request_index', 'save_memory', 'search_concepts', 'search_sources', 'search_structure', 'trace_paths', 'verify_claim', 'workspace_status']

describe('AC22 MCP tool contracts', () => {
  it('FR035 FR421 with --tools all lists exactly the M0 tools plus the M2, M3, M5 and M6 tools, each with its input schema file unchanged', async () => {
    // The default lists the core profile only (FR420); --tools all is the whole surface.
    const all = await mcpClient(d, '--tools', 'all')
    try {
      const { tools } = await all.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS)
      for (const t of tools) expect(t.inputSchema).toEqual(loadSchema(`tools/${t.name}.input.schema.json`))
    } finally { await all.close() }
  })

  it('tells every client when to reach for the graph and how to ask for framework relationships', () => {
    const text = client.getInstructions() ?? ''
    expect(text).toMatch(/instead of text search/)
    for (const tool of ['find_symbols', 'get_relationships', 'trace_paths', 'analyze_impact']) expect(text).toContain(tool)
    expect(text).toMatch(/only calls unless you name the types/)
  })

  it('every tool response validates against the envelope and its data schema', async () => {
    const handle = symbolId(d, 'packages/api/src/handler:handleInvoice')
    const target = symbolId(d, 'packages/format/src/currency:formatAmount')
    const calls: Array<[string, Record<string, unknown>]> = [
      ['workspace_status', {}], ['find_symbols', { text: 'formatAmount' }], ['get_symbol', { symbol_id: handle }],
      ['get_relationships', { subject_id: handle }], ['trace_paths', { source_id: handle, target_id: target }],
    ]
    for (const [name, args] of calls) {
      // The JSON envelope by name: the query tools answer lean text by default (FR099).
      const r = await client.callTool({ name, arguments: { ...args, envelope: 'full' } })
      expect(r.isError, name).toBeFalsy()
      expect(check('envelope.schema.json', r.structuredContent), name).toBeUndefined()
      expect(check(`tools/${name}.data.schema.json`, (r.structuredContent as any).data), name).toBeUndefined()
      if (name === 'get_symbol') {
        const ev = await client.callTool({ name: 'read_evidence', arguments: { evidence_ids: (r.structuredContent as any).evidence_ids } })
        expect(check('tools/read_evidence.data.schema.json', (ev.structuredContent as any).data)).toBeUndefined()
      }
    }
  })

  it('FR099 FR095 the query tools answer lean by default: text only, a header then rows, no JSON and no structuredContent; compact and full by name', async () => {
    const handle = symbolId(d, 'packages/api/src/handler:handleInvoice')
    const target = symbolId(d, 'packages/format/src/currency:formatAmount')
    const calls: Array<[string, Record<string, unknown>]> = [
      ['find_symbols', { text: 'formatAmount' }], ['get_symbol', { symbol_id: handle }], ['get_relationships', { subject_id: handle }],
      ['trace_paths', { source_id: handle, target_id: target }], ['analyze_impact', { subject_ids: [target] }], ['find_tests', { subject_ids: [target] }],
      ['get_symbols_at', { locations: ['packages/api/src/handler.ts:1'] }], ['get_session_trail', { session_id: 'a-session-with-no-trail' }],
      ['find_unused', {}], ['find_cycles', {}], ['find_entry_points', {}], ['find_hubs', {}],
      ['get_context_map', { focus: { paths: ['packages/api/src/handler.ts'] } }], ['search_structure', { pattern: 'formatAmount($$$)', language: 'typescript' }], ['search_concepts', { text: 'format the invoice amount' }],
      ['query_graph', { query: "MATCH (c)-[r:calls]->(:function {name: 'formatAmount'}) RETURN r" }],
    ]
    expect(calls.map(([name]) => name).sort()).toEqual([...LEAN].sort())
    // get_session_trail and get_context_map are in the data profile and the structure tools and query_graph in extra; the default client lists core only.
    const data = await mcpClient(d, '--tools', 'core,data,extra')
    onTestFinished(() => data.close())
    for (const [name, args] of calls) {
      const via = PROFILE[name as keyof typeof PROFILE] === 'core' ? client : data
      const r = await via.callTool({ name, arguments: args }) as { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean }
      expect(r.isError, name).toBeFalsy()
      expect(r.structuredContent, name).toBeUndefined()
      expect(r.content.map((c) => c.type), name).toEqual(['text'])
      const [header, ...rest] = r.content[0]!.text.split('\n')
      expect(header, name).toMatch(/^# .+ · \d+ rows? · snap_[0-9a-z]+ (current|stale)$/)
      expect(rest.every((l) => !l.startsWith('{') && !l.startsWith('[')), name).toBe(true)
      for (const envelope of ['compact', 'full']) {
        const j = await via.callTool({ name, arguments: { ...args, envelope } })
        expect(check('envelope.schema.json', j.structuredContent), `${name} ${envelope}`).toBeUndefined()
        expect(JSON.parse((j.content as Array<{ text: string }>)[0]!.text), `${name} ${envelope}`).toEqual(j.structuredContent)
      }
    }
    // Tools whose results are not code locations keep answering in JSON.
    expect(check('envelope.schema.json', (await client.callTool({ name: 'workspace_status', arguments: {} })).structuredContent)).toBeUndefined()
  })

  it('FR100 over MCP a symbol is named by name and path in place of its id, and the tools describe the lean envelope', async () => {
    const r = await client.callTool({ name: 'get_symbol', arguments: { symbol_id: { name: 'handleInvoice', path: 'packages/api/src/handler.ts' } } }) as { content: Array<{ text: string }> }
    expect(r.content[0]!.text.split('\n').slice(1)).toEqual([expect.stringMatching(/^handleInvoice packages\/api\/src\/handler\.ts:\d+ function stable_key=\S+ body_hash=[0-9a-f]{64}$/)])
    const { tools } = await client.listTools()
    for (const t of tools.filter((x) => LEAN.has(x.name))) expect(JSON.stringify(t.inputSchema), t.name).toContain('lean, the default over MCP')
    expect(client.getInstructions()).toContain('answer in lean text')
  })

  it('errors are tool results with isError and a schema-valid error body', async () => {
    const r = await client.callTool({ name: 'get_symbol', arguments: { symbol_id: 'sym_000' } })
    expect(r.isError).toBe(true)
    expect(check('error.schema.json', r.structuredContent)).toBeUndefined()
    expect((r.structuredContent as any).error.code).toBe('NOT_FOUND')
    const bad = await client.callTool({ name: 'find_symbols', arguments: { text: '' } })
    expect((bad.structuredContent as any).error.code).toBe('INVALID_ARGUMENT')
  })
})

describe('AC23 stdout carries protocol frames only', () => {
  it('FR039 with debug logging on, every stdout line is a JSON-RPC message and logs go to stderr', async () => {
    const child = spawn(process.execPath, [CLI, '--data-dir', d, 'mcp'], { env: { ...process.env, PROOFMESH_LOG_LEVEL: 'debug' } })
    const out: string[] = [], err: string[] = []
    readline.createInterface({ input: child.stdout }).on('line', (l) => out.push(l))
    readline.createInterface({ input: child.stderr }).on('line', (l) => err.push(l))
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace_status', arguments: {} } })
    const deadline = Date.now() + 15000
    while (out.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    child.kill()
    expect(out.length).toBeGreaterThanOrEqual(3)
    for (const line of out) expect(JSON.parse(line).jsonrpc).toBe('2.0')
    expect(err.some((l) => JSON.parse(l).level === 'debug')).toBe(true)
  })
})

describe('FR038 cancellation', () => {
  it('FR038 a request cancelled before it runs is refused with a structured CANCELLED error and leaves no query record', () => {
    const question = { text: 'cancelledInProcess' }
    let refused: unknown
    try { runTool(d, 'find_symbols', question, undefined, AbortSignal.abort()) } catch (e) { refused = e }
    expect(refused).toBeInstanceOf(ProofmeshError)
    expect((refused as ProofmeshError).code).toBe('CANCELLED')
    expect(check('error.schema.json', (refused as ProofmeshError).toJSON())).toBeUndefined()
    const records = (tool(d, 'list_queries', { limit: 1000 }).data as { records: Array<{ input_hash: string }> }).records
    expect(records.map((r) => r.input_hash)).not.toContain(queryHash('find_symbols', question))
  })

  it('FR038 over stdio MCP a tool call cancelled before its handler starts is not run and gets no reply, and the next call is answered', async () => {
    const child = spawn(process.execPath, [CLI, '--data-dir', d, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const replies = new Map<number, any>()
    readline.createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); if (m.id !== undefined) replies.set(m.id, m) })
    const frame = (m: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`
    const reply = async (id: number) => { const until = Date.now() + 30000; while (!replies.has(id) && Date.now() < until) await new Promise((r) => setTimeout(r, 20)); return replies.get(id) }
    try {
      child.stdin.write(frame({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + frame({ method: 'notifications/initialized' }))
      expect(await reply(1)).toBeDefined()
      const cancelled = { text: 'cancelledOverStdio' }, answered = { text: 'answeredAfterTheCancel' }
      // One write, so the server reads the cancellation before the call's handler starts.
      child.stdin.write(frame({ id: 2, method: 'tools/call', params: { name: 'find_symbols', arguments: cancelled } }) + frame({ method: 'notifications/cancelled', params: { requestId: 2, reason: 'the agent moved on' } }) + frame({ id: 3, method: 'tools/call', params: { name: 'find_symbols', arguments: answered } }))
      expect((await reply(3)).result.isError).toBeFalsy()
      child.stdin.write(frame({ id: 4, method: 'tools/call', params: { name: 'list_queries', arguments: { limit: 1000 } } }))
      const hashes = ((await reply(4)).result.structuredContent.data.records as Array<{ input_hash: string }>).map((r) => r.input_hash)
      expect(replies.has(2)).toBe(false)
      expect([hashes.includes(queryHash('find_symbols', cancelled)), hashes.includes(queryHash('find_symbols', answered))]).toEqual([false, true])
    } finally {
      child.kill()
    }
  })
})
