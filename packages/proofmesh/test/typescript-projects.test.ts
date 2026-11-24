import { describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, withSnapshot } from './helpers.js'

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
