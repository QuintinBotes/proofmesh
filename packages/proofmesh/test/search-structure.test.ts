// search_structure (#37, FR1060 to FR1067): code found by its shape with ast-grep's pattern syntax, limited by the graph.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { check } from '../src/core/schemas.js'
import type { ProofmeshError } from '../src/core/errors.js'
import { PROFILE } from '../src/query/tools.js'
import { indexedDataDir, ROOT, tmpDir, tool } from './helpers.js'
import { mcpClient } from './mcp-client.js'

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shapes', version: '1.0.0' }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true }, include: ['src'] }),
  'src/api.ts': [
    'export function handle(input: string): string {',
    '  return escape(input)',
    '}',
    'export function render(): string {',
    "  return escape('<b>')",
    '}',
    'export function escape(s: string): string {',
    "  return s.replace(/</g, '&lt;')",
    '}',
    'export function same(a: number, b: number): boolean {',
    '  return a === a || a === b',
    '}',
    '',
  ].join('\n'),
  'src/loop.ts': [
    'export async function each(items: string[], save: (x: string) => Promise<void>): Promise<void> {',
    '  for (const item of items) {',
    '    await save(item)',
    '  }',
    '  try {',
    "    await save('x')",
    '  } catch (e) {}',
    '}',
    '',
  ].join('\n'),
  'src/main.ts': "import { handle } from './api'\nexport function main(): string {\n  return handle('x')\n}\n",
  'src/other.ts': "export function helper(): string {\n  return 'h'\n}\n",
  // A right-to-left override in source must not reorder a lean row.
  'src/bidi.ts': "export const label = 'a\u202Eb'\n",
  'tool/clean.py': 'def clean(x):\n    return escape(x)\n\ndef helper():\n    pass\n',
  'notes.md': '# Notes\n\nreturn escape(x)\n',
}

let d: string, repo: string
let extra: Client, core: Client
beforeAll(async () => {
  repo = tmpDir('pm-structure-search-')
  for (const [file, text] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text) }
  ;({ dataDir: d } = await indexedDataDir(repo))
  extra = await mcpClient(d, '--tools', 'extra')
  core = await mcpClient(d)
}, 120000)
afterAll(async () => { await extra?.close(); await core?.close() })

