import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { evidenceSlice, expectedFor, fixtureRepo, indexedDataDir, ROOT, tmpDir, tool, withSnapshot } from './helpers.js'

const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const qn = (db: Database.Database, id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name

for (const fixture of ['cs-orders', 'cs-linked', 'cs-transitive', 'cs-inherited']) describe(`golden facts for fixtures/${fixture} (no execution)`, () => {
  const EXPECTED = expectedFor(fixture)
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo(fixture)))
  })
  const slice = (db: Database.Database, id: string) => evidenceSlice(dataDir, db, id)

  it('NFR004 the adapter build that produced the facts is part of snapshot identity', async () => {
    const { createHash } = await import('node:crypto')
    const dll = path.join(ROOT, 'adapters', 'csharp', 'bin', 'Release', 'net10.0', 'Proofmesh.Adapter.CSharp.dll')
    const adapters = withSnapshot(dataDir, (db) => JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value)) as Array<{ id: string; toolchain: Record<string, string> }>
    expect(adapters.find((a) => a.id === 'csharp')!.toolchain.adapter_build).toBe(createHash('sha256').update(fs.readFileSync(dll)).digest('hex').slice(0, 16))
    // The build must not embed the commit it was built at, or every commit would change snapshot identity with no adapter change.
    expect(fs.readFileSync(dll).toString('latin1')).not.toMatch(/\d+\.\d+\.\d+\+[0-9a-f]{40}/)
  })

  it('FR080 the snapshot records that it was built without executing build logic', () => {
    withSnapshot(dataDir, (db) => expect(db.prepare("select value from meta where key = 'analysis_mode'").get()).toEqual({ value: EXPECTED.analysis_mode }))
  })

  it('FR077 C# dispositions equal the oracle', () => {
    const rows = withSnapshot(dataDir, (db) => db.prepare('select path, disposition, disposition_detail from file order by path').all() as Array<{ path: string; disposition: string; disposition_detail: string | null }>)
    expect(Object.fromEntries(rows.map((r) => [r.path, [r.disposition, r.disposition_detail]]))).toEqual(EXPECTED.dispositions)
  })

  it('FR077 C# symbols equal the oracle, each with its declaration as evidence', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare('select kind, qualified_name, start_line, end_line, signature, evidence_id from symbol').all() as Array<{ kind: string; qualified_name: string; start_line: number; end_line: number; signature: string | null; evidence_id: string }>
      const order = byKey((s: { kind: string; qualified_name: string }) => `${s.qualified_name}|${s.kind}`)
      expect(rows.map((r) => ({ kind: r.kind, qualified_name: r.qualified_name, lines: [r.start_line, r.end_line], signature: r.signature })).sort(order)).toEqual([...EXPECTED.symbols].sort(order))
      // A project is declared by its project file, which is configuration rather than source.
      for (const r of rows) expect((db.prepare('select source_kind from evidence where id = ?').get(r.evidence_id) as { source_kind: string }).source_kind).toBe(r.kind === 'project' ? 'configuration' : 'declaration')
    })
  })

  it('FR017 FR018 A3 C# calls equal the oracle, closed world, each unresolved call carrying its reason', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare(`select a.resolution, a.reason, a.source_id, a.target_id, ae.evidence_id from assertion a join assertion_evidence ae on ae.assertion_id = a.id where a.type = 'calls'`).all() as Array<{ resolution: string; reason: string | null; source_id: string; target_id: string | null; evidence_id: string }>
      const actual = rows.map((r) => {
        const c: Record<string, unknown> = { from: qn(db, r.source_id), line: (db.prepare('select start_line from evidence where id = ?').get(r.evidence_id) as { start_line: number }).start_line, site_text: slice(db, r.evidence_id), resolution: r.resolution }
        if (r.resolution === 'resolved') c.to = qn(db, r.target_id!)
        if (r.resolution === 'resolved_external') c.external = db.prepare('select module, name from external_symbol where id = ?').get(r.target_id)
        if (r.reason) c.reason = r.reason
        return c
      })
      const order = byKey((c: any) => `${c.from}|${String(c.line).padStart(4, '0')}|${c.site_text}`)
      expect(actual.sort(order)).toEqual([...EXPECTED.calls].sort(order))
    })
  })

  it('FR077 C# structure (implements, project dependencies, packages, containment) equals the oracle', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare(`select a.id, a.type, a.source_id, a.target_kind, a.target_id, a.detail from assertion a where a.type in ('implements', 'inherits', 'overrides', 'depends_on', 'depends_on_package', 'contains')`).all() as Array<{ id: string; type: string; source_id: string; target_kind: string; target_id: string; detail: string | null }>
      const actual = rows.map((r) => {
        const s: Record<string, unknown> = { type: r.type, from: qn(db, r.source_id) }
        if (r.target_kind === 'external') s.external = db.prepare('select module, name from external_symbol where id = ?').get(r.target_id)
        else s.to = qn(db, r.target_id)
        if (r.detail) s.detail = JSON.parse(r.detail)
        if (r.type === 'implements' || r.type === 'inherits') s.site_text = slice(db, (db.prepare('select evidence_id from assertion_evidence where assertion_id = ?').get(r.id) as { evidence_id: string }).evidence_id)
        return s
      })
      const order = byKey((s: any) => `${s.type}|${s.from}|${s.to ?? s.external?.name}`)
      expect(actual.sort(order)).toEqual([...EXPECTED.structure].sort(order))
    })
  })

  it.runIf(fixture === 'cs-orders')('A2 the packages and reference packs read are listed in identity, and a missing one is stated in every answer', () => {
    const adapters = withSnapshot(dataDir, (db) => JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value)) as Array<{ id: string; external_inputs: string[] }>
    const inputs = adapters.find((a) => a.id === 'csharp')!.external_inputs
    expect(inputs).toContain('nuget:Contoso.Missing.Client/1.0.0 missing')
    expect(inputs.some((i) => /^pack:Microsoft\.NETCore\.App\.Ref\/\d+\.\d+/.test(i))).toBe(true)
    // Two sites: `new AuditClient()` and the chained `.Send(total)` on it (#134).
    expect(tool(dataDir, 'find_symbols', { text: 'OrderService' }).limitations).toContain('1 external input was missing when this snapshot was built; 2 unresolved sites are blamed on them as dependency_missing, and workspace_status counts them by package.')
    // #37: counted per package, so a project lacking several packages adds a site to each.
    expect((tool(dataDir, 'workspace_status', {}).data as { calls: { dependency_missing_by_package: Record<string, number> } }).calls.dependency_missing_by_package).toEqual({ 'Contoso.Missing.Client': 2 })
  })

  it.runIf(fixture === 'cs-orders')('FR017 the same-named C# decoy acquires no inbound resolved edge', () => {
    withSnapshot(dataDir, (db) => {
      const decoy = db.prepare("select id from symbol where qualified_name = 'Orders.Core.Decoy.Calculate'").get() as { id: string }
      expect(db.prepare('select count(*) n from edge where dst = ?').get(decoy.id)).toEqual({ n: 0 })
    })
  })
})

