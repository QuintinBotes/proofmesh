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
