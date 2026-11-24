import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { imageRepository, LINK_FORMAT_VERSION, literals } from '../src/links/index.js'
import { cli, expectedFor, ROOT, tmpDir, tool } from './helpers.js'
import { writeLinkFile } from './helpers-links.js'

const EXPECTED = expectedFor('cloud-links')
const PULUMI = `export type Input<T> = T | { apply<U>(f: (value: T) => U): unknown }
export interface CustomResourceOptions { dependsOn?: Resource[] }
export declare abstract class Resource { readonly urn: string }
export declare class CustomResource extends Resource { constructor(type: string, name: string, args?: object, opts?: CustomResourceOptions) }
`
const AZURE_NATIVE = `import * as pulumi from '@pulumi/pulumi'
export declare namespace web {
  class WebApp extends pulumi.CustomResource {
    constructor(name: string, args: { name?: pulumi.Input<string>; resourceGroupName: pulumi.Input<string> }, opts?: pulumi.CustomResourceOptions)
  }
}
`
const MEMBERS = ['infra', 'orders', 'storefront'] as const
type Row = { type: string; rule: string; source_repository_id: string; source_symbol_id: string; target_repository_id: string | null; target_symbol_id: string | null; confidence: number; resolution: string; reason: string | null }
type Oracle = { type: string; rule: string; source_repository: string; source: string; target_repository: string | null; target: string | null; confidence: number; resolution: string; reason: string | null }

const run = (d: string, ...args: string[]) => { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0); return r.stdout }
const link = (d: string) => { const m = /^link file (link_\w+) (sealed|unchanged)/.exec(run(d, 'workspace', 'link', 'cloud'))!; return { id: m[1]!, state: m[2]! } }

/** fixtures/cloud-links: each member copied, the Pulumi stand-ins installed into infra, all indexed and grouped into the workspace `cloud`. */
function indexed() {
  const d = tmpDir(), repos = Object.fromEntries(MEMBERS.map((name) => [name, tmpDir(`pm-cloud-${name}-`)])) as Record<(typeof MEMBERS)[number], string>
  for (const name of MEMBERS) fs.cpSync(path.join(ROOT, 'fixtures', 'cloud-links', `repo-${name}`), repos[name], { recursive: true })
  for (const [name, types] of [['@pulumi/pulumi', PULUMI], ['@pulumi/azure-native', AZURE_NATIVE]] as const) {
    const dir = path.join(repos.infra, 'node_modules', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', types: 'index.d.ts' }))
    fs.writeFileSync(path.join(dir, 'index.d.ts'), types)
  }
  run(d, 'init')
  for (const name of MEMBERS) run(d, 'repo', 'add', repos[name], '--name', name)
  for (const name of MEMBERS) run(d, 'index', repos[name])
  run(d, 'workspace', 'add', 'cloud', ...MEMBERS.map((name) => repos[name]))
  return { d, repos }
}

/** The links of a sealed file as the oracle states them: repository names and qualified names instead of ids. */
function rows(d: string, id: string): { links: Oracle[]; members: Array<{ repository_id: string; snapshot_id: string; name: string }>; format: string } {
  const db = new Database(path.join(d, 'links', `${id}.db`), { readonly: true, fileMustExist: true })
  try {
    const members = db.prepare('select repository_id, snapshot_id, name from member').all() as Array<{ repository_id: string; snapshot_id: string; name: string }>
    const repo = (id: string | null) => (id ? members.find((m) => m.repository_id === id)!.name : null)
    const qn = (repoId: string | null, symbolId: string | null) => {
      if (!repoId || !symbolId) return null
      const s = new Database(path.join(d, 'snapshots', `${members.find((m) => m.repository_id === repoId)!.snapshot_id}.db`), { readonly: true })
      try { return (s.prepare('select qualified_name from symbol where id = ?').get(symbolId) as { qualified_name: string }).qualified_name } finally { s.close() }
    }
    const links = (db.prepare('select * from link').all() as Row[]).map((r) => ({
      type: r.type, rule: r.rule, source_repository: repo(r.source_repository_id)!, source: qn(r.source_repository_id, r.source_symbol_id)!, target_repository: repo(r.target_repository_id),
      target: qn(r.target_repository_id, r.target_symbol_id), confidence: r.confidence, resolution: r.resolution, reason: r.reason,
    }))
    return { links, members, format: (db.prepare("select value from meta where key = 'format_version'").get() as { value: string }).value }
  } finally {
    db.close()
  }
}
const key = (l: Oracle) => `${l.type}|${l.source}|${l.target_repository}|${l.target}`
const sorted = (xs: Oracle[]) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : 1))

