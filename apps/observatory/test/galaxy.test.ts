import zlib from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'
import { JITTER, areaFog, areaLabel, ghostAreas, legendAreas, placeLabels, seeds, layoutKey, matchIndices, nameHashes, parseGalaxy, rankMatches, shortName, warmStart, type GalaxyData } from '../src/galaxyData'
import { galaxyFor } from '../../../packages/proofmesh/src/query/galaxy.js'
import { indexedDataDir } from '../../../packages/proofmesh/test/helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })
const load = () => { const gz = galaxyFor(d).gz; const raw = zlib.gunzipSync(gz); return parseGalaxy(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) }

describe('A11 the Galaxy payload: every symbol of the snapshot in one compact binary', () => {
  it('holds every non-module symbol with its area, and the distinct resolved links between them', () => {
    const g = load()
    expect(g.names.slice().sort()).toEqual([
      'packages/api/src/handler:dispatch', 'packages/api/src/handler:handleInvoice', 'packages/api/src/handler:handlers',
      'packages/billing/src/invoice:Line', 'packages/billing/src/invoice:invoiceTotal',
      'packages/format/src/currency:formatAmount', 'packages/legacy/src/format:formatAmount',
    ])
    const name = (i: number) => g.names[i]!
    const links = Array.from({ length: g.links.length / 2 }, (_, j) => `${name(g.links[j * 2]!)} -> ${name(g.links[j * 2 + 1]!)}`).sort()
    // invoiceTotal's use of the Line type is a TypeScript reference (FR086), and dispatch's read of the handlers variable is one too
    // (FR102), so each is a resolved link.
    expect(links).toEqual(['packages/api/src/handler:dispatch -> packages/api/src/handler:handlers', 'packages/api/src/handler:handleInvoice -> packages/billing/src/invoice:invoiceTotal', 'packages/billing/src/invoice:invoiceTotal -> packages/billing/src/invoice:Line', 'packages/billing/src/invoice:invoiceTotal -> packages/format/src/currency:formatAmount'])
    expect(g.areas.map((a) => [a.name, a.count])).toEqual([['packages/api/src', 3], ['packages/billing/src', 2], ['packages/format/src', 1], ['packages/legacy/src', 1], ['(root)', 0], ['packages/api', 0], ['packages/billing/dist', 0]])
    expect(g.names.map((n, i) => [n.split(':')[0]!.split('/').slice(0, 3).join('/'), g.areas[g.area[i]!]!.name]).every(([a, b]) => a === b)).toBe(true)
  })

  it('FR059 each area carries its coverage: files by disposition, call sites, unresolved calls, and why files were not analysed', () => {
    const none = { indexed: 0, unsupported: 0, excluded: 0, failed: 0, pending: 0 }
    expect(load().areas).toEqual([
      { name: 'packages/api/src', count: 3, files: { ...none, indexed: 1 }, calls: { sites: 2, unresolved: 1 }, gaps: [] },
      { name: 'packages/billing/src', count: 2, files: { ...none, indexed: 2 }, calls: { sites: 2, unresolved: 0 }, gaps: [] },
      { name: 'packages/format/src', count: 1, files: { ...none, indexed: 2 }, calls: { sites: 1, unresolved: 0 }, gaps: [] },
      { name: 'packages/legacy/src', count: 1, files: { ...none, indexed: 1 }, calls: { sites: 1, unresolved: 0 }, gaps: [] },
      { name: '(root)', count: 0, files: { ...none, indexed: 1, unsupported: 1 }, calls: { sites: 0, unresolved: 0 }, gaps: [['no_adapter:.md', 1]] },
      { name: 'packages/api', count: 0, files: { ...none, unsupported: 1 }, calls: { sites: 0, unresolved: 0 }, gaps: [['no_adapter:.graphql', 1]] },
      { name: 'packages/billing/dist', count: 0, files: { ...none, excluded: 1 }, calls: { sites: 0, unresolved: 0 }, gaps: [['**/dist/**', 1]] },
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
    expect(rankMatches(g, matchIndices(g, 'invoice'), 'invoice').map((i) => g.names[i])).toEqual(['packages/billing/src/invoice:invoiceTotal', 'packages/api/src/handler:handleInvoice', 'packages/billing/src/invoice:Line'])
    expect(shortName('Demo.Garden.Watering.Schedules.SprinklerScheduleDiagnostics')).toBe('SprinklerScheduleDiagnostics')
  })
})

describe('A11 B18 settle-once layouts are cached by snapshot and seed, and a new snapshot starts from the last layout', () => {
  const none = { indexed: 1, unsupported: 0, excluded: 0, failed: 0, pending: 0 }
  const galaxy = (snapshotId: string, names: string[], area: number[], areas: Array<[string, number]>) => ({
    snapshotId, n: names.length, names, area: Uint16Array.from(area), areas: areas.map(([name, count]) => ({ name, count, files: none, calls: { sites: 0, unresolved: 0 }, gaps: [] })),
  }) as unknown as GalaxyData

  it('the cache key names the snapshot and changes when the seed inputs change', () => {
    const a = galaxy('snap_a', ['x', 'y'], [0, 0], [['src', 2]])
    expect(layoutKey(a)).toMatch(/^snap_a:[0-9a-f]{8}$/)
    expect(layoutKey(galaxy('snap_a', ['x', 'y'], [0, 0], [['src', 2]]))).toBe(layoutKey(a))
    expect(layoutKey(galaxy('snap_a', ['x', 'y'], [0, 1], [['src', 1], ['lib', 1]]))).not.toBe(layoutKey(a))
    expect(layoutKey(galaxy('snap_b', ['x', 'y'], [0, 0], [['src', 2]])).split(':')[1]).toBe(layoutKey(a).split(':')[1])
  })

  it('a symbol kept between snapshots keeps its place, and a new one starts at the centre of its area', () => {
    const before = galaxy('snap_a', ['src:a', 'src:b', 'lib:c'], [0, 0, 1], [['src', 2], ['lib', 1]])
    const after = galaxy('snap_b', ['src:a', 'src:new', 'lib:d', 'docs:e'], [0, 0, 1, 2], [['src', 2], ['lib', 1], ['docs', 1]])
    const previous = { names: nameHashes(before), positions: Float32Array.from([10, 20, 30, 40, 500, 600]) }
    const seed = Float32Array.from([1, 1, 2, 2, 3, 3, 4, 4])
    const { positions, reused } = warmStart(after, previous, seed)
    expect(reused).toBe(1)
    // src:a kept; src:new near the centre of src's kept points; lib and docs kept no points, so their new symbols use the seed.
    expect([positions[0], positions[1], positions[4], positions[5], positions[6], positions[7]]).toEqual([10, 20, 3, 3, 4, 4])
    expect(Math.hypot(positions[2]! - 10, positions[3]! - 20)).toBeLessThanOrEqual(JITTER)
    expect(warmStart(after, null, seed)).toEqual({ positions: seed, reused: 0 })
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

describe('B13 B14 points never collapse onto one place, and labels never pile up', () => {
  it('B13 seeds every point of an area at its own place, even with no links', () => {
    const none = { indexed: 1, unsupported: 0, excluded: 0, failed: 0, pending: 0 }
    const n = 344
    const g = { n, area: new Uint16Array(n), areas: [{ name: 'Gears/Cogs', count: n, files: none, calls: { sites: 0, unresolved: 0 }, gaps: [] }] } as unknown as GalaxyData
    const p = seeds(g)
    expect(new Set(Array.from({ length: n }, (_, i) => `${p[i * 2]!.toFixed(3)},${p[i * 2 + 1]!.toFixed(3)}`)).size).toBe(n)
  })

  it('B14 keeps labels in order and drops one that would overlap a label already placed', () => {
    const labels = [{ name: 'Demo.Garden.App', x: 100, y: 100 }, { name: 'Shed', x: 130, y: 105 }, { name: 'Orchard', x: 100, y: 140 }, { name: 'Meadows', x: 400, y: 100 }]
    expect(placeLabels(labels).map((l) => l.name)).toEqual(['Demo.Garden.App', 'Orchard', 'Meadows'])
  })

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

