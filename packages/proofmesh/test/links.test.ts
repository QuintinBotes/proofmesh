import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { routeScore, serviceMatches } from '../src/links/index.js'
import { cli, expectedFor, ROOT, tmpDir } from './helpers.js'

type Row = { type: string; rule: string; source_repository_id: string; source_symbol_id: string; target_repository_id: string | null; target_symbol_id: string | null; confidence: number; resolution: string; reason: string | null }

/** Two fixture repositories, by their directories under fixtures/, indexed into one data directory and grouped into a workspace. */
function workspace([[repoA, nameA], [repoB, nameB]] = [['cs-links/repo-a', 'store'], ['cs-links/repo-b', 'shop']], name = 'retail') {
  const d = tmpDir(), a = tmpDir('pm-links-a-'), b = tmpDir('pm-links-b-')
  fs.cpSync(path.join(ROOT, 'fixtures', repoA!), a, { recursive: true })
  fs.cpSync(path.join(ROOT, 'fixtures', repoB!), b, { recursive: true })
  for (const args of [['init'], ['repo', 'add', a, '--name', nameA!], ['repo', 'add', b, '--name', nameB!], ['index', a], ['index', b], ['workspace', 'add', name, a, b]]) {
    const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0)
  }
  return { d, a, b }
}
const link = (d: string, name = 'retail') => { const r = cli(['--data-dir', d, 'workspace', 'link', name]); expect(r.status, r.stderr).toBe(0); return { id: /^link file (link_\w+) (sealed|unchanged)/.exec(r.stdout)![1]!, state: /^link file link_\w+ (\w+)/.exec(r.stdout)![1]!, out: r.stdout } }
const ro = (file: string) => new Database(file, { readonly: true, fileMustExist: true })

/** Every link as the oracle states it: repository names and qualified names instead of ids. */
function links(d: string, id: string) {
  const db = ro(path.join(d, 'links', `${id}.db`))
  const members = db.prepare('select repository_id, snapshot_id, name from member').all() as Array<{ repository_id: string; snapshot_id: string; name: string }>
  const name = (repo: string | null, sym: string | null) => {
    if (!repo || !sym) return null
    const m = members.find((x) => x.repository_id === repo)!
    const s = ro(path.join(d, 'snapshots', `${m.snapshot_id}.db`))
    try { return (s.prepare('select qualified_name from symbol where id = ?').get(sym) as { qualified_name: string }).qualified_name } finally { s.close() }
  }
  const rows = (db.prepare('select * from link order by type, source_symbol_id').all() as Row[]).map((r) => ({
    type: r.type, rule: r.rule, source_repository: members.find((m) => m.repository_id === r.source_repository_id)!.name, source: name(r.source_repository_id, r.source_symbol_id),
    target_repository: r.target_repository_id ? members.find((m) => m.repository_id === r.target_repository_id)!.name : null, target: name(r.target_repository_id, r.target_symbol_id),
    confidence: r.confidence, resolution: r.resolution, reason: r.reason,
  }))
  db.close()
  return { rows, members }
}
const key = (l: { type: string; source: string | null; target: string | null }) => `${l.type}|${l.source}|${l.target}`
const sorted = <T extends { type: string; source: string | null; target: string | null }>(xs: T[]) => [...xs].sort((x, y) => (key(x) < key(y) ? -1 : 1))

