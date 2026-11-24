import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cli, fixtureRepo, tmpDir, withSnapshot } from './helpers.js'

describe('A7 the Python adapter names the endpoints a client calls, as framework facts the link rules match', () => {
  it('a path literal, an f-string, a module constant, an absolute URL, a base-relative route and request(verb, path) each become an outbound dispatches_to; a built path and a bare word do not, and a FastAPI route is exposed, never called', () => {
    const d = tmpDir(), repo = tmpDir('pm-pyhttp-')
    fs.cpSync(fixtureRepo('py-http'), repo, { recursive: true })
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    expect(withSnapshot(d, (db) => db.prepare(`select qualified_name, start_line from symbol where kind = 'endpoint' order by qualified_name, start_line`).all())).toEqual([
      { qualified_name: 'GET api/orders/getAll', start_line: 17 },
      { qualified_name: 'GET api/orders/getAll', start_line: 46 },
      { qualified_name: 'GET api/orders/{param}', start_line: 20 },
      { qualified_name: 'GET health', start_line: 26 },
      { qualified_name: 'POST api/orders/add', start_line: 23 },
      { qualified_name: 'POST api/orders/getAll', start_line: 35 },
      { qualified_name: 'POST api/orders/settle', start_line: 32 },
    ])
    expect(withSnapshot(d, (db) => db.prepare(`select s.qualified_name as src, t.qualified_name as dst, a.detail from assertion a join symbol s on s.id = a.source_id join symbol t on t.id = a.target_id
      where a.type = 'dispatches_to' order by src`).all())).toEqual([
      { src: 'app/client:Shop.order', dst: 'GET api/orders/{param}', detail: '{"direction":"outbound","rule":"http_client"}' },
      { src: 'app/client:Shop.orders', dst: 'GET api/orders/getAll', detail: '{"direction":"outbound","rule":"http_client"}' },
      { src: 'app/client:Shop.ping', dst: 'GET health', detail: '{"direction":"outbound","rule":"http_client"}' },
      { src: 'app/client:Shop.place', dst: 'POST api/orders/add', detail: '{"direction":"outbound","rule":"http_client"}' },
      { src: 'app/client:Shop.raw', dst: 'POST api/orders/getAll', detail: '{"direction":"outbound","rule":"http_client"}' },
      { src: 'app/client:Shop.settle', dst: 'POST api/orders/settle', detail: '{"direction":"outbound","rule":"http_client"}' },
    ])
    // The router is included nowhere, so its route is taken as mounted at the root, and says so.
    expect(withSnapshot(d, (db) => db.prepare(`select s.qualified_name as src, t.qualified_name as dst, a.detail from assertion a join symbol s on s.id = a.source_id join symbol t on t.id = a.target_id where a.type = 'exposes'`).all())).toEqual([
      { src: 'GET api/orders/getAll', dst: 'app/client:list_orders', detail: '{"inferred":"no include_router or register_blueprint the rules read mounts it, so it is taken as mounted at the root","rule":"fastapi_route"}' },
    ])
    expect(withSnapshot(d, (db) => (db.prepare("select capabilities from file where path = 'app/client.py'").get() as { capabilities: string }).capabilities)).toContain('"framework":"partial"')
  }, 240000)
})
