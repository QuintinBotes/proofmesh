// Pure mapping from a get_ecosystem answer (A11) to a scene: one node per member repository, one edge per linked pair, and a stub
// per boundary where a member's client facts matched nothing in the workspace. No DOM, so it is testable without a browser.
import { forceLayout } from './layout'
import { TOKENS, type Scene, type SceneEdge, type SceneNode } from './scene'

export type LinkType = 'calls_endpoint' | 'messages' | 'depends_on_package' | 'calls_service' | 'deploys' | 'uses_resource' | 'calls' | 'inherits' | 'implements' | 'references'
export type EcosystemMember = { repository_id: string; name: string; snapshot_id: string; current: boolean; symbols: number; files_indexed: number; endpoints: number; channels: number; projects: number }
export type EcosystemLink = { source_repository_id: string; target_repository_id: string; type: LinkType; resolved: number; candidate: number; min_confidence: number; max_confidence: number; sample: Array<{ link_id: string; source: string; target: string | null; confidence: number; rule: string }> }
export type EcosystemBoundary = { repository_id: string; type: LinkType; count: number; sample: Array<{ link_id: string; source: string; reason: string }> }
export type Ecosystem = { workspace: { name: string; link_file_id: string; sealed_at: string; rules: Record<string, string> }; members: EcosystemMember[]; links: EcosystemLink[]; boundaries: EcosystemBoundary[] }

export const LINK_WORDS: Record<LinkType, string> = { calls_endpoint: 'calls endpoints of', messages: 'sends messages to', depends_on_package: 'depends on packages of', calls_service: 'calls the service', deploys: 'deploys', uses_resource: 'uses the cloud resource', calls: 'calls code of', inherits: 'extends types of', implements: 'implements types of', references: 'uses types of' }
/** How a member relates to the selected repository, read from the link file's pairs (A11). */
export type Relation = 'selected' | 'links_to' | 'linked_from' | 'both' | 'indirect' | 'unlinked'
export const RELATION_COLOURS: Record<Relation, string> = { selected: '#ffd166', links_to: '#7fd4ff', linked_from: '#c49bff', both: '#5ee2a0', indirect: '#8f99ad', unlinked: '#4d566b' }
export const RELATION_WORDS: Record<Relation, string> = { selected: 'selected', links_to: 'links to it', linked_from: 'linked from it', both: 'linked both ways', indirect: 'linked through others', unlinked: 'not linked' }

/** One row per ordered pair of members, every link type folded together: what the picture and the table both show. */
export function pairs(e: Ecosystem): Array<{ source: string; target: string; resolved: number; candidate: number; types: LinkType[]; min: number; max: number }> {
  const by = new Map<string, { source: string; target: string; resolved: number; candidate: number; types: LinkType[]; min: number; max: number }>()
  for (const l of e.links) {
    const key = `${l.source_repository_id}>${l.target_repository_id}`
    const p = by.get(key) ?? { source: l.source_repository_id, target: l.target_repository_id, resolved: 0, candidate: 0, types: [], min: 1, max: 0 }
    p.resolved += l.resolved; p.candidate += l.candidate; p.types.push(l.type); p.min = Math.min(p.min, l.min_confidence); p.max = Math.max(p.max, l.max_confidence)
    by.set(key, p)
  }
  return [...by.values()].sort((a, b) => (a.source + a.target < b.source + b.target ? -1 : 1))
}

/** The member with the most linked partners, ties by name: what the overview selects until a person picks one. */
export function defaultSelection(e: Ecosystem): string | null {
  const partners = new Map(e.members.map((m) => [m.repository_id, new Set<string>()]))
  for (const p of pairs(e)) { partners.get(p.source)?.add(p.target); partners.get(p.target)?.add(p.source) }
  return [...e.members].sort((a, b) => partners.get(b.repository_id)!.size - partners.get(a.repository_id)!.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0]?.repository_id ?? null
}

/** Each member's relation to `selected`: direct links by direction, then members reachable only through others, then the rest. */
export function relations(e: Ecosystem, selected: string): Map<string, Relation> {
  const out = new Map<string, Relation>(e.members.map((m) => [m.repository_id, 'unlinked']))
  out.set(selected, 'selected')
  const near = new Map<string, Set<string>>()
  for (const p of pairs(e)) {
    for (const [a, b] of [[p.source, p.target], [p.target, p.source]] as const) near.set(a, (near.get(a) ?? new Set()).add(b))
    const other = p.source === selected ? p.target : p.target === selected ? p.source : null
    if (!other || !out.has(other)) continue
    const now = out.get(other)!, dir: Relation = p.source === selected ? 'linked_from' : 'links_to'
    out.set(other, now === 'unlinked' || now === dir ? dir : 'both')
  }
  const seen = new Set([selected]), queue = [selected]
  while (queue.length) for (const n of near.get(queue.shift()!) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); if (out.get(n) === 'unlinked') out.set(n, 'indirect') }
  return out
}

