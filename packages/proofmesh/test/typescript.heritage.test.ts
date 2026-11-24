import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { expectedFor, fixtureRepo, indexedDataDir, symbolId, tmpDir, tool } from './helpers.js'

const EXPECTED = expectedFor('ts-heritage')
type Query = { subject: string; type: string; rows: string[] }
type Row = { type: string; resolution: string; other: { qualified_name: string }; site: { path: string; start_line: number }; via?: { qualified_name: string } }
const short = (qualified: string) => qualified.slice(qualified.indexOf(':') + 1)
const byPathThenLine = (a: Row, b: Row) => (a.site.path < b.site.path ? -1 : a.site.path > b.site.path ? 1 : a.site.start_line - b.site.start_line)
const query = (type: string) => (EXPECTED.relationships as Query[]).filter((q) => q.type === type)

describe('FR083 FR084 FR085 FR086 FR087 FR088 TypeScript heritage, references and dispatch (fixtures/ts-heritage)', () => {
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('ts-heritage')))
  }, 120000)
  /** The inbound rows of one type, ordered by path then line, written `name path:line`, with `via <member>` on a dispatch row. */
  const inbound = (q: Query) => {
    const r = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, q.subject), direction: 'in', types: [q.type] })
    return (r.data.relationships as Row[]).sort(byPathThenLine).map((x) => {
      expect(x.type).toBe(q.type)
      expect(x.resolution).toBe('resolved')
      return `${short(x.other.qualified_name)} ${x.site.path}:${x.site.start_line}${x.via ? ` via ${short(x.via.qualified_name)}` : ''}`
    })
  }

  it('FR083 interface members are method symbols named like class members', () => {
    const r = tool(dataDir, 'find_symbols', EXPECTED.find_symbols.input)
    const rows = (r.data.symbols as Array<{ qualified_name: string; path: string; start_line: number; kind: string }>).map((s) => `${short(s.qualified_name)} ${s.path}:${s.start_line} ${s.kind}`)
    expect(rows).toEqual(EXPECTED.find_symbols.rows)
  })

  it('FR084 a call through a value typed as an interface resolves to the interface member', () => {
    for (const q of query('calls').filter((x) => x.subject === 'src/shape:Shape.area')) expect(inbound(q)).toEqual(q.rows)
  })

  it('FR085 implements and inherits come from heritage clauses, each cited at its clause', () => {
    for (const q of [...query('implements'), ...query('inherits')]) expect([q.subject, q.type, inbound(q)]).toEqual([q.subject, q.type, q.rows])
  })

  it('FR086 every non-declaration use of a type is a reference at its line; import lines are not', () => {
    for (const q of query('references')) expect(inbound(q)).toEqual(q.rows)
  })

  it('FR087 callers of a concrete member include the calls that reach it by dispatch, marked via; an abstract member is no dispatch target', () => {
    for (const q of query('calls').filter((x) => x.subject !== 'src/shape:Shape.area')) expect([q.subject, inbound(q)]).toEqual([q.subject, q.rows])
    const r = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'src/circle:Circle.area'), direction: 'in' })
    expect(r.limitations.join(' ')).toMatch(/implements or overrides/)
  })

  it('FR088 analyze_impact and trace_paths follow dispatch', () => {
    const { subject, types, max_depth, dependents } = EXPECTED.impact
    const impact = tool(dataDir, 'analyze_impact', { subject_ids: [symbolId(dataDir, subject)], types, limits: { max_depth } })
    expect((impact.data.dependents as Array<{ qualified_name: string }>).map((d) => short(d.qualified_name)).sort()).toEqual(dependents)
    const { source, target, nodes } = EXPECTED.trace
    const trace = tool(dataDir, 'trace_paths', { source_id: symbolId(dataDir, source), target_id: symbolId(dataDir, target) })
    const name = (id: string) => short((tool(dataDir, 'get_symbol', { symbol_id: id }).data.symbol as { qualified_name: string }).qualified_name)
    expect((trace.data.paths as Array<{ nodes: string[] }>)[0]!.nodes.map(name)).toEqual(nodes)
  })
})

