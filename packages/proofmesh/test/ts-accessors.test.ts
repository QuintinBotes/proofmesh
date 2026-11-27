import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { indexedRepo, symbolId, tool } from './helpers.js'

const A = `export function load(): number { return 1 }
export class Box {
  get value(): number { return load() }
  set value(v: number) { load() }
  static get size(): number { return load() }
}
export class Big extends Box {
  get value(): number { return 2 }
  set value(v: number) {}
}
`

describe('FR550 FR551 FR552 TypeScript get and set accessors are method symbols (#127)', () => {
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedRepo({ 'tsconfig.json': '{ "include": ["*.ts"] }\n', 'a.ts': A }))
  }, 120000)

  it('FR550 a get/set pair is one method symbol under the member name, keyed like an overload set', () => {
    const r = tool(dataDir, 'find_symbols', { text: 'value', path_prefix: 'a.ts' })
    const rows = (r.data.symbols as Array<{ qualified_name: string; kind: string; start_line: number; key: string }>).map((s) => `${s.qualified_name} ${s.kind} ${s.start_line} ${s.key}`)
    expect(rows.sort()).toEqual(['a:Big.value method 8 a.ts#a:Big.value#method', 'a:Box.value method 3 a.ts#a:Box.value#method'])
    // An overriding pair overrides once, at its first accessor.
    const over = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'a:Box.value'), direction: 'in', types: ['overrides'] })
    expect((over.data.relationships as Array<{ other: { qualified_name: string }; site: { start_line: number } }>).map((x) => `${x.other.qualified_name} ${x.site.start_line}`)).toEqual(['a:Big.value 8'])
  })

  it('FR551 a call inside a get or set accessor comes from the accessor symbol, not the class', () => {
    const r = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'a:load'), direction: 'in', types: ['calls'] })
    const rows = (r.data.relationships as Array<{ other: { qualified_name: string }; site: { path: string; start_line: number } }>)
      .map((x) => `${x.other.qualified_name} ${x.site.path}:${x.site.start_line}`).sort()
    expect(rows).toEqual(['a:Box.size a.ts:5', 'a:Box.value a.ts:3', 'a:Box.value a.ts:4'])
  })

  it('FR552 the syntax tier does the same: a call in a setter comes from the one method of the pair, not the class', async () => {
    const saved = process.env.PROOFMESH_TS_ADAPTER
    process.env.PROOFMESH_TS_ADAPTER = path.join(import.meta.dirname, 'fake-adapters', 'versioned-2.0.mjs')
    try {
      const { dataDir: d } = await indexedRepo({ 'tsconfig.json': '{ "include": ["*.ts"] }\n', 'a.ts': A, 'b.js': A.replace(/: number/g, '') })
      for (const m of ['a', 'b']) {
        const symbols = (tool(d, 'find_symbols', { text: 'value', path_prefix: m === 'a' ? 'a.ts' : 'b.js' }).data.symbols as Array<{ qualified_name: string; key: string }>).map((s) => s.key).sort()
        expect(symbols).toEqual([`${m === 'a' ? 'a.ts' : 'b.js'}#${m}:Big.value#method`, `${m === 'a' ? 'a.ts' : 'b.js'}#${m}:Box.value#method`])
        const r = tool(d, 'get_relationships', { subject_id: symbolId(d, `${m}:Box.value`), direction: 'out', types: ['calls'] })
        expect((r.data.relationships as Array<{ site: { start_line: number } }>).map((x) => x.site.start_line).sort()).toEqual([3, 4])
      }
    } finally {
      if (saved === undefined) delete process.env.PROOFMESH_TS_ADAPTER
      else process.env.PROOFMESH_TS_ADAPTER = saved
    }
  }, 120000)
})
