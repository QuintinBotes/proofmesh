import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { indexRepository } from '../src/indexer/coordinator.js'
import { fixtureRepo, indexedDataDir, indexedRepo, symbolId, tool, withSnapshot } from './helpers.js'

type Rel = { assertion_id: string; type: string; direction: string; resolution: string; origin: string; basis?: string; reason: string | null; other: { name?: string; qualified_name?: string }; site: { path: string; start_line: number }; detail: Record<string, string> | null }
const relationships = (dataDir: string, subject: string, types: string[], direction: 'in' | 'out') =>
  (tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, subject), direction, types }).data.relationships as Rel[])
const TS = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true }, include: ['*.ts'] })
/** A one-route FastAPI application. */
const py = (route: string, fn: string) => ['from fastapi import FastAPI', '', 'app = FastAPI()', '', '', `@app.get("${route}")`, `def ${fn}():`, '    return []', ''].join('\n')
/** The rows of one adapter, as the snapshot holds them. */
const assertions = (dataDir: string, adapter: string) => withSnapshot(dataDir, (db) => db.prepare(`select a.type, a.origin, a.resolution, a.reason, s.qualified_name as src, t.qualified_name as dst, a.detail from assertion a join symbol s on s.id = a.source_id left join symbol t on t.id = a.target_id
  where a.adapter = ? and a.type in ('dispatches_to', 'exposes') order by src, dst, a.detail`).all(adapter) as Array<{ type: string; origin: string; resolution: string; reason: string | null; src: string; dst: string | null; detail: string }>)
/** What a client at `src` was linked to, as `resolution:target` with its detail. */
const linkOf = (dataDir: string, src: string) => assertions(dataDir, 'seams-http').filter((r) => r.type === 'dispatches_to' && r.src === src).map((r) => ({ resolution: r.resolution, reason: r.reason, dst: r.dst, ...(JSON.parse(r.detail) as Record<string, string>) }))
const clientsOf = (dataDir: string, src: string): Array<Record<string, string>> => assertions(dataDir, 'typescript').filter((r) => r.type === 'dispatches_to' && r.src === src).map((r) => ({ endpoint: r.dst!, ...(JSON.parse(r.detail) as Record<string, string>) }))

