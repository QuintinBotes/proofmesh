import zlib from 'node:zlib'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseGalaxy, type GalaxyArea, type GalaxyData } from '../src/galaxyData'
import { cellRect, coverageOf, DRAWN_BUNDLES, drawnStrokes, FRAME, LABEL_PX, labels, terrainOf, type View } from '../src/terrainModel'
import { galaxyFor } from '../../../packages/proofmesh/src/query/galaxy.js'
import { layoutPositions, packCells, type LayoutCell } from '../../../packages/proofmesh/src/query/layout.js'
import { indexedDataDir } from '../../../packages/proofmesh/test/helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })
const load = () => { const raw = zlib.gunzipSync(galaxyFor(d).gz); return parseGalaxy(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) }
/** The frame fitted into a square of side px, as the Terrain fits it. */
const fit = (px: number, at = 0): View => ({ kx: px / FRAME, bx: at, ky: px / FRAME, by: at, width: px + 2 * at, height: px + 2 * at })
const none = { indexed: 0, unsupported: 0, excluded: 0, failed: 0, pending: 0 }

/** A galaxy of many areas, built with the server's own layout and packing: `areas` areas of `files` files of 8 symbols each, linked area to next area. */
function synthetic(areas: number, files: number, inferredEvery = 0): GalaxyData {
  const items: Array<{ path: string; name: string; line: number; byte: number }> = [], area: number[] = []
  for (let a = 0; a < areas; a++) for (let f = 0; f < files; f++) for (let s = 0; s < 8; s++) { items.push({ path: `src/a${a}/sub${f % 3}/f${f}.ts`, name: `src/a${a}/sub${f % 3}/f${f}:sym${s}`, line: s + 1, byte: s }); area.push(a) }
  const cells: LayoutCell[] = []
  const positions = layoutPositions(items, cells)
  const packed = packCells(cells)
  const bundles: Array<[number, number, number, number, number]> = []
  for (let a = 0; a < areas; a++) { bundles.push([a, (a + 1) % areas, 0, 0, 100 - a]); if (inferredEvery && a % inferredEvery === 0) bundles.push([a, (a + 2) % areas, 1, 1, 3]) }
  const ar: GalaxyArea[] = Array.from({ length: areas }, (_, a) => ({ name: `src/a${a}`, count: files * 8, files: { ...none, indexed: files }, calls: { sites: 100, unresolved: a % 2 ? 10 : 1 }, gaps: [] }))
  return {
    snapshotId: 's', n: items.length, links: new Uint32Array(), degree: new Uint32Array(items.length), area: Uint16Array.from(area), kind: new Uint8Array(items.length), positions,
    kinds: ['method'], areas: ar, names: items.map((x) => x.name), files: [],
    cells: { rects: packed.rects, parent: packed.parent, count: packed.count, names: new TextDecoder().decode(packed.cellNames).split('\n') }, bundles, relTypes: ['calls', 'injects'],
  }
}

describe('FR056 FR1400 FR1401 the Terrain draws each area as a cell of the snapshot\'s layout', () => {
  it('every area with symbols is the cell of its two directories, holding its symbols, and every symbol sits in its area\'s cell', () => {
    const g = load(), t = terrainOf(g)
    expect(g.areas.map((a, k) => [a.name, t.areaCell[k]! >= 0 ? t.paths[t.areaCell[k]!] : null])).toEqual([['packages/billing', 'packages/billing'], ['packages/api', 'packages/api'], ['packages/format', 'packages/format'], ['packages/legacy', 'packages/legacy'], ['(root)', null]])
    g.areas.forEach((a, k) => { if (a.count) expect(g.cells.count[t.areaCell[k]!]).toBe(a.count) })
    const r = g.cells.rects
    for (let i = 0; i < g.n; i++) {
      const c = t.areaCell[g.area[i]!]!, x = g.positions[i * 2]!, y = g.positions[i * 2 + 1]!
      expect(x >= r[c * 4]! && x <= r[c * 4]! + r[c * 4 + 2]! && y >= r[c * 4 + 1]! && y <= r[c * 4 + 1]! + r[c * 4 + 3]!, g.names[i]).toBe(true)
    }
    // Files are leaves inside their area.
    const handler = t.paths.indexOf('packages/api/src/handler.ts')
    expect([t.isFile[handler], g.areas[t.cellArea[handler]!]!.name, t.cellDepth[handler]]).toEqual([1, 'packages/api', 2])
  })

  it('an area of fewer than two directories is its directory\'s own files, beside its subdirectories', () => {
    const items = [{ path: 'src/index.ts', name: 'src/index:main', line: 1, byte: 0 }, { path: 'src/driver/pg.ts', name: 'src/driver/pg:Pg', line: 1, byte: 0 }, { path: 'cli.ts', name: 'cli:run', line: 1, byte: 0 }]
    const cells: LayoutCell[] = []
    const positions = layoutPositions(items, cells), packed = packCells(cells)
    const areas: GalaxyArea[] = ['src', 'src/driver', '(root)'].map((name) => ({ name, count: 1, files: { ...none, indexed: 1 }, calls: { sites: 0, unresolved: 0 }, gaps: [] }))
    const g = { n: 3, areas, positions, area: Uint16Array.from([0, 1, 2]), bundles: [], relTypes: [], cells: { rects: packed.rects, parent: packed.parent, count: packed.count, names: new TextDecoder().decode(packed.cellNames).split('\n') } } as unknown as GalaxyData
    const t = terrainOf(g)
    // Each area's cell holds that area's symbol and no other.
    for (let i = 0; i < 3; i++) {
      const c = t.areaCell[i]!, r = g.cells.rects
      expect(g.cells.count[c]).toBe(1)
      expect(positions[i * 2]! >= r[c * 4]! && positions[i * 2]! <= r[c * 4]! + r[c * 4 + 2]!, areas[i]!.name).toBe(true)
    }
    expect(t.paths[t.areaCell[0]!]).toBe('src')
  })
})