describe('A7 A28 cross-repository links sealed in a workspace link file', () => {
  it('links the client repository to the server one and leaves what matches nothing as a boundary, as the hand-written oracle says', () => {
    const { d } = workspace()
    const { id, state } = link(d)
    expect(state).toBe('sealed')
    expect(sorted(links(d, id).rows)).toEqual(sorted(expectedFor('cs-links').links))
  }, 300000)

  it('the same member snapshots give the same file; re-indexing one member after an edit seals a new file and leaves the other snapshot alone', () => {
    const { d, a } = workspace()
    const first = link(d)
    expect(link(d)).toMatchObject({ id: first.id, state: 'unchanged' })
    const before = links(d, first.id).members
    fs.appendFileSync(path.join(a, 'src', 'Store.Clients', 'Clients.cs'), '\n// changed\n')
    expect(cli(['--data-dir', d, 'index', a]).status).toBe(0)
    const second = link(d)
    expect(second.id).not.toBe(first.id)
    const after = links(d, second.id).members
    expect(after.find((m) => m.name === 'shop')!.snapshot_id).toBe(before.find((m) => m.name === 'shop')!.snapshot_id)
    expect(after.find((m) => m.name === 'store')!.snapshot_id).not.toBe(before.find((m) => m.name === 'store')!.snapshot_id)
    expect(sorted(links(d, second.id).rows)).toEqual(sorted(links(d, first.id).rows))
  }, 300000)

  it('A7 http_route links a Python client\'s calls to the FastAPI routes a Python server exposes, with prefixes composed across its files, as written by hand', () => {
    const { d } = workspace([['py-http/repo', 'client'], ['py-routes/repo', 'server']], 'python')
    const { id } = link(d, 'python')
    const exact = (source: string, target: string) => ({ type: 'calls_endpoint', rule: 'http_route', source_repository: 'client', source, target_repository: 'server', target, confidence: 1, resolution: 'resolved', reason: null })
    expect(sorted(links(d, id).rows.filter((r) => r.target_repository === 'server' && r.confidence === 1))).toEqual(sorted([
      exact('app/client:Shop.order', 'GET api/orders/{order_id}'),
      exact('app/client:Shop.place', 'POST api/orders/add'),
      exact('app/client:Shop.ping', 'GET health'),
    ]))
  }, 300000)

  it('a link file that no longer matches its recorded digest is refused', () => {
    const { d } = workspace()
    const { id } = link(d)
    const file = path.join(d, 'links', `${id}.db`)
    fs.chmodSync(file, 0o644)
    fs.appendFileSync(file, 'tampered')
    const r = cli(['--data-dir', d, 'workspace', 'link', 'retail'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/does not match its recorded digest/)
  }, 300000)

  it('route matching: exact 1, a client literal where the server has a parameter 0.9, a suffix 0.6, otherwise 0; ANY serves every verb; parameters alone match nothing', () => {
    expect(routeScore('GET api/Orders/{id}', 'GET api/orders/{orderId}')).toBe(1)
    expect(routeScore('GET api/orders/42', 'GET api/Orders/{id}')).toBe(0.9)
    expect(routeScore('GET orders/{id}', 'GET api/Orders/{id}')).toBe(0.6)
    expect(routeScore('POST api/orders/{id}', 'GET api/Orders/{id}')).toBe(0.8)
    expect(routeScore('ANY api/orders/{id}', 'GET api/Orders/{id}')).toBe(1)
    expect(routeScore('GET api/orders/{id}', 'POST api/Orders')).toBe(0)
    expect(routeScore('GET api/orders/{id}/items', 'GET api/Orders/{id}')).toBe(0)
    expect(routeScore('GET api/orders', 'ANY api/Orders')).toBe(1)
    expect(routeScore('DELETE /', 'DELETE /')).toBe(1)
    expect(routeScore('GET health', 'ANY {*url}')).toBe(0)
    expect(routeScore('POST rates/add', 'GET api/items/{kind}/{id}')).toBe(0)
    expect(routeScore('GET orders/{id}', 'ANY l/{name}/{key}')).toBe(0)
    expect(routeScore('GET {id}', 'GET api/orders/{orderId}')).toBe(0)
  })

  it('service names match repositories without their Service and api suffixes, case-insensitively', () => {
    expect(serviceMatches('BillingService', 'billing')).toBe(true)
    expect(serviceMatches('Billing', 'billing-api')).toBe(true)
    expect(serviceMatches('BillingService', 'Billing.Api')).toBe(true)
    expect(serviceMatches('BillingService', 'shipping')).toBe(false)
  })
})

describe('A7 http_route links a C# Refit client to a TypeScript server\'s Express and NestJS endpoints', () => {
  it('A7 the client\'s GET api/orders/{orderId} matches an Express route on a mounted router and GET inventory/{sku} a NestJS action, as the hand-written oracle says', () => {
    const { d } = workspace([['cs-links/repo-a', 'store'], ['ts-routes/repo', 'shop']])
    expect(sorted(links(d, link(d).id).rows.filter((l) => l.rule === 'http_route'))).toEqual(sorted(expectedFor('ts-routes').links))
  }, 300000)
})
