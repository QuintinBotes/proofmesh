// Exports of a view (FR064): an SVG drawing, an offline HTML page, and PNG metadata. Pure functions, so they are testable without a DOM.
import { ghostAreas, type GalaxyData } from './galaxyData'
import { plural } from './plural'
import { CELL, cellRect, coverageOf, FRAME, GHOST_SIDE, GHOST_Y, GHOSTS, ghostRect, labels, MATCH, POINT, STROKE, SYMBOL, symbolSide, type Rect, type Stroke, type Terrain, type View } from './terrainModel'
import { type Scene, TOKENS } from './scene'
import { visible } from './visible'

/** What every export carries inside it: where it came from, what it covers, what it left out, and how to read it. */
export type Caveats = {
  view: string
  repository: string
  snapshotId: string
  analysisMode: string
  scope: string
  limits: string[]
  coverage: string[]
}
/** Source text from the evidence panel, present only when the person consented to include it (FR052). */
export type Source = { path: string; startLine: number; text: string } | null

export const LEGEND: Array<{ label: string; color: string; dashed?: boolean }> = [
  { label: 'resolved relationship', color: TOKENS.resolved },
  { label: 'framework rule', color: TOKENS.framework },
  { label: 'resolved outside the repository', color: TOKENS.resolved_external },
  { label: 'explored by the search', color: TOKENS.explored },
  { label: 'unresolved: the target is unknown', color: TOKENS.unresolved, dashed: true },
]

