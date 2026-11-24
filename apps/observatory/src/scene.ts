// Pure mapping from a trace_paths envelope to what Observatory draws. No DOM, so it is testable without a browser.
export type TraceEnvelope = {
  data: {
    conclusion: 'path_found' | 'no_path_within_bounds' | 'no_resolved_path' | 'no_path_exhaustive'
    paths: Array<{ nodes: string[]; assertions: string[] }>
    search: { levels: Array<{ depth: number }>; stopped_by: string | null; horizon: Array<{ id: string; unexplored_edges: number }>; explored?: Array<{ from: string; to: string; assertion_id: string; depth: number }> }
    boundaries: Array<{ assertion_id: string; type?: string; reason: string; path: string; line: number; from_id: string }>
    nodes: Record<string, { kind: string; name: string; qualified_name: string; path: string; start_line: number }>
    relationships?: Record<string, { type: string; origin: string; rule: string | null }>
  }
  limits: { applied: { max_depth: number } }
}
export type Role = 'source' | 'target' | 'path' | 'horizon' | 'explored' | 'unreached-target' | 'stub' | 'focus' | 'caller' | 'callee' | 'external' | 'area'
export type SceneNode = { id: string; label: string; qualifiedName: string; path: string; line: number; x: number; y: number; role: Role; size: number; color: string; depth: number; labelPosition?: 'left' | 'right' | 'below' }
export type SceneEdge = { id: string; source: string; target: string; style: 'resolved' | 'resolved_external' | 'candidate' | 'ambiguous' | 'unresolved' | 'explored' | 'framework' | 'aggregate'; depth: number; color: string; size: number; assertionId?: string; label?: string }
export type Scene = { nodes: SceneNode[]; edges: SceneEdge[]; badges: Array<{ nodeId: string; text: string }>; stubs: Array<{ id: string; fromId: string; reason: string; line: number }>; conclusion: string }

export const TOKENS = {
  resolved: '#7fd4ff', resolved_external: '#5b6478', unresolved: '#f2b84b', explored: '#3d5a80', framework: '#c79bff',
  source: '#9be7ff', target: '#ffd36e', path: '#b8c4ff', horizon: '#ffffff', explored_node: '#6f86b3', focus: '#9be7ff', caller: '#b8c4ff', callee: '#b8c4ff', external: '#5b6478', area: '#7fd4ff', 'unreached-target': '#6b7280', stub: '#3a4256',
} as const

/** Relationship types that framework rules produce; the Trace view follows them on request. */
export const FRAMEWORK_TYPES = ['maps_to', 'handles', 'dispatches_to', 'exposes', 'runs', 'injects', 'registered_as', 'publishes', 'consumes', 'sends_to', 'listens_on', 'evaluates_flag', 'reads_config', 'calls_service', 'renders', 'uses_hook', 'provides_context', 'uses_context'] as const

const RESOLUTION_WORDS: Record<string, string> = { resolved: '', resolved_external: 'external', candidate: 'candidate', ambiguous: 'ambiguous', unresolved: 'unresolved' }
const ORIGIN_WORDS: Record<string, string> = {
  semantic_resolver: '', syntax: 'syntax only', configuration_adapter: 'configuration', contract_match: 'contract match', runtime_observation: 'observed at runtime',
  documentation: 'documentation', human_assertion: 'asserted by a person', model_hypothesis: 'model hypothesis',
}
/**
 * The words a relationship carries on screen, so neither its resolution nor its origin rests on colour alone (FR057): its type unless a
 * call, a framework rule or any origin other than the semantic resolver, and any resolution short of resolved. A call the semantic
 * resolver resolved, the common case, carries none.
 */
export function relationshipWords(r: { type: string; resolution: string; origin: string; rule?: string | null }): string[] {
  const framework = r.origin === 'framework_adapter'
  return [framework || r.type !== 'calls' ? r.type : '', framework ? r.rule ?? 'rule' : ORIGIN_WORDS[r.origin] ?? r.origin.replace(/_/g, ' '), RESOLUTION_WORDS[r.resolution] ?? r.resolution].filter(Boolean)
}
const label = (words: string[]) => (words.length ? words.join(' · ') : undefined)

// Framework symbols carry a glyph, so a table or an endpoint never reads as code.
const GLYPH: Record<string, string> = { endpoint: '⇄ ', table: '▦ ', message: '✉ ', channel: '≋ ', job: '⏱ ', feature_flag: '⚑ ', config_key: '⚙ ', team: '◍ ', service: '☁ ', resource: '▣ ', output: '⇥ ', module_call: '⧉ ' }
export const glyph = (kind: string | undefined) => (kind && Object.hasOwn(GLYPH, kind) ? GLYPH[kind] : '')

export function conclusionText(env: TraceEnvelope): string {
  const d = env.data
  switch (d.conclusion) {
    case 'path_found': return `Path found: ${(d.paths[0]?.nodes.length ?? 1) - 1} step${(d.paths[0]?.nodes.length ?? 2) - 1 === 1 ? '' : 's'}${d.paths.length > 1 ? `, ${d.paths.length} shortest paths` : ''}.`
    case 'no_path_within_bounds': {
      const reason = d.search.stopped_by === 'max_depth' ? `the depth limit` : `the ${d.search.stopped_by ?? 'search'} limit`
      return `No path within depth ${env.limits.applied.max_depth}. The search stopped at ${reason}; this is not evidence that no path exists.`
    }
    case 'no_resolved_path': return 'No resolved path. Unresolved call sites in the explored region could lead to the target.'
    case 'no_path_exhaustive': return 'No path exists within the declared relationship types and resolutions in this snapshot.'
  }
}

