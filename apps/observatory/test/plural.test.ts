import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { toEcosystem, type Ecosystem } from '../src/ecosystem'
import { toNeighbourhood, type Focus, type RelationshipsEnvelope } from '../src/explore'
import { galaxySvg } from '../src/exporting'
import { toMap, type Overview } from '../src/map'
import { plural } from '../src/plural'
import { indexedDataDir, tool } from '../../../packages/proofmesh/test/helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })

describe('FR1210 a count of one is said with the singular noun', () => {
  it('plural says one in the singular and every other count in the plural, grouped by thousands', () => {
    expect([plural(0, 'symbol'), plural(1, 'symbol'), plural(2, 'symbol'), plural(1234, 'symbol'), plural(1, 'match', 'matches'), plural(3, 'match', 'matches')])
      .toEqual(['0 symbols', '1 symbol', '2 symbols', '1,234 symbols', '1 match', '3 matches'])
  })

  it('the map says one matching symbol, one area and one link', () => {
    expect(toMap(tool(d, 'get_overview', { text: 'invoiceTotal' }).data as Overview, 'invoiceTotal').conclusion)
      .toBe('“invoiceTotal”: 1 matching symbol in 1 area of packages/billing/src. Click one to narrow down.')
    expect(toMap(tool(d, 'get_overview', { path: 'packages/legacy/src' }).data as Overview, null).conclusion)
      .toBe('packages/legacy/src: 1 area, 0 links between them. Click one to open it.')
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

  it('a Galaxy export of one area says one area, one symbol and one match, also to a screen reader', () => {
    const svg = galaxySvg({ positions: Uint16Array.from([0, 0]), area: Uint16Array.from([0]) }, [0], [{ name: 'src', color: '#7fd4ff', count: 1, matches: 1 }], { view: 'Galaxy', repository: 'r', snapshotId: 's', analysisMode: 'no_execution', scope: 'all', limits: [], coverage: [] }, null)
    expect(svg).toContain('aria-label="Galaxy: 1 area"')
    expect(svg).toContain(">1 symbol, placed by the snapshot&#39;s path tree</text>")
    expect(svg).toContain('>src · 1 match</text>')
  })
})
