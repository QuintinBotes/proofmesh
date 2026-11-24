import fs from 'node:fs'
import path from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { defaultSelection, evidenceFor, LINK_WORDS, pairs, RELATION_COLOURS, relations, toEcosystem, type Ecosystem } from '../src/ecosystem'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const envelope = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'ecosystem.json'), 'utf8'))
const data = envelope.data as Ecosystem

describe('A11 the ecosystem overview: a workspace as repositories and the links between them', () => {
  it('the recorded envelope is valid against the get_ecosystem data contract', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'tools', 'get_ecosystem.data.schema.json'), 'utf8'))
    const validate = new Ajv2020({ strict: false }).compile(schema)
    expect(validate(data), JSON.stringify(validate.errors)).toBe(true)
  })

  it('draws one node per member, sized by symbols, and folds every link type of a pair into one edge', () => {
    const scene = toEcosystem(data)
    expect(scene.nodes.filter((n) => n.role === 'area').map((n) => n.label)).toEqual(['contracts · 60 · newer snapshot exists', 'orders-api · 980', 'storefront · 420'])
    const [contracts, orders, store] = scene.nodes
    expect(orders!.size).toBeGreaterThan(store!.size)
    expect(store!.size).toBeGreaterThan(contracts!.size)
    expect(scene.edges.filter((e) => e.style !== 'unresolved' || !e.target.startsWith('stub:')).map((e) => [e.source, e.target, e.style, e.label])).toEqual([
      ['repo_aaaaaaaaaaaaaaaaaaaaaaaa', 'repo_bbbbbbbbbbbbbbbbbbbbbbbb', 'aggregate', '4 resolved, 1 candidate'],
      ['repo_bbbbbbbbbbbbbbbbbbbbbbbb', 'repo_cccccccccccccccccccccccc', 'unresolved', '2 candidate'],
    ])
    expect(pairs(data).map((p) => p.types)).toEqual([['calls_endpoint', 'messages'], ['depends_on_package']])
  })

  it('a boundary is a stub leaving its member, counted, and the conclusion counts everything', () => {
    const scene = toEcosystem(data)
    expect(scene.stubs).toEqual([{ id: 'stub:repo_aaaaaaaaaaaaaaaaaaaaaaaa:calls_endpoint', fromId: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa', reason: 'calls_endpoint', line: 0 }])
    expect(scene.nodes.find((n) => n.role === 'stub')!.label).toBe('2 unresolved · calls_endpoint')
    expect(scene.conclusion).toBe('shop: 3 repositories, 2 linked pairs, 2 unresolved boundaries; 1 linked from a snapshot that is no longer current. Click a repository to see its links and open only it.')
  })

  it('the layout is deterministic', () => {
    expect(toEcosystem(data).nodes.map((n) => [n.x, n.y])).toEqual(toEcosystem(data).nodes.map((n) => [n.x, n.y]))
  })

  it('A11 nodes are coloured by their relation to the selected repository, by default the one with the most linked partners', () => {
    const [A, B, C] = ['repo_aaaaaaaaaaaaaaaaaaaaaaaa', 'repo_bbbbbbbbbbbbbbbbbbbbbbbb', 'repo_cccccccccccccccccccccccc']
    expect(defaultSelection(data)).toBe(B)
    expect(Object.fromEntries(relations(data, B))).toEqual({ [A]: 'links_to', [B]: 'selected', [C]: 'linked_from' })
    expect(Object.fromEntries(relations(data, A))).toEqual({ [A]: 'selected', [B]: 'linked_from', [C]: 'indirect' })
    const colour = (sel: string) => Object.fromEntries(toEcosystem(data, sel).nodes.filter((n) => n.role === 'area').map((n) => [n.id, n.color]))
    expect(colour(B)).toEqual({ [A]: RELATION_COLOURS.links_to, [B]: RELATION_COLOURS.selected, [C]: RELATION_COLOURS.linked_from })
    expect(colour(A)[C]).toBe(RELATION_COLOURS.indirect)
    const both: Ecosystem = { ...data, links: [...data.links, { ...data.links[0]!, source_repository_id: B, target_repository_id: A }] }
    expect(relations(both, B).get(A)).toBe('both')
  })

  it('A11 selecting a repository shows its evidence: links each way with their samples, and its boundaries', () => {
    const ev = evidenceFor(data, 'repo_aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(ev.name).toBe('storefront')
    expect(ev.outgoing.map((l) => [l.other, l.type, l.resolved, l.candidate, l.sample.length > 0])).toEqual([['orders-api', 'calls_endpoint', 3, 1, true], ['orders-api', 'messages', 1, 0, true]])
    expect(ev.incoming).toEqual([])
    expect(ev.boundaries.map((b) => [b.type, b.count])).toEqual([['calls_endpoint', 2]])
  })

  it('A11 B19 repositories with no links, or sharing one relation, never collapse onto one point', () => {
    const member = (i: number) => ({ ...data.members[1]!, repository_id: `repo_${String(i).padStart(24, '0')}`, name: `r${i}` })
    // The closest pair as a share of the widest: the view fits the layout to the screen, and node sizes are in screen pixels.
    const apart = (e: Ecosystem) => {
      const ns = toEcosystem(e).nodes.filter((n) => n.role === 'area'), d: number[] = []
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) d.push(Math.hypot(ns[i]!.x - ns[j]!.x, ns[i]!.y - ns[j]!.y))
      return Math.min(...d) / Math.max(...d)
    }
    const lonely: Ecosystem = { ...data, members: Array.from({ length: 8 }, (_, i) => member(i)), links: [], boundaries: [] }
    expect(apart(lonely)).toBeGreaterThan(0.2)
    const hub = member(0).repository_id
    const star: Ecosystem = { ...lonely, links: lonely.members.slice(1).map((m) => ({ ...data.links[0]!, source_repository_id: m.repository_id, target_repository_id: hub })) }
    expect(new Set([...relations(star, hub).values()])).toEqual(new Set(['selected', 'links_to']))
    expect(apart(star)).toBeGreaterThan(0.2)
  })

  it('A8 A35 every link type the get_ecosystem contract names has words, the cloud link types among them', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'tools', 'get_ecosystem.data.schema.json'), 'utf8'))
    const types = schema.properties.links.items.properties.type.enum as string[]
    expect(Object.keys(LINK_WORDS).sort()).toEqual([...types].sort())
    expect([LINK_WORDS.deploys, LINK_WORDS.uses_resource]).toEqual(['deploys', 'uses the cloud resource'])
  })
})
