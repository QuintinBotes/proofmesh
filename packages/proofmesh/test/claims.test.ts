import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { indexRepository } from '../src/indexer/coordinator.js'
import { copyFixture, indexedDataDir, symbolId, tool } from './helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })
const check = (proposition: Record<string, unknown>, dataDir = d) => tool(dataDir, 'verify_claim', { claim: { statement: 'An agent wrote this.', proposition } })
const outcomes = (env: any) => Object.fromEntries(env.data.layers.map((l: any) => [l.name, l.outcome]))
const fn = (qn: string) => `function:${qn}`

describe('a path claim through an interface is supported when implements is among the relationships, and says so when it is not', () => {
  it('calls plus implements: supported; calls only: refuted with the hint to add implements', async () => {
    const { fixtureRepo, indexedDataDir, symbolId, tool } = await import('./helpers.js')
    const { dataDir } = await indexedDataDir(fixtureRepo('cs-orders'))
    const source = symbolId(dataDir, 'Orders.Core.Checkout.Buy'), target = symbolId(dataDir, 'Orders.Core.OrderService.PlaceOrder')
    const run = (relationships: string[]) => tool(dataDir, 'verify_claim', { claim: { statement: 'Buy reaches PlaceOrder.', proposition: { type: 'path', source, target, relationships, max_depth: 4 } } })
    const found = run(['calls', 'implements'])
    expect((found.data as any).verdict).toBe('supported')
    expect(found.limitations).toContain('implements and overrides hops run both ways: a call to an interface or virtual member may dispatch to any implementation.')
    const callsOnly = run(['calls'])
    expect((callsOnly.data as any).verdict).toBe('refuted')
    expect(callsOnly.limitations).toContain('Paths were followed along calls only; name implements and overrides among the relationships to reach implementations through interfaces and virtual members.')
  }, 180000)
})

describe('FR027 FR028 FR030 FR033 verify_claim: layered outcomes and a scoped verdict', () => {
  it('a resolved relationship is supported, resting on evidence whose hash still matches', () => {
    const env = check({ type: 'relationship', source: fn('packages/api/src/handler:handleInvoice'), relationship: 'calls', target: fn('packages/billing/src/invoice:invoiceTotal') }) as any
    expect(env.data.verdict).toBe('supported')
    expect(outcomes(env)).toEqual({ scope: 'pass', resolution: 'pass', semantic: 'pass', integrity: 'pass', replay: 'unsupported', independent: 'not_run', execution: 'not_run' })
    expect(env.data.dependencies.assertions).toHaveLength(1)
    expect(env.limitations).toContain('The statement text is not checked; only the structured proposition is.')
  })

  it('a relationship to the same-named decoy is refuted', () => {
    expect((check({ type: 'relationship', source: fn('packages/billing/src/invoice:invoiceTotal'), relationship: 'calls', target: fn('packages/legacy/src/format:formatAmount') }) as any).data.verdict).toBe('refuted')
  })

  it('a path claim is supported by the path it rests on', () => {
    const env = check({ type: 'path', source: fn('packages/api/src/handler:handleInvoice'), target: fn('packages/format/src/currency:formatAmount') }) as any
    expect([env.data.verdict, env.data.dependencies.assertions.length]).toEqual(['supported', 2])
  })

  it('an absence claim is supported only when the search was exhaustive; an unresolved boundary in reach makes it inconclusive', () => {
    expect((check({ type: 'no_path', source: fn('packages/format/src/currency:formatAmount'), target: fn('packages/api/src/handler:handleInvoice') }) as any).data.verdict).toBe('supported')
    const blocked = check({ type: 'no_path', source: fn('packages/api/src/handler:dispatch'), target: fn('packages/legacy/src/format:formatAmount') }) as any
    expect([blocked.data.verdict, outcomes(blocked).semantic]).toEqual(['inconclusive', 'inconclusive'])
  })

  it('an unknown reference cannot be verified', () => {
    const env = check({ type: 'path', source: fn('packages/nowhere:gone'), target: fn('packages/format/src/currency:formatAmount') }) as any
    expect([env.data.verdict, outcomes(env).resolution, outcomes(env).semantic]).toEqual(['inconclusive', 'fail', 'not_run'])
  })

  it('tampered evidence makes a claim invalid even though the graph still supports it, and a stored claim can be checked again', async () => {
    const { dataDir } = await indexedDataDir()
    const first = check({ type: 'relationship', source: fn('packages/api/src/handler:handleInvoice'), relationship: 'calls', target: fn('packages/billing/src/invoice:invoiceTotal') }, dataDir) as any
    const hash = (tool(dataDir, 'read_evidence', { evidence_ids: first.data.dependencies.evidence }).data.evidence as any[])[0].object_hash
    const object = path.join(dataDir, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash)
    fs.chmodSync(object, 0o644)
    fs.appendFileSync(object, '// tampered\n')
    const again = tool(dataDir, 'verify_claim', { claim_id: first.data.claim_id }) as any
    expect([again.data.claim_id, again.data.verdict, outcomes(again).semantic, outcomes(again).integrity]).toEqual([first.data.claim_id, 'invalid', 'pass', 'fail'])
  })
})

