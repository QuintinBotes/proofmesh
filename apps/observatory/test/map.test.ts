import { beforeAll, describe, expect, it } from 'vitest'
import { forceLayout } from '../src/layout'
import { toMap, type Overview } from '../src/map'
import { indexedDataDir, tool } from '../../../packages/proofmesh/test/helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })

describe('FR056 the map: areas as a graph', () => {
  it('draws one node per area, labelled with its symbols, and one line per linked pair', () => {
    const scene = toMap(tool(d, 'get_overview', {}).data as Overview, null)
    expect(scene.nodes.map((n) => n.label)).toEqual(['api/src · 3', 'billing/src · 2', 'format/src · 1', 'legacy/src · 1'])
    expect(scene.edges.map((e) => [e.source, e.target])).toEqual([['packages/api/src', 'packages/billing/src'], ['packages/billing/src', 'packages/format/src']])
    expect(scene.conclusion).toBe('packages: 4 areas, 2 links between them. Click one to open it.')
  })

  it('while searching, nodes count matches and the footer names the search', () => {
    const scene = toMap(tool(d, 'get_overview', { text: 'format' }).data as Overview, 'format')
    expect(scene.nodes.map((n) => n.label)).toEqual(['format/src · 1', 'legacy/src · 1'])
    expect(scene.conclusion).toBe('“format”: 2 matching symbols in 2 areas of packages. Click one to narrow down.')
  })

  it('the layout is deterministic and keeps unlinked nodes at the rim of the cluster', () => {
    const radii = Array.from({ length: 12 }, (_, i) => 6 + i)
    const links = Array.from({ length: 10 }, (_, i) => ({ a: 0, b: i + 1, weight: 10 }))
    const first = forceLayout(radii, links), second = forceLayout(radii, links)
    expect(second).toEqual(first)
    const cx = first.reduce((a, p) => a + p.x, 0) / first.length, cy = first.reduce((a, p) => a + p.y, 0) / first.length
    const dist = first.map((p) => Math.hypot(p.x - cx, p.y - cy))
    const linkedMax = Math.max(...dist.slice(0, 11))
    expect(dist[11]!).toBeLessThanOrEqual(linkedMax * 1.6)
  })
})
