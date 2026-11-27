import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, indexedRepo, withSnapshot } from './helpers.js'

type Call = { line: number; resolution: string; to?: string; external?: unknown; reason?: string }

describe('M2 the TypeScript adapter analyses each file under the project configuration that owns it', () => {
  it('a package resolves its path alias and its own libraries, through a shared base configuration', async () => {
    const { dataDir } = await indexedDataDir(fixtureRepo('ts-monorepo'))
    const calls = withSnapshot(dataDir, (db) => {
      const render = (db.prepare("select id from symbol where qualified_name = 'packages/web/src/page:render'").get() as { id: string }).id
      const rows = db.prepare(`select a.resolution, a.reason, a.target_id, ev.start_line, ev.start_byte from assertion a join assertion_evidence ae on ae.assertion_id = a.id join evidence ev on ev.id = ae.evidence_id where a.type = 'calls' and a.source_id = ? order by ev.start_byte`).all(render) as Array<{ resolution: string; reason: string | null; target_id: string | null; start_line: number }>
      return rows.map((r) => {
        const c: Call = { line: r.start_line, resolution: r.resolution }
        if (r.resolution === 'resolved') c.to = (db.prepare('select qualified_name from symbol where id = ?').get(r.target_id) as { qualified_name: string }).qualified_name
        if (r.resolution === 'resolved_external') c.external = db.prepare('select module, name from external_symbol where id = ?').get(r.target_id)
        if (r.reason) c.reason = r.reason
        return c
      })
    })
    expect(calls).toEqual([
      { line: 4, resolution: 'resolved_external', external: { module: 'lib.dom.d.ts', name: 'Document.createElement' } },
      { line: 5, resolution: 'resolved_external', external: { module: 'lib.es5.d.ts', name: 'String' } },
      { line: 5, resolution: 'resolved', to: 'packages/core/src/money:cents' },
    ])
  }, 120000)
})

describe('FR810 a TypeScript file that starts with a UTF-8 byte order mark keeps its ranges on the bytes as stored', () => {
  it('FR810 byte order mark: the bytes of the captured a.ts at each symbol range are its declaration, and the module is the whole file', async () => {
    const file = "\uFEFFexport function hello() { return 'é' }\nexport class Box {\n  get value() { return 1 }\n}\n"
    const { repo, dataDir } = await indexedRepo({ 'a.ts': file })
    const bytes = fs.readFileSync(path.join(repo, 'a.ts'))
    const slices = withSnapshot(dataDir, (db) => (db.prepare("select s.qualified_name as name, s.start_byte as start, s.end_byte as end from symbol s join file f on f.id = s.file_id where f.path = 'a.ts' order by s.start_byte, s.qualified_name").all() as Array<{ name: string; start: number; end: number }>)
      .map((s) => [s.name, bytes.subarray(s.start, s.end).toString('utf8')]))
    expect(slices).toEqual([
      ['a', file],
      ['a:hello', "export function hello() { return 'é' }"],
      ['a:Box', 'export class Box {\n  get value() { return 1 }\n}'],
      ['a:Box.value', 'get value() { return 1 }'],
    ])
  }, 120000)
})
