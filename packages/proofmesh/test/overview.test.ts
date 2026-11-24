import { beforeAll, describe, expect, it } from 'vitest'
import { indexedDataDir, tool } from './helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })
const view = (input: Record<string, unknown>) => tool(d, 'get_overview', input).data as { path: string; scope: string; children: Array<Record<string, unknown>>; links: Array<Record<string, unknown>>; omitted: number }

describe('FR056 FR019 get_overview: the repository as a graph of areas', () => {
  it('the root collapses single-child chains and aggregates resolved calls and imports between areas', () => {
    const o = view({})
    expect(o.path).toBe('packages')
    expect(o.children.map((c) => [c.name, c.kind, c.symbols])).toEqual([['api/src', 'directory', 3], ['billing/src', 'directory', 2], ['format/src', 'directory', 1], ['legacy/src', 'directory', 1]])
    expect(o.links).toEqual([
      { from: 'packages/api/src', to: 'packages/billing/src', count: 2, by_type: { calls: 1, imports: 1 } },
      { from: 'packages/billing/src', to: 'packages/format/src', count: 2, by_type: { calls: 1, imports: 1 } },
    ])
  })

  it('a directory lists its files, a barrel file included, with the imports between them', () => {
    const o = view({ path: 'packages/billing/src' })
    expect(o.children.map((c) => [c.name, c.kind, c.symbols])).toEqual([['invoice.ts', 'file', 2], ['index.ts', 'file', 0]])
    expect(o.links).toEqual([{ from: 'packages/billing/src/index.ts', to: 'packages/billing/src/invoice.ts', count: 1, by_type: { imports: 1 } }])
  })

  it('a file lists its symbols', () => {
    const o = view({ path: 'packages/billing/src/invoice.ts' })
    expect(o.scope).toBe('file')
    expect(o.children.map((c) => [c.name, c.symbol_kind])).toEqual([['Line', 'interface'], ['invoiceTotal', 'function']])
  })

  it('a search keeps only the areas holding a match, with their match counts', () => {
    const o = view({ text: 'format' })
    expect(o.path).toBe('packages')
    expect(o.children.map((c) => [c.name, c.matches])).toEqual([['format/src', 1], ['legacy/src', 1]])
    expect(o.links).toEqual([])
  })
})
