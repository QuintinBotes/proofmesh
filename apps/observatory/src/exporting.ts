// Exports of a view (FR064): an SVG drawing, an offline HTML page, and PNG metadata. Pure functions, so they are testable without a DOM.
import { areaLabel, placeLabels } from './galaxyData'
import { plural } from './plural'
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
/** The Galaxy's positions come from the path tree (FR1224): they show containment, and nearness is still no relationship. */
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
    c.view === 'Galaxy' ? CONTAINMENT : NO_MEANING,
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

export type GalaxyExportArea = { name: string; color: string; count: number; matches?: number; fog?: string }
const GHOST_BAND = 120, GHOSTS = 10
/**
 * The Galaxy as it is drawn: each symbol (while searching, each match) a point at its place in the snapshot, in its area's colour
 * with y up as on screen, each area named at its centre, incomplete coverage as a dashed ring with words (FR059), and the areas
 * with no symbols as ghosts below the map. The places come with the snapshot, so one snapshot exports the same bytes (FR1580).
 */
export function galaxySvg(d: { positions: ArrayLike<number>; area: ArrayLike<number> }, shown: number[], areas: GalaxyExportArea[], caveats: Caveats, source: Source, width = 1600, height = 1000): string {
  const block = caveatBlock(caveats, source, 24, height)
  const top = 60, side = Math.min(width - 48, height - top - GHOST_BAND), left = (width - side) / 2
  const sum = areas.map((): [number, number, number] => [0, 0, 0])
  const dots = shown.map((i) => {
    const x = left + (d.positions[i * 2]! / 65535) * side, y = top + (1 - d.positions[i * 2 + 1]! / 65535) * side, s = sum[d.area[i]!]!
    s[0] += x; s[1] += y; s[2]++
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${areas[d.area[i]!]!.color}"/>`
  }).join('')
  const centres = areas.slice(0, 40).flatMap((a, k) => (sum[k]![2] ? [{ a, name: areaLabel(a.name), x: sum[k]![0]! / sum[k]![2]!, y: sum[k]![1]! / sum[k]![2]! }] : []))
  // Names go under the points, so no point is hidden; a name that would overlap one already placed is left off, as on screen (B14).
  const names = placeLabels(centres).map(({ a, name, x, y }) => `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="12" font-weight="600" text-anchor="middle" fill="${a.color}">${esc(name)}${a.matches !== undefined ? ` · ${plural(a.matches, 'match', 'matches')}` : ''}</text>`).join('')
  const ring = (x: number, y: number, r: number, fog: string, words: string) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="none" stroke="#cbd5e1" stroke-opacity="0.7" stroke-dasharray="4 3"/><text x="${x.toFixed(1)}" y="${(y + r + 13).toFixed(1)}" font-size="10" text-anchor="middle" fill="#cbd5e1"><title>${esc(fog)}</title>${esc(words)}</text>`
  const rings = centres.filter((c) => c.a.fog).map((c) => ring(c.x, c.y, 18, c.a.fog!, c.a.fog!.slice(c.a.name.length + 2))).join('')
  const empty = areas.filter((a) => !a.count && a.fog), cols = Math.min(5, Math.max(1, empty.length))
  const ghosts = empty.slice(0, GHOSTS).map((a, i) => ring(24 + ((i % cols) + 0.5) * ((width - 48) / cols), top + side + 26 + Math.floor(i / cols) * 48, 10, a.fog!, a.fog!)).join('')
  const more = empty.length > GHOSTS ? `<text x="24" y="${height - 6}" font-size="11" fill="#cbd5e1">${esc(`+${plural(empty.length - GHOSTS, 'more area')} with no symbols; the table lists them`)}</text>` : ''
  const title = `${shown.length === d.area.length ? plural(shown.length, 'symbol') : `${plural(shown.length, 'matching symbol')} of ${plural(d.area.length, 'symbol')}`}, placed by the snapshot's path tree`
  const total = height + block.height
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}" role="img" aria-label="${esc(`${caveats.view}: ${plural(areas.length, 'area')}`)}"><rect width="100%" height="100%" fill="#0b0f1a"/><text x="24" y="36" font-size="18" fill="#e6e9f2">${esc(title)}</text>${names}${rings}${dots}${ghosts}${more}${block.svg}</svg>`
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