/** Layout is derived, never evidence (FR068): every view and every export says so. */
export const NO_MEANING = 'Position carries no meaning; only drawn lines are relationships.'
/** The Terrain's positions come from the path tree (FR1224): they show containment, and nearness is still no relationship. */
export const CONTAINMENT = 'Position shows containment: directory, then file, then name. Nearness is not a relationship; only drawn lines are relationships.'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
/** Repository text is untrusted: escaped for markup, with bidirectional and invisible characters made visible (FR065). */
export const esc = (s: string) => visible(s).replace(/[&<>"']/g, (c) => ESCAPES[c]!)

export function caveatLines(c: Caveats, source: Source): string[] {
  return [
    `Proofmesh ${c.view} · repository ${c.repository}`,
    `snapshot ${c.snapshotId} · analysis mode ${c.analysisMode === 'trusted_build' ? 'trusted build' : 'no execution'}`,
    `scope: ${c.scope}`,
    ...c.limits.map((l) => `limit: ${l}`),
    ...c.coverage.map((l) => `coverage: ${l}`),
    source ? `source included with consent: ${source.path} from line ${source.startLine}` : 'no source code included',
    // The Terrain's positions are its layout's containment (SC-003); every other view's carry no meaning.
    c.view === 'Terrain' || c.view === 'Change review' ? CONTAINMENT : NO_MEANING,
  ]
}

const LINE = 22
/** An on-screen instruction ("Click a node…") has no meaning in a file, so exports drop it. */
const withoutInstructions = (s: string) => s.split(/(?<=\.)\s+/).filter((sentence) => !/^Click\b/.test(sentence)).join(' ')
/** The caveats and legend as SVG text, drawn from the top-left corner. */
function caveatBlock(c: Caveats, source: Source, x: number, y: number): { svg: string; height: number } {
  const lines = caveatLines(c, source)
  const text = lines.map((l, i) => `<text x="${x}" y="${y + (i + 1) * LINE}" font-size="15" fill="#e6e9f2">${esc(l)}</text>`).join('')
  const legendY = y + (lines.length + 1) * LINE
  const legend = LEGEND.map((l, i) => {
    const lx = x + i * 300
    return `<line x1="${lx}" y1="${legendY - 5}" x2="${lx + 28}" y2="${legendY - 5}" stroke="${l.color}" stroke-width="3"${l.dashed ? ' stroke-dasharray="6 4"' : ''}/><text x="${lx + 36}" y="${legendY}" font-size="14" fill="#b8c0d4">${esc(l.label)}</text>`
  }).join('')
  return { svg: text + legend, height: (lines.length + 2) * LINE }
}

/** A graph view as standalone SVG: its nodes and edges in their encodings, the horizon and unresolved boundaries, and the caveats. */
export function sceneSvg(scene: Scene, caveats: Caveats, source: Source, width = 1600, height = 1000): string {
  const block = caveatBlock(caveats, source, 24, height)
  // Labels sit beside their nodes, so the drawing keeps room for them on both sides.
  const [padX, padTop, padBottom] = [240, 90, 50]
  const xs = scene.nodes.map((n) => n.x), ys = scene.nodes.map((n) => n.y)
  const [minX, maxX, minY, maxY] = xs.length ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : [0, 1, 0, 1]
  const scale = Math.min((width - 2 * padX) / Math.max(maxX - minX, 1), (height - padTop - padBottom) / Math.max(maxY - minY, 1))
  const at = new Map(scene.nodes.map((n) => [n.id, { x: padX + (n.x - minX) * scale, y: padTop + (n.y - minY) * scale }]))
  const edges = scene.edges.map((e) => {
    const a = at.get(e.source), b = at.get(e.target)
    if (!a || !b) return ''
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${e.color}" stroke-width="${Math.max(1, e.size)}"${e.style === 'unresolved' || e.style === 'candidate' || e.style === 'ambiguous' ? ' stroke-dasharray="6 4"' : ''}/>`
  }).join('')
  const stubs = scene.stubs.map((s) => {
    const a = at.get(s.fromId)
    return a ? `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${(a.x + 40).toFixed(1)}" y2="${(a.y + 24).toFixed(1)}" stroke="${TOKENS.unresolved}" stroke-width="1.5" stroke-dasharray="4 3"/><text x="${(a.x + 44).toFixed(1)}" y="${(a.y + 30).toFixed(1)}" font-size="11" fill="${TOKENS.unresolved}">${esc(s.reason)}</text>` : ''
  }).join('')
  const nodes = scene.nodes.map((n) => {
    const p = at.get(n.id)!, r = Math.max(3, n.size)
    const [lx, ly, anchor] = n.labelPosition === 'left' ? [p.x - r - 6, p.y + 4, 'end'] : n.labelPosition === 'below' ? [p.x, p.y + r + 16, 'middle'] : [p.x + r + 6, p.y + 4, 'start']
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${n.color}"/><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="13" text-anchor="${anchor}" fill="#e6e9f2" stroke="#0b0f1a" stroke-width="3" paint-order="stroke">${esc(n.label)}</text>`
  }).join('')
  const badges = scene.badges.map((b) => {
    const p = at.get(b.nodeId)
    return p ? `<text x="${(p.x + 8).toFixed(1)}" y="${(p.y - 14).toFixed(1)}" font-size="12" fill="${TOKENS.horizon}">${esc(b.text)}</text>` : ''
  }).join('')
  const total = height + block.height
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}" role="img" aria-label="${esc(`${caveats.view}: ${withoutInstructions(scene.conclusion)}`)}"><rect width="100%" height="100%" fill="#0b0f1a"/><text x="24" y="36" font-size="18" fill="#e6e9f2">${esc(withoutInstructions(scene.conclusion))}</text>${edges}${stubs}${nodes}${badges}${block.svg}</svg>`
}

/**
 * The Terrain as it is drawn (FR1580): each area's cells nested by depth at their places in the snapshot's layout, hatched where many
 * calls are unresolved and marked where files were not analysed (FR059); the bundles drawn, solid observed and dashed inferred; each
 * symbol (while searching, each match) a point at its place; the overview's labels; and the areas with no symbols as ghost cells in
 * the row below. Nothing depends on the camera or the pointer, so one snapshot exports the same bytes.
 */
export function terrainSvg(d: GalaxyData, t: Terrain, strokes: Stroke[], matches: number[] | null, caveats: Caveats, source: Source, width = 1600, height = 1000): string {
  const block = caveatBlock(caveats, source, 24, height)
  const top = 60, side = Math.min(width - 48, (height - top - 30) * FRAME / (GHOST_Y + GHOST_SIDE)), k = side / FRAME
  const v: View = { kx: k, bx: (width - side) / 2, ky: k, by: top, width, height }
  const at = (q: Rect) => `x="${q.left.toFixed(1)}" y="${q.top.toFixed(1)}" width="${q.width.toFixed(1)}" height="${q.height.toFixed(1)}"`
  const r = d.cells.rects, centre = (c: number) => [(r[c * 4]! + r[c * 4 + 2]! / 2) * k + v.bx, (r[c * 4 + 1]! + r[c * 4 + 3]! / 2) * k + v.by] as const
  let cells = ''
  for (let c = 0; c < t.cellArea.length; c++) {
    const depth = t.cellDepth[c]!
    if (depth >= 0 && (depth === 0 || d.cells.names[c])) cells += `<rect ${at(cellRect(d, v, c))} fill="${CELL[Math.min(depth, 2)]}"/>`
  }
  const fog = d.areas.map((a, n) => {
    const c = t.areaCell[n]!, cov = coverageOf(a)
    if (c < 0 || (!cov.hatched && !cov.ghost)) return ''
    const q = cellRect(d, v, c), g = Math.min(36, Math.max(8, q.width * 0.22))
    return `<g><title>${esc(cov.text)}</title>${cov.hatched ? `<rect ${at(q)} fill="url(#hatch)"/>` : ''}${cov.ghost ? `<rect ${at({ left: q.left + q.width * 0.94 - g, top: q.top + q.height * 0.94 - g, width: g, height: g })} fill="url(#ghost)" stroke="#cbd5e1" stroke-opacity="0.75" stroke-dasharray="3 2"/>` : ''}</g>`
  }).join('')
  const max = Math.max(1, ...t.pairs.map((p) => p.observed + p.inferred))
  const bundles = strokes.map(({ pair, basis, count }) => {
    const ca = t.areaCell[pair.from]!, cb = t.areaCell[pair.to]!
    if (ca < 0 || cb < 0) return ''
    const [x0, y0] = centre(ca), [x1, y1] = centre(cb), bend = basis === 'inferred' ? 0.22 : 0.12
    const qx = (x0 + x1) / 2 - (y1 - y0) * bend, qy = (y0 + y1) / 2 + (x1 - x0) * bend
    return `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="${STROKE[basis]}" stroke-width="${(1.5 + (4 * Math.log(1 + count)) / Math.log(1 + max)).toFixed(1)}"${basis === 'inferred' ? ' stroke-dasharray="7 5"' : ''} marker-end="url(#${basis})"/>`
  }).join('')
  // Labels go under the points, so no point is hidden.
  const names = labels(d, t, v).map((l) => l.kind === 'symbol'
    ? `<text x="${(l.left + l.width / 2).toFixed(1)}" y="${(l.top + 11).toFixed(1)}" font-size="11" text-anchor="middle" fill="${SYMBOL}">${esc(l.text)}</text>`
    : (l.height > 16 ? l.text.split(' ') : [l.text]).map((line, i) => `<text x="${l.left.toFixed(1)}" y="${(l.top + 12 + i * 16).toFixed(1)}" font-size="${l.kind === 'area' ? 12 : 11}"${l.kind === 'area' ? ' font-weight="600"' : ''} fill="${l.kind === 'area' ? '#e6eeff' : '#c9d3ea'}">${esc(line)}</text>`).join('')).join('')
  const radius = Math.min(4, Math.max(1.5, symbolSide(d, v) * POINT)).toFixed(1), picked = matches && new Set(matches)
  let dots = ''
  for (let i = 0; i < d.n; i++) if (!picked || picked.has(i)) dots += `<circle cx="${(d.positions[i * 2]! * k + v.bx).toFixed(1)}" cy="${(d.positions[i * 2 + 1]! * k + v.by).toFixed(1)}" r="${radius}" fill="${picked ? MATCH : SYMBOL}"/>`
  const { shown, rest } = ghostAreas(d.areas, GHOSTS)
  const ghosts = [...shown.map((a) => ({ name: a.name, text: coverageOf(a).text })), ...(rest.areas ? [{ name: `+${plural(rest.areas, 'smaller area')}`, text: `${plural(rest.areas, 'more area')} with no symbols ${rest.areas === 1 ? 'holds' : 'hold'} ${plural(rest.files, 'file')} the graph cannot see; the table lists them` }] : [])]
  const pitch = GHOST_SIDE * 1.25 * k
  const empty = ghosts.map((g, i) => {
    const q = ghostRect(v, i), fits = Math.max(1, Math.floor((pitch - 6) / 6.2)), name = g.name.length > fits ? `${g.name.slice(0, fits - 1)}…` : g.name
    return `<g><title>${esc(g.text)}</title><rect ${at(q)} fill="url(#ghost)" stroke="#cbd5e1" stroke-opacity="0.6" stroke-dasharray="3 2"/><text x="${q.left.toFixed(1)}" y="${(q.top + q.height + 15).toFixed(1)}" font-size="11" fill="#cbd5e1">${esc(name)}</text></g>`
  }).join('')
  const defs = `<defs><pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="10" stroke="#f2b84b" stroke-opacity="0.35"/></pattern><pattern id="ghost" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="7" stroke="#cbd5e1" stroke-opacity="0.3" stroke-width="2"/></pattern>${(['observed', 'inferred'] as const).map((b) => `<marker id="${b}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${STROKE[b]}"/></marker>`).join('')}</defs>`
  const title = `${picked ? `${plural(picked.size, 'matching symbol')} of ${plural(d.n, 'symbol')}` : plural(d.n, 'symbol')} in ${plural(d.areas.length, 'area')}, placed by the snapshot's path tree`
  const total = height + block.height
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}" role="img" aria-label="${esc(`${caveats.view}: ${plural(d.areas.length, 'area')}`)}">${defs}<rect width="100%" height="100%" fill="#0b0f1a"/><text x="24" y="36" font-size="18" fill="#e6e9f2">${esc(title)}</text>${cells}${fog}${bundles}${names}${dots}${empty}${block.svg}</svg>`
}