describe('FR1402 bundles: at rest the twelve strongest, plus every inferred one; on hover, all of an area\'s', () => {
  it('pairs the payload\'s bundles by direction, with each basis\'s count and type', () => {
    const g = load(), t = terrainOf(g)
    const name = (k: number) => g.areas[k]!.name
    expect(t.pairs.map((p) => [name(p.from), name(p.to), p.observed, p.inferred])).toEqual([['packages/billing', 'packages/format', 1, 0], ['packages/api', 'packages/billing', 1, 0]])
    expect(t.pairs[0]!.types).toEqual([{ type: 'calls', observed: 1, inferred: 0 }])
  })

  it('draws at most twelve observed bundles at rest, every inferred one, and on hover every bundle into or out of the area', () => {
    const g = synthetic(40, 2, 5), t = terrainOf(g)
    const rest = drawnStrokes(t.pairs, null)
    expect(rest.filter((s) => s.basis === 'observed')).toHaveLength(DRAWN_BUNDLES)
    expect(rest.filter((s) => s.basis === 'inferred')).toHaveLength(8)
    // The strongest observed bundles are the ones drawn.
    expect(Math.min(...rest.filter((s) => s.basis === 'observed').map((s) => s.count))).toBe(100 - (DRAWN_BUNDLES - 1))
    const hover = drawnStrokes(t.pairs, 31)
    const touching = t.pairs.filter((p) => p.from === 31 || p.to === 31)
    for (const p of touching) for (const basis of ['observed', 'inferred'] as const) if (p[basis]) expect(hover.some((s) => s.pair === p && s.basis === basis), `${p.from}->${p.to} ${basis}`).toBe(true)
    expect(touching.length).toBeGreaterThan(0)
    expect(rest.some((s) => s.pair.from === 31 || s.pair.to === 31)).toBe(false)
  })
})

describe('FR1404 semantic zoom: labels by on-screen size, never overlapping', () => {
  it('at fit, every area large enough is named with its count; files are named once zoomed in, and symbols after them', () => {
    const g = load(), t = terrainOf(g)
    expect(labels(g, t, fit(800)).filter((l) => l.kind === 'area').map((l) => l.text).sort()).toEqual(['api 3', 'billing 3', 'format 1', 'legacy 1'])
    // An area too small to label has no label at all: its name is in the tooltip and the table.
    expect(labels(g, t, fit(60)).filter((l) => l.kind === 'area')).toEqual([])
    // Thirty areas of 72 symbols: areas at fit, then files, then symbols, as the cells grow on screen.
    const s = synthetic(30, 9), ts = terrainOf(s)
    const kinds = (px: number) => new Set(labels(s, ts, { ...fit(px), width: 1400, height: 900 }).map((l) => l.kind))
    expect(kinds(300)).toEqual(new Set(['area']))
    expect([...kinds(800)].filter((k) => k === 'file' || k === 'symbol')).toEqual([])
    expect(kinds(2000)).toEqual(new Set(['area', 'dir', 'file']))
    expect(new Set(labels(s, ts, { kx: 40000 / FRAME, bx: -20000, ky: 40000 / FRAME, by: -20000, width: 1400, height: 900 }).map((l) => l.kind)).has('symbol')).toBe(true)
  })

  it('no two labels overlap and every labelled cell is at least 40 px on both sides, at any zoom and pan', () => {
    const g = synthetic(30, 9), t = terrainOf(g)
    fc.assert(fc.property(fc.double({ min: 200, max: 400000, noNaN: true }), fc.double({ min: -1, max: 0, noNaN: true }), fc.double({ min: -1, max: 0, noNaN: true }), (px, ox, oy) => {
      const v = { kx: px / FRAME, bx: ox * px, ky: px / FRAME, by: oy * px, width: 1400, height: 900 }
      const ls = labels(g, t, v)
      for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
        const a = ls[i]!, b = ls[j]!
        expect(a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + 16 && b.top < a.top + 16, `${a.text} / ${b.text}`).toBe(false)
      }
      for (const l of ls) if (l.kind !== 'symbol') { const r = cellRect(g, v, Number(l.key.slice(1))); expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(LABEL_PX) }
    }), { numRuns: 200 })
  })
})

describe('FR1405 coverage: hatching for unresolved calls, a ghost for files not analysed', () => {
  const area = (files: Partial<typeof none>, sites: number, unresolved: number, gaps: Array<[string, number]> = []): GalaxyArea => ({ name: 'src/x', count: 5, files: { ...none, ...files }, calls: { sites, unresolved }, gaps })
  it('hatches an area with more than 4% of at least 20 calls unresolved, and says how many and why', () => {
    expect(coverageOf(area({ indexed: 3 }, 100, 4))).toEqual({ hatched: false, ghost: false, text: '' })
    expect(coverageOf(area({ indexed: 3 }, 100, 5))).toEqual({ hatched: true, ghost: false, text: 'src/x: 5% of 100 calls unresolved' })
    expect(coverageOf(area({ indexed: 3 }, 19, 19)).hatched).toBe(false)
    expect(coverageOf(area({ indexed: 3, unsupported: 2 }, 0, 0, [['no_adapter:.rb', 2]]))).toEqual({ hatched: false, ghost: true, text: 'src/x: 2 files not analysed (no_adapter:.rb 2)' })
  })
})