/** What the evidence panel shows for one member: its links each way with their samples, and its boundaries. */
export function evidenceFor(e: Ecosystem, id: string) {
  const name = (r: string) => e.members.find((m) => m.repository_id === r)?.name ?? r
  const side = (dir: 'out' | 'in') => e.links.filter((l) => (dir === 'out' ? l.source_repository_id : l.target_repository_id) === id)
    .map((l) => ({ other: name(dir === 'out' ? l.target_repository_id : l.source_repository_id), type: l.type, resolved: l.resolved, candidate: l.candidate, min: l.min_confidence, max: l.max_confidence, sample: l.sample }))
    .sort((a, b) => (a.other + a.type < b.other + b.type ? -1 : 1))
  return { name: name(id), outgoing: side('out'), incoming: side('in'), boundaries: e.boundaries.filter((b) => b.repository_id === id) }
}

export function toEcosystem(e: Ecosystem, selected: string | null = defaultSelection(e)): Scene {
  const members = [...e.members].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const index = new Map(members.map((m, i) => [m.repository_id, i]))
  const max = Math.max(1, ...members.map((m) => m.symbols))
  const radii = members.map((m) => 8 + 22 * Math.sqrt(m.symbols / max))
  const ps = pairs(e).filter((p) => index.has(p.source) && index.has(p.target))
  const positions = forceLayout(radii, ps.map((p) => ({ a: index.get(p.source)!, b: index.get(p.target)!, weight: p.resolved + p.candidate })))
  const rel = selected && index.has(selected) ? relations(e, selected) : null
  const nodes: SceneNode[] = members.map((m, i) => ({
    id: m.repository_id, label: `${m.name} · ${m.symbols.toLocaleString('en')}${m.current ? '' : ' · newer snapshot exists'}`, qualifiedName: m.name, path: m.snapshot_id, line: 0,
    x: positions[i]!.x, y: positions[i]!.y, role: 'area', size: radii[i]!, color: RELATION_COLOURS[rel?.get(m.repository_id) ?? 'unlinked'], depth: 0,
  }))
  const maxLinks = Math.max(1, ...ps.map((p) => p.resolved + p.candidate))
  const edges: SceneEdge[] = ps.map((p) => ({
    id: `l:${p.source} -> ${p.target}`, source: p.source, target: p.target, style: p.resolved ? 'aggregate' : 'unresolved', depth: 0,
    // A pair with candidates only reads in the unresolved colour: nothing between them is settled.
    color: p.resolved ? 'rgba(127,212,255,0.6)' : TOKENS.unresolved, size: 1 + 5 * (Math.log(1 + p.resolved + p.candidate) / Math.log(1 + maxLinks)),
    label: `${p.resolved ? `${p.resolved} resolved` : ''}${p.resolved && p.candidate ? ', ' : ''}${p.candidate ? `${p.candidate} candidate` : ''}`,
  }))
  const stubs: Scene['stubs'] = []
  for (const b of e.boundaries.filter((x) => index.has(x.repository_id))) {
    const m = nodes[index.get(b.repository_id)!]!, k = stubs.filter((s) => s.fromId === b.repository_id).length
    const id = `stub:${b.repository_id}:${b.type}`
    nodes.push({ id, label: `${b.count} unresolved · ${b.type}`, qualifiedName: `${m.qualifiedName} ${b.type}`, path: '', line: 0, x: m.x + m.size * 2.2, y: m.y + (k - 0.5) * 18, role: 'stub', size: 4, color: TOKENS.stub, depth: 0 })
    edges.push({ id: `b:${id}`, source: b.repository_id, target: id, style: 'unresolved', depth: 0, color: TOKENS.unresolved, size: 1.5 })
    stubs.push({ id, fromId: b.repository_id, reason: b.type, line: 0 })
  }
  const stale = members.filter((m) => !m.current).length
  const unresolved = e.boundaries.reduce((n, b) => n + b.count, 0)
  const conclusion = `${e.workspace.name}: ${members.length} repositories, ${ps.length} linked pairs, ${unresolved.toLocaleString('en')} unresolved boundaries${stale ? `; ${stale} linked from a snapshot that is no longer current` : ''}. Click a repository to see its links and open only it.`
  return { nodes, edges, badges: [], stubs, conclusion }
}
