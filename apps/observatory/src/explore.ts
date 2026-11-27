// Pure mapping from a get_relationships envelope to a neighbourhood scene: callers on the left, the focus in the middle,
// callees, framework relations and unresolved sites on the right. No DOM, so it is testable without a browser.
import { plural } from './plural'
import { glyph, relationshipWords, TOKENS, type Scene, type SceneEdge, type SceneNode } from './scene'

type Other = { kind: string; symbol_kind?: string; id?: string; name?: string; qualified_name?: string; path?: string; module?: string; start_line?: number }
export type Relationship = {
  assertion_id: string; type: string; direction: 'in' | 'out'; resolution: string; origin: string; other: Other
  site: { path: string; start_line: number }; reason: string | null; detail: Record<string, string> | null
}
export type RelationshipsEnvelope = { data: { relationships: Relationship[]; boundaries: unknown[]; totals: { in: number; out: number } }; completion: { truncated: boolean } }
export type Focus = { id: string; kind: string; name: string; qualified_name: string; path: string; start_line: number }

/** At most this many neighbours per side, so a hub stays readable; the rest are counted on a badge. */
export const SIDE_LIMIT = 24

export function toNeighbourhood(env: RelationshipsEnvelope, focus: Focus): Scene {
  const rels = env.data.relationships
  const nodes: SceneNode[] = [{ id: focus.id, label: glyph(focus.kind) + focus.name, qualifiedName: focus.qualified_name, path: focus.path, line: focus.start_line, x: 0, y: 0, role: 'focus', size: 15, color: TOKENS.source, depth: 0 }]
  const edges: SceneEdge[] = []
  const stubs: Scene['stubs'] = []
  const seen = new Set([focus.id])
  const sides = { in: rels.filter((r) => r.direction === 'in' && r.other.id), out: rels.filter((r) => r.direction === 'out') }
  let hidden = 0
  const placedBySide = Object.fromEntries((Object.entries(sides) as Array<['in' | 'out', Relationship[]]>).map(([d, list]) => [d, list.filter((r) => !r.other.id || !seen.has(r.other.id) || r.resolution === 'unresolved')]))
  // The renderer keeps the aspect ratio, so the columns sit as far apart as the tallest column is high; labels face outwards.
  const tallest = Math.max(1, ...Object.values(placedBySide).map((l) => Math.min(l.length, SIDE_LIMIT) - 1))
  const spread = Math.max(1, tallest * 0.6)
  for (const [direction, placed] of Object.entries(placedBySide) as Array<['in' | 'out', Relationship[]]>) {
    const x = direction === 'in' ? -spread : spread
    const labelPosition = direction === 'in' ? 'left' as const : 'right' as const
    const shown = placed.slice(0, SIDE_LIMIT)
    hidden += placed.length - shown.length
    shown.forEach((r, i) => {
      const y = (shown.length - 1) / 2 - i
      const framework = r.origin === 'framework_adapter'
      const words = relationshipWords({ type: r.type, resolution: r.resolution, origin: r.origin, rule: r.detail?.rule })
      if (r.resolution === 'unresolved' || !r.other.id) {
        const id = `stub:${r.assertion_id}`
        stubs.push({ id, fromId: focus.id, reason: r.reason ?? r.resolution, line: r.site.start_line })
        // The frayed stub is itself the mark of an unresolved site, so its words name the reason rather than repeat that.
        const stubWords = [...new Set([...words.filter((w) => w !== 'unresolved'), r.reason ?? r.resolution])]
        nodes.push({ id, label: `${stubWords.join(' · ')} · line ${r.site.start_line}`, qualifiedName: r.reason ?? r.resolution, path: r.site.path, line: r.site.start_line, x, y, role: 'stub', size: 7, color: TOKENS.stub, depth: 1, labelPosition })
        edges.push({ id: `e:${r.assertion_id}`, source: focus.id, target: id, style: 'unresolved', depth: 1, color: TOKENS.unresolved, size: 1.5, assertionId: r.assertion_id })
        return
      }
      const otherId = r.other.id
      if (!seen.has(otherId)) {
        seen.add(otherId)
        const external = r.other.kind === 'external'
        nodes.push({
          id: otherId, label: external ? r.other.name! : glyph(r.other.symbol_kind) + r.other.name!, qualifiedName: external ? `${r.other.module}:${r.other.name}` : r.other.qualified_name!,
          path: r.other.path ?? r.other.module ?? '', line: r.other.start_line ?? 0, x, y, role: external ? 'external' : direction === 'in' ? 'caller' : 'callee', size: 10, color: external ? TOKENS.resolved_external : TOKENS.path, depth: 1, labelPosition,
        })
      }
      // A caller whose call only might reach the focus (candidate or ambiguous) draws thin and in the unresolved colour, and says which.
      const settled = r.resolution === 'resolved' || r.resolution === 'resolved_external'
      const style: SceneEdge['style'] = !settled ? r.resolution as SceneEdge['style'] : framework ? 'framework' : r.resolution === 'resolved_external' ? 'resolved_external' : 'resolved'
      edges.push({
        id: `e:${r.assertion_id}`, source: direction === 'in' ? otherId : focus.id, target: direction === 'in' ? focus.id : otherId, style, depth: 1,
        color: !settled ? TOKENS.unresolved : framework ? TOKENS.framework : style === 'resolved_external' ? TOKENS.resolved_external : TOKENS.resolved, size: settled ? 3 : 1.5, assertionId: r.assertion_id, label: words.length ? words.join(' · ') : undefined,
      })
    })
  }
  const { totals } = env.data
  const notDrawn = totals.in + totals.out - rels.length + hidden
  const badges = notDrawn > 0 ? [{ nodeId: focus.id, text: `+${plural(notDrawn, 'relationship')} not drawn` }] : []
  const unresolved = sides.out.filter((r) => r.resolution === 'unresolved').length
  const conclusion = `${focus.name}: ${totals.in} incoming, ${totals.out - unresolved} outgoing${unresolved ? `, ${unresolved} unresolved` : ''}${notDrawn > 0 ? `; ${notDrawn} not drawn, the table lists what was returned` : ''}. Click a node to explore from it.`
  return { nodes, edges, badges, stubs, conclusion }
}