describe('FR250 to FR259 HTTP seams: a client is linked to its handler inside one repository, in any language, and labelled inferred', () => {
  let dataDir = ''
  beforeAll(async () => { dataDir = (await indexedDataDir(fixtureRepo('seams-http'))).dataDir }, 120000)

  it('FR250 scenario 1: fetch and axios calls in web/src/orders.ts are outbound dispatches_to endpoints, rules fetch_client and axios_client, each interpolation a {param}', () => {
    expect(clientsOf(dataDir, 'web/src/orders:fetchOrder')).toEqual([{ endpoint: 'GET api/orders/{param}', direction: 'outbound', rule: 'fetch_client' }])
    expect(clientsOf(dataDir, 'web/src/orders:listOrders')).toEqual([{ endpoint: 'GET api/orders', direction: 'outbound', rule: 'axios_client' }])
    // The query string is dropped, and the file says its framework facts are partial.
    expect(clientsOf(dataDir, 'web/src/inventory:loadInventory')).toEqual([{ endpoint: 'GET api/inventory', direction: 'outbound', rule: 'fetch_client' }])
    expect(withSnapshot(dataDir, (db) => (db.prepare("select capabilities from file where path = 'web/src/orders.ts'").get() as { capabilities: string }).capabilities)).toContain('"framework":"partial"')
  })

  it('FR252 scenario 2: openapi.yaml declares an endpoint symbol per path and verb at its line, from configuration evidence, with the operationId in its signature', () => {
    expect(withSnapshot(dataDir, (db) => db.prepare(`select s.qualified_name, s.start_line, s.signature, e.source_kind, e.extractor from symbol s join file f on f.id = s.file_id join evidence e on e.id = s.evidence_id where f.path = 'openapi.yaml' and s.kind = 'endpoint' order by s.start_line`).all())).toEqual([
      { qualified_name: 'GET api/orders/{orderId}', start_line: 7, signature: 'operationId: getOrder', source_kind: 'configuration', extractor: 'build' },
      { qualified_name: 'GET api/orders', start_line: 13, signature: null, source_kind: 'configuration', extractor: 'build' },
      { qualified_name: 'POST api/legacy', start_line: 18, signature: null, source_kind: 'configuration', extractor: 'build' },
    ])
  })

  it('FR253 a Swagger 2.0 JSON document is read the same way, its basePath joined to each path', () => {
    expect(withSnapshot(dataDir, (db) => db.prepare(`select s.qualified_name, s.start_line, s.signature from symbol s join file f on f.id = s.file_id where f.path = 'services/inventory/swagger.json' and s.kind = 'endpoint'`).all())).toEqual([
      { qualified_name: 'GET api/inventory', start_line: 7, signature: 'operationId: listInventory' },
    ])
  })

  it('FR254 scenario 3: the inbound dispatches_to of get_order names fetchOrder at its line, the rule and the endpoint matched, confidence 0.9 for parameters matched by position, basis inferred', () => {
    const inbound = relationships(dataDir, 'api/main:get_order', ['dispatches_to'], 'in')
    expect(inbound).toHaveLength(1)
    expect(inbound[0]).toMatchObject({
      type: 'dispatches_to', direction: 'in', resolution: 'resolved', origin: 'contract_match', basis: 'inferred',
      other: { qualified_name: 'web/src/orders:fetchOrder' }, site: { path: 'web/src/orders.ts', start_line: 1 },
      detail: { rule: 'http_route', endpoint: 'GET api/orders/{orderId}', confidence: '0.9', path: 'api/orders/{param}' },
    })
  })

  it('FR254 an exact path is confidence 1, and the other-verb and no-new-type rules of the workspace links hold', async () => {
    const list = relationships(dataDir, 'api/main:list_orders', ['dispatches_to'], 'in').map((r) => ({ from: r.other.qualified_name, conf: r.detail!.confidence, basis: r.basis }))
    expect(list).toContainEqual({ from: 'web/src/orders:listOrders', conf: '1', basis: 'inferred' })
    const { dataDir: other } = await indexedRepo({
      'tsconfig.json': TS,
      'client.ts': "export const place = () => fetch('/api/orders', { method: 'POST' })\n",
      'server.py': py('/api/orders', 'list_orders'),
    })
    expect(linkOf(other, 'client:place')).toMatchObject([{ resolution: 'resolved', dst: 'server:list_orders', confidence: '0.8' }])
    // No relationship type is new: every row of the pass is one the schema already had.
    expect(new Set(assertions(dataDir, 'seams-http').map((r) => `${r.type}:${r.origin}`))).toEqual(new Set(['dispatches_to:contract_match', 'exposes:contract_match']))
  })

  it('FR255 scenario 4: analyze_impact on list_orders with include_inferred lists listOrders at depth 1, inferred', () => {
    const impact = tool(dataDir, 'analyze_impact', { subject_ids: [symbolId(dataDir, 'api/main:list_orders')], include_inferred: true, limits: { max_depth: 2 } }).data as { dependents: Array<{ qualified_name: string; depth: number; basis: string }> }
    expect(impact.dependents.find((d) => d.qualified_name === 'web/src/orders:listOrders')).toMatchObject({ depth: 1, basis: 'inferred' })
    // The client of get_order is not a dependent of list_orders.
    expect(impact.dependents.some((d) => d.qualified_name === 'web/src/orders:fetchOrder')).toBe(false)
  })

  it('FR256 scenario 5: POST /api/legacy, declared with no handler, is an unresolved exposes that says so, and no link is invented for it', () => {
    const declared = relationships(dataDir, 'POST api/legacy', ['exposes'], 'out')
    expect(declared.map((r) => ({ resolution: r.resolution, reason: r.reason, why: r.detail?.why, line: r.site.start_line, path: r.site.path }))).toEqual([
      { resolution: 'unresolved', reason: 'unknown_name', why: 'declared_without_handler', line: 18, path: 'openapi.yaml' },
    ])
    expect(assertions(dataDir, 'seams-http').filter((r) => r.resolution === 'resolved' && (r.src.includes('legacy') || (r.dst ?? '').includes('legacy')))).toEqual([])
    // The call to it is a boundary too, told apart from a call nothing declares.
    expect(linkOf(dataDir, 'web/src/edge:retireLegacy')).toEqual([{ resolution: 'unresolved', reason: 'not_indexed', dst: null, rule: 'http_route', path: 'api/legacy', endpoint: 'POST api/legacy', why: 'declared_without_handler' }])
  })

  it('FR257 scenario 6: fetch("/api/unknown") stays an unresolved dispatches_to, reason unknown_name, with the path in its detail', () => {
    const rows = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'web/src/edge:unknownCall'), direction: 'out', types: ['dispatches_to'] }).data.relationships as Rel[]
    expect(rows.filter((r) => r.resolution === 'unresolved').map((r) => ({ reason: r.reason, path: r.detail!.path, rule: r.detail!.rule, basis: r.basis }))).toEqual([{ reason: 'unknown_name', path: 'api/unknown', rule: 'http_route', basis: undefined }])
  })

  it('FR256 a handler in a language with no route rules is found through the document operationId and its client is linked at 0.7, never above', () => {
    expect(relationships(dataDir, 'services/inventory/inventory:ListInventory', ['dispatches_to', 'exposes'], 'in').map((r) => ({ type: r.type, from: r.other.qualified_name, conf: r.detail!.confidence, rule: r.detail!.rule, basis: r.basis })).sort((a, b) => a.type.localeCompare(b.type))).toEqual([
      { type: 'dispatches_to', from: 'web/src/inventory:loadInventory', conf: '0.7', rule: 'http_route', basis: 'inferred' },
      { type: 'exposes', from: 'GET api/inventory', conf: '0.7', rule: 'openapi_operation_id', basis: 'inferred' },
    ])
  })

  it('FR258 the same VERB path in code and in the document is one endpoint: its client links once, to the one handler, and the document endpoint exposes that handler too', () => {
    expect(linkOf(dataDir, 'web/src/orders:listOrders')).toHaveLength(1)
    expect(relationships(dataDir, 'api/main:list_orders', ['exposes'], 'in').map((r) => `${r.other.qualified_name} in ${r.site.path}: ${r.detail!.rule ?? ''}`).sort()).toEqual(['GET api/orders in api/main.py: fastapi_route', 'GET api/orders in openapi.yaml: openapi_path'])
  })

  it('FR251 a path on a base held in a variable keeps its literal suffix with prefix_unknown and links, at 0.5, only because one endpoint ends with it', () => {
    expect(clientsOf(dataDir, 'web/src/edge:viaBase')).toEqual([{ endpoint: 'GET orders', direction: 'outbound', rule: 'fetch_client', prefix_unknown: 'true' }])
    expect(linkOf(dataDir, 'web/src/edge:viaBase')).toEqual([{ resolution: 'resolved', reason: null, dst: 'api/main:list_orders', rule: 'http_route', endpoint: 'GET api/orders', path: 'orders', prefix_unknown: 'true', confidence: '0.5' }])
  })
})