/** A self-contained page: the drawing, the caveats, the legend, a table of what is drawn, and source only with consent. It loads nothing. */
export function offlineHtml(svg: string, caveats: Caveats, table: { head: string[]; rows: string[][] }, source: Source): string {
  const cells = (row: string[], tag: string) => `<tr>${row.map((c) => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(`Proofmesh ${caveats.view} · ${caveats.snapshotId}`)}</title>
<style>body{background:#0b0f1a;color:#e6e9f2;font:15px/1.5 system-ui,sans-serif;margin:24px}svg{max-width:100%;height:auto}table{border-collapse:collapse;margin-top:16px}td,th{border:1px solid #2a3245;padding:4px 8px;text-align:left}pre{background:#111827;padding:12px;overflow:auto}</style>
</head>
<body>
<main>
<h1>${esc(`Proofmesh ${caveats.view}`)}</h1>
<section aria-label="Caveats"><ul>${caveatLines(caveats, source).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>
<section aria-label="Legend"><ul>${LEGEND.map((l) => `<li><span style="color:${l.color}">${l.dashed ? '- - -' : '———'}</span> ${esc(l.label)}</li>`).join('')}</ul></section>
${svg}
<section aria-label="Table"><table><thead>${cells(table.head, 'th')}</thead><tbody>${table.rows.map((r) => cells(r, 'td')).join('')}</tbody></table></section>
${source ? `<section aria-label="Source"><h2>${esc(`${source.path} from line ${source.startLine}`)}</h2><pre>${esc(source.text)}</pre></section>` : ''}
</main>
</body>
</html>
`
}

