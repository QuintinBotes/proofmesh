import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { CLI, evidenceSlice, expectedFor, fixtureRepo, ROOT, tmpDir, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('cs-conventions')
const CONVENTIONS = path.join(ROOT, 'fixtures', 'cs-conventions', 'conventions.json')
const qn = (db: Database.Database, id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name
const cli = (dataDir: string, ...args: string[]) => execFileSync(process.execPath, [CLI, '--data-dir', dataDir, ...args], { encoding: 'utf8' })

describe('A32 C# rules a conventions file configures (fixtures/cs-conventions)', () => {
  let dataDir: string, repoId: string
  beforeAll(async () => {
    dataDir = tmpDir()
    initDataDir(dataDir)
    const catalog = Catalog.open(dataDir)
    repoId = catalog.addRepository(fixtureRepo('cs-conventions')).id
    catalog.close()
    expect(cli(dataDir, 'repo', 'conventions', repoId, CONVENTIONS)).toContain('conventions registered')
    await indexRepository(dataDir, repoId)
  })

  it('FR016 jobs, feature flags and code-declared teams are framework symbols declared where the repository declares them', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select s.kind, s.qualified_name, s.name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind in ('job', 'feature_flag', 'team')").all()
      const order = (a: any, b: any) => (`${a.kind}|${a.qualified_name}` < `${b.kind}|${b.qualified_name}` ? -1 : 1)
      expect(rows.sort(order)).toEqual([...EXPECTED.symbols].sort(order))
    })
  })

  it('FR016 runs, evaluates_flag and owned_by equal the oracle, each citing its rule and site', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select a.id, a.type, a.source_id, a.target_id, a.resolution, a.detail from assertion a where a.type in ('runs', 'evaluates_flag', 'owned_by') and a.origin = 'framework_adapter'").all() as Array<{ id: string; type: string; source_id: string; target_id: string; resolution: string; detail: string }>
      const actual = rows.map((r) => {
        expect(r.resolution).toBe('resolved')
        const e = db.prepare('select ae.evidence_id as id, e.start_line as line from assertion_evidence ae join evidence e on e.id = ae.evidence_id where ae.assertion_id = ?').get(r.id) as { id: string; line: number }
        return { type: r.type, from: qn(db, r.source_id), to: qn(db, r.target_id), line: e.line, site_text: evidenceSlice(dataDir, db, e.id), rule: JSON.parse(r.detail).rule }
      })
      const order = (a: any, b: any) => (`${a.type}|${a.from}|${a.to}` < `${b.type}|${b.from}|${b.to}` ? -1 : 1)
      expect(actual.sort(order)).toEqual([...EXPECTED.relationships].sort(order))
    })
  })

  it('a conventions file is part of snapshot identity, and a malformed one is refused', async () => {
    const current = () => { const c = Catalog.open(dataDir); try { return c.currentSnapshot(repoId)!.id } finally { c.close() } }
    const before = current()
    expect(cli(dataDir, 'repo', 'conventions', repoId)).toContain('"enum_type": "Ops.Crew"')
    const bad = path.join(tmpDir(), 'bad.json')
    fs.writeFileSync(bad, JSON.stringify({ schema_version: '0.1', csharp: { jobs: [{ base: 'X' }] } }))
    expect(() => cli(dataDir, 'repo', 'conventions', repoId, bad)).toThrow(/not a conventions file 0.1/)
    cli(dataDir, 'repo', 'conventions', repoId, '--clear')
    const cleared = await indexRepository(dataDir, repoId)
    withSnapshot(dataDir, (db) => expect((db.prepare("select count(*) as n from symbol where kind in ('job', 'feature_flag', 'team')").get() as { n: number }).n).toBe(0))
    expect(cleared.snapshotId).not.toBe(before)
    expect(current()).toBe(cleared.snapshotId)
  })
})
