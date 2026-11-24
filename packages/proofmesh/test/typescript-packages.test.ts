import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, tmpDir, withSnapshot } from './helpers.js'

/** A copy of fixtures/ts-packages, with greeter installed and the workspace package linked as npm workspaces link it. */
function repo(installed: boolean): string {
  const r = tmpDir('pm-tspkg-')
  fs.cpSync(fixtureRepo('ts-packages'), r, { recursive: true })
  if (installed) {
    fs.mkdirSync(path.join(r, 'node_modules/greeter'), { recursive: true })
    fs.writeFileSync(path.join(r, 'node_modules/greeter/package.json'), JSON.stringify({ name: 'greeter', version: '1.4.0', types: 'index.d.ts' }))
    fs.writeFileSync(path.join(r, 'node_modules/greeter/index.d.ts'), 'export declare function greet(name: string): string;\n')
    fs.mkdirSync(path.join(r, 'node_modules/@fx'), { recursive: true })
    fs.symlinkSync('../../packages/util', path.join(r, 'node_modules/@fx/util'))
  }
  return r
}

type Call = { line: number; resolution: string; to?: string; external?: unknown; reason?: string }
function facts(dataDir: string): { calls: Call[]; inputs: string[]; externals: unknown[] } {
  return withSnapshot(dataDir, (db) => {
    const run = (db.prepare("select id from symbol where qualified_name = 'src/main:run'").get() as { id: string }).id
    const rows = db.prepare(`select a.resolution, a.reason, a.target_id, ev.start_line from assertion a join assertion_evidence ae on ae.assertion_id = a.id join evidence ev on ev.id = ae.evidence_id where a.type = 'calls' and a.source_id = ? order by ev.start_line`).all(run) as Array<{ resolution: string; reason: string | null; target_id: string | null; start_line: number }>
    const calls = rows.map((r) => {
      const c: Call = { line: r.start_line, resolution: r.resolution }
      if (r.resolution === 'resolved') c.to = (db.prepare('select qualified_name from symbol where id = ?').get(r.target_id) as { qualified_name: string }).qualified_name
      if (r.resolution === 'resolved_external') c.external = db.prepare('select module, name from external_symbol where id = ?').get(r.target_id)
      if (r.reason) c.reason = r.reason
      return c
    })
    const adapters = JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value) as Array<{ id: string; external_inputs: string[] }>
    return { calls, inputs: adapters.find((a) => a.id === 'typescript')!.external_inputs, externals: db.prepare('select module, name from external_symbol order by module, name').all() }
  })
}

describe('A2 the TypeScript adapter reads installed packages as declared external inputs', () => {
  it('resolves into an installed package by package name, reaches a linked workspace package as source, and blames a missing one', async () => {
    const r = repo(true)
    const { dataDir } = await indexedDataDir(r)
    const { calls, inputs, externals } = facts(dataDir)
    expect(calls).toEqual([
      { line: 6, resolution: 'resolved_external', external: { module: 'greeter', name: 'greet' } },
      { line: 7, resolution: 'unresolved', reason: 'dependency_missing' },
      { line: 8, resolution: 'resolved', to: 'packages/util/src/index:shout' },
    ])
    expect(inputs).toEqual(['npm:absent-lib missing', 'npm:greeter/1.4.0'])
    // Names of external targets carry no machine path, so the same tree seals the same facts anywhere.
    expect(JSON.stringify(externals)).not.toMatch(/node_modules|\/private\/|\/tmp\/|staging/)
  }, 120000)

  it('without node_modules every declared package is missing, and calls into them say so', async () => {
    const { dataDir } = await indexedDataDir(repo(false))
    const { calls, inputs } = facts(dataDir)
    expect(calls).toEqual([
      { line: 6, resolution: 'unresolved', reason: 'dependency_missing' },
      { line: 7, resolution: 'unresolved', reason: 'dependency_missing' },
      { line: 8, resolution: 'unresolved', reason: 'dependency_missing' },
    ])
    expect(inputs).toEqual(['npm:@fx/util missing', 'npm:absent-lib missing', 'npm:greeter missing'])
  }, 120000)
})
