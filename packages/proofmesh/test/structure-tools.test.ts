import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { check } from '../src/core/schemas.js'
import { components } from '../src/query/structure.js'
import { indexedDataDir, tmpDir, tool } from './helpers.js'
import { mcpClient } from './mcp-client.js'

// A small TypeScript package with one of each case the structure tools tell apart (#34).
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shapes', version: '1.0.0', main: './src/index.js', bin: { shapes: './bin/cli.js' } }, null, 2),
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true }, include: ['src', 'test'] }),
  'src/index.ts': "export * from './api'\n",
  'src/api.ts': 'export function publicApi(): number {\n  return 1\n}\nexport const port = 3000\n',
  'src/log.ts': 'export function log(message: string): void {\n  console.log(message)\n}\n',
  'src/a.ts': "import { b } from './b'\nimport { log } from './log'\nexport function a(): number {\n  log('a')\n  return b()\n}\n",
  'src/b.ts': "import { a } from './a'\nimport { log } from './log'\nexport function b(): number {\n  log('b')\n  return 1\n}\nexport function callsA(): number {\n  return a()\n}\n",
  'src/c.ts': "import type { D } from './d'\nexport type C = { d?: D }\n",
  'src/d.ts': "import type { C } from './c'\nexport type D = { c?: C }\n",
  // A runtime cycle g <-> h that a type-only import h -> i, and i -> g, join into a larger set.
  'src/g.ts': "import './h'\nexport type G = number\n",
  'src/h.ts': "import './g'\nimport type { I } from './i'\nexport type H = I\n",
  'src/i.ts': "import './g'\nexport type I = number\n",
  'src/util.ts': 'export function dead(): void {}\nexport function onlyTests(): number {\n  return 2\n}\nexport function byName(): number {\n  return 3\n}\n',
  'src/lazy.ts': 'export const loaded = true\n',
  'src/main.ts': "import { callsA } from './b'\nimport { log } from './log'\nconst anything: any = {}\nlog(String(callsA()))\nanything.byName()\nvoid import('./lazy')\n",
  'src/server.ts': "import express from 'express'\nimport { log } from './log'\nconst app = express()\nexport function health(_req: unknown, res: { send(body: string): void }): void {\n  log('health')\n  res.send('ok')\n}\napp.get('/health', health)\n",
  'src/items.controller.ts': "import { Controller, Get } from '@nestjs/common'\n@Controller('items')\nexport class ItemsController {\n  @Get()\n  list(): string[] {\n    return []\n  }\n}\n",
  'test/util.test.ts': "import { onlyTests } from '../src/util'\nonlyTests()\n",
}

let d: string
let mcp: Client, extra: Client
beforeAll(async () => {
  const repo = tmpDir('pm-structure-')
  for (const [file, text] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text) }
  ;({ dataDir: d } = await indexedDataDir(repo))
  mcp = await mcpClient(d)
  extra = await mcpClient(d, '--tools', 'extra')
}, 120000)
afterAll(async () => { await mcp?.close(); await extra?.close() })

