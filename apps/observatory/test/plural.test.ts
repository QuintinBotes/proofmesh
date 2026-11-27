import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { toEcosystem, type Ecosystem } from '../src/ecosystem'
import { toNeighbourhood, type Focus, type RelationshipsEnvelope } from '../src/explore'
import { terrainSvg } from '../src/exporting'
import type { GalaxyData } from '../src/galaxyData'
import { plural } from '../src/plural'
import { terrainOf, terrainSummary, type Pair } from '../src/terrainModel'

describe('FR1210 a count of one is said with the singular noun', () => {
  it('plural says one in the singular and every other count in the plural, grouped by thousands', () => {
    expect([plural(0, 'symbol'), plural(1, 'symbol'), plural(2, 'symbol'), plural(1234, 'symbol'), plural(1, 'match', 'matches'), plural(3, 'match', 'matches')])
      .toEqual(['0 symbols', '1 symbol', '2 symbols', '1,234 symbols', '1 match', '3 matches'])
  })

  it('the Terrain says one symbol, one area and one bundle', () => {
    const none = { indexed: 1, unsupported: 0, excluded: 0, failed: 0, pending: 0 }
    const g = { n: 1, areas: [{ name: 'src', count: 1, files: none, calls: { sites: 0, unresolved: 0 }, gaps: [] }, { name: 'docs', count: 0, files: none, calls: { sites: 0, unresolved: 0 }, gaps: [] }] } as unknown as GalaxyData
    const pair: Pair = { from: 0, to: 1, observed: 1, inferred: 0, types: [] }
    expect(terrainSummary(g, [pair], 1)).toBe('1 symbol in 1 area; 1 of 1 bundle between areas drawn; 1 more area holds files the graph cannot see. Search, zoom into an area, or open a bundle.')
  })

  it('Explore says one relationship not drawn', () => {
    const focus: Focus = { id: 'f', kind: 'function', name: 'f', qualified_name: 'f', path: 'a.ts', start_line: 1 }
    const env = { data: { relationships: [], boundaries: [], totals: { in: 1, out: 0 } }, completion: { truncated: false } } as RelationshipsEnvelope
    expect(toNeighbourhood(env, focus).badges.map((b) => b.text)).toEqual(['+1 relationship not drawn'])
  })

  it('the ecosystem says one repository, one linked pair and one unresolved boundary', () => {
    const data = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'ecosystem.json'), 'utf8')).data as Ecosystem
    const [a, b] = data.members, boundaries = [{ ...data.boundaries[0]!, count: 1 }]
    const pair = data.links.filter((l) => l.source_repository_id === a!.repository_id && l.target_repository_id === b!.repository_id)
    expect(toEcosystem({ ...data, members: [a!, b!], links: pair, boundaries }).conclusion).toMatch(/^shop: 2 repositories, 1 linked pair, 1 unresolved boundary\. /)
    expect(toEcosystem({ ...data, members: [a!], links: [], boundaries }).conclusion).toMatch(/^shop: 1 repository, 0 linked pairs, 1 unresolved boundary\. /)
  })

  it('a Terrain export of one area says one area, one symbol and one match, also to a screen reader', () => {
    const none = { indexed: 0, unsupported: 0, excluded: 0, failed: 0, pending: 0 }
    const g: GalaxyData = {
      snapshotId: 's', n: 1, links: new Uint32Array(), degree: new Uint32Array(1), area: Uint16Array.from([0]), kind: new Uint8Array(1), positions: Uint16Array.from([100, 100]), kinds: ['function'], names: ['src/a:x'], files: [],
      areas: [{ name: 'src', count: 1, files: { ...none, indexed: 1 }, calls: { sites: 0, unresolved: 0 }, gaps: [] }],
      cells: { rects: Uint16Array.from([0, 0, 65535, 65535, 0, 0, 65535, 65535]), parent: Int32Array.from([-1, 0]), count: Uint32Array.from([1, 1]), names: ['', 'src'] }, bundles: [], relTypes: [],
    }
    const caveats = { view: 'Terrain', repository: 'r', snapshotId: 's', analysisMode: 'no_execution', scope: 'all', limits: [], coverage: [] }
    expect(terrainSvg(g, terrainOf(g), [], null, caveats, null)).toContain('aria-label="Terrain: 1 area"')
    expect(terrainSvg(g, terrainOf(g), [], null, caveats, null)).toContain(">1 symbol in 1 area, placed by the snapshot&#39;s path tree</text>")
    expect(terrainSvg(g, terrainOf(g), [], [0], caveats, null)).toContain(">1 matching symbol of 1 symbol in 1 area, placed by the snapshot&#39;s path tree</text>")
  })
})
