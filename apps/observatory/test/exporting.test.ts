import { describe, expect, it } from 'vitest'
import { areasSvg, caveatLines, CONTAINMENT, NO_MEANING, offlineHtml, pngText, pngWithText, sceneSvg, sceneTable, type Caveats } from '../src/exporting'
import type { Scene } from '../src/scene'

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

describe('FR059 SC011 a Galaxy export shows incomplete coverage, never an empty or small area', () => {
  it('an area with gaps gets a dashed ring and its coverage in words; an area with no symbols draws no symbol disc', () => {
    const svg = areasSvg([
      { name: 'src/core', count: 40 },
      { name: 'src/legacy', count: 3, fog: 'src/legacy: 12 files not analysed (no_adapter:.vb 12)' },
      { name: 'docs', count: 0, fog: 'docs: 9 files not analysed (no_adapter:.md 9)' },
    ], { ...caveats, view: 'Galaxy' }, null)
    expect(svg.match(/stroke-dasharray="4 3"/g)).toHaveLength(2)
    expect(svg).toContain('<title>src/legacy: 12 files not analysed (no_adapter:.vb 12)</title>12 files not analysed (no_adapter:.vb 12)</text>')
    expect(svg).toContain('<title>docs: 9 files not analysed (no_adapter:.md 9)</title>9 files not analysed (no_adapter:.md 9)</text>')
    expect(svg.match(/fill-opacity="0.35"/g)).toHaveLength(2)
  })
})