type Row = Record<string, unknown>
const data = (name: string, input: Record<string, unknown> = {}) => {
  const env = tool(d, name, input)
  expect(check(`tools/${name}.data.schema.json`, env.data), name).toBeUndefined()
  return env
}
const text = async (name: string, args: Record<string, unknown>) => ((await extra.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text

describe('FR940 find_unused: code nothing uses, and what only tests, frameworks or public exports reach', () => {
  it('FR940 lists a top-level function nothing uses as unused, and the others apart with why', () => {
    const rows = (data('find_unused', { kinds: ['function'], path_prefix: 'src/' }).data.symbols as Row[]).map((r) => [r.name, r.path, r.line, r.group, r.by ?? r.sites ?? null])
    // health is passed to app.get, a use as a value: not listed.
    expect(rows).toEqual([
      ['dead', 'src/util.ts', 1, 'unused', null],
      ['publicApi', 'src/api.ts', 1, 'reachable_only_by', 'public_export'],
      ['onlyTests', 'src/util.ts', 2, 'reachable_only_by', 'test'],
      ['byName', 'src/util.ts', 5, 'possibly_used', 1],
    ])
  })

  it('FR940 an export whose name is inside the word export is still read as exported', () => {
    const rows = (data('find_unused', { kinds: ['variable'], path_prefix: 'src/api' }).data.symbols as Row[]).map((r) => [r.name, r.group, r.by ?? null])
    expect(rows).toEqual([['port', 'reachable_only_by', 'public_export']])
  })

  it('FR940 a member only a framework route reaches is listed under reachable_only_by framework, with top_level_only false', () => {
    const rows = (data('find_unused', { kinds: ['class', 'method'], path_prefix: 'src/items', top_level_only: false }).data.symbols as Row[]).map((r) => [r.qualified_name, r.group, r.by ?? null])
    expect(rows).toEqual([['src/items.controller:ItemsController', 'unused', null], ['src/items.controller:ItemsController.list', 'reachable_only_by', 'framework']])
  })

  it('FR940 with include_tests, a use from test code counts and test code is checked too', () => {
    const rows = data('find_unused', { kinds: ['function'], include_tests: true }).data.symbols as Row[]
    expect(rows.map((r) => r.name)).not.toContain('onlyTests')
    expect(data('find_unused', { kinds: ['function'] }).data.totals).toEqual({ checked: 9, unused: 1, reachable_only_by: { test: 1, framework: 0, public_export: 1 }, possibly_used: 1 })
  })

  it('FR940 kinds module lists a file nothing imports and nothing uses', () => {
    const rows = (data('find_unused', { kinds: ['module'], path_prefix: 'src/' }).data.symbols as Row[]).map((r) => [r.path, r.group, r.by ?? null])
    expect(rows).toEqual([['src/items.controller.ts', 'unused', null], ['src/main.ts', 'unused', null], ['src/server.ts', 'unused', null], ['src/index.ts', 'reachable_only_by', 'public_export'], ['src/util.ts', 'reachable_only_by', 'test']])
  })
})

describe('FR941 find_cycles: each strongly connected set of files once, with every import in it', () => {
  it('FR941 a runtime cycle comes first, a type-only one apart, each import at its file:line', () => {
    const env = data('find_cycles', { path_prefix: 'src/' })
    expect(env.data.cycles).toEqual([
      { cycle: 1, type_only: false, inferred: false, files: ['src/a.ts', 'src/b.ts'], edges: 2 },
      { cycle: 2, type_only: false, inferred: false, files: ['src/g.ts', 'src/h.ts'], edges: 2 },
      { cycle: 3, type_only: true, inferred: false, files: ['src/g.ts', 'src/h.ts', 'src/i.ts'], edges: 2 },
      { cycle: 4, type_only: true, inferred: false, files: ['src/c.ts', 'src/d.ts'], edges: 2 },
    ])
    // The larger set lists only the imports the runtime cycle inside it did not: each import is one row.
    expect((env.data.edges as Row[]).map((e) => [e.cycle, e.from, e.to, e.line, e.kind])).toEqual([
      [1, 'src/a.ts', 'src/b.ts', 1, 'static'], [1, 'src/b.ts', 'src/a.ts', 1, 'static'],
      [2, 'src/g.ts', 'src/h.ts', 1, 'static'], [2, 'src/h.ts', 'src/g.ts', 1, 'static'],
      [3, 'src/h.ts', 'src/i.ts', 2, 'type_only'], [3, 'src/i.ts', 'src/g.ts', 1, 'static'],
      [4, 'src/c.ts', 'src/d.ts', 1, 'type_only'], [4, 'src/d.ts', 'src/c.ts', 1, 'type_only'],
    ])
    expect((data('find_cycles', { include_type_only: false }).data.cycles as Row[]).map((c) => c.files)).toEqual([['src/a.ts', 'src/b.ts'], ['src/g.ts', 'src/h.ts']])
  })

  it('FR941 a large cycle pages: max_rows bounds the edges, the totals stay whole and a cursor continues', () => {
    const first = data('find_cycles', { limits: { max_rows: 7 } })
    expect((first.data.edges as Row[]).length).toBe(7)
    expect(first.data.totals).toEqual({ cycles: 4, type_only: 2, files: 7, edges: 8 })
    const next = data('find_cycles', { limits: { max_rows: 7 }, cursor: first.completion.next_cursor })
    expect((next.data.edges as Row[]).map((e) => e.from)).toEqual(['src/d.ts'])
  })

  it('FR941 the components are Tarjan\'s, iteratively, so a long chain does not overflow the stack', () => {
    const n = 50000, adj = new Map(Array.from({ length: n }, (_, i) => [`f${i}`, [`f${(i + 1) % n}`]]))
    expect(components([...adj.keys()], adj).map((c) => c.length)).toEqual([n])
  })
})

describe('FR942 find_entry_points: modules nothing imports, and framework and manifest entries', () => {
  it('FR942 lists the modules no file under the prefix imports, static, dynamic or re-export imports counted', () => {
    const rows = (data('find_entry_points', { path_prefix: 'src/' }).data.entries as Row[]).map((e) => [e.reason, e.path, e.name, e.kind])
    expect(rows).toEqual([
      ['not_imported', 'src/index.ts', null, 'module'], ['not_imported', 'src/items.controller.ts', null, 'module'], ['not_imported', 'src/main.ts', null, 'module'],
      ['not_imported', 'src/server.ts', null, 'module'], ['not_imported', 'src/util.ts', null, 'module'],
      ['endpoint', 'src/items.controller.ts', 'GET items', 'endpoint'], ['endpoint', 'src/server.ts', 'GET health', 'endpoint'],
      ['main', 'src/index.ts', null, null],
    ])
  })

  it('FR942 over the whole repository a test import counts, test files are not entries, and a bin with no indexed file is shown at its manifest', () => {
    const rows = (data('find_entry_points').data.entries as Row[]).map((e) => [e.reason, e.path, e.name])
    expect(rows).toEqual([
      ['not_imported', 'src/index.ts', null], ['not_imported', 'src/items.controller.ts', null], ['not_imported', 'src/main.ts', null], ['not_imported', 'src/server.ts', null],
      ['endpoint', 'src/items.controller.ts', 'GET items'], ['endpoint', 'src/server.ts', 'GET health'], ['main', 'src/index.ts', null], ['bin', 'package.json', './bin/cli.js'],
    ])
  })
})

describe('FR943 find_hubs: the symbols the most code depends on', () => {
  it('FR943 ranks by fan_in with both counts, and by fan_out', () => {
    const hubs = data('find_hubs', { top: 2 }).data.hubs as Row[]
    expect(hubs[0]).toMatchObject({ name: 'log', path: 'src/log.ts', fan_in: 4 })
    expect(data('find_hubs', { top: 1, by: 'fan_out', kinds: ['function'] }).data.hubs).toEqual([expect.objectContaining({ name: 'a', fan_out: 2 })])
  })

  it('FR943 betweenness ranks the symbol most shortest use paths pass through', () => {
    const env = data('find_hubs', { top: 1, by: 'betweenness' })
    expect(env.data.sampled_sources).toBeNull()
    expect((env.data.hubs as Row[])[0]).toMatchObject({ name: 'a' }) // on main -> callsA -> a -> b and callsA -> a -> log
  })
})

describe('FR944 FR945 the structure tools are in the extra profile and answer lean over MCP', () => {
  it('FR944 the default listing leaves them out; --tools extra lists them', async () => {
    const names = (await mcp.listTools()).tools.map((t) => t.name)
    for (const t of ['find_unused', 'find_cycles', 'find_entry_points', 'find_hubs']) expect(names).not.toContain(t)
    expect((await extra.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['find_unused', 'find_cycles', 'find_entry_points', 'find_hubs']))
  })

  it('FR945 each row is a lean row with its path:line and tags', async () => {
    expect((await text('find_unused', { kinds: ['function'], path_prefix: 'src/' })).split('\n').slice(1, 5)).toEqual([
      'dead src/util.ts:1 function unused', 'publicApi src/api.ts:1 function reachable_only_by=public_export',
      'onlyTests src/util.ts:2 function reachable_only_by=test', 'byName src/util.ts:5 function possibly_used sites=1',
    ])
    expect((await text('find_cycles', { path_prefix: 'src/' })).split('\n').slice(5, 9)).toEqual(['src/i.ts src/h.ts:2 cycle=3 type_only', 'src/g.ts src/i.ts:1 cycle=3', 'src/d.ts src/c.ts:1 cycle=4 type_only', 'src/c.ts src/d.ts:1 cycle=4 type_only'])
    expect((await text('find_entry_points', { path_prefix: 'src/' })).split('\n').slice(1, 3)).toEqual(['src/index.ts:1 not_imported', 'src/items.controller.ts:1 not_imported'])
    expect((await text('find_hubs', { top: 1 })).split('\n')[1]).toBe('log src/log.ts:1 function fan_in=4 fan_out=0')
  })
})
