import { describe, expect, it } from 'vitest'
import { caveatLines, terrainSvg, CONTAINMENT, NO_MEANING, offlineHtml, pngText, pngWithText, sceneSvg, sceneTable, type Caveats } from '../src/exporting'
import type { GalaxyData } from '../src/galaxyData'
import type { Scene } from '../src/scene'
import { drawnStrokes, terrainOf } from '../src/terrainModel'

const caveats: Caveats = { view: 'Trace', repository: 'invoicing', snapshotId: 'snap_0123456789abcdef01234567', analysisMode: 'no_execution', scope: 'handleInvoice → formatAmount, depth 6', limits: ['max_depth 6 reached'], coverage: ['3 of 10 call sites unresolved'] }
const scene: Scene = {
  nodes: [
    { id: 'a', label: 'handleInvoice', qualifiedName: 'api:handleInvoice', path: 'api.ts', line: 3, x: 0, y: 0, role: 'source', size: 8, color: '#9be7ff', depth: 0 },
    { id: 'b', label: '<script>alert(1)</script>‮', qualifiedName: 'format:formatAmount', path: 'format.ts', line: 1, x: 100, y: 50, role: 'target', size: 8, color: '#ffd36e', depth: 1 },
  ],
  edges: [{ id: 'e', source: 'a', target: 'b', style: 'unresolved', depth: 1, color: '#f2b84b', size: 2 }],
  badges: [], stubs: [{ id: 's', fromId: 'a', reason: 'dynamic_element_access', line: 7 }], conclusion: 'No resolved path.',
}

describe('FR064 FR052 FR065 exports carry their caveats, load nothing, and include source only with consent', () => {
  it('the offline page holds the drawing, every caveat, the legend and the table, and makes no request', () => {
    const html = offlineHtml(sceneSvg(scene, caveats, null), caveats, sceneTable(scene), null)
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`)
    expect(html).not.toMatch(/<script|<link|\ssrc=|\shref=|url\(/i)
    for (const line of caveatLines(caveats, null)) expect(html).toContain(line)
    expect(html).toContain('snapshot snap_0123456789abcdef01234567 · analysis mode no execution')
    expect(html).toContain('limit: max_depth 6 reached')
    expect(html).toContain('unresolved: the target is unknown')
    expect(html).toContain('no source code included')
    expect(html).toContain('<td>unresolved</td><td>api:handleInvoice → ?</td><td>dynamic_element_access · line 7</td>')
  })

  it('FR1224 a Terrain export says position shows containment, as its legend does; every other view says position carries no meaning', () => {
    expect(caveatLines({ ...caveats, view: 'Terrain' }, null)).toContain(CONTAINMENT)
    expect(caveatLines({ ...caveats, view: 'Terrain' }, null)).not.toContain(NO_MEANING)
    expect(caveatLines(caveats, null)).toContain(NO_MEANING)
  })

  it('repository text is escaped and its invisible characters shown', () => {
    const svg = sceneSvg(scene, caveats, null)
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;⟨U+202E⟩')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('stroke-dasharray="6 4"')
  })

  it('source appears only when it was consented to, and the caveats say so', () => {
    const source = { path: 'format.ts', startLine: 1, text: 'export const x = 1 < 2' }
    const html = offlineHtml(sceneSvg(scene, caveats, source), caveats, sceneTable(scene), source)
    expect(html).toContain('source included with consent: format.ts from line 1')
    expect(html).toContain('<pre>export const x = 1 &lt; 2</pre>')
  })

  it('a PNG carries the caveats as text, and stays a valid PNG ending in IEND', () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
    const out = pngWithText(png, 'proofmesh:caveats', caveatLines(caveats, null).join('\n'))
    expect(pngText(out)['proofmesh:caveats']).toBe(caveatLines(caveats, null).join('\n'))
    expect(new TextDecoder().decode(out.subarray(out.length - 8, out.length - 4))).toBe('IEND')
    expect(Buffer.from(out.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a')
  })
})

const none = { indexed: 0, unsupported: 0, excluded: 0, failed: 0, pending: 0 }
/** Two areas side by side, src (two symbols, half its calls unresolved) and lib (one symbol, two files not analysed), and docs with no symbols. */
const tiny: GalaxyData = {
  snapshotId: 's', n: 3, links: new Uint32Array(), degree: new Uint32Array(3), area: Uint16Array.from([0, 0, 1]), kind: new Uint8Array(3),
  positions: Uint16Array.from([0, 0, 65535, 65535, 49152, 16384]), kinds: ['function'], names: ['src/a:x', 'src/a:y', 'lib/b:z'], files: [],
  areas: [
    { name: 'src', count: 2, files: { ...none, indexed: 1 }, calls: { sites: 100, unresolved: 50 }, gaps: [] },
    { name: 'lib', count: 1, files: { ...none, indexed: 1, unsupported: 2 }, calls: { sites: 0, unresolved: 0 }, gaps: [['no_adapter:.vb', 2]] },
    { name: 'docs', count: 0, files: { ...none, unsupported: 9 }, calls: { sites: 0, unresolved: 0 }, gaps: [['no_adapter:.md', 9]] },
  ],
  cells: { rects: Uint16Array.from([0, 0, 65535, 65535, 0, 0, 32768, 65535, 32768, 0, 32767, 65535]), parent: Int32Array.from([-1, 0, 0]), count: Uint32Array.from([3, 2, 1]), names: ['', 'src', 'lib'] },
  bundles: [[0, 1, 0, 0, 5]], relTypes: ['calls'],
}
const terrainCaveats = { ...caveats, view: 'Terrain' }

describe('FR059 SC011 a Terrain export shows incomplete coverage, never an empty or small area', () => {
  it('a hatched area and an area with files not analysed say so, and an area with no symbols is a ghost cell with no point', () => {
    const t = terrainOf(tiny), svg = terrainSvg(tiny, t, drawnStrokes(t.pairs, null), null, terrainCaveats, null)
    expect(svg).toMatch(/<title>src: 50% of 100 calls unresolved<\/title><rect [^>]+ fill="url\(#hatch\)"\/>/)
    expect(svg).toMatch(/<title>lib: 2 files not analysed \(no_adapter:\.vb 2\)<\/title><rect [^>]+ fill="url\(#ghost\)"/)
    expect(svg).toMatch(/<title>docs: 9 files not analysed \(no_adapter:\.md 9\)<\/title><rect [^>]+ fill="url\(#ghost\)"[^>]*\/><text [^>]+>docs<\/text>/)
    expect(svg.match(/<circle /g)).toHaveLength(3)
  })
})

describe('FR1580 a Terrain export draws the map at its snapshot positions', () => {
  it('maps the layout frame onto one square above the row of ghosts, draws the bundles, and the same input gives the same bytes', () => {
    const t = terrainOf(tiny), draw = () => terrainSvg(tiny, t, drawnStrokes(t.pairs, null), null, terrainCaveats, null)
    const svg = draw()
    // 1600 by 1000: an 827-pixel square from x 386.4 and y 60, the frame's y downward as on screen.
    expect([...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => `${m[1]},${m[2]}`)).toEqual(['386.4,60.0', '1213.6,887.3', '1006.8,266.8'])
    expect(svg.match(/<path d="M[^"]+" fill="none" stroke="#7fd4ff"/g)).toHaveLength(1)
    expect(draw()).toBe(svg)
    expect(terrainSvg(tiny, t, [], [2], terrainCaveats, null).match(/<circle [^>]+fill="#ffd36e"\/>/g)).toHaveLength(1)
  })
})
