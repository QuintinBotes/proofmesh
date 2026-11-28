import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, expect, it } from 'vitest'
import { ROOT } from './helpers.js'

const q = { target: { file: 'src/Driver.ts', qname: 'Driver.escape' } }
let callers: (tool: string, question: typeof q, call: (name: string, args: any) => Promise<unknown>, project?: string) => Promise<any>
beforeAll(async () => {
  callers = (await import(pathToFileURL(path.join(ROOT, 'bench/parity/agents/callers.mjs')).href)).directCallers
})

it('FR3005 Gortex must resolve the target in the declared file and return a call edge to that symbol', async () => {
  const target = { file_path: q.target.file, name: 'escape', id: 'repo/src/Driver.ts::Driver.escape' }
  const from = { file_path: 'src/query.ts', name: 'build', id: 'caller', start_line: 3 }
  const call = async (name: string, args: any) => {
    if (name === 'search') return { results: [{ ...target, file_path: 'src/Other.ts' }, target] }
    expect(args.target.symbol).toBe(target.id)
    return { nodes: [target, from], edges: [
      { from: from.id, to: target.id, kind: 'calls', line: 9, file_path: from.file_path },
      { from: from.id, to: 'unrelated', kind: 'calls', line: 10, file_path: from.file_path },
    ], truncated: true }
  }
  expect(await callers('gortex', q, call)).toEqual({ status: 'answered', truncated: true, facts: [{ file: from.file_path, caller: 'build', site: 'src/query.ts:9' }] })
  expect((await callers('gortex', q, async () => ({ results: [] }))).status).toBe('target_missing')
})

it('FR3005 records GitNexus caller evidence without inventing a call-site line', async () => {
  let n = 0
  const call = async () => ++n === 1 ? { row_count: 1, markdown: '| identity |\n| --- |\n| method |' }
    : { row_count: 1, markdown: '| file | caller |\n| --- | --- |\n| src/query.ts | build |' }
  expect(await callers('gitnexus', q, call)).toMatchObject({
    status: 'answered', facts: [{ file: 'src/query.ts', caller: 'build', site: null }], site_limitation: expect.any(String),
  })
})

it('FR3005 distinguishes a missing declaration from a returned empty caller set', async () => {
  expect(await callers('codebase-memory-mcp', q, async () => ({ rows: [] }))).toMatchObject({ status: 'target_missing' })
  let n = 0
  expect(await callers('codebase-memory-mcp', q, async () => ++n === 1 ? { rows: [['method']] } : { rows: [] })).toMatchObject({ status: 'answered', facts: [] })
})

const relationships = async () => (await import(pathToFileURL(path.join(ROOT, 'bench/parity/agents/relations.mjs')).href)).relatedItems

it('FR3005 counts files that use a type outside its own declaration and an import clause', async () => {
  const query = { kind: 'type_users', target: { file: 'src/T.ts', qname: 'T' } }
  const call = async (tool: string) => tool === 'search' ? { results: [{ id: 'src/T.ts::T', name: 'T', file_path: 'src/T.ts' }] } : {
    groups: [
      { file: 'src/T.ts', uses: [{ context: 'field' }] },
      { file: 'src/barrel.ts', uses: [{ context: 'import' }] },
      { file: 'src/use.ts', uses: [{ context: 'import' }, { context: 'parameter_type' }] },
    ], file_count: 3, _truncated_by_budget: true,
  }
  expect(await (await relationships())('gortex', query, call)).toEqual({ status: 'answered', items: ['src/use.ts'], truncated: true })
})

it('FR3005 walks native caller identities to the requested depth and excludes a cycle back to the target', async () => {
  const responses = [
    [['target']],
    [['src/a.ts', 'get', 'a'], ['src/b.ts', 'get', 'b']],
    [['src/c.ts', 'outer', 'c'], ['src/t.ts', 'start', 'target']],
  ]
  const statements: string[] = []
  const call = async (_tool: string, args: { query: string }) => {
    statements.push(args.query)
    return { rows: responses.shift() }
  }
  const query = { kind: 'transitive_callers', depth: 2, target: { file: 'src/t.ts', qname: 'start' } }
  expect(await (await relationships())('codebase-memory-mcp', query, call, 'repo')).toEqual({
    status: 'answered', items: ['src/a.ts::get', 'src/b.ts::get', 'src/c.ts::outer'], truncated: false,
  })
  expect(statements).toHaveLength(3)
  expect(statements[2]).toContain("b.qualified_name = 'a' OR b.qualified_name = 'b'")
})

it('FR3005 counts direct import edges to the requested file even when the tool includes unrelated edges', async () => {
  const file = 'src/T.ts', other = 'src/user.ts'
  const query = { kind: 'importers', target: { file } }
  const call = async () => ({
    nodes: [file, other].map(id => ({ id, file_path: id })), edges: [
      { kind: 'imports', from: other, to: file }, { kind: 'references', from: 'not-an-import', to: file },
      { kind: 'imports', from: 'not-direct', to: other },
    ],
  })
  expect(await (await relationships())('gortex', query, call)).toEqual({ status: 'answered', items: [other], truncated: false })
})
