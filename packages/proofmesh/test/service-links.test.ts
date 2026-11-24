import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { evidenceTerms } from '../src/discover/index.js'
import { parseRegistry, registryLinks, registryScore } from '../src/links/index.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { openSnapshot } from '../src/meshstore/snapshot.js'
import { cli, evidenceSlice, expectedFor, ROOT, tmpDir } from './helpers.js'

const EXPECTED = expectedFor('cs-services')
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const sorted = <T extends { source: string; target_repository: string | null; confidence: number }>(rows: T[]) => [...rows].sort(byKey((r) => `${r.source}|${r.target_repository}|${r.confidence}`))
const run = (d: string, ...args: string[]) => { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0); return r.stdout }

/** fixtures/cs-services: repo-a registered as storefront and repo-b as orders, indexed and grouped into the workspace `services`. */
function workspace() {
  const d = tmpDir(), a = tmpDir('pm-svc-a-'), b = tmpDir('pm-svc-b-')
  fs.cpSync(path.join(ROOT, 'fixtures', 'cs-services', 'repo-a'), a, { recursive: true })
  fs.cpSync(path.join(ROOT, 'fixtures', 'cs-services', 'repo-b'), b, { recursive: true })
  for (const args of [['init'], ['repo', 'add', a, '--name', 'storefront'], ['repo', 'add', b, '--name', 'orders'], ['index', a], ['index', b], ['workspace', 'add', 'services', a, b]]) run(d, ...args)
  return { d, a, b }
}
const link = (d: string) => /^link file (link_\w+) (sealed|unchanged)/.exec(run(d, 'workspace', 'link', 'services'))![1]!

function withRepo<T>(d: string, name: string, fn: (db: Database.Database, repositoryId: string) => T): T {
  const catalog = Catalog.open(d)
  try {
    const repo = catalog.repository(name), db = openSnapshot(catalog, catalog.currentSnapshot(repo.id)!)
    try { return fn(db, repo.id) } finally { db.close() }
  } finally {
    catalog.close()
  }
}

/** The links of one rule as the oracle states them: repository names, and the qualified name of a source that is a symbol. */
function links(d: string, id: string, rule: string) {
  const db = new Database(path.join(d, 'links', `${id}.db`), { readonly: true })
  try {
    const members = new Map((db.prepare('select repository_id, snapshot_id, name from member').all() as Array<{ repository_id: string; snapshot_id: string; name: string }>).map((m) => [m.repository_id, m]))
    const source = (repo: string, symbol: string) => {
      const s = new Database(path.join(d, 'snapshots', `${members.get(repo)!.snapshot_id}.db`), { readonly: true })
      try { return (s.prepare('select qualified_name from symbol where id = ?').get(symbol) as { qualified_name: string } | undefined)?.qualified_name ?? symbol } finally { s.close() }
    }
    type Row = { type: string; source_repository_id: string; source_symbol_id: string; target_repository_id: string | null; target_symbol_id: string | null; confidence: number; resolution: string; reason: string | null }
    const rows = (db.prepare('select * from link where rule = ?').all(rule) as Row[]).map((r) => {
      expect([r.type, r.target_symbol_id]).toEqual(['calls_service', null])
      return { source_repository: members.get(r.source_repository_id)!.name, source: source(r.source_repository_id, r.source_symbol_id), target_repository: r.target_repository_id && members.get(r.target_repository_id)!.name, confidence: r.confidence, resolution: r.resolution, reason: r.reason }
    })
    return sorted(rows)
  } finally {
    db.close()
  }
}

