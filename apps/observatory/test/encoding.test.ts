import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { toNeighbourhood, type Focus, type Relationship, type RelationshipsEnvelope } from '../src/explore'
import { toScene, type Scene, type TraceEnvelope } from '../src/scene'

const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'schemas', 'tools', 'get_relationships.data.schema.json'), 'utf8'))
const item = schema.properties.relationships.items.properties
const RESOLUTIONS = ['resolved', 'resolved_external', 'candidate', 'ambiguous', 'unresolved']
const ORIGINS = ['syntax', 'semantic_resolver', 'configuration_adapter', 'framework_adapter', 'contract_match', 'runtime_observation', 'documentation', 'human_assertion', 'model_hypothesis']

/** What a person who cannot tell colours apart still sees of a relationship: the line's width and words, and the label and size of what it ends at. */
function seen(scene: Scene, assertionId: string, from: string) {
  const e = scene.edges.find((x) => x.assertionId === assertionId || x.id === `e:${assertionId}`)!
  const end = scene.nodes.find((n) => n.id === (e.source === from ? e.target : e.source))!
  return { width: e.size, words: e.label ?? null, end: end.label, endSize: end.size }
}

const focus: Focus = { id: 'sym_f', kind: 'function', name: 'Focus', qualified_name: 'a:Focus', path: 'a.ts', start_line: 1 }
function neighbourhood(r: Partial<Relationship>) {
  const rel = { assertion_id: 'as_1', type: 'calls', direction: 'out', resolution: 'resolved', origin: 'semantic_resolver', site: { path: 'a.ts', start_line: 3 }, reason: null, detail: null, other: { kind: 'symbol', symbol_kind: 'function', id: 'sym_o', name: 'Other', qualified_name: 'b:Other', path: 'b.ts', start_line: 1 }, ...r } as Relationship
  const env = { data: { relationships: [rel], boundaries: [], totals: { in: rel.direction === 'in' ? 1 : 0, out: rel.direction === 'out' ? 1 : 0 } }, completion: { truncated: false } } as RelationshipsEnvelope
  return seen(toNeighbourhood(env, focus), 'as_1', focus.id)
}

describe('FR057 neighbourhoods and traced paths tell resolution status and origin apart without relying on colour', () => {
  it('FR057 the statuses and origins drawn are the ones the get_relationships contract defines', () => {
    expect(item.resolution.enum).toEqual(RESOLUTIONS)
    expect(item.origin.enum).toEqual(ORIGINS)
  })

  it('FR057 Explore: every resolution status of an outgoing relationship draws differently with colour ignored, and names itself', () => {
    const none = { kind: 'none' } as Relationship['other']
    const drawn = {
      resolved: neighbourhood({}),
      resolved_external: neighbourhood({ resolution: 'resolved_external', other: { kind: 'external', id: 'ext_o', name: 'Other', module: 'lib' } }),
      candidate: neighbourhood({ resolution: 'candidate', other: none }),
      ambiguous: neighbourhood({ resolution: 'ambiguous', other: none }),
      unresolved: neighbourhood({ resolution: 'unresolved', other: none, reason: 'unknown_name' }),
    }
    expect(drawn).toEqual({
      resolved: { width: 3, words: null, end: 'Other', endSize: 10 },
      resolved_external: { width: 3, words: 'external', end: 'Other', endSize: 10 },
      candidate: { width: 1.5, words: null, end: 'candidate · line 3', endSize: 7 },
      ambiguous: { width: 1.5, words: null, end: 'ambiguous · line 3', endSize: 7 },
      unresolved: { width: 1.5, words: null, end: 'unknown_name · line 3', endSize: 7 },
    })
  })

  it('FR057 Explore: a caller whose call is only a candidate or ambiguous draws thin and says so, unlike a resolved caller', () => {
    const caller = { kind: 'symbol', symbol_kind: 'function', id: 'sym_c', name: 'Caller', qualified_name: 'c:Caller', path: 'c.ts', start_line: 1 }
    expect(['resolved', 'candidate', 'ambiguous'].map((resolution) => neighbourhood({ direction: 'in', resolution, other: caller }))).toEqual([
      { width: 3, words: null, end: 'Caller', endSize: 10 },
      { width: 1.5, words: 'candidate', end: 'Caller', endSize: 10 },
      { width: 1.5, words: 'ambiguous', end: 'Caller', endSize: 10 },
    ])
  })

  it('FR057 Explore: every origin of a resolved call draws differently with colour ignored, by the words on its line', () => {
    const words = ORIGINS.map((origin) => neighbourhood({ origin, detail: origin === 'framework_adapter' ? { rule: 'di' } : null }).words)
    expect(Object.fromEntries(ORIGINS.map((o, i) => [o, words[i]]))).toEqual({
      syntax: 'syntax only', semantic_resolver: null, configuration_adapter: 'configuration', framework_adapter: 'calls · di', contract_match: 'contract match',
      runtime_observation: 'observed at runtime', documentation: 'documentation', human_assertion: 'asserted by a person', model_hypothesis: 'model hypothesis',
    })
    expect(new Set(words).size).toBe(ORIGINS.length)
  })

  it('FR057 Trace: each hop of a path names its origin, explored edges keep theirs, and path, explored and unresolved draw differently with colour ignored', () => {
    const hops = ORIGINS.map((origin, i) => ({ from: `sym_${i}`, to: `sym_${i + 1}`, assertion: `as_${i}`, origin }))
    const nodes = Object.fromEntries([...hops.map((h) => h.from), 'sym_9', 'sym_x'].map((id) => [id, { kind: 'function', name: id, qualified_name: `q:${id}`, path: 'p.ts', start_line: 1 }]))
    const env = {
      data: {
        conclusion: 'path_found', paths: [{ nodes: [...hops.map((h) => h.from), 'sym_9'], assertions: hops.map((h) => h.assertion) }],
        search: { levels: [{ depth: 1 }], stopped_by: null, horizon: [], explored: [{ from: 'sym_0', to: 'sym_x', assertion_id: 'as_x', depth: 1 }] },
        boundaries: [{ assertion_id: 'as_b', reason: 'unknown_name', path: 'p.ts', line: 7, from_id: 'sym_0' }],
        nodes,
        relationships: { ...Object.fromEntries(hops.map((h) => [h.assertion, { type: 'calls', origin: h.origin, rule: h.origin === 'framework_adapter' ? 'di' : null }])), as_x: { type: 'maps_to', origin: 'framework_adapter', rule: 'dbset_convention' } },
      },
      limits: { applied: { max_depth: 12 } },
    } as TraceEnvelope
    const scene = toScene(env, 'sym_0', 'sym_9')
    expect(hops.map((h) => scene.edges.find((e) => e.assertionId === h.assertion)!.label ?? null)).toEqual([
      'syntax only', null, 'configuration', 'calls · di', 'contract match', 'observed at runtime', 'documentation', 'asserted by a person', 'model hypothesis',
    ])
    const path = seen(scene, 'as_1', 'sym_1'), explored = seen(scene, 'as_x', 'sym_0'), stub = seen(scene, 'stub:as_b', 'sym_0')
    expect([path.width, path.words, explored.width, explored.words]).toEqual([4, null, 2, 'maps_to · dbset_convention'])
    expect(stub).toEqual({ width: 1.5, words: null, end: 'unknown_name · line 7', endSize: 7 })
  })
})
