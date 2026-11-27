import { describe, expect, it } from 'vitest'
import { indexedRepo, withSnapshot } from './helpers.js'

describe('FR650 FR651 every call of a chain is its own calls row', () => {
  it('FR650 FR651 (0..3).map(..).collect() in Rust gives map and collect, b().C().D() in Go gives b, C and D, and a TypeScript chain gives one row per call, each with one evidence row', async () => {
    const { dataDir } = await indexedRepo({
      'rust/main.rs': 'fn main() {\n    let v: Vec<u8> = (0..3).map(|x| x as u8).collect();\n}\n',
      'go/main.go': 'package main\n\nfunc main() { b().C().D() }\n',
      'ts/main.ts': 'declare const x: any\nexport function main(xs: number[]) {\n  x.a().b()\n  return xs.map((n) => n + 1).filter(Boolean).join(",")\n}\n',
    })
    // One row per assertion: the callee (or the target), its line and how many evidence rows it has.
    const calls = withSnapshot(dataDir, (db) => db.prepare(`select f.path, coalesce(json_extract(a.detail, '$.callee'), x.name, a.reason) callee, min(e.start_line) line, count(*) evidence
      from assertion a join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id left join external_symbol x on x.id = a.target_id
      where a.type = 'calls' group by a.id order by f.path, callee`).all() as Array<{ path: string; callee: string; line: number; evidence: number }>)
    const by = (file: string) => calls.filter((r) => r.path === file).map((r) => [r.callee, r.line, r.evidence])
    expect({ rust: by('rust/main.rs'), go: by('go/main.go'), ts: by('ts/main.ts') }).toEqual({
      rust: [['collect', 2, 1], ['map', 2, 1]],
      go: [['C', 3, 1], ['D', 3, 1], ['b', 3, 1]],
      ts: [['Array.filter', 4, 1], ['Array.join', 4, 1], ['Array.map', 4, 1], ['a', 3, 1], ['b', 3, 1]],
    })
    // The key is part of snapshot identity, so a snapshot keyed by the start byte alone is not reused.
    expect(withSnapshot(dataDir, (db) => JSON.parse((db.prepare("select value from meta where key = 'identity'").get() as { value: string }).value).site_key)).toBe('span')
  })
})
