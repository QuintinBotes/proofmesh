import { describe, expect, it } from 'vitest'
import { cli, fixtureRepo, tmpDir, withSnapshot } from './helpers.js'

const keys = (d: string) => withSnapshot(d, (db) => db.prepare('select kind, stable_key as key from symbol order by stable_key').all() as Array<{ kind: string; key: string }>)
const index = (env: Record<string, string>) => {
  const repo = fixtureRepo('cs-orders'), d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) { const r = cli(['--data-dir', d, ...args], env); expect(r.status, r.stderr).toBe(0) }
  return d
}

describe('FR316 the syntax tier names a C# declaration as Roslyn does (runs under pnpm test:csharp in Docker, where the .NET SDK is)', () => {
  it('FR316 scenario 2: every declaration the syntax tier found has the same key under the C# adapter, and Roslyn adds only the projects', () => {
    const syntax = keys(index({ PROOFMESH_CS_ADAPTER: '/nonexistent/Proofmesh.Adapter.CSharp.dll' }))
    const precise = keys(index({}))
    expect(syntax.length).toBeGreaterThan(0)
    const preciseKeys = new Set(precise.map((s) => s.key))
    expect(syntax.filter((s) => !preciseKeys.has(s.key))).toEqual([])
    const syntaxKeys = new Set(syntax.map((s) => s.key))
    expect(precise.filter((s) => !syntaxKeys.has(s.key)).map((s) => s.kind)).toEqual(['project', 'project'])
  }, 240000)
})
