import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { indexedRepo, ROOT, tmpDir, withSnapshot } from './helpers.js'

const source = `export interface Dep {}
export declare class Shell {
  field: Dep
  method(value: Dep): Dep
}
export type Alias = Dep
export class Ready {
  value: Dep = {} as Dep
}
export function parse(v: Dep): Dep
export function parse(v: string): Dep
export function parse(v: unknown): unknown { return v }
export declare function take(v: Dep): Dep
export declare function take(v: string): Dep
export const typed: Dep = {}
take({} as Dep)
export interface Hooks { notify?: (input: Dep) => Dep }
`
const expected = ['3:Shell', '4:Shell.method', '6:Alias', '8:Ready', '8:Ready.value', '10:parse', '11:parse',
  '13:take', '14:take', '15:typed', '16:<module>', '17:Hooks.notify'].sort()

describe('FR3007 TypeScript source ownership for distinct-user counts', () => {
  let repo: string, dataDir: string
  beforeAll(async () => {
    ;({ repo, dataDir } = await indexedRepo({ 'tsconfig.json': '{"include":["a.ts"]}', 'a.ts': source }))
  }, 120000)

  it('the adapter cites each reference site with its declaration or file and shares one symbol per overload set', () => {
    withSnapshot(dataDir, db => {
      const rows = db.prepare(`select e.start_line as line, s.kind, s.qualified_name as owner from assertion a
        join symbol s on s.id = a.source_id join symbol d on d.id = a.target_id
        join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id
        where a.type = 'references' and d.qualified_name = 'a:Dep'`).all() as { line: number; kind: string; owner: string }[]
      expect([...new Set(rows.map(r => r.line + ':' + (r.kind === 'module' ? '<module>' : r.owner.slice(2))))].sort()).toEqual(expected)
      expect(rows.filter(r => r.line === 10)).toHaveLength(2)
      expect(db.prepare("select name, start_line from symbol where kind = 'function' order by name").all()).toEqual([
        { name: 'parse', start_line: 12 }, { name: 'take', start_line: 13 },
      ])
    })
  })

  it('the independent compiler oracle attributes the same sites and retains duplicate occurrences', () => {
    const out = path.join(tmpDir(), 'truth.json')
    execFileSync(process.execPath, [path.join(ROOT, 'bench/graph-bench/truth.mjs'), repo, out])
    const result = JSON.parse(fs.readFileSync(out, 'utf8')) as {
      symbols: { id: string; qname: string }[]; refs: { from: string; to: string; line: number }[]
    }
    const names = new Map(result.symbols.map(s => [s.id, s.qname]))
    const refs = result.refs.filter(r => names.get(r.to) === 'Dep')
    expect([...new Set(refs.map(r => r.line + ':' + names.get(r.from)))].sort()).toEqual(expected)
    expect(refs.filter(r => r.line === 10)).toHaveLength(2)
    for (const name of ['parse', 'take']) expect(result.symbols.filter(s => s.qname === name)).toHaveLength(1)
  })
})