describe('A8 A35 links from cloud resources to the services that deploy to or use them, in link format 0.2', () => {
  let d = '', repos = {} as Record<(typeof MEMBERS)[number], string>, id = '', unlinked = ''
  beforeAll(() => {
    ({ d, repos } = indexed())
    // A copy taken before any link file is sealed, for the test that must seal its own.
    unlinked = tmpDir('pm-cloud-unlinked-')
    fs.cpSync(d, unlinked, { recursive: true })
    id = link(d).id
  }, 900000)

  it('A8 A35 every link equals the hand-written oracle: type, rule, source, target, confidence and resolution', () => {
    const { links, format } = rows(d, id)
    expect(format).toBe(LINK_FORMAT_VERSION)
    expect(sorted(links)).toEqual(sorted(EXPECTED.links))
  })

  it('A8 A35 a resource declared in the member whose service or channel it names is not a link', () => {
    const { links } = rows(d, id)
    // storefront declares its own web app named storefront, while infra's container app naming storefront does link.
    expect(links.filter((l) => l.source === 'deploy:azurerm_linux_web_app.site' || (l.type === 'deploys' && l.source_repository === 'storefront'))).toEqual([])
    expect(links.some((l) => l.type === 'deploys' && l.target_repository === 'storefront')).toBe(true)
    // orders declares its own orders.audit queue, so that channel keeps only its messaging boundary.
    expect(links.filter((l) => l.source === 'kafka:orders.audit').map((l) => l.type)).toEqual(['messages'])
    expect(links.filter((l) => l.source_repository === l.target_repository)).toEqual([])
  })

  it('A8 A35 a name that is not a literal is not matched, and only the attribute that names a resource is its name', () => {
    // The queue's name is a variable whose default is orders.placed; only the topic whose name is that literal links.
    expect(rows(d, id).links.filter((l) => l.type === 'uses_resource' && l.source === 'kafka:orders.placed').map((l) => l.target)).toEqual(['terraform:azurerm_servicebus_topic.placed'])
    expect(literals('resource "azurerm_servicebus_queue" "q" {\n  name = var.returns_queue\n  topic = "orders-${var.env}"\n  other = "a" + "b"\n}', true)).toEqual([])
    expect(literals('resource "azurerm_container_app" "shop" {\n  name = "shop-web" # comment\n  template {\n    container {\n      name  = "web"\n      image = "registry.example.test/storefront:1.4"\n    }\n  }\n  tags = { "team" = "a" }\n}', true)).toEqual([
      { path: 'name', value: 'shop-web' }, { path: 'template.container.name', value: 'web' }, { path: 'template.container.image', value: 'registry.example.test/storefront:1.4' }, { path: 'tags.team', value: 'a' },
    ])
    expect(literals("new k8s.apps.v1.Deployment('web', { metadata: { name: 'orders' }, spec: { containers: [{ name: `${app}`, image: 'r/orders:1' }] }, note: 'a' + b })", false)).toEqual([
      { path: 'metadata.name', value: 'orders' }, { path: 'spec.containers.image', value: 'r/orders:1' },
    ])
    expect(literals('web.WebApp(\n    "orders-web",\n    name="orders",\n    resource_group_name=f"{group}",\n)', false)).toEqual([{ path: 'name', value: 'orders' }])
    expect(literals('new WebApp("orders-web", new WebAppArgs { Name = "orders", ResourceGroupName = $"{group}", Kind = @"app" })', false)).toEqual([{ path: 'name', value: 'orders' }, { path: 'kind', value: 'app' }])
    expect(['registry.example.test:5000/team/orders-api:1.2', 'orders-api@sha256:00ff', 'orders-api'].map(imageRepository)).toEqual(['orders-api', 'orders-api', 'orders-api'])
  })

  it('A8 A35 a resource renamed in the working tree after indexing links as it was indexed: names are read from the member snapshot', () => {
    const file = path.join(repos.infra, 'terraform', 'main.tf'), original = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, original.replaceAll('orders', 'billing').replaceAll('storefront', 'nothing'))
    try {
      const sealed = link(unlinked)
      expect(sealed.state).toBe('sealed')
      expect(sorted(rows(unlinked, sealed.id).links)).toEqual(sorted(EXPECTED.links))
    } finally {
      fs.writeFileSync(file, original)
    }
  })

  it('A8 A35 get_ecosystem returns the cloud links as pairs of members, and none of them as a boundary', () => {
    const data = tool(d, 'get_ecosystem', { workspace: 'cloud', link_file_id: id }).data as { members: Array<{ repository_id: string; name: string }>; links: Array<Record<string, unknown>>; boundaries: Array<{ type: string }> }
    const name = (repo: unknown) => data.members.find((m) => m.repository_id === repo)!.name
    expect(data.links.filter((l) => l.type === 'deploys' || l.type === 'uses_resource').map((l) => ({ from: name(l.source_repository_id), to: name(l.target_repository_id), type: l.type, resolved: l.resolved, candidate: l.candidate, min: l.min_confidence, max: l.max_confidence }))
      .sort((a, b) => (`${a.from}${a.to}` < `${b.from}${b.to}` ? -1 : 1))).toEqual([
      { from: 'infra', to: 'orders', type: 'deploys', resolved: 2, candidate: 0, min: 0.7, max: 0.9 },
      { from: 'infra', to: 'storefront', type: 'deploys', resolved: 1, candidate: 0, min: 0.9, max: 0.9 },
      { from: 'orders', to: 'infra', type: 'uses_resource', resolved: 2, candidate: 0, min: 0.9, max: 1 },
    ])
    expect(data.boundaries.map((b) => b.type)).toEqual(['messages'])
  })

  it('A8 A35 a link file in format 0.1 still opens and answers', () => {
    const { members } = rows(d, id)
    const repo = (name: string) => members.find((m) => m.name === name)!.repository_id
    const built = new Database(path.join(d, 'links', `${id}.db`), { readonly: true })
    const channel = (built.prepare("select source_symbol_id from link where type = 'messages' limit 1").get() as { source_symbol_id: string }).source_symbol_id
    built.close()
    const old = writeLinkFile(d, 'cloud', members, [{ type: 'calls_service', rule: 'service_name', source: [repo('orders'), channel], target: [repo('storefront'), null], confidence: 0.7, resolution: 'resolved' }], { service_name: '1' })
    expect(rows(d, old.id).format).toBe('0.1')
    const data = tool(d, 'get_ecosystem', { workspace: 'cloud', link_file_id: old.id }).data as { workspace: { link_file_id: string }; links: Array<Record<string, unknown>> }
    expect(data.workspace.link_file_id).toBe(old.id)
    expect(data.links.map((l) => [l.source_repository_id, l.target_repository_id, l.type, l.resolved])).toEqual([[repo('orders'), repo('storefront'), 'calls_service', 1]])
  })
})