describe('SC007 missing, stale or out-of-scope evidence cannot receive a current supported verdict', () => {
  const calls = { type: 'relationship', source: fn('packages/api/src/handler:handleInvoice'), relationship: 'calls', target: fn('packages/billing/src/invoice:invoiceTotal') }
  // Another registration of the fixture, at another root: another repository, whose snapshot IDs and symbol IDs are its own.
  let other: { repo: string; dataDir: string; snapshotId: string; repoId: string }
  beforeAll(async () => { const repo = copyFixture(); other = { repo, ...(await indexedDataDir(repo)) } })

  it('SC007 missing evidence: with an evidence object deleted the claim is inconclusive and its integrity unavailable', async () => {
    const { dataDir } = await indexedDataDir()
    const first = check(calls, dataDir) as any
    expect(first.data.verdict).toBe('supported')
    const hash = (tool(dataDir, 'read_evidence', { evidence_ids: first.data.dependencies.evidence }).data.evidence as any[])[0].object_hash
    fs.rmSync(path.join(dataDir, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash))
    const again = tool(dataDir, 'verify_claim', { claim_id: first.data.claim_id }) as any
    expect([again.data.verdict, outcomes(again).semantic, outcomes(again).integrity]).toEqual(['inconclusive', 'pass', 'unavailable'])
  })

  it('SC007 stale evidence: once the call is edited away and the repository re-indexed, the claim is not supported by old symbol IDs or by name', async () => {
    const { dataDir, snapshotId: before, repoId, repo } = other
    const byId = { ...calls, source: symbolId(dataDir, 'packages/api/src/handler:handleInvoice'), target: symbolId(dataDir, 'packages/billing/src/invoice:invoiceTotal') }
    const [idClaim, nameClaim] = [check(byId, dataDir), check(calls, dataDir)] as any[]
    expect([idClaim.data.verdict, nameClaim.data.verdict]).toEqual(['supported', 'supported'])
    const handler = path.join(repo, 'packages/api/src/handler.ts')
    fs.writeFileSync(handler, fs.readFileSync(handler, 'utf8').replace('return invoiceTotal(request.lines, "EUR");', 'return "none";'))
    const after = (await indexRepository(dataDir, repoId)).snapshotId
    expect(after).not.toBe(before)
    const id = tool(dataDir, 'verify_claim', { claim_id: idClaim.data.claim_id }) as any
    expect([id.snapshot.id, id.data.verdict, outcomes(id).scope]).toEqual([after, 'inconclusive', 'fail'])
    const name = tool(dataDir, 'verify_claim', { claim_id: nameClaim.data.claim_id }) as any
    expect([name.snapshot.id, name.data.verdict, outcomes(name).scope, outcomes(name).semantic]).toEqual([after, 'refuted', 'pass', 'fail'])
    // Pinned to the superseded snapshot, the verdict is that snapshot's, and it says it is not about the code as it is now.
    const pinned = tool(dataDir, 'verify_claim', { claim_id: nameClaim.data.claim_id, snapshot_id: before }) as any
    expect([pinned.snapshot.id, pinned.data.verdict]).toEqual([before, 'supported'])
    expect(pinned.limitations).toContain(`Snapshot ${before} is not the repository's current snapshot (${after} is): the verdict holds for that snapshot, not for the code as it is now.`)
  })

  it('SC007 out-of-scope subjects: an external symbol and a symbol ID of another repository fail the scope layer and are not supported', () => {
    const format = symbolId(d, 'packages/format/src/currency:formatAmount')
    const external = ((tool(d, 'get_relationships', { subject_id: format, direction: 'out', include_external: true }).data as any).relationships as any[]).find((r) => r.other.kind === 'external').other.id as string
    expect(external).toMatch(/^ext_/)
    const ext = check({ type: 'relationship', source: fn('packages/format/src/currency:formatAmount'), relationship: 'calls', target: external }) as any
    expect([ext.data.verdict, outcomes(ext).scope, outcomes(ext).resolution, outcomes(ext).semantic]).toEqual(['inconclusive', 'fail', 'not_run', 'not_run'])
    const foreign = symbolId(other.dataDir, 'packages/billing/src/invoice:invoiceTotal')
    const env = check({ ...calls, target: foreign }) as any
    expect([env.data.verdict, outcomes(env).scope, outcomes(env).semantic]).toEqual(['inconclusive', 'fail', 'not_run'])
    expect(env.data.layers.find((l: any) => l.name === 'scope').detail).toContain(foreign)
  })
})

describe('FR100 verify_claim takes { name, path } in place of a symbol reference', () => {
  it('a relationship named by name and path is checked as one named by kind:qualified name, and stored that way', () => {
    const env = check({ type: 'relationship', source: { name: 'handleInvoice', path: 'packages/api/src/handler.ts' }, relationship: 'calls', target: { name: 'invoiceTotal', path: 'packages/billing/src/invoice.ts' } }) as any
    expect(env.data.verdict).toBe('supported')
    const again = tool(d, 'verify_claim', { claim_id: env.data.claim_id }) as any
    expect(again.data.verdict).toBe('supported')
  })
})
