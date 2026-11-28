import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { copyTrackedFixture, indexedDataDir, symbolId, tool, cli } from './helpers.js'

it('FR942 entry-point witnesses reach the same helper through a recursive component, with bounded alternatives and snapshot citations (#302)', async () => {
  const repo = copyTrackedFixture('ts-routes'), source = path.join(repo, 'src/routes/orders.ts')
  fs.appendFileSync(source, `
function money() { return 1 }
function first(n) { return n ? second(n - 1) : money() }
function second(n) { return n ? first(n - 1) : money() }
function statement() { return first(2) + second(2) }
function balance() { return money() }
function history() { return 0 }
router.get('/statement', statement)
router.get('/balance', balance)
router.get('/history', history)
router.get('/unknown', handlers[name])
`)
  const { dataDir, snapshotId } = await indexedDataDir(repo)
  const target = symbolId(dataDir, 'src/routes/orders:money')
  const input = { target_id: target, alternative: true, snapshot_id: snapshotId, limits: { max_rows: 100, max_depth: 10 } }
  const query = () => tool(dataDir, 'find_entry_points', input)
  const answer = query()
  const entries = answer.data.entries as { name: string; id: string; witnesses: { from: string; to: string; type: string; evidence_ids: string[]; path: string; line: number }[][] }[]
  expect(entries.map((r) => r.name).sort()).toEqual(['GET api/orders/balance', 'GET api/orders/statement'])
  expect(entries.map((r) => r.witnesses.length).sort()).toEqual([1, 2])
  for (const row of entries) {
    const traced = tool(dataDir, 'trace_paths', { source_id: row.id, target_id: target, types: ['exposes', 'calls'] })
    for (const hops of row.witnesses) {
      expect(traced.data.paths).toContainEqual(expect.objectContaining({ nodes: [row.id, ...hops.map((h) => h.to)] }))
      expect(hops.every((h) => h.path === 'src/routes/orders.ts' && h.line > 0 && h.evidence_ids.length)).toBe(true)
      const cited = tool(dataDir, 'read_evidence', { evidence_ids: hops[0]!.evidence_ids })
      expect(cited.data.evidence).toContainEqual(expect.objectContaining({ integrity: { status: 'verified' } }))
    }
  }
  expect(answer.unresolved.count).toBeGreaterThan(0)
  expect(tool(dataDir, 'find_entry_points', { ...input, limits: { max_depth: 1 } }).completion.stop_reasons).toContain('max_depth')
  fs.appendFileSync(source, '\nrouter.get(\'/another\', balance)\n')
  expect(cli(['--data-dir', dataDir, 'index', repo]).status).toBe(0)
  expect(query().data).toEqual(answer.data)
}, 120000)