type Match = { path: string; line: number; end_line: number; text: string; symbol: { id: string; qualified_name: string; kind: string } | null }
const search = (input: Record<string, unknown>) => {
  const env = tool(d, 'search_structure', input)
  expect(check('tools/search_structure.data.schema.json', env.data)).toBeUndefined()
  return env
}
const sites = (input: Record<string, unknown>) => (search(input).data.matches as Match[]).map((m) => `${m.path}:${m.line}`)
const refused = (input: Record<string, unknown>): ProofmeshError => { try { tool(d, 'search_structure', input) } catch (e) { return e as ProofmeshError } throw new Error('not refused') }
const lean = async (args: Record<string, unknown>) => ((await extra.callTool({ name: 'search_structure', arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text

describe('FR1060 search_structure finds code by its shape with ast-grep pattern syntax', () => {
  it('FR1060 matches a pattern in its language, each match with its enclosing symbol', () => {
    const r = search({ pattern: 'escape($A)', language: 'typescript' })
    expect((r.data.matches as Match[]).map((m) => [m.path, m.line, m.text, m.symbol?.qualified_name])).toEqual([
      ['src/api.ts', 2, 'escape(input)', 'src/api:handle'],
      ['src/api.ts', 5, "escape('<b>')", 'src/api:render'],
    ])
    expect((r.data.totals as { matches: number }).matches).toBe(2)
  })

  it('FR1061 $$$ matches any number of nodes, and a block pattern matches only that shape', () => {
    expect(sites({ pattern: 'for (const $X of $Y) { $$$ }', language: 'typescript' })).toEqual(['src/loop.ts:2'])
    expect(sites({ pattern: 'try { $$$ } catch ($E) {}', language: 'typescript' })).toEqual(['src/loop.ts:5'])
    expect(sites({ pattern: 'await $X', language: 'typescript' })).toEqual(['src/loop.ts:3', 'src/loop.ts:6'])
  })

  it('FR1061 a repeated metavariable matches only equal code', () => {
    expect((search({ pattern: '$A === $A', language: 'typescript' }).data.matches as Match[]).map((m) => m.text)).toEqual(['a === a'])
    expect((search({ pattern: '$A === $B', language: 'typescript' }).data.matches as Match[]).map((m) => m.text)).toEqual(['a === a', 'a === b'])
  })

  it('FR1060 reads each language with its own grammar, and with no language every file whose extension has one', () => {
    expect(sites({ pattern: 'escape($A)', language: 'python' })).toEqual(['tool/clean.py:2'])
    const all = search({ pattern: 'escape($A)' })
    expect((all.data.matches as Match[]).map((m) => `${m.path}:${m.line}`)).toEqual(['src/api.ts:2', 'src/api.ts:5', 'tool/clean.py:2'])
    // Edge case: a file in a language with no grammar is skipped and counted.
    expect(all.limitations.find((l) => l.includes('no grammar'))).toMatch(/^\d+ files? in a language with no grammar here (was|were) not searched: \.json 2\.$/)
  })
})

describe('FR1062 a graph scope limits the matches', () => {
  // Scenario 2: exactly the matches whose enclosing symbol trace_paths reaches from the start.
  it('FR1062 reachable_from keeps exactly the matches inside the symbols trace_paths reaches', () => {
    const main = (search({ pattern: 'handle($A)', language: 'typescript' }).data.matches as Match[])[0]!.symbol!.id
    const scoped = search({ pattern: 'return $X', language: 'typescript', scope: { reachable_from: ['main'] } })
    const every = search({ pattern: 'return $X', language: 'typescript' }).data.matches as Match[]
    const reached = (id: string) => id === main || (tool(d, 'trace_paths', { source_id: main, target_id: id }).data as { conclusion: string }).conclusion === 'path_found'
    const expected = every.filter((m) => reached(m.symbol!.id))
    expect(scoped.data.matches).toEqual(expected)
    expect((scoped.data.matches as Match[]).map((m) => `${m.symbol!.qualified_name} ${m.path}:${m.line}`)).toEqual([
      'src/api:handle src/api.ts:2', 'src/api:escape src/api.ts:8', 'src/main:main src/main.ts:3',
    ])
    // A symbol by { name, path } or by id gives the same scope.
    expect(search({ pattern: 'return $X', language: 'typescript', scope: { reachable_from: [{ name: 'main', path: 'src/main.ts' }] } }).data.matches).toEqual(expected)
    expect(search({ pattern: 'return $X', language: 'typescript', scope: { reachable_from: [main] } }).data.matches).toEqual(expected)
  })

  it('FR1062 reaching keeps the matches inside the symbols that reach a symbol, and importing those in the files importing a file', () => {
    expect(sites({ pattern: 'return $X', language: 'typescript', scope: { reaching: ['escape'] } })).toEqual(['src/api.ts:2', 'src/api.ts:5', 'src/api.ts:8', 'src/main.ts:3'])
    expect(sites({ pattern: 'return $X', language: 'typescript', scope: { importing: ['src/api.ts'] } })).toEqual(['src/main.ts:3'])
    // Two scopes intersect.
    expect(sites({ pattern: 'return $X', language: 'typescript', scope: { reaching: ['escape'], reachable_from: ['render'] } })).toEqual(['src/api.ts:5', 'src/api.ts:8'])
  })

  it('FR1062 a name that names no symbol, or several, is refused', () => {
    const none = refused({ pattern: 'return $X', language: 'typescript', scope: { reachable_from: ['nowhere'] } })
    expect([none.code, none.message]).toEqual(['NOT_FOUND', 'no symbol named nowhere in this snapshot'])
    const several = refused({ pattern: 'return $X', language: 'typescript', scope: { reaching: ['helper'] } })
    expect([several.code, several.details.detail]).toEqual(['INVALID_ARGUMENT', 'ambiguous_name'])
    expect(several.message).toMatch(/^helper names 2 symbols; pass one by id or as \{ name, path \}:\nhelper src\/other\.ts:1 function id=sym_\w+\nhelper tool\/clean\.py:4 function id=sym_\w+$/)
  })
})

describe('FR1063 lean rows over MCP', () => {
  it('FR1063 each match is `<enclosing name> <path>:<line> "<first line>"`, in the extra profile and not core', async () => {
    const text = await lean({ pattern: 'escape($A)', language: 'typescript' })
    const rows = text.split('\n').filter((l) => !l.startsWith('#'))
    expect(rows).toEqual(['handle src/api.ts:2 escape(input)', 'render src/api.ts:5 escape(\'<b>\')'])
    expect((await lean({ pattern: '$A === $B', language: 'typescript' })).split('\n')[1]).toBe('same src/api.ts:11 "a === a"')
    expect(text.split('\n')[0]).toMatch(/^# search_structure · 2 rows · snap_[0-9a-z]+ current$/)
    expect(PROFILE.search_structure).toBe('extra')
    expect((await core.listTools()).tools.map((t) => t.name)).not.toContain('search_structure')
  })

  it('FR1063 control and bidirectional characters in a match are escaped in its lean row', async () => {
    expect((await lean({ pattern: "const $X = 'a\u202Eb'", language: 'typescript' })).split('\n')[1]).toBe('label src/bidi.ts:1 "const label = \'a\\\\u202eb\'"')
  })

  it('FR1063 the first line of a match is cut at 120 characters', () => {
    const m = (search({ pattern: 'export async function $F($$$P): $R { $$$ }', language: 'typescript' }).data.matches as Match[])[0]!
    expect(m.text).toBe(FILES['src/loop.ts']!.split('\n')[0]!.slice(0, 120))
    expect([m.line, m.end_line]).toEqual([1, 8])
  })
})

describe('FR1065 matches are against the snapshot, not the working tree', () => {
  it('FR1065 a change on disk after the index is not searched, and the answer says what was', () => {
    fs.writeFileSync(path.join(repo, 'src/other.ts'), "export function helper(): string {\n  return escape('late')\n}\n")
    try {
      const r = search({ pattern: 'escape($A)', language: 'typescript' })
      expect((r.data.matches as Match[]).map((m) => m.path)).not.toContain('src/other.ts')
      expect(r.limitations.some((l) => /^Matched against the content snapshot snap_[0-9a-z]+ captured.*not the working tree\.$/.test(l))).toBe(true)
    } finally { fs.writeFileSync(path.join(repo, 'src/other.ts'), FILES['src/other.ts']!) }
  })
})

describe('FR1066 a pattern that does not parse is refused with the parse error and its syntax tree', () => {
  // Scenario 4. The tree is what ast-grep 0.51.1 prints for `--debug-query=pattern` (its dump_syntax_tree in pattern format).
  it('FR1066 an unclosed call is INVALID_ARGUMENT naming the error, with the pattern tree', () => {
    const e = refused({ pattern: 'foo($A', language: 'typescript' })
    expect(e.code).toBe('INVALID_ARGUMENT')
    expect(e.message).toMatch(/^the pattern does not parse as typescript: (syntax error|missing)/)
    expect(e.details.syntax_tree).toBe('ERROR\n  identifier foo\n  (\n  MetaVar $A\n')
    expect(e.message).toContain('MetaVar $A')
  })

  it('FR1066 more than one node, or a lone $$$, is refused as ast-grep refuses it', () => {
    expect(refused({ pattern: 'a; b', language: 'typescript' }).message).toMatch(/^Multiple AST nodes are detected/)
    expect(refused({ pattern: '$$$A', language: 'typescript' }).message).toMatch(/^Standalone multi meta variable/)
  })

  it('FR1066 a pattern is refused even when no file of its language is in scope', () => {
    expect(refused({ pattern: 'def (', language: 'go' }).code).toBe('INVALID_ARGUMENT')
  })
})

describe('FR1067 a pattern is a resource surface: time, matches, bytes and files are bounded', () => {
  it('FR1067 max_rows pages with a cursor, and completion.total is exact', () => {
    const first = search({ pattern: '$A', language: 'typescript', limits: { max_rows: 5 } })
    const total = first.completion.total!
    expect(total).toBeGreaterThan(5)
    expect((first.data.totals as { matches: number }).matches).toBe(total)
    expect(first.completion.stop_reasons).toEqual(['max_rows'])
    const seen = [...(first.data.matches as Match[])]
    let cursor = first.completion.next_cursor
    while (cursor) {
      const next = search({ pattern: '$A', language: 'typescript', limits: { max_rows: 5 }, cursor })
      seen.push(...(next.data.matches as Match[]))
      cursor = next.completion.next_cursor
    }
    // The pages, joined, are the whole answer once: nothing skipped, nothing repeated.
    expect(seen).toEqual(search({ pattern: '$A', language: 'typescript', limits: { max_rows: 1000 } }).data.matches)
  })

  it('FR1067 the time limit stops the search and says so, instead of running on', () => {
    const t0 = Date.now()
    const r = search({ pattern: '$A', language: 'typescript', limits: { timeout_ms: 1 } })
    expect(Date.now() - t0).toBeLessThan(10000)
    expect(r.completion.stop_reasons).toContain('timeout')
    expect(r.limitations).toContain('The search stopped at timeout_ms 1; total counts the matches found before it.')
  })

  it('FR1067 a pattern longer than 4096 characters is refused before anything runs', () => {
    const e = refused({ pattern: `f(${'a,'.repeat(3000)}a)`, language: 'typescript' })
    expect(e.code).toBe('INVALID_ARGUMENT')
    expect(e.message).toMatch(/pattern/)
  })
})

// SC-001 without the network: the matcher's answers on the project's own fixtures equal those ast-grep 0.51.1 gave, recorded by
// `node bench/structure/run.mjs --record` (each pattern of bench/structure/patterns.json in its language).
describe('FR1064 the pattern suite equals ast-grep on fixtures/', () => {
  const recorded = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/structure/fixtures-answers.json'), 'utf8')) as { ast_grep: string; files: Record<string, string[]>; answers: Array<{ pattern: string; language: string; sites: string[] }> }
  it.each(recorded.answers.map((a) => [`${a.language}: ${a.pattern}`, a]))('%s', (_name, a) => {
    const entry = createRequire(path.join(ROOT, 'packages/proofmesh/package.json')).resolve('@proofmesh/adapter-syntax/pattern')
    const files = recorded.files[a.language]!
    const req = { pattern: a.pattern, files: files.map((f) => ({ text: fs.readFileSync(path.join(ROOT, f), 'utf8'), language: a.language, symbols: [], scoped: false })), skip: 0, take: 1e9, deadline: Date.now() + 60000, strict: true }
    const r = spawnSync(process.execPath, [entry], { input: JSON.stringify(req), maxBuffer: 1 << 28 })
    const reply = JSON.parse(r.stdout.toString()) as { matches: Array<{ file: number; start_line: number; end_line: number }> }
    expect(reply.matches.map((m) => `${files[m.file]}:${m.start_line}-${m.end_line}`).sort()).toEqual([...a.sites].sort())
  })
})
