import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CSP, startViewServer, type ViewServer } from '../src/http/server.js'
import { GALAXY_FORMAT } from '../src/query/galaxy.js'
import { cli, copyFixture, indexedDataDir, ROOT, symbolId } from './helpers.js'
import { mcpClient } from './mcp-client.js'

let d: string
let snapshotId: string
let s: ViewServer
let client: Client

function request(method: string, p: string, { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; raw: Buffer }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers: { host: `127.0.0.1:${s.port}`, origin: s.url, 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => { const raw = Buffer.concat(chunks); resolve({ status: res.statusCode!, headers: res.headers, body: raw.toString('utf8'), raw }) })
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
  ;({ dataDir: d, snapshotId } = await indexedDataDir())
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

describe('FR1450 static assets go compressed, and only what a content hash names is cached', () => {
  it('FR1450 negotiates Brotli, then gzip, from the copies the build wrote; hashed assets are immutable and the page is revalidated', async () => {
    const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-assets-'))
    const js = 'export const x = 1\n'.repeat(200)
    fs.mkdirSync(path.join(assets, 'assets'))
    fs.writeFileSync(path.join(assets, 'index.html'), '<!doctype html><script type="module" src="/assets/index-AbCd1234.js"></script>')
    fs.writeFileSync(path.join(assets, 'assets', 'index-AbCd1234.js'), js)
    fs.writeFileSync(path.join(assets, 'assets', 'index-AbCd1234.js.br'), zlib.brotliCompressSync(js))
    fs.writeFileSync(path.join(assets, 'assets', 'index-AbCd1234.js.gz'), zlib.gzipSync(js))
    const own = await startViewServer(d, 0, assets)
    const get = (p: string, accept?: string) => new Promise<{ headers: http.IncomingHttpHeaders; raw: Buffer }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: own.port, path: p, headers: { host: `127.0.0.1:${own.port}`, ...(accept ? { 'accept-encoding': accept } : {}) } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve({ headers: res.headers, raw: Buffer.concat(chunks) }))
      }).on('error', reject)
    })
    try {
      const br = await get('/assets/index-AbCd1234.js', 'br, gzip')
      expect([br.headers['content-encoding'], br.headers.vary]).toEqual(['br', 'Accept-Encoding'])
      expect(zlib.brotliDecompressSync(br.raw).toString()).toBe(js)
      expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      const gz = await get('/assets/index-AbCd1234.js', 'gzip, br;q=0')
      expect(gz.headers['content-encoding']).toBe('gzip')
      expect(zlib.gunzipSync(gz.raw).toString()).toBe(js)
      const plain = await get('/assets/index-AbCd1234.js')
      expect(plain.headers['content-encoding']).toBeUndefined()
      expect(plain.raw.toString()).toBe(js)
      const page = await get('/', 'br, gzip')
      expect(page.headers['cache-control']).toBe('no-cache')
      expect(page.headers['content-security-policy']).toBe(CSP)
    } finally { await own.close() }
  })
})

describe('FR1453 a snapshot\'s Galaxy has an address of its own that a browser may cache; API answers are never stored', () => {
  it('FR1453 API answers and refusals carry no-store', async () => {
    const cookie = await session()
    for (const r of [await request('POST', '/api/v1/tools/workspace_status', { headers: { cookie }, body: {} }), await request('POST', '/api/v1/galaxy', { headers: { cookie }, body: {} }), await request('POST', '/api/v1/tools/workspace_status', { body: {} })]) expect(r.headers['cache-control']).toBe('no-store')
  })

  it('FR1453 serves the Galaxy by snapshot id and format version, private and immutable, behind the session; another version or snapshot is 404', async () => {
    const cookie = await session()
    const at = `/api/v1/galaxy/v${GALAXY_FORMAT}/${snapshotId}`
    expect((await request('GET', at)).status).toBe(401)
    const r = await request('GET', at, { headers: { cookie } })
    expect(r.status).toBe(200)
    expect(r.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(r.headers['content-encoding']).toBe('gzip')
    expect(r.headers['content-security-policy']).toBe(CSP)
    expect(r.raw.equals((await request('POST', '/api/v1/galaxy', { headers: { cookie }, body: {} })).raw)).toBe(true)
    const terrain = await request('GET', at, { headers: { cookie, accept: 'application/vnd.proofmesh.terrain' } })
    expect(terrain.status).toBe(200)
    expect(terrain.headers.vary).toBe('Accept')
    expect(r.headers.vary).toBe('Accept')
    expect(terrain.headers['content-type']).toBe('application/vnd.proofmesh.terrain')
    expect(terrain.raw.equals(r.raw)).toBe(false)
    // A snapshot gc removed, or a payload of another format, is not there: the view asks again for the current snapshot.
    for (const gone of [`/api/v1/galaxy/v${GALAXY_FORMAT - 1}/${snapshotId}`, `/api/v1/galaxy/v${GALAXY_FORMAT}/snap_000000000000`]) {
      const g = await request('GET', gone, { headers: { cookie } })
      expect(g.status, gone).toBe(404)
      expect(g.headers['cache-control']).toBe('no-store')
    }
  })

  it('FR1453 a snapshot gc retires is 404 at its address, though its Galaxy was built and cached before', async () => {
    const repo = copyFixture()
    const { dataDir, snapshotId: old } = await indexedDataDir(repo)
    fs.appendFileSync(path.join(repo, 'packages/format/src/currency.ts'), '\n// edit\n')
    expect(cli(['--data-dir', dataDir, 'index', repo]).status).toBe(0)
    const own = await startViewServer(dataDir, 0)
    const at = (p: string, cookie: string) => new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: own.port, path: p, headers: { host: `127.0.0.1:${own.port}`, cookie } }, (res) => { res.resume(); resolve(res.statusCode!) }).on('error', reject)
    })
    try {
      const cookie = await new Promise<string>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: own.port, method: 'POST', path: '/session', headers: { host: `127.0.0.1:${own.port}`, origin: own.url, 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(String(res.headers['set-cookie']).split(';')[0]!) })
        req.on('error', reject)
        req.end(JSON.stringify({ token: own.issueToken() }))
      })
      expect(await at(`/api/v1/galaxy/v${GALAXY_FORMAT}/${old}`, cookie)).toBe(200)
      expect(cli(['--data-dir', dataDir, 'gc', '--keep', '1']).status).toBe(0)
      expect(await at(`/api/v1/galaxy/v${GALAXY_FORMAT}/${old}`, cookie)).toBe(404)
    } finally { await own.close() }
  })
})