/** The table equivalent of a graph view: every node, then every edge. */
export function sceneTable(scene: Scene): { head: string[]; rows: string[][] } {
  const name = new Map(scene.nodes.map((n) => [n.id, n.qualifiedName || n.label]))
  return {
    head: ['kind', 'name', 'detail'],
    rows: [
      ...scene.nodes.map((n) => ['node', n.qualifiedName || n.label, n.path ? `${n.path}:${n.line} · ${n.role}` : n.role]),
      ...scene.edges.map((e) => ['edge', `${name.get(e.source) ?? e.source} → ${name.get(e.target) ?? e.target}`, e.label ? `${e.style} · ${e.label}` : e.style]),
      ...scene.stubs.map((s) => ['unresolved', `${name.get(s.fromId) ?? s.fromId} → ?`, `${s.reason} · line ${s.line}`]),
    ],
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A PNG with a tEXt chunk inserted before IEND, so the caveats travel inside the image as text as well as drawn. */
export function pngWithText(png: Uint8Array, keyword: string, text: string): Uint8Array {
  const data = new TextEncoder().encode(`${keyword}\0${text}`)
  const chunk = new Uint8Array(12 + data.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  chunk.set(new TextEncoder().encode('tEXt'), 4)
  chunk.set(data, 8)
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))
  const iend = png.length - 12
  const out = new Uint8Array(png.length + chunk.length)
  out.set(png.subarray(0, iend), 0)
  out.set(chunk, iend)
  out.set(png.subarray(iend), iend + chunk.length)
  return out
}

/** The text of every tEXt chunk in a PNG, by keyword. */
export function pngText(png: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  for (let i = 8; i + 8 <= png.length;) {
    const length = view.getUint32(i), type = new TextDecoder().decode(png.subarray(i + 4, i + 8))
    if (type === 'tEXt') {
      const body = new TextDecoder().decode(png.subarray(i + 8, i + 8 + length))
      const nul = body.indexOf('\0')
      out[body.slice(0, nul)] = body.slice(nul + 1)
    }
    i += 12 + length
  }
  return out
}