describe('FR250 FR251 the TypeScript client rules read the call forms a front end uses and nothing else', () => {
  it('FR250 template parameters, a dropped query string, a method option, a module constant, axios instances and the config form each name the endpoint they call; a variable path, a local fetch and a non-HTTP call name none', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': TS,
      'calls.ts': [
        "import axios from 'axios'",
        "const BASE = '/api'",
        "const http = axios.create({ baseURL: '/v2' })",
        'declare const id: string',
        'declare const url: string',
        'export const a = () => fetch(`/api/orders/${id}/lines?expand=${id}`)',
        "export const b = () => fetch(BASE + '/items', { method: 'delete' })",
        "export const c = () => axios({ url: '/api/pay', method: 'put' })",
        "export const d = () => axios('/api/ping')",
        "export const e = () => http.post('/pay', {})",
        "export const f = () => axios.request({ url: '/api/req' })",
        'export const g = () => fetch(url)',
        "export const h = () => fetch('https://example.com/api/abs#top')",
        "export const i = () => ['x'].get('/api/not-http')",
        "export const j = () => fetch('data')",
        'export const k = () => fetch(`${BASE}/typed`)',
      ].join('\n') + '\n',
      'local.ts': "function fetch(path: string) { return path }\nexport const l = () => fetch('/api/local')\n",
    })
    const got = (src: string) => clientsOf(dataDir, `calls:${src}`).map((r) => `${r.endpoint} ${r.rule}${r.prefix_unknown ? ' prefix_unknown' : ''}`)
    expect(got('a')).toEqual(['GET api/orders/{param}/lines fetch_client'])
    expect(got('b')).toEqual(['DELETE api/items fetch_client'])
    expect(got('c')).toEqual(['PUT api/pay axios_client'])
    expect(got('d')).toEqual(['GET api/ping axios_client'])
    expect(got('e')).toEqual(['POST v2/pay axios_client'])
    expect(got('f')).toEqual(['GET api/req axios_client'])
    expect(got('g')).toEqual([])
    expect(got('h')).toEqual(['GET api/abs fetch_client'])
    expect(got('i')).toEqual([])
    expect(got('j')).toEqual([])
    expect(got('k')).toEqual(['GET api/typed fetch_client'])
    expect(clientsOf(dataDir, 'local:l')).toEqual([])
  })

  it('FR251 an axios instance whose baseURL is not a literal, and a call on a leading interpolation, keep their literal suffix with prefix_unknown; one with no leading slash records nothing', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': TS,
      'calls.ts': [
        "import axios from 'axios'",
        'declare const root: string',
        'declare const host: string',
        'const api = axios.create({ baseURL: root })',
        "export const a = () => api.get('/orders')",
        'export const b = () => fetch(`${host}/orders/${root}`)',
        "export const c = () => fetch(root + 'orders')",
      ].join('\n') + '\n',
    })
    const got = (src: string) => clientsOf(dataDir, `calls:${src}`).map((r) => `${r.endpoint}${r.prefix_unknown ? ' prefix_unknown' : ''}`)
    expect(got('a')).toEqual(['GET orders prefix_unknown'])
    expect(got('b')).toEqual(['GET orders/{param} prefix_unknown'])
    expect(got('c')).toEqual([])
  })
})

