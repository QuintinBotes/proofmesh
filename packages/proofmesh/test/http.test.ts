import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CSP, startViewServer, type ViewServer } from '../src/http/server.js'
import { indexedDataDir, ROOT, symbolId } from './helpers.js'
import { mcpClient } from './mcp-client.js'

let d: string
let s: ViewServer
let client: Client

function request(method: string, p: string, { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers: { host: `127.0.0.1:${s.port}`, origin: s.url, 'content-type': 'application/json', ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

async function session(): Promise<string> {
  const r = await request('POST', '/session', { body: { token: s.issueToken() } })
  expect(r.status).toBe(204)
  return String(r.headers['set-cookie']).split(';')[0]!
}

beforeAll(async () => {
  ;({ dataDir: d } = await indexedDataDir())
  s = await startViewServer(d, 0)
  client = await mcpClient(d)
})
afterAll(async () => { await s?.close(); await client?.close() })

describe('AC25 loopback security', () => {
  it('refuses tool calls without a session', async () => {
    expect((await request('POST', '/api/v1/tools/workspace_status', { body: {} })).status).toBe(401)
  })

  it('a launch token works once', async () => {
    const token = s.issueToken()
    expect((await request('POST', '/session', { body: { token } })).status).toBe(204)
    expect((await request('POST', '/session', { body: { token } })).status).toBe(401)
  })

  it('FR066 refuses a foreign Host and a foreign Origin', async () => {
    const cookie = await session()
    expect((await request('POST', '/api/v1/tools/workspace_status', { headers: { host: `evil.example:${s.port}`, cookie }, body: {} })).status).toBe(403)
    expect((await request('POST', '/api/v1/tools/workspace_status', { headers: { origin: 'http://evil.example', cookie }, body: {} })).status).toBe(403)
  })

  it('sets the session cookie HttpOnly and SameSite=Strict, and serves the exact security headers', async () => {
    const r = await request('POST', '/session', { body: { token: s.issueToken() } })
    expect(String(r.headers['set-cookie'])).toMatch(/pm_session=[0-9a-f]+; HttpOnly; SameSite=Strict; Path=\//)
    const g = await request('GET', '/')
    expect(g.headers['content-security-policy']).toBe(CSP)
    expect(g.headers['x-content-type-options']).toBe('nosniff')
    expect(g.headers['referrer-policy']).toBe('no-referrer')
  })

  it('the launch URL carries its token in the fragment only', () => {
    expect(s.launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}$/)
  })
})

describe('AC24 the HTTP tool API matches MCP', () => {
  it('returns the same data as MCP for the same inputs on the same snapshot', async () => {
    const cookie = await session()
    const source = symbolId(d, 'packages/api/src/handler:handleInvoice')
    const target = symbolId(d, 'packages/format/src/currency:formatAmount')
    const inputs: Array<[string, Record<string, unknown>]> = [['workspace_status', {}], ['find_symbols', { text: 'format' }], ['trace_paths', { source_id: source, target_id: target, limits: { max_depth: 1 } }], ['get_relationships', { subject_id: source }]]
    for (const [name, args] of inputs) {
      const viaHttp = JSON.parse((await request('POST', `/api/v1/tools/${name}`, { headers: { cookie }, body: args })).body)
      const viaMcp = (await client.callTool({ name, arguments: { ...args, envelope: 'full' } })).structuredContent as any
      expect(viaHttp.data, name).toEqual(viaMcp.data)
      expect(viaHttp.snapshot.id).toBe(viaMcp.snapshot.id)
    }
  })

  it('FR095 an explicit lean request answers with the plain text MCP answers, not JSON', async () => {
    const cookie = await session()
    const viaHttp = await request('POST', '/api/v1/tools/find_symbols', { headers: { cookie }, body: { text: 'format', envelope: 'lean' } })
    const viaMcp = (await client.callTool({ name: 'find_symbols', arguments: { text: 'format' } })).content as Array<{ text: string }>
    expect(viaHttp.headers['content-type']).toMatch(/^text\/plain/)
    expect(viaHttp.body).toBe(viaMcp[0]!.text)
  })

  it('maps errors to HTTP status codes with the same error body', async () => {
    const cookie = await session()
    const r = await request('POST', '/api/v1/tools/get_symbol', { headers: { cookie }, body: { symbol_id: 'sym_000' } })
    expect(r.status).toBe(404)
    expect(JSON.parse(r.body).error.code).toBe('NOT_FOUND')
  })
})

describe('FR065 the browser treats repository content as untrusted: a strict Content Security Policy on every response', () => {
  it('FR065 pages, assets, API answers and refusals all carry this exact policy, which allows no unsafe source and nothing beyond the page\'s own origin', async () => {
    const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    const cookie = await session()
    const responses = [
      await request('GET', '/'), await request('GET', '/no-such-asset.js'),
      await request('POST', '/api/v1/tools/workspace_status', { headers: { cookie }, body: {} }),
      await request('POST', '/api/v1/tools/workspace_status', { body: {} }),
      await request('GET', '/', { headers: { host: `evil.example:${s.port}` } }),
    ]
    expect(responses.map((r) => r.status)).toEqual([expect.any(Number), 404, 200, 401, 403])
    for (const r of responses) {
      const header = String(r.headers['content-security-policy'])
      expect(header).toBe(policy)
      const directives = Object.fromEntries(header.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name!, sources]))
      expect(Object.values(directives).flat().filter((src) => !["'self'", "'none'", 'data:', 'blob:'].includes(src))).toEqual([])
      expect(directives['script-src']).toEqual(["'self'"])
      expect(directives['frame-ancestors']).toEqual(["'none'"])
    }
  })
})

describe('FR068 layout is derived in the browser, never answered: no tool envelope carries coordinates', () => {
  const COORDINATES = new Set(['x', 'y', 'z', 'pos', 'position', 'positions', 'coordinates', 'coords', 'layout'])
  const keys = (v: unknown, path = ''): string[] => (Array.isArray(v) ? v.flatMap((x) => keys(x, path)) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [`${path}.${k}`, ...keys(x, `${path}.${k}`)]) : [])
  const named = (paths: string[]) => paths.filter((p) => COORDINATES.has(p.split('.').pop()!.toLowerCase()))

  it('FR068 no property in the envelope or any tool output schema is a coordinate, position or layout', () => {
    const dir = path.join(ROOT, 'schemas', 'tools')
    const schemas = ['envelope.schema.json', ...fs.readdirSync(dir).filter((f) => f.endsWith('.data.schema.json')).map((f) => path.join('tools', f))]
    expect(schemas.length).toBeGreaterThan(20)
    const found = schemas.flatMap((f) => named(keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', f), 'utf8')))).filter((p) => /\.properties\.[^.]+$/.test(p)).map((p) => `${f}${p}`))
    expect(found).toEqual([])
  })

  it('FR068 the envelopes the graph views are drawn from, as MCP returns them, hold no coordinate', async () => {
    const source = symbolId(d, 'packages/api/src/handler:handleInvoice'), target = symbolId(d, 'packages/format/src/currency:formatAmount')
    const calls: Array<[string, Record<string, unknown>]> = [
      ['workspace_status', {}], ['find_symbols', { text: 'format' }], ['get_symbol', { symbol_id: source }], ['get_overview', {}],
      ['get_relationships', { subject_id: source, direction: 'both', include_external: true }], ['trace_paths', { source_id: source, target_id: target }],
    ]
    for (const [name, args] of calls) {
      const env = (await client.callTool({ name, arguments: { ...args, envelope: 'full' } })).structuredContent
      expect(env, name).toMatchObject({ tool: name })
      expect(named(keys(env)), name).toEqual([])
    }
  })
})
