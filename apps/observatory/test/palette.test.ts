import zlib from 'node:zlib'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildIndex, LIMIT, searchIndex } from '../src/paletteIndex'
import { parseGalaxy } from '../src/galaxyData'
import { galaxyFor } from '../../../packages/proofmesh/src/query/galaxy.js'
import { indexedDataDir } from '../../../packages/proofmesh/test/helpers.js'

const names = (symbols: string[], files: string[], query: string) => {
  const all = [...symbols, ...files]
  return searchIndex(buildIndex(symbols, files), query).items.map((i) => all[i])
}

describe('FR1141 the palette ranks symbols and files: exact name, then prefix, then substring, then qualified name', () => {
  it('puts exact names first, then names that start with the text, then names that hold it, then qualified names that hold it; each by name', () => {
    const symbols = ['src/a:zeta.initializeAll', 'src/b:Other.reinitialize', 'src/initialize/x:run', 'src/z:DataSource.initialize', 'src/c:Init.initialize', 'src/d:unrelated']
    expect(names(symbols, ['src/initialize.ts', 'src/other.ts'], 'Initialize')).toEqual([
      'src/c:Init.initialize', 'src/initialize.ts', 'src/z:DataSource.initialize',
      'src/a:zeta.initializeAll',
      'src/b:Other.reinitialize',
      'src/initialize/x:run',
    ])
  })

  it(`lists the first ${LIMIT} in rank order and counts every match`, () => {
    const symbols = Array.from({ length: 45 }, (_, i) => `src/items:loadItem${String(i).padStart(2, '0')}`).concat('src/z:load')
    const r = searchIndex(buildIndex(symbols, []), 'load')
    expect(r.total).toBe(46)
    expect(r.items.map((i) => symbols[i])).toEqual(['src/z:load', ...symbols.slice(0, LIMIT - 1)])
  })

  it('lists a name that holds the text twice once', () => {
    expect(names(['src/a:abab', 'src/b:ab'], [], 'ab')).toEqual(['src/b:ab', 'src/a:abab'])
  })

  it('agrees with a plain filter and sort on any names and query', () => {
    const short = (s: string) => (s.split(/[.:/]/).pop() || s).toLowerCase()
    const rank = (s: string, q: string) => (short(s) === q ? 0 : short(s).startsWith(q) ? 1 : short(s).includes(q) ? 2 : 3)
    fc.assert(fc.property(fc.array(fc.stringMatching(/^[a-c./:]{1,8}$/), { maxLength: 60 }), fc.stringMatching(/^[a-c.]{2,3}$/), (symbols, q) => {
      const want = symbols.map((s, i) => [s, i] as const).filter(([s]) => s.toLowerCase().includes(q))
        .sort((x, y) => rank(x[0], q) - rank(y[0], q) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]))
      const r = searchIndex(buildIndex(symbols, []), q)
      expect(r.total).toBe(want.length)
      expect(r.items).toEqual(want.slice(0, LIMIT).map(([, i]) => i))
    }))
  })
})

describe('FR1142 symbols wait for two characters', () => {
  it('answers nothing for a query shorter than two characters', () => {
    const idx = buildIndex(['src/a:a', 'src/b:ab'], ['src/a.ts'])
    expect(searchIndex(idx, ' a ')).toEqual({ items: [], total: 0 })
    expect(searchIndex(idx, '')).toEqual({ items: [], total: 0 })
  })
})

describe('FR1142 the Galaxy payload carries the files the palette lists', () => {
  let d: string
  beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })
  it('names every indexed file once, sorted, and every symbol lives in one of them', () => {
    const raw = zlib.gunzipSync(galaxyFor(d).gz)
    const g = parseGalaxy(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    expect(g.files).toEqual([...new Set(g.files)].sort())
    expect(g.files).toContain('packages/billing/src/invoice.ts')
    for (const n of g.names) expect(g.files.some((f) => f.replace(/\.[^./]+$/, '') === n.split(':')[0])).toBe(true)
  })
})
