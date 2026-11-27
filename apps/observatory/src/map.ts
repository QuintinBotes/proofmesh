// Pure mapping from a get_overview result to a scene: one node per area, file or symbol, sized by its symbols (or matches
// while searching), with aggregated resolved relationships between them. No DOM, so it is testable without a browser.
import { forceLayout } from './layout'
import { plural } from './plural'
import { glyph, type Scene } from './scene'

export type OverviewChild = { key: string; name: string; kind: 'directory' | 'file' | 'symbol'; symbols: number; matches: number | null; symbol_kind: string | null }
export type Overview = { path: string; scope: 'directory' | 'file'; children: OverviewChild[]; links: Array<{ from: string; to: string; count: number; by_type: Record<string, number> }>; omitted: number }

/** The Galaxy palette: hues a golden angle apart, so neighbouring areas never share a colour. */
export function areaColor(i: number): string {
  const h = (200 + i * 137.508) % 360, s = 0.78, l = 0.63
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))) }
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

export function toMap(o: Overview, text: string | null): Scene {
  const weight = (c: OverviewChild) => (text ? c.matches ?? 0 : c.symbols)
  const max = Math.max(1, ...o.children.map(weight))
  const radii = o.children.map((c) => 6 + 20 * Math.sqrt(weight(c) / max))
  const index = new Map(o.children.map((c, i) => [c.key, i]))
  const maxLink = Math.max(1, ...o.links.map((l) => l.count))
  const positions = forceLayout(radii, o.links.map((l) => ({ a: index.get(l.from)!, b: index.get(l.to)!, weight: l.count })))
  const nodes = o.children.map((c, i) => ({
    id: c.key, label: `${c.kind === 'symbol' ? glyph(c.symbol_kind ?? undefined) : ''}${c.name} · ${weight(c).toLocaleString('en')}`, qualifiedName: c.key, path: c.kind === 'symbol' ? o.path : c.key, line: 0,
    x: positions[i]!.x, y: positions[i]!.y, role: 'area' as const, size: radii[i]!, color: areaColor(i), depth: 0,
  }))
  const edges = o.links.map((l) => ({
    id: `l:${l.from} -> ${l.to}`, source: l.from, target: l.to, style: 'aggregate' as const, depth: 0,
    color: 'rgba(127,212,255,0.5)', size: 1 + 5 * (Math.log(1 + l.count) / Math.log(1 + maxLink)),
  }))
  const where = o.path === '' ? 'the repository' : o.path
  const item = o.scope === 'file' ? 'symbol' : 'area'
  const total = o.children.reduce((n, c) => n + weight(c), 0)
  const conclusion = text
    ? `“${text}”: ${plural(total, 'matching symbol')} in ${plural(o.children.length, item)} of ${where}${o.omitted ? ` (+${o.omitted} more)` : ''}. Click one to narrow down.`
    : `${where}: ${plural(o.children.length, item)}${o.omitted ? ` (+${o.omitted} more)` : ''}, ${plural(o.links.length, 'link')} between them. Click one to open it.`
  return { nodes, edges, badges: [], stubs: [], conclusion }
}