/** A few explored symbols keep the picture readable; more are counted, not drawn. */
export const EXPLORED_LIMIT = 40

export function toScene(env: TraceEnvelope, sourceId: string, targetId: string): Scene {
  const d = env.data
  const depth = new Map<string, number>([[sourceId, 0]])
  for (const p of d.paths) p.nodes.forEach((n, i) => depth.set(n, Math.min(depth.get(n) ?? i, i)))
  for (const e of d.search.explored ?? []) if (!depth.has(e.to)) depth.set(e.to, e.depth)
  const frontierDepth = d.search.levels.length
  for (const h of d.search.horizon) if (!depth.has(h.id)) depth.set(h.id, frontierDepth)
  const reached = d.paths.length > 0
  if (!depth.has(targetId)) depth.set(targetId, Math.max(frontierDepth, 1) + 1)
  // A column is several rows wide, so a label never reaches the next column when the view fits a tall column (B14).
  const COL = 4
  const slots = new Map<number, number>()
  const nodes: SceneNode[] = []
  const add = (id: string, role: Role) => {
    const info = d.nodes[id]
    const dep = depth.get(id) ?? 1
    const slot = slots.get(dep) ?? 0
    slots.set(dep, slot + 1)
    nodes.push({ id, label: glyph(info?.kind) + (info?.name ?? id), qualifiedName: info?.qualified_name ?? id, path: info?.path ?? '', line: info?.start_line ?? 0, x: dep * COL, y: -slot, role, size: role === 'source' || role === 'target' || role === 'unreached-target' ? 14 : 11, color: role === 'explored' ? TOKENS.explored_node : TOKENS[role], depth: dep })
  }
  const pathNodes = new Set(d.paths.flatMap((p) => p.nodes))
  add(sourceId, 'source')
  for (const id of [...pathNodes].filter((n) => n !== sourceId && n !== targetId).sort((a, b) => depth.get(a)! - depth.get(b)! || (a < b ? -1 : 1))) add(id, 'path')
  const horizonIds = new Set(d.search.horizon.map((h) => h.id))
  for (const h of d.search.horizon) if (!pathNodes.has(h.id) && h.id !== sourceId) add(h.id, 'horizon')
  // Nodes the search reached that are on no path and not on the horizon; a few keep the picture readable.
  const allExplored = [...new Set((d.search.explored ?? []).map((e) => e.to))].filter((id) => !pathNodes.has(id) && !horizonIds.has(id) && id !== sourceId && id !== targetId)
  const exploredIds = allExplored.slice(0, EXPLORED_LIMIT)
  const notDrawn = allExplored.length - exploredIds.length
  for (const id of exploredIds) add(id, 'explored')
  add(targetId, reached ? 'target' : 'unreached-target')
  const edges: SceneEdge[] = []
  for (const p of d.paths) {
    for (let i = 1; i < p.nodes.length; i++) {
      const id = `e:${p.assertions[i - 1]}`
      const rel = d.relationships?.[p.assertions[i - 1]!]
      const framework = rel?.origin === 'framework_adapter'
      if (!edges.some((e) => e.id === id)) edges.push({ id, source: p.nodes[i - 1]!, target: p.nodes[i]!, style: framework ? 'framework' : 'resolved', depth: i, color: framework ? TOKENS.framework : TOKENS.resolved, size: 4, assertionId: p.assertions[i - 1]!, label: rel ? label(relationshipWords({ ...rel, resolution: 'resolved' })) : undefined })
    }
  }
  const drawn = new Set(nodes.map((n) => n.id))
  for (const e of d.search.explored ?? []) {
    const id = `e:${e.assertion_id}`
    if (edges.some((x) => x.id === id) || !drawn.has(e.from) || !drawn.has(e.to)) continue
    const rel = d.relationships?.[e.assertion_id]
    edges.push({ id, source: e.from, target: e.to, style: 'explored', depth: e.depth, color: TOKENS.explored, size: 2, assertionId: e.assertion_id, label: rel ? label(relationshipWords({ ...rel, resolution: 'resolved' })) : undefined })
  }
  const stubs = d.boundaries.map((b) => ({ id: `stub:${b.assertion_id}`, fromId: b.from_id, reason: b.reason, line: b.line }))
  const taken = new Set<string>()
  for (const s of stubs) {
    const from = nodes.find((n) => n.id === s.fromId)
    if (!from) continue
    // Halfway to the next column and between its rows, at the first free place below the caller, so a stub's label meets no other label.
    let y = from.y - 0.5
    while (taken.has(`${from.x}:${y}`)) y -= 1
    taken.add(`${from.x}:${y}`)
    nodes.push({ id: s.id, label: `${s.reason} · line ${s.line}`, qualifiedName: s.reason, path: '', line: s.line, x: from.x + COL / 2, y, role: 'stub', size: 7, color: TOKENS.stub, depth: from.depth + 1 })
    edges.push({ id: `e:${s.id}`, source: s.fromId, target: s.id, style: 'unresolved', depth: from.depth + 1, color: TOKENS.unresolved, size: 1.5 })
  }
  const badges = d.search.horizon.map((h) => ({ nodeId: h.id, text: `+${h.unexplored_edges} unexplored · stopped by ${d.search.stopped_by}` }))
  // Explored symbols past the limit are counted where the search began, never dropped silently (FR058).
  if (notDrawn) badges.push({ nodeId: sourceId, text: `+${notDrawn} explored symbol${notDrawn === 1 ? '' : 's'} not drawn` })
  return { nodes, edges, badges, stubs, conclusion: `${conclusionText(env)}${notDrawn ? ` ${notDrawn} explored symbol${notDrawn === 1 ? ' is' : 's are'} not drawn.` : ''}` }
}
