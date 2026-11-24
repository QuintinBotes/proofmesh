import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { check } from '../../../packages/proofmesh/src/core/schemas.js'
import { kinds, overlay, rows, tiles, type CompareData } from '../src/diff'
import type { GalaxyData } from '../src/galaxyData'

const envelope = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'compare.json'), 'utf8'))
const data = envelope.data as CompareData

describe('FR019 the Diff view reads a compare_snapshots answer', () => {
  it('the recorded envelope is valid against the tool contract', () => {
    expect(check('tools/compare_snapshots.data.schema.json', data)).toBeUndefined()
  })

  it('tiles read the counts, never the lists, so a truncated list leaves them right', () => {
    expect(tiles(data).map((t) => [t.label, t.value])).toEqual([
      ['Symbols added', '2'], ['Symbols removed', '1'], ['Symbols changed', '2'],
      ['Relationships', '+5 −2 (calls +4 −2, imports +1 −0)'],
      ['Files', '1 added, 0 removed, 2 changed'],
      ['Unresolved', '4 → 3'],
    ])
  })

  it('rows are one ordered table by path, then name, then change, and filters narrow it', () => {
    expect(rows(data).map((r) => `${r.change} ${r.qualified_name}${r.what ? ` [${r.what}]` : ''}`)).toEqual([
      'added packages/api/src/handler:Rates',
      'changed packages/api/src/handler:handleInvoice [range, signature]',
      'added packages/billing/src/invoice:invoiceTax',
      'changed packages/billing/src/invoice:invoiceTotal [signature]',
      'removed packages/format/src/currency:legacyFormat',
    ])
    expect(rows(data, { kinds: new Set(['class']) }).map((r) => r.qualified_name)).toEqual(['packages/api/src/handler:Rates'])
    expect(rows(data, { changes: new Set(['removed']) }).map((r) => r.qualified_name)).toEqual(['packages/format/src/currency:legacyFormat'])
    expect(kinds(data)).toEqual(['class', 'function'])
  })

  it('the overlay tints added and changed symbols of the head galaxy and leaves removed ones to the table', () => {
    const g = { n: 4, names: ['packages/billing/src/invoice:invoiceTotal', 'packages/api/src/handler:Rates', 'packages/format/src/currency:legacyFormat', 'other:thing'] } as unknown as GalaxyData
    expect(Array.from(overlay(g, data))).toEqual([2, 1, 0, 0])
  })
})
