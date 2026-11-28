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

it('FR3005 includes a re-export, follows indirect imports, and distinguishes cycles from isolated roots', async () => {
  const target = 'src/T.ts', barrel = 'src/index.ts', app = 'src/app.ts', root = 'src/entry.ts'
  const ns = 'http://graphml.graphdrawing.org/xmlns'
  const files = [target, barrel, app, root]
  const nodes = files.map(f => `<node id="${f}"><data key="file_path">${f}</data></node>`)
  const edge = (a: string, b: string, kind: string) => `<edge source="${a}" target="${b}"><data key="edge_kind">${kind}</data></edge>`
  const xml = `<graphml xmlns="${ns}"><graph>${nodes.join('')}${edge(barrel, target, 're_exports')}${edge(app, barrel, 'imports')}${edge(target, app, 'imports')}${edge(root, target, 'calls')}</graph></graphml>`
  const query = await relationships()
  const ask = async (kind: string) => {
    const answer = await query('gortex', { kind, target: ['roots', 'cycles'].includes(kind) ? undefined : { file: target } }, async () => xml)
    return answer.items.sort()
  }
  expect(await ask('importers')).toEqual([barrel])
  expect(await ask('dependents')).toEqual([barrel, app].sort())
  expect(await ask('cycles')).toEqual([target, barrel, app].sort())
  expect(await ask('roots')).toEqual([root])
})

it('FR3005 waits for MCP process shutdown before the benchmark removes its private cache', async () => {
  const { McpClient } = await import(pathToFileURL(path.join(ROOT, 'bench/graph-bench/mcp-client.mjs')).href)
  const script = `process.stdin.resume()
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50))
    process.stdout.write('ready\\n')`
  const client = new McpClient(process.execPath, ['-e', script])
  await new Promise(resolve => client.proc.stdout.once('data', resolve))
  await Promise.all([client.close(), client.close()])
  expect(client.proc.exitCode).toBe(0)
})

it('FR3005 resumes a byte-limited native graph page at its returned row count', async () => {
  const a = 'src/a.ts', b = 'src/b.ts', c = 'src/c.ts'
  const call = async (_: string, { query }: { query: string }) => {
    const offset = Number(/SKIP (\d+)/.exec(query)?.[1])
    if (query.includes('MATCH (a:File)')) {
      if (offset === 0) return { rows: [[a], [b]], truncated: true }
      expect(offset).toBe(2)
      return { rows: [[c]] }
    }
    if (offset === 0) return { rows: [[b, a]], has_more: true }
    expect(offset).toBe(1)
    return { rows: [[c, b]] }
  }
  const answer = await (await relationships())('codebase-memory-mcp', { kind: 'dependents', target: { file: a } }, call, 'repo')
  expect(answer.items).toEqual([b, c])
  expect(answer.truncated).toBe(false)
})

it('FR3005 verifies both path endpoints, exact declarations and the kind of every directed hop', async () => {
  const { pathScore } = await import(pathToFileURL(path.join(ROOT, 'bench/parity/agents/paths.mjs')).href)
  const file = 'src/demo.ts'
  const symbols = ['A.start', 'A.step', 'B.step', 'A.end'].map((qname, index) => ({
    id: qname, qname, name: qname.split('.')[1], file, line: index + 1,
  }))
  const q = { source: { file, qname: 'A.start' }, target: { file, qname: 'A.end' } }
  const compiler = { T: { symbols, calls: [
    { caller: 'A.start', callee: 'A.step' }, { caller: 'A.step', callee: 'A.end' },
  ] }, tFind: (_: string, qname: string) => qname, truthFor: () => ({ shortest: 2 }) }
  const route = [q.source, { file, name: 'step', line: 2 }, q.target]
  expect(pathScore(q, { path: route, kinds: ['calls', 'calls'] }, compiler).valid).toBe(true)
  expect(pathScore(q, { path: route, kinds: ['calls', 'has_method'] }, compiler).valid).toBe(false)
  expect(pathScore(q, { path: route.slice(1), kinds: ['calls'] }, compiler).valid).toBe(false)
  expect(pathScore(q, { path: [q.source, { file, name: 'step', line: 3 }, q.target], kinds: ['calls', 'calls'] }, compiler).valid).toBe(false)
})

it('FR3005 scores unused public functions and counts distinct source symbols using each hub', async () => {
  const { symbolUsage } = await import(pathToFileURL(path.join(ROOT, 'bench/parity/agents/symbol-usage.mjs')).href)
  const file = 'src/demo.ts'
  const id = (name: string) => file + '::' + name
  const nodes = ['a', 'b', 'exported', 'a.nested'].map(n =>
    `<node id="${id(n)}"><data key="kind">function</data><data key="name">${n.split('.').at(-1)}</data><data key="file_path">${file}</data></node>`)
  const edge = (a: string, b: string, kind: string) => `<edge source="${id(a)}" target="${id(b)}"><data key="edge_kind">${kind}</data></edge>`
  const xml = `<graphml xmlns="http://graphml.graphdrawing.org/xmlns"><graph>${nodes.join('')}${edge('a', 'b', 'calls')}${edge('a', 'b', 'references')}${edge('b', 'b', 'calls')}${edge('a.nested', 'b', 'reads')}${edge('a', 'exported', 'imports')}</graph></graphml>`
  const call = async () => xml
  expect((await symbolUsage('gortex', { kind: 'hubs', top: 1 }, call)).ranked).toEqual([[id('b'), 2]])
  expect((await symbolUsage('gortex', { kind: 'dead_code', scope: 'src/' }, call)).items.sort()).toEqual([id('a'), id('exported')])
})

it('FR3005 names a missing native tool or facade operation before scoring', async () => {
  const { requireOperation } = await import(pathToFileURL(path.join(ROOT, 'bench/parity/agents/callers.mjs')).href)
  const surface = new Map([['trace', { inputSchema: { properties: { operation: { enum: ['walk'] } } } }]])
  expect(() => requireOperation(surface, 'trace', { operation: 'walk' })).not.toThrow()
  for (const [name, args] of [['trace', { operation: 'path' }], ['cypher', {}]] as const) {
    expect(() => requireOperation(surface, name, args)).toThrow(expect.objectContaining({ code: 'unsupported_operation' }))
  }
})