describe('FR253 FR258 an API description is read as far as it can be, and a document that does not parse is failed with its diagnostic', () => {
  const failure = (files: Record<string, string>, file: string) => indexedRepo(files).then(({ dataDir }) => withSnapshot(dataDir, (db) => db.prepare('select disposition, disposition_detail from file where path = ?').get(file)))

  it('FR253 a YAML document with servers, quoted keys, comments, block scalars, flow values and extensions declares each path and verb once per base path; a $ref path item is reported partial', async () => {
    const { dataDir } = await indexedRepo({
      'api/openapi.yml': [
        'openapi: "3.1.0"  # the version',
        'servers:',
        '  - url: https://example.com/v1/',
        '  - url: /v2',
        'x-owner: nobody',
        'paths:',
        "  '/pets/{petId}':",
        '    parameters: [{ name: petId, in: path }]',
        '    get:',
        '      summary: |',
        '        Reads: one pet',
        '      operationId: "readPet"',
        '    delete: {}',
        '  /pets:',
        '    post:',
        '      tags: [a, b]',
        '    $ref: ./shared.yaml',
        '  /shared:',
        '    $ref: ./shared.yaml',
        '  x-hidden:',
        '    get: {}',
      ].join('\n') + '\n',
    })
    expect(withSnapshot(dataDir, (db) => db.prepare("select qualified_name, start_line, signature from symbol where kind = 'endpoint' order by qualified_name, start_line").all())).toEqual([
      { qualified_name: 'DELETE v1/pets/{petId}', start_line: 13, signature: null },
      { qualified_name: 'DELETE v2/pets/{petId}', start_line: 13, signature: null },
      { qualified_name: 'GET v1/pets/{petId}', start_line: 9, signature: 'operationId: readPet' },
      { qualified_name: 'GET v2/pets/{petId}', start_line: 9, signature: 'operationId: readPet' },
      { qualified_name: 'POST v1/pets', start_line: 15, signature: null },
      { qualified_name: 'POST v2/pets', start_line: 15, signature: null },
    ])
    expect(withSnapshot(dataDir, (db) => (db.prepare("select capabilities from file where path = 'api/openapi.yml'").get() as { capabilities: string }).capabilities)).toContain('"symbols":"partial"')
  })

  it.each([
    ['openapi.json', '{ "openapi": "3.0.0", "paths": { "/a": { "get": {} } ', /^invalid_openapi:line 1: /],
    ['swagger.yaml', 'swagger: "2.0"\npaths:\n\t/a:\n    get: {}\n', /^invalid_openapi:line 3: a tab cannot indent/],
    ['openapi.yaml', 'openapi: 3.0.0\npaths:\n  /a:\n    get: {}\n  /a:\n    post: {}\n', /^invalid_openapi:line 5: duplicate key "\/a"/],
    ['orders.openapi.yaml', 'openapi: 3.0.0\npaths:\n  /a\n', /^invalid_openapi:line 3: expected "key: value"/],
  ])('FR253 %s that fails to parse is failed with the diagnostic, and declares nothing', async (file, text, detail) => {
    const row = (await failure({ [file]: text }, file)) as { disposition: string; disposition_detail: string }
    expect(row.disposition).toBe('failed')
    expect(row.disposition_detail).toMatch(detail)
  })

  it('FR253 a file named like a description that is none is indexed and declares nothing', async () => {
    const { dataDir } = await indexedRepo({ 'openapi.json': '{ "name": "not-a-description" }\n', 'swagger.yaml': 'name: also-not\n' })
    expect(withSnapshot(dataDir, (db) => ({ endpoints: db.prepare("select count(*) as n from symbol where kind = 'endpoint'").get(), files: db.prepare("select disposition from file order by path").all() }))).toEqual({ endpoints: { n: 0 }, files: [{ disposition: 'indexed' }, { disposition: 'indexed' }] })
  })

  it('FR258 two code endpoints for one client path leave it ambiguous with both handlers as candidates, and a base-unknown path that two endpoints end with is not linked', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': TS,
      'client.ts': "declare const base: string\nexport const exact = () => fetch('/api/items')\nexport const loose = () => fetch(base + '/items')\n",
      'one.py': py('/api/items', 'items_one'),
      'two.py': py('/api/items', 'items_two'),
      'three.py': py('/v9/items', 'items_three'),
    })
    expect(linkOf(dataDir, 'client:exact')).toMatchObject([{ resolution: 'ambiguous', endpoint: 'GET api/items', confidence: '1' }])
    const rows = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'client:exact'), direction: 'out', types: ['dispatches_to'], resolutions: ['ambiguous'] }).data.relationships as Rel[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ resolution: 'ambiguous', basis: 'inferred', origin: 'contract_match' })
    expect(withSnapshot(dataDir, (db) => db.prepare("select s.qualified_name from assertion_candidate c join assertion a on a.id = c.assertion_id join symbol s on s.id = c.symbol_id where a.adapter = 'seams-http' and a.source_id = (select id from symbol where qualified_name = 'client:exact') order by s.qualified_name").all())).toEqual([{ qualified_name: 'items_one' }, { qualified_name: 'items_two' }].map((r) => ({ qualified_name: `${r.qualified_name === 'items_one' ? 'one' : 'two'}:${r.qualified_name}` })))
    // Three endpoints end in /items, so a client that does not know its base is linked to none of them, and says so.
    expect(linkOf(dataDir, 'client:loose')).toMatchObject([{ resolution: 'ambiguous', prefix_unknown: 'true', confidence: '0.5' }])
  })
})