describe('the trust boundary for build logic (fixtures/cs-sentinel)', () => {
  const realHome = process.env.HOME
  afterEach(() => { process.env.HOME = realHome })

  async function indexSentinel(trust: boolean): Promise<{ marker: string; mode: unknown }> {
    // The fixture's build writes $HOME/proofmesh-sentinel-ran; a private HOME makes the marker observable.
    const home = tmpDir('pm-home-')
    process.env.HOME = home
    const dataDir = tmpDir()
    const repo = tmpDir('pm-sentinel-')
    fs.cpSync(fixtureRepo('cs-sentinel'), repo, { recursive: true })
    initDataDir(dataDir)
    const catalog = Catalog.open(dataDir)
    const repoId = catalog.addRepository(repo).id
    if (trust) catalog.grantTrust(repoId, 'test')
    catalog.close()
    await indexRepository(dataDir, repoId)
    const mode = withSnapshot(dataDir, (db) => db.prepare("select value from meta where key = 'analysis_mode'").get())
    return { marker: path.join(home, 'proofmesh-sentinel-ran'), mode }
  }

  it('FR079 SC015 without a trust grant no build logic runs', async () => {
    const { marker, mode } = await indexSentinel(false)
    expect(fs.existsSync(marker)).toBe(false)
    expect(mode).toEqual({ value: 'no_execution' })
  })

  it('FR079 FR080 with a trust grant, build logic runs and the snapshot says so', async () => {
    const { marker, mode } = await indexSentinel(true)
    expect(fs.existsSync(marker)).toBe(true)
    expect(mode).toEqual({ value: 'trusted_build' })
  }, 240000)
})