describe('FR083 FR084 FR085 FR086 FR087 TypeScript heritage edge cases (fixtures/ts-heritage plus src/edges.ts and src/members.ts)', () => {
  let dataDir: string
  beforeAll(async () => {
    const repo = tmpDir('pm-heritage-')
    fs.cpSync(fixtureRepo('ts-heritage'), repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'src', 'edges.ts'), EDGES)
    fs.writeFileSync(path.join(repo, 'src', 'members.ts'), MEMBERS)
    fs.writeFileSync(path.join(repo, 'src', 'plain.ts'), 'export default class Plain {}\n')
    ;({ dataDir } = await indexedDataDir(repo))
  }, 120000)
  const rows = (subject: string, type: string, direction = 'in') => (tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, subject), direction, types: [type] }).data.relationships as Row[])
    .sort(byPathThenLine).map((x) => direction === 'out' ? short(x.other.qualified_name) : `${short(x.other.qualified_name)} ${x.site.path}:${x.site.start_line}${x.via ? ` via ${short(x.via.qualified_name)}` : ''}`)

  it('FR083 an overloaded member is one symbol, at its implementation, which every overload resolves to', () => {
    const found = (tool(dataDir, 'find_symbols', { text: 'size', path_prefix: 'src/edges.ts' }).data.symbols as Array<{ qualified_name: string; start_line: number }>)
      .filter((s) => s.qualified_name.endsWith('.size')).map((s) => `${short(s.qualified_name)}:${s.start_line}`)
    expect(found).toEqual(['Box.size:22', 'Crate.size:30', 'Sized.size:4'])
    expect(rows('src/edges:Sized.size', 'calls')).toEqual(['measure src/edges.ts:35'])
  })

  it('FR085 a class implementing two interfaces, one merged from two declarations, has a row per declaration; a structural match has none', () => {
    expect(rows('src/edges:Box', 'implements', 'out').sort()).toEqual(['Shape', 'Sized', 'Sized'])
    expect(rows('src/edges:Free', 'implements', 'out')).toEqual([])
  })

  it('FR086 a re-export is not a reference', () => {
    expect(rows('src/shape:Shape', 'references').filter((r) => r.includes('src/edges.ts'))).toEqual(['unit src/edges.ts:10', 'Box src/edges.ts:16'])
  })

  it('FR087 dispatch reaches an override through this, an override of an interface member through its base, and a typed constant\'s literal member; not a structural match', () => {
    expect(rows('src/edges:Crate.size', 'calls')).toEqual(['Box.area src/edges.ts:18 via Box.size', 'measure src/edges.ts:35 via Sized.size'])
    expect(rows('src/edges:unit.area', 'calls')).toEqual(['report src/report.ts:3 via Shape.area', 'totalArea src/total.ts:3 via Shape.area'])
    expect(rows('src/edges:Free.area', 'calls')).toEqual([])
  })

  /** The symbol of a qualified name declared at a line, where a static and an instance member share the name. */
  const at = (qualified: string, line: number) => (tool(dataDir, 'find_symbols', { text: short(qualified).split('.').pop()!, path_prefix: 'src/members.ts' }).data.symbols as Array<{ id: string; qualified_name: string; start_line: number }>)
    .find((s) => s.qualified_name === qualified && s.start_line === line)?.id
  const callers = (id: string | undefined) => (id ? (tool(dataDir, 'get_relationships', { subject_id: id, direction: 'in', types: ['calls'] }).data.relationships as Row[]).sort(byPathThenLine).map((x) => `${short(x.other.qualified_name)} ${x.site.path}:${x.site.start_line}${x.via ? ` via ${short(x.via.qualified_name)}` : ''}`) : ['no symbol'])

  it('FR083 FR087 a static and an instance member of one name are two symbols, and a static member is no dispatch target', () => {
    expect(callers(at('src/members:Counter.next', 4))).toEqual(['viaStatic src/members.ts:17'])
    expect(callers(at('src/members:Counter.next', 7))).toEqual(['viaInstance src/members.ts:20'])
    expect(callers(at('src/members:Ticker.next', 12))).toEqual([])
  })

  it('FR084 FR087 a call through an abstract property holding a function resolves to that property, which is no dispatch target', () => {
    expect(rows('src/members:start', 'calls', 'out').sort()).toEqual(['Job.run', 'Runner.run'])
    expect(rows('src/members:Job.run', 'calls')).toEqual(['start src/members.ts:29'])
  })

  it('FR086 a type imported under another name, or as a renamed default, is referenced where that name is used', () => {
    expect(rows('src/shape:Shape', 'references').filter((r) => r.includes('src/members.ts'))).toEqual(['start src/members.ts:28'])
    expect(rows('src/plain:Plain', 'references')).toEqual(['start src/members.ts:28'])
  })

  it('FR086 one reference per user and target, at its first site, with every use in detail.use; enums are symbols; a shorthand property is a value use', () => {
    const refs = (subject: string) => (tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, subject), direction: 'out', types: ['references'] }).data.relationships as Array<Row & { detail: { use: string } }>)
      .map((x) => `${short(x.other.qualified_name)} ${x.site.start_line} ${x.detail.use}`).sort()
    expect(refs('src/members:kindOf')).toEqual(['Kind 35 type,value'])
    expect(refs('src/members:start')).toEqual(['Job 28 type', 'Plain 28 type', 'Runner 28 type', 'Shape 28 type'])
    expect(refs('src/members:registry')).toEqual(['Counter 38 value'])
  })
})

const MEMBERS = `import type { Shape as Outline } from './shape'
import type Item from './plain'
export class Counter {
  static next(): number {
    return 1
  }
  next(): number {
    return 2
  }
}
export class Ticker extends Counter {
  static next(): number {
    return 3
  }
}
export function viaStatic(): number {
  return Counter.next()
}
export function viaInstance(): number {
  return new Ticker().next()
}
export interface Runner {
  run(): void
}
export abstract class Job implements Runner {
  abstract run: () => void
}
export function start(j: Job, r: Runner, o: Outline, p: Item): void {
  j.run()
  r.run()
}
export enum Kind {
  A,
}
export function kindOf(k: Kind): Kind {
  return k === Kind.A ? Kind.A : k
}
export const registry = { Counter }
`

const EDGES = `import type { Shape } from './shape'
export type { Shape } from './shape'
export interface Sized {
  size(): number
  size(scale: number): number
}
export interface Sized {
  label(): string
}
export const unit: Shape = { area: () => 1 }
export class Free {
  area(): number {
    return 0
  }
}
export class Box implements Shape, Sized {
  area(): number {
    return this.size()
  }
  size(): number
  size(scale: number): number
  size(scale = 1): number {
    return scale
  }
  label(): string {
    return 'box'
  }
}
export class Crate extends Box {
  size(scale = 2): number {
    return scale
  }
}
export function measure(s: Sized): number {
  return s.size(2)
}
`
