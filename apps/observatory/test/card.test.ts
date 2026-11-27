import { beforeAll, describe, expect, it } from 'vitest'
import { cardHood, declarationEvidence, rowEvidence, rowMark, rowName, rowWords, type Card, type CardRow } from '../src/card'
import { toNeighbourhood } from '../src/explore'
import { indexedDataDir, symbolId, tool } from '../../../packages/proofmesh/test/helpers.js'

let card: Card
beforeAll(async () => {
  const { dataDir } = await indexedDataDir()
  card = tool(dataDir, 'get_symbol_card', { symbol_id: symbolId(dataDir, 'packages/billing/src/invoice:invoiceTotal') }).data as unknown as Card
})
const callee = (name: string) => card.outgoing.rows.find((r) => r.other.name === name)!

describe('FR1183 every lens row says how it is known in words, and observed, inferred and unresolved rows differ by more than colour', () => {
  it('a resolved call reads observed; an external target adds external', () => {
    expect([rowName(callee('formatAmount')), rowWords(callee('formatAmount')), rowMark(callee('formatAmount'))]).toEqual(['formatAmount', ['observed'], 'observed'])
    expect(rowWords(callee('Array.reduce'))).toEqual(['observed', 'external'])
  })
  it('a candidate reads inferred and candidate, with the dashed mark; an unresolved call reads unresolved and its reason, named by the call as written', () => {
    const candidate: CardRow = { ...callee('formatAmount'), resolution: 'candidate', basis: 'inferred' }
    expect([rowWords(candidate), rowMark(candidate)]).toEqual([['inferred', 'candidate'], 'inferred'])
    const unresolved: CardRow = { ...callee('formatAmount'), resolution: 'unresolved', basis: undefined, reason: 'unknown_name', other: { kind: 'none' } }
    expect([rowName(unresolved), rowWords(unresolved), rowMark(unresolved)]).toEqual(['formatAmount(cents, currency)', ['unresolved', 'unknown_name'], 'unresolved'])
  })
})

describe('FR1180 the lens opens evidence from the card alone', () => {
  it('a row opens its call site with the cited span highlighted; the focus opens its declaration', () => {
    const e = rowEvidence(callee('formatAmount'))
    expect(e.text!.slice(...e.highlight!)).toBe('formatAmount(cents, currency)')
    expect(e).toMatchObject({ integrity: 'verified', facts: [['origin', 'semantic_resolver'], ['file', 'packages/billing/src/invoice.ts:9']], focusId: callee('formatAmount').other.id })
    expect(declarationEvidence(card)).toMatchObject({ title: 'packages/billing/src/invoice:invoiceTotal', integrity: 'verified' })
  })
  it('the Table view and the export read the same rows, with the same conclusion as before', () => {
    expect(toNeighbourhood(cardHood(card), card.symbol).conclusion).toBe('invoiceTotal: 1 incoming, 2 outgoing. Click a node to explore from it.')
  })
})
