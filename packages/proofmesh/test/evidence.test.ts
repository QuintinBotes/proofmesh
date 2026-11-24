import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../src/core/hash.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { FIXTURE, fixtureRepo, indexedDataDir, symbolId, tool, withSnapshot } from './helpers.js'

async function callEvidence() {
  const { dataDir } = await indexedDataDir()
  const rel = (tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'packages/billing/src/invoice:invoiceTotal'), direction: 'out', resolutions: ['resolved'] }).data.relationships as any[])[0]
  return { dataDir, evidenceId: rel.evidence_ids[0] as string }
}
const objectPath = (d: string, hash: string) => path.join(d, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash)

describe('AC21 read_evidence integrity', () => {
  it('returns the exact text, verified', async () => {
    const { dataDir, evidenceId } = await callEvidence()
    const ev = (tool(dataDir, 'read_evidence', { evidence_ids: [evidenceId] }).data.evidence as any[])[0]
    expect(ev).toMatchObject({ text: 'formatAmount(cents, currency)', integrity: { status: 'verified' }, start_line: 9, path: 'packages/billing/src/invoice.ts' })
  })

  it('FR029 an altered object fails with its actual hash and no text', async () => {
    const { dataDir, evidenceId } = await callEvidence()
    const hash = (tool(dataDir, 'read_evidence', { evidence_ids: [evidenceId] }).data.evidence as any[])[0].object_hash
    const p = objectPath(dataDir, hash)
    fs.chmodSync(p, 0o644)
    fs.appendFileSync(p, '// tampered\n')
    const ev = (tool(dataDir, 'read_evidence', { evidence_ids: [evidenceId] }).data.evidence as any[])[0]
    expect(ev.integrity.status).toBe('failed')
    expect(ev.integrity.actual_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(ev.text).toBeNull()
  })

  it('FR031 a deleted object is unavailable', async () => {
    const { dataDir, evidenceId } = await callEvidence()
    const hash = (tool(dataDir, 'read_evidence', { evidence_ids: [evidenceId] }).data.evidence as any[])[0].object_hash
    fs.rmSync(objectPath(dataDir, hash), { force: true })
    const ev = (tool(dataDir, 'read_evidence', { evidence_ids: [evidenceId] }).data.evidence as any[])[0]
    expect(ev).toMatchObject({ integrity: { status: 'unavailable' }, text: null })
  })

  it('an unknown evidence ID fails the whole call as NOT_FOUND', async () => {
    const { dataDir } = await callEvidence()
    expect(() => tool(dataDir, 'read_evidence', { evidence_ids: ['ev_000'] })).toThrow(/not in snapshot/)
  })
})

describe('FR025 a fact links to its source evidence, the content hash, and the extractor and analysis mode that produced it', () => {
  it('read_evidence of a call names the adapter and version that asserted the call, its mode, and the hash of the file it cites', async () => {
    const { dataDir, evidenceId } = await callEvidence()
    const ev = (tool(dataDir, 'read_evidence', { evidence_ids: [evidenceId] }).data.evidence as any[])[0]
    const producer = withSnapshot(dataDir, (db) => db.prepare('select a.adapter, a.adapter_version, a.analysis_mode from assertion a join assertion_evidence ae on ae.assertion_id = a.id where ae.evidence_id = ?').get(evidenceId))
    const recorded = (tool(dataDir, 'workspace_status').data.adapters as Array<{ id: string; version: string }>).find((a) => a.id === 'typescript')!
    expect(producer).toEqual({ adapter: 'typescript', adapter_version: recorded.version, analysis_mode: 'no_execution' })
    expect(ev).toMatchObject({ extractor: 'typescript', extractor_version: recorded.version, analysis_mode: 'no_execution', source_kind: 'call_site', object_hash: sha256(fs.readFileSync(path.join(FIXTURE, 'packages/billing/src/invoice.ts'))) })
  })
})

describe('SC002 every published fact cites valid evidence', () => {
  for (const fixture of ['ts-invoicing', 'py-shop', 'tf-basics', 'ownership', 'cs-orders']) {
    it(`SC002 ${fixture}: each assertion and each symbol cites at least one evidence record whose object verifies`, async () => {
      const { dataDir } = await indexedDataDir(fixtureRepo(fixture))
      const store = new EvidenceStore(dataDir)
      withSnapshot(dataDir, (db) => {
        const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
        const assertions = n('select count(*) n from assertion'), symbols = n('select count(*) n from symbol')
        expect(assertions * symbols).toBeGreaterThan(0)
        expect({
          assertions: n('select count(*) n from assertion a where exists (select 1 from assertion_evidence ae join evidence e on e.id = ae.evidence_id where ae.assertion_id = a.id)'),
          symbols: n('select count(*) n from symbol s join evidence e on e.id = s.evidence_id'),
        }).toEqual({ assertions, symbols })
        const objects = (db.prepare('select distinct object_hash from evidence').all() as Array<{ object_hash: string }>).map((r) => r.object_hash)
        expect(objects.filter((h) => store.verify(h).integrity.status !== 'verified')).toEqual([])
      })
    }, 180000)
  }
})
