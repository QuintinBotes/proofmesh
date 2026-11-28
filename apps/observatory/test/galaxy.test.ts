import crypto from 'node:crypto'
import zlib from 'node:zlib'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildIndex, LIMIT, searchIndex } from '../src/paletteIndex'
import { areaFog, areaLabel, ghostAreas, legendAreas, matchIndices, parseGalaxy, parseGalaxySliced, rankMatches, shortName, type GalaxyData } from '../src/galaxyData'
import { terrainPayload } from '../../../packages/proofmesh/src/query/terrain-payload.js'
import { galaxyFor } from '../../../packages/proofmesh/src/query/galaxy.js'
import { indexedDataDir } from '../../../packages/proofmesh/test/helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })
const load = () => { const gz = galaxyFor(d).gz; const raw = zlib.gunzipSync(gz); return parseGalaxy(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) }

describe('A11 the Galaxy payload: every symbol of the snapshot in one compact binary', () => {
  it('FR1453 the Terrain projection carries the same positions, names, degrees and bundles', async () => {
    const full = load()
    const raw = zlib.gunzipSync(await terrainPayload(d, galaxyFor(d).gz))
    const terrain = parseGalaxy(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    expect(terrain.links.length).toBe(0)
    expect({ ...terrain, links: full.links }).toEqual(full)
  })
  it('holds every non-module symbol with its area, and the distinct resolved links between them', () => {
    const g = load()
    expect(g.names.slice().sort()).toEqual([
      'packages/api/src/handler:dispatch', 'packages/api/src/handler:handleInvoice', 'packages/api/src/handler:handlers',
      'packages/billing/src/invoice:Line', 'packages/billing/src/invoice:Line.cents', 'packages/billing/src/invoice:invoiceTotal',
      'packages/format/src/currency:formatAmount', 'packages/legacy/src/format:formatAmount',
    ])
    const name = (i: number) => g.names[i]!
    const links = Array.from({ length: g.links.length / 2 }, (_, j) => `${name(g.links[j * 2]!)} -> ${name(g.links[j * 2 + 1]!)}`).sort()
    // invoiceTotal's use of the Line type is a TypeScript reference (FR086), its read of line.cents is one too (FR1021), and dispatch's
    // read of the handlers variable is one (FR102), so each is a resolved link.
    expect(links).toEqual(['packages/api/src/handler:dispatch -> packages/api/src/handler:handlers', 'packages/api/src/handler:handleInvoice -> packages/billing/src/invoice:invoiceTotal', 'packages/billing/src/invoice:invoiceTotal -> packages/billing/src/invoice:Line', 'packages/billing/src/invoice:invoiceTotal -> packages/billing/src/invoice:Line.cents', 'packages/billing/src/invoice:invoiceTotal -> packages/format/src/currency:formatAmount'])
    // An area is a file's first two directories (FR1400).
    expect(g.areas.map((a) => [a.name, a.count])).toEqual([['packages/billing', 3], ['packages/api', 3], ['packages/format', 1], ['packages/legacy', 1], ['(root)', 0]])
    expect(g.names.map((n, i) => [n.split(':')[0]!.split('/').slice(0, 2).join('/'), g.areas[g.area[i]!]!.name]).every(([a, b]) => a === b)).toBe(true)
  })

  it('FR059 each area carries its coverage: files by disposition, call sites, unresolved calls, and why files were not analysed', () => {
    const none = { indexed: 0, unsupported: 0, excluded: 0, failed: 0, pending: 0 }
    expect(load().areas).toEqual([
      { name: 'packages/billing', count: 3, files: { ...none, indexed: 2, excluded: 1 }, calls: { sites: 2, unresolved: 0 }, gaps: [['**/dist/**', 1]] },
      { name: 'packages/api', count: 3, files: { ...none, indexed: 1, unsupported: 1 }, calls: { sites: 2, unresolved: 1 }, gaps: [['no_adapter:.avsc', 1]] },
      { name: 'packages/format', count: 1, files: { ...none, indexed: 2 }, calls: { sites: 1, unresolved: 0 }, gaps: [] },
      { name: 'packages/legacy', count: 1, files: { ...none, indexed: 1 }, calls: { sites: 1, unresolved: 0 }, gaps: [] },
      { name: '(root)', count: 0, files: { ...none, indexed: 1, unsupported: 1 }, calls: { sites: 0, unresolved: 0 }, gaps: [['no_adapter:.md', 1]] },
    ])
  })

  it('FR059 A4 fog: unanalysed and excluded files, and an unresolved share only from 20 call sites', () => {
    const none = { indexed: 0, unsupported: 0, excluded: 0, failed: 0, pending: 0 }
    const area = (files: Partial<typeof none>, sites: number, unresolved: number) => ({ name: 'a', count: 5, files: { ...none, ...files }, calls: { sites, unresolved }, gaps: [] })
    expect(areaFog(area({ indexed: 10 }, 40, 2))).toEqual({ unanalysed: 0, excluded: 0, unresolvedShare: 0.05, haze: 0, ring: false })
    expect(areaFog(area({ indexed: 6, unsupported: 3, failed: 1 }, 19, 19))).toEqual({ unanalysed: 4, excluded: 0, unresolvedShare: null, haze: 0.4, ring: false })
    expect(areaFog(area({ indexed: 8, excluded: 30 }, 20, 5))).toEqual({ unanalysed: 0, excluded: 30, unresolvedShare: 0.25, haze: 0, ring: true })
    expect(areaFog({ ...area({ unsupported: 2 }, 0, 0), count: 0 })).toEqual({ unanalysed: 2, excluded: 0, unresolvedShare: null, haze: 1, ring: false })
  })

  it('FR059 areas with no symbols: the largest drawn one by one, the rest folded into one so the galaxy stays readable', () => {
    const none = { indexed: 0, unsupported: 0, excluded: 0, failed: 0, pending: 0 }
    const ghost = (name: string, unsupported: number) => ({ name, count: 0, files: { ...none, unsupported }, calls: { sites: 0, unresolved: 0 }, gaps: [] })
    const areas = [{ ...ghost('code', 0), count: 9, files: { ...none, indexed: 4 } }, ghost('a', 1), ghost('b', 5), ghost('c', 3), ghost('d', 2)]
    expect(ghostAreas(areas, 2)).toEqual({ shown: [ghost('b', 5), ghost('c', 3)], rest: { areas: 2, files: 3 } })
    expect(ghostAreas(areas, 10)).toEqual({ shown: [ghost('b', 5), ghost('c', 3), ghost('d', 2), ghost('a', 1)], rest: { areas: 0, files: 0 } })
  })

  it('search matches qualified names in the browser, and labels use the short name', () => {
    const g = load()
    expect(matchIndices(g, 'FORMAT').map((i) => g.names[i]).sort()).toEqual(['packages/format/src/currency:formatAmount', 'packages/legacy/src/format:formatAmount'])
    expect(matchIndices(g, 'f')).toEqual([])
    expect(rankMatches(g, matchIndices(g, 'invoice'), 'invoice').map((i) => g.names[i])).toEqual(['packages/billing/src/invoice:invoiceTotal', 'packages/api/src/handler:handleInvoice', 'packages/billing/src/invoice:Line', 'packages/billing/src/invoice:Line.cents'])
    expect(shortName('Demo.Garden.Watering.Schedules.SprinklerScheduleDiagnostics')).toBe('SprinklerScheduleDiagnostics')
  })
})

describe('FR1220 FR1221 the payload carries every symbol\'s position, computed with the snapshot', () => {
  it('B13 positions are 16 bits per axis in the map\'s frame, one place for each symbol, in format 6 (FR2621)', () => {
    const raw = zlib.gunzipSync(galaxyFor(d).gz)
    expect(JSON.parse(raw.subarray(4, 4 + raw.readUInt32LE(0)).toString('utf8')).format).toBe(6)
    const g = load()
    expect(g.positions).toHaveLength(g.n * 2)
    expect(new Set(Array.from({ length: g.n }, (_, i) => `${g.positions[i * 2]},${g.positions[i * 2 + 1]}`)).size).toBe(g.n)
    const p = g.positions
    // Containment: a symbol sits nearer another of its file than any symbol of another package.
    const at = (name: string) => g.names.indexOf(name)
    const gap = (a: number, b: number) => Math.hypot(p[a * 2]! - p[b * 2]!, p[a * 2 + 1]! - p[b * 2 + 1]!)
    const line = at('packages/billing/src/invoice:Line'), total = at('packages/billing/src/invoice:invoiceTotal')
    const others = g.names.flatMap((n, i) => (n.startsWith('packages/billing/') ? [] : [i]))
    expect(gap(line, total)).toBeLessThan(Math.min(...others.map((o) => gap(line, o))))
  })

  it('two indexes of the same repository, in two data directories, send byte-identical payloads', async () => {
    const other = (await indexedDataDir()).dataDir
    const digest = (dir: string) => crypto.createHash('sha256').update(zlib.gunzipSync(galaxyFor(dir).gz)).digest('hex')
    expect(digest(other)).toBe(digest(d))
  })
})

describe('FR058 the area legend says when it lists only the largest areas', () => {
  it('lists at most the limit, largest first, leaves out areas with no symbols, and counts what it left out', () => {
    const none = { indexed: 1, unsupported: 0, excluded: 0, failed: 0, pending: 0 }
    const areas = [['a', 9], ['b', 5], ['c', 2], ['d', 0]].map(([name, count]) => ({ name, count, files: none, calls: { sites: 0, unresolved: 0 }, gaps: [] }))
    const g = { areas, area: Uint16Array.from([0, 0, 1, 2, 1]), n: 5 } as unknown as GalaxyData
    expect(legendAreas(g, [], 2)).toEqual({ shown: [{ index: 0, name: 'a', count: 9 }, { index: 1, name: 'b', count: 5 }], total: 3 })
    expect(legendAreas(g, [2, 3, 4], 2)).toEqual({ shown: [{ index: 1, name: 'b', count: 2 }, { index: 2, name: 'c', count: 1 }], total: 2 })
  })
})

describe('B20 area labels say which area they are', () => {
  it('uses the last directory, with its parent when that directory is generic', () => {
    expect(['src/widgets/Gears', 'packages/api/src', 'tools/lib', 'src', '(root)'].map(areaLabel)).toEqual(['Gears', 'api/src', 'tools/lib', 'src', '(root)'])
  })
})

describe('NFR005 search over the names', () => {
  it('NFR005 search over one joined text finds exactly what a plain filter finds, each name once, in index order', () => {
    const names = Array.from({ length: 5000 }, (_, i) => `src/area${i % 37}/File${i}:Order${i % 11}.place${i % 7 ? '' : 'OrderOrder'}`)
    names[0] = 'order:first'; names[4999] = 'last:ORDER'
    const g = { n: names.length, names } as unknown as GalaxyData
    for (const q of ['order', 'ORDER', 'area3', 'placeorder', 'last:order', 'first', 'file49', 'zz-none', 'r:f']) {
      const plain = names.flatMap((n, i) => (n.toLowerCase().includes(q.toLowerCase()) ? [i] : []))
      expect(matchIndices(g, q), q).toEqual(plain)
    }
  })
})

describe('FR1200 search maps each match to its own name when lowering changes the length of a name before it', () => {
  // İ lowers to two code units; ẞ, ß, combining marks, final sigma and an emoji are case-folding traps of their own.
  const units = ['İ', 'i', '\u0307', 'ẞ', 'ß', 's', 'S', 'e', '\u0301', 'é', '🚀', 'Σ', 'ς', 'a', 'b', ':', '/']
  const galaxy = (names: string[]) => ({ n: names.length, names }) as unknown as GalaxyData

  it('finds the name the text is in, after a name holding İ, in the Galaxy and the palette', () => {
    const names = ['src/a:' + 'İ'.repeat(20), 'src/b:ab', 'src/c:xy']
    expect(matchIndices(galaxy(names), 'src/b:ab').map((i) => names[i])).toEqual(['src/b:ab'])
    expect(searchIndex(buildIndex(names, []), 'src/b:ab').items.map((i) => names[i])).toEqual(['src/b:ab'])
  })

  it('agrees with a plain filter on any names and query built from case-folding traps', () => {
    const text = (min: number, max: number) => fc.array(fc.constantFrom(...units), { minLength: min, maxLength: max }).map((a) => a.join(''))
    fc.assert(fc.property(fc.array(text(1, 12), { maxLength: 40 }), text(2, 4), (names, q) => {
      const want = names.flatMap((n, i) => (n.toLowerCase().includes(q.toLowerCase()) ? [i] : []))
      expect(matchIndices(galaxy(names), q)).toEqual(want)
      const r = searchIndex(buildIndex(names, []), q)
      expect(r.total).toBe(want.length)
      expect(r.items.length).toBe(Math.min(want.length, LIMIT))
      for (const i of r.items) expect(want).toContain(i)
    }), { numRuns: 500 })
  })
})


describe('FR1452 without a Web Worker the payload is parsed on the page in slices', () => {
  const GENERATOR: string = '../../../bench/observatory/gen-galaxy.mjs'
  const buffer = (gz: Buffer) => { const raw = zlib.gunzipSync(gz); return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) }
  it('FR1452 gives the galaxy parseGalaxy gives, yielding between blocks of names', async () => {
    const small = buffer(galaxyFor(d).gz)
    expect(await parseGalaxySliced(small)).toEqual(parseGalaxy(small))
    const { generateGalaxy } = await import(GENERATOR)
    const big = buffer(generateGalaxy({ nodes: 20000, seed: 1, snapshotId: 'snap_sliced', ids: galaxyFor(d).ids }).gz)
    let pauses = 0
    const sliced = await parseGalaxySliced(big, 0, async () => { pauses++ })
    expect(sliced).toEqual(parseGalaxy(big))
    expect(sliced.names).toHaveLength(20000)
    expect(pauses).toBeGreaterThan(1)
  })
})
