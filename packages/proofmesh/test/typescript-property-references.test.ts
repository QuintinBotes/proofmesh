import { describe, expect, it } from 'vitest'
import { indexedRepo, symbolId, tool } from './helpers.js'

type Row = { other: { qualified_name: string }; site: { start_line: number }; evidence_ids: string[]; detail: { use: string; access: string } }

describe('FR1020 FR1021 a read or a write of a class property is a reference, with its access, citing every site', () => {
  it('FR1020 FR1021 b.value read twice is one references row from read, access read, citing both sites; b.value = 2 is one row, access write', async () => {
    const { dataDir } = await indexedRepo({ 'a.ts': 'export class Box { value = 1 }\nexport function read(b: Box) { return b.value + b.value }\nexport function write(b: Box) { b.value = 2 }\n' })
    const rows = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'a:Box.value'), direction: 'in', types: ['references'] }).data.relationships as Row[]
    expect(rows.map((x) => `${x.other.qualified_name} ${x.site.start_line} ${x.detail.use} ${x.detail.access} sites=${new Set(x.evidence_ids).size}`).sort()).toEqual(['a:read 2 value read sites=2', 'a:write 3 value write sites=1'])
  }, 120000)

  it('FR1020 FR1021 an interface property and a constructor parameter property are property symbols; this.x++ is a write, a parameter\'s bare name is no reference', async () => {
    const { dataDir } = await indexedRepo({ 'a.ts': 'export interface Named { name: string }\nexport class Counter {\n  constructor(private count: number) { console.log(count) }\n  bump(n: Named) { this.count++; return n.name }\n}\n' })
    const rows = (subject: string) => (tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, subject), direction: 'in', types: ['references'] }).data.relationships as Row[])
      .map((x) => `${x.other.qualified_name} ${x.site.start_line} ${x.detail.access}`)
    expect(rows('a:Named.name')).toEqual(['a:Counter.bump 4 read'])
    expect(rows('a:Counter.count')).toEqual(['a:Counter.bump 4 write'])
  }, 120000)
})

describe('FR1860 a property\'s declared type and decorators are used by its class, its initializer by the property', () => {
  it('FR1860 two properties typed Doc are one user, the class; a decorator is the class\'s call; a parameter property\'s type is the class\'s, as any constructor parameter\'s; an initializer is the property\'s', async () => {
    const { dataDir } = await indexedRepo({ 'a.ts': 'export class Doc {}\nexport function tag() { return (..._: unknown[]) => {} }\nexport class Holder {\n  a: Doc\n  @tag() b: Doc\n  c = new Doc()\n  constructor(private d: Doc) {}\n}\n' })
    const users = (subject: string, type: string) => (tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, subject), direction: 'in', types: [type] }).data.relationships as Row[])
      .map((x) => `${x.other.qualified_name} ${x.site.start_line} sites=${new Set(x.evidence_ids).size}`).sort()
    expect(users('a:Doc', 'references')).toEqual(['a:Holder 4 sites=3', 'a:Holder.c 6 sites=1'])
    expect(users('a:tag', 'calls')).toEqual(['a:Holder 5 sites=1'])
  }, 120000)
})