describe('A7 named HTTP clients: a C# rule names the services a repository calls, and the service_name rule links them across repositories', () => {
  let d: string
  beforeAll(() => { ({ d } = workspace()) }, 300000)

  it('A7 each client name is a service symbol declared at its first registration, called from the method or file that registers it', () => {
    withRepo(d, 'storefront', (db) => {
      const qn = (id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name
      const site = (assertion: string) => {
        const ev = (db.prepare('select evidence_id from assertion_evidence where assertion_id = ?').get(assertion) as { evidence_id: string }).evidence_id
        return { line: (db.prepare('select start_line from evidence where id = ?').get(ev) as { start_line: number }).start_line, site_text: evidenceSlice(d, db, ev) }
      }
      expect(db.prepare("select s.qualified_name, s.name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind = 'service' order by s.qualified_name").all()).toEqual(EXPECTED.services)
      const rows = db.prepare("select id, source_id, target_id, resolution, reason, origin, detail from assertion where type = 'calls_service'").all() as Array<{ id: string; source_id: string; target_id: string | null; resolution: string; reason: string | null; origin: string; detail: string }>
      expect(new Set(rows.map((r) => r.origin))).toEqual(new Set(['framework_adapter']))
      const order = byKey((r: { from: string; line: number }) => `${r.from}|${String(r.line).padStart(4, '0')}`)
      expect(rows.filter((r) => r.resolution === 'resolved').map((r) => ({ from: qn(r.source_id), to: qn(r.target_id!), rule: JSON.parse(r.detail).rule, ...site(r.id) })).sort(order)).toEqual(EXPECTED.calls_service)
      expect(rows.filter((r) => r.resolution === 'unresolved').map((r) => ({ from: qn(r.source_id), reason: r.reason, rule: JSON.parse(r.detail).rule, ...site(r.id) })).sort(order)).toEqual(EXPECTED.calls_service_unresolved)
    })
  })

  it('A7 a two-member workspace links each call to orders-service to the member repository orders, and leaves catalog-api as a boundary', () => {
    expect(links(d, link(d), 'service_name')).toEqual(sorted(EXPECTED.service_name_links))
  })

  it('A10 evidenceTerms on the storefront snapshot returns the services its named clients call', () => {
    const repositoryId = withRepo(d, 'storefront', (_, id) => id)
    expect(evidenceTerms(d, repositoryId).terms.filter((t) => t.kind === 'service')).toEqual(EXPECTED.service_terms)
  })
})

describe('A7 service registries: a member lists the callers it grants, and the link file reads that list from its sealed snapshot', () => {
  it('A7 registry links: an exact repository name at 1, a service-name match at 0.8, an unmatched entry as a boundary on the registry member, from the snapshot and not the working tree', () => {
    const { d, b } = workspace()
    const before = link(d)
    expect(links(d, before, 'service_registry')).toEqual([])
    const [member, file] = EXPECTED.registry.split(':')
    expect(cli(['--data-dir', d, 'workspace', 'add', 'services', '--registry', `${member}:../${file}`]).stderr).toMatch(/--registry takes <repository>:<path relative to its root>/)
    expect(run(d, 'workspace', 'add', 'services', '--registry', EXPECTED.registry)).toMatch(/^workspace services: 2 repositories; orders lists its callers in \.contoso\/api-clients\.yaml/)
    expect(run(d, 'workspace', 'list')).toMatch(/^services {2}orders \(registry \.contoso\/api-clients\.yaml\), storefront {2}by /)
    // Named after the member was indexed: its snapshot does not hold the file yet.
    const stale = cli(['--data-dir', d, 'workspace', 'link', 'services'])
    expect(stale.status).not.toBe(0)
    expect(stale.stderr).toMatch(/the service registry \.contoso\/api-clients\.yaml of orders is not in its snapshot snap_\w+; run "proofmesh index orders" to capture it/)
    run(d, 'index', b)
    // An edit after indexing is not in the snapshot, so it links nothing.
    fs.appendFileSync(path.join(b, file!), '  - name: storefront-admin\n    repository: storefront\n')
    const after = link(d)
    expect(after).not.toBe(before)
    expect(links(d, after, 'service_registry')).toEqual(sorted(EXPECTED.service_registry_links))
    expect(links(d, after, 'service_name')).toEqual(sorted(EXPECTED.service_name_links))
  }, 300000)

  it('A7 the registry parser reads bare names and name, repository and service fields under any key, and the matcher ranks exact names over service-name matches', () => {
    expect(parseRegistry('# callers\nclients:\n  - name: storefront-web   # the shop\n    repository: storefront\n  - "Storefront-Api"\n  - service: no-name\nother:\n  - name: \'reporting\'\n    service: reporting-service\nname: top-level\n')).toEqual([
      { name: 'storefront-web', repository: 'storefront' }, { name: 'Storefront-Api' }, { name: 'reporting', service: 'reporting-service' },
    ])
    expect([registryScore({ name: 'x', repository: 'storefront' }, 'storefront'), registryScore({ name: 'storefront-api' }, 'storefront'), registryScore({ name: 'reporting' }, 'storefront')]).toEqual([1, 0.8, 0])
    const registry = { path: 'clients.yaml', entries: [{ name: 'shop-service' }, { name: 'shop-service' }, { name: 'orders-api' }, { name: 'billing', repository: 'shop' }] }
    expect(registryLinks([{ repository_id: 'r1', name: 'orders', registry }, { repository_id: 'r2', name: 'shop' }, { repository_id: 'r3', name: 'shop-api' }]).map((l) => [l.source_repository_id, l.source_symbol_id, l.targets.map((t) => [t.repository_id, t.confidence]), !!l.ambiguous])).toEqual([
      ['r2', 'clients.yaml#shop-service', [['r1', 0.8]], true],
      ['r3', 'clients.yaml#shop-service', [['r1', 0.8]], true],
      ['r2', 'clients.yaml#billing', [['r1', 1]], false],
    ])
  })
})