describe('FR259 the links are the same whether the repository was indexed clean or incrementally', () => {
  it('FR259 editing one client file and indexing again gives the HTTP links a clean index of the tree gives', async () => {
    const files = {
      'tsconfig.json': TS,
      'client.ts': "export const a = () => fetch('/api/orders')\n",
      'server.py': py('/api/orders', 'list_orders'),
    }
    const { repo, dataDir, repoId } = await indexedRepo(files)
    fs.writeFileSync(path.join(repo, 'client.ts'), files['client.ts'] + "export const b = () => fetch('/api/missing')\n")
    await indexRepository(dataDir, repoId)
    const clean = await indexedDataDir(repo)
    expect(assertions(dataDir, 'seams-http')).toEqual(assertions(clean.dataDir, 'seams-http'))
    expect(assertions(dataDir, 'seams-http').map((r) => `${r.src}:${r.resolution}`)).toEqual(['client:a:resolved', 'client:b:unresolved'])
  })
})

describe('FR250 to FR254 corrections: hostile inputs, base paths, option wrappers and unknown-base ambiguity', () => {
  const failed = async (files: Record<string, string>, file: string) => {
    const { dataDir } = await indexedRepo(files)
    return withSnapshot(dataDir, (db) => db.prepare('select disposition, disposition_detail from file where path = ?').get(file)) as { disposition: string; disposition_detail: string }
  }

  it('FR254 a relationship to a symbol whose local id starts with @ keeps its adapter, and the HTTP links still resolve beside it', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true }, include: ['*.ts'] }),
      '@lib.ts': 'export function helper(): number { return 1 }\n',
      'user.ts': "import { helper } from './@lib'\nexport const run = () => helper()\nexport const get = () => fetch('/api/x')\n",
      'server.py': py('/api/x', 'serve'),
    })
    expect(linkOf(dataDir, 'user:get')).toMatchObject([{ resolution: 'resolved', dst: 'server:serve' }])
    expect(withSnapshot(dataDir, (db) => db.prepare("select count(*) as n from assertion a join symbol t on t.id = a.target_id where a.type = 'calls' and t.name = 'helper'").get())).toEqual({ n: 1 })
  })

  it('FR253 an array nested too deep to read in an x- field makes the document invalid_openapi and does not abort the index', async () => {
    const deep = '['.repeat(50000) + ']'.repeat(50000)
    const row = await failed({ 'openapi.json': `{ "openapi": "3.0.0", "x-deep": ${deep}, "paths": {} }` }, 'openapi.json')
    expect(row.disposition).toBe('failed')
    expect(row.disposition_detail).toMatch(/^invalid_openapi:line 1: nesting is deeper than/)
  })

  it('FR253 a YAML mapping nested too deep is invalid_openapi too', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${' '.repeat(i)}k${i}:`)
    const row = await failed({ 'openapi.yaml': ['openapi: 3.0.0', 'x-deep:', ...lines.map((l) => ' ' + l)].join('\n') + '\n' }, 'openapi.yaml')
    expect(row.disposition).toBe('failed')
    expect(row.disposition_detail).toMatch(/^invalid_openapi:line \d+: nesting is deeper than/)
  })

  it('FR253 duplicate-key checking does work in the number of keys, not its square', async () => {
    const { parseYaml } = await import('../../../adapters/syntax/src/openapi.js')
    const n = 4000, doc = Array.from({ length: n }, (_, i) => `key${i}: v`).join('\n') + '\n'
    // A scan of the members so far per key calls Array.prototype.some about n*n/2 times; a set calls it never.
    const original = Array.prototype.some
    let calls = 0
    Array.prototype.some = function (this: unknown[], ...args: Parameters<typeof original>) { calls += this.length; return original.apply(this, args) }
    try { parseYaml(doc) } finally { Array.prototype.some = original }
    expect(calls).toBeLessThan(n * 10)
  })

  it('FR251 a base-unknown suffix that one served and one declared-only endpoint end with is ambiguous, not a 0.5 link', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': TS,
      'client.ts': "declare const base: string\nexport const loose = () => fetch(base + '/orders')\n",
      'server.py': py('/api/orders', 'list_orders'),
      'openapi.yaml': 'openapi: 3.0.0\npaths:\n  /legacy/orders:\n    get: {}\n',
    })
    expect(linkOf(dataDir, 'client:loose')).toMatchObject([{ resolution: 'ambiguous', prefix_unknown: 'true' }])
  })

  it('FR253 a sixth distinct server path is kept, not dropped', async () => {
    const servers = Array.from({ length: 7 }, (_, i) => `  - url: /v${i}`).join('\n')
    const { dataDir } = await indexedRepo({ 'openapi.yaml': `openapi: 3.0.0\nservers:\n${servers}\npaths:\n  /a:\n    get: {}\n` })
    expect(withSnapshot(dataDir, (db) => db.prepare("select qualified_name from symbol where kind = 'endpoint' order by qualified_name").all()).length).toBe(7)
  })

  it('FR253 an undefined YAML alias is invalid_openapi', async () => {
    const row = await failed({ 'openapi.yaml': 'openapi: 3.0.0\npaths: *missing\n' }, 'openapi.yaml')
    expect(row.disposition).toBe('failed')
    expect(row.disposition_detail).toMatch(/^invalid_openapi:line 2: undefined alias/)
  })

  it('FR253 a duplicate key in a JSON document is invalid_openapi', async () => {
    const row = await failed({ 'openapi.json': '{\n  "openapi": "3.0.0",\n  "paths": {},\n  "paths": { "/a": { "get": {} } }\n}\n' }, 'openapi.json')
    expect(row.disposition).toBe('failed')
    expect(row.disposition_detail).toMatch(/^invalid_openapi:line 4: duplicate key "paths"/)
  })

  it('FR253 a bad escape in a nested YAML key is reported at its own line', async () => {
    const row = await failed({ 'openapi.yaml': 'openapi: 3.0.0\npaths:\n  /a:\n    "bad\\qkey": 1\n' }, 'openapi.yaml')
    expect(row.disposition_detail).toMatch(/^invalid_openapi:line 4: /)
  })

  it('FR250 options wrapped in as, satisfies, parentheses or non-null are read; so is a config object under them', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': TS,
      'calls.ts': [
        "import axios from 'axios'",
        "export const a = () => fetch('/o', { method: 'POST' } as RequestInit)",
        "export const b = () => fetch('/o', ({ method: 'PUT' }) satisfies RequestInit)",
        "export const c = () => fetch('/o', { method: 'DELETE' }!)",
        "export const d = () => axios({ url: '/o', method: 'patch' } as object as { url: string })",
      ].join('\n') + '\n',
    })
    const got = (s: string) => clientsOf(dataDir, `calls:${s}`).map((r) => r.endpoint)
    expect([got('a'), got('b'), got('c'), got('d')]).toEqual([['POST o'], ['PUT o'], ['DELETE o'], ['PATCH o']])
  })

  it('FR251 every leading interpolation is the unknown base, not just the first', async () => {
    const { dataDir } = await indexedRepo({ 'tsconfig.json': TS, 'calls.ts': 'declare const a: string\ndeclare const b: string\nexport const x = () => fetch(`${a}${b}/orders`)\n' })
    expect(clientsOf(dataDir, 'calls:x')).toEqual([{ endpoint: 'GET orders', direction: 'outbound', rule: 'fetch_client', prefix_unknown: 'true' }])
  })
})
