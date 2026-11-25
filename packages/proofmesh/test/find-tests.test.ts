import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, symbolId, tool } from './helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir(fixtureRepo('tests-reach'))) })

describe('include_tests false leaves test code out of symbol and relationship results', () => {
  it('find_symbols drops test files and honours path_prefix; get_relationships drops callers in test code', async () => {
    const { fixtureRepo, indexedDataDir, tool } = await import('./helpers.js')
    const { isTestPath } = await import('../src/query/tests.js')
    const { dataDir } = await indexedDataDir(fixtureRepo('tests-reach'))
    const all = (tool(dataDir, 'find_symbols', { text: 'e', limits: { max_rows: 1000 } }).data as any).symbols as Array<{ path: string; id: string }>
    expect(all.some((s) => isTestPath(s.path)), 'the fixture has test code').toBe(true)
    const production = (tool(dataDir, 'find_symbols', { text: 'e', include_tests: false, limits: { max_rows: 1000 } }).data as any).symbols as Array<{ path: string }>
    expect(production.length).toBeGreaterThan(0)
    expect(production.every((s) => !isTestPath(s.path))).toBe(true)
    expect(production.length).toBe(all.filter((s) => !isTestPath(s.path)).length)
    const dir = production[0]!.path.split('/').slice(0, -1).join('/') + '/'
    expect(((tool(dataDir, 'find_symbols', { text: 'e', path_prefix: dir, limits: { max_rows: 1000 } }).data as any).symbols as Array<{ path: string }>).every((s) => s.path.startsWith(dir))).toBe(true)
    const called = all.filter((s) => !isTestPath(s.path)).find((s) => ((tool(dataDir, 'get_relationships', { subject_id: s.id, direction: 'in' }).data as any).relationships as any[]).some((r) => isTestPath(r.other.path)))
    expect(called, 'a production symbol that a test calls').toBeDefined()
    const rows = (tool(dataDir, 'get_relationships', { subject_id: called!.id, direction: 'in', include_tests: false }).data as any).relationships as Array<{ other: { path: string } }>
    expect(rows.every((r) => !isTestPath(r.other.path))).toBe(true)
  }, 180000)
})

describe('FR019 find_tests: tests that statically reach code, with observed coverage kept apart', () => {
  it('FR024 finds the test two calls away and leaves the non-test caller out, with observed coverage reported apart', () => {
    const env = tool(d, 'find_tests', { subject_ids: [symbolId(d, 'src/core:core')] })
    expect((env.data as any).tests.map((t: any) => [t.qualified_name, t.depth])).toEqual([['test/service.test:serviceAddsOne', 2]])
    expect((env.data as any).observed).toEqual({ available: false, reason: 'No coverage data has been imported for this snapshot.' })
    expect(env.limitations).toContain('Test code is recognised by file convention and project naming, and by the roles an adapter gave each symbol (a test entry point, or code in a test-only scope).')
  })

  it('accepts a file and finds the tests of everything in it', () => {
    expect((tool(d, 'find_tests', { paths: ['src/service.ts'] }).data as any).tests.map((t: any) => [t.name, t.depth])).toEqual([['serviceAddsOne', 1]])
  })

  it('FR101 FR103 each row adds its evidence kind and chain: serviceAddsOne reaches core as transitive_call at depth 2', () => {
    const t = (tool(d, 'find_tests', { subject_ids: [symbolId(d, 'src/core:core')] }).data as any).tests
    expect(t.map((r: any) => [r.qualified_name, r.evidence, r.depth])).toEqual([['test/service.test:serviceAddsOne', 'transitive_call', 2]])
    expect(t[0].chain.map((h: any) => `${h.name} ${h.path}:${h.line}`)).toEqual(['serviceAddsOne test/service.test.ts:4', 'service src/service.ts:4', 'core src/core.ts:1'])
    expect((tool(d, 'find_tests', { paths: ['src/service.ts'] }).data as any).tests.map((r: any) => r.evidence)).toEqual(['call'])
  })

  it('a test itself has no tests reaching it', () => {
    expect((tool(d, 'find_tests', { subject_ids: [symbolId(d, 'test/service.test:serviceAddsOne')] }).data as any).totals.tests).toBe(0)
  })
})
