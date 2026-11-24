import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runKit } from '../src/conformance/kit.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { BUILT_IN } from '../src/indexer/languages.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { evidenceSlice, expectedFor, fixtureRepo, tmpDir, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('tf-basics')
const terraform = () => { const b = BUILT_IN.find((x) => x.id === 'terraform')!; return { id: 'terraform', entry: b.entry()!, extensions: b.extensions, configNames: [] } }
const key = (r: Record<string, unknown>) => `${r.type}|${r.from}|${String(r.line).padStart(4, '0')}|${r.site_text}`

async function indexed() {
  const d = tmpDir(), repo = tmpDir('pm-tf-')
  fs.cpSync(fixtureRepo('tf-basics'), repo, { recursive: true })
  initDataDir(d)
  const c = Catalog.open(d); c.addRepository(repo); c.close()
  return { d, repo, first: await indexRepository(d, repo) }
}

describe('A8 A25 FR077 the Terraform adapter: static HCL, a module per directory, never terraform init', () => {
  it('SC014 passes the conformance kit, with dispositions and symbols equal to the hand-written oracle', async () => {
    const r = await runKit(terraform(), fixtureRepo('tf-basics'), { dispositions: EXPECTED.dispositions, symbols: EXPECTED.symbols })
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`)).toEqual([])
  }, 240000)

  it('references and depends_on equal the oracle, closed world: a local module resolves, a remote one and an undeclared name do not', async () => {
    const { d } = await indexed()
    const actual = withSnapshot(d, (db) => {
      const qn = (id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name
      return (db.prepare(`select a.type, a.source_id, a.target_id, a.resolution, a.reason, ae.evidence_id from assertion a join assertion_evidence ae on ae.assertion_id = a.id where a.type in ('references', 'depends_on')`).all() as Array<{ type: string; source_id: string; target_id: string | null; resolution: string; reason: string | null; evidence_id: string }>)
        .map((r) => ({ type: r.type, from: qn(r.source_id), line: (db.prepare('select start_line from evidence where id = ?').get(r.evidence_id) as { start_line: number }).start_line, site_text: evidenceSlice(d, db, r.evidence_id), resolution: r.resolution, ...(r.resolution === 'resolved' ? { to: qn(r.target_id!) } : { reason: r.reason }) }))
    })
    expect(actual.sort((a, b) => (key(a) < key(b) ? -1 : 1))).toEqual([...EXPECTED.relationships].sort((a: Record<string, unknown>, b: Record<string, unknown>) => (key(a) < key(b) ? -1 : 1)))
  }, 240000)

  it('A16 a module is a unit: an edit to the root module reuses the child module it calls', async () => {
    const { d, repo, first } = await indexed()
    expect(first.reuse).toEqual({ reused: 0, analysed: 2 })
    fs.appendFileSync(path.join(repo, 'main.tf'), '\nlocals {\n  extra = var.env\n}\n')
    expect((await indexRepository(d, repo)).reuse).toEqual({ reused: 1, analysed: 1 })
  }, 240000)
})
