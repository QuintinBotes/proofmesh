import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ProofmeshError } from '../src/core/errors.js'
import { runTool } from '../src/query/tools.js'
import { fixtureRepo, indexedDataDir, indexedRepo } from './helpers.js'
import { mcpClient } from './mcp-client.js'

// Issue 33: get_context_map, the declarations around a focus in both directions, ranked, within a byte budget.
const IMPLS = Array.from({ length: 12 }, (_, i) => `Driver${i + 1}`)
const FILES: Record<string, string> = {
  'tsconfig.json': '{ "compilerOptions": { "target": "es2020", "module": "commonjs", "strict": false, "noEmit": true }, "include": ["src"] }\n',
  'src/driver/Options.ts': 'export interface Options { name: string }\n',
  'src/driver/Driver.ts': 'import { Options } from "./Options"\nexport interface Driver {\n    options: Options\n    escape(s: string): string\n    connect(): void\n}\n',
  ...Object.fromEntries(IMPLS.map((d) => [`src/driver/${d.toLowerCase()}/${d}.ts`, `import { Driver } from "../Driver"\nimport { Options } from "../Options"\nexport class ${d} implements Driver {\n    options: Options\n    escape(s: string): string { return s }\n    connect(): void {}\n}\n`])),
  'src/query/Select.ts': 'import { Driver } from "../driver/Driver"\nexport function select(d: Driver): string {\n    return d.escape("a")\n}\n',
  'src/query/Insert.ts': 'import { Driver } from "../driver/Driver"\nexport function insert(d: Driver): string {\n    return d.escape("b")\n}\n',
  'src/api/run.ts': 'import { Driver } from "../driver/Driver"\nimport { select } from "../query/Select"\nimport { insert } from "../query/Insert"\nexport function runSelect(d: Driver): string {\n    return select(d)\n}\nexport function runAll(d: Driver): string {\n    return runSelect(d) + insert(d)\n}\n',
  'src/query/Select.test.ts': 'import { select } from "./Select"\nimport { Driver1 } from "../driver/driver1/Driver1"\nexport function selectTest(): void {\n    select(new Driver1())\n}\n',
  'notes.txt': 'not code\n',
}
const RELATION = '(changed|implements|implemented_by|calls|called_by|tests|references|referenced_by|imports|imported_by)'
// A lean row: the name and path:line (a file's row is its path:line alone), the relation, depth=<n>, and inferred for a row a candidate edge reached.
const ROW = new RegExp(`^(\\S+ )?\\S+:\\d+ ${RELATION} depth=\\d+( inferred)?$`)
const rowsOf = (text: string) => text.split('\n').filter((l) => !l.startsWith('#'))
const map = (d: string, input: Record<string, unknown>) => runTool(d, 'get_context_map', { envelope: 'lean', ...input })

let d: string
let repo: string
beforeAll(async () => {
  ;({ dataDir: d, repo } = await indexedRepo(FILES))
}, 180000)

describe('FR920 FR921 FR922 issue 33 scenarios 1 and 2: one budgeted map of a file, in both directions', () => {
  it('FR920 FR921 scenario 1: a file focus names what uses it and what it uses, each declaration once with its relation and depth', () => {
    const rows = rowsOf(map(d, { focus: { paths: ['src/driver/Driver.ts'] }, budget_bytes: 65536 }).text!)
    // What it uses: the file it imports. What uses it: the implementations, the callers through the interface, the importers.
    expect(rows).toContain('Options src/driver/Options.ts:1 references depth=1')
    for (const impl of IMPLS) expect(rows).toContain(`${impl} src/driver/${impl.toLowerCase()}/${impl}.ts:3 implemented_by depth=1`)
    expect(rows).toContain('select src/query/Select.ts:2 called_by depth=1')
    expect(rows).toContain('insert src/query/Insert.ts:2 called_by depth=1')
    expect(rows).toContain('runSelect src/api/run.ts:4 referenced_by depth=1')
    expect(rows).toContain('src/query/Select.ts:1 imported_by depth=1')
    // Two hops: the test that calls a caller, marked tests.
    expect(rows).toContain('selectTest src/query/Select.test.ts:3 tests depth=2')
    // Nothing in the focus file is a row, and each declaration is one row.
    expect(rows.some((r) => r.includes(' src/driver/Driver.ts:'))).toBe(false)
    expect(new Set(rows.map((r) => r.split(' ').slice(0, 2).join(' '))).size).toBe(rows.length)
  })

  it('FR922 scenario 2 and SC-002: every row is `<name> <path>:<line> <relation> depth=<n>`, and every answer is at most budget_bytes, cut or whole', () => {
    for (const budget of [65536, 4096, 2000, 1200, 900, 700]) {
      const a = map(d, { focus: { paths: ['src/driver/Driver.ts'] }, budget_bytes: budget })
      expect(Buffer.byteLength(a.text!), `budget ${budget}`).toBeLessThanOrEqual(budget)
      const rows = rowsOf(a.text!)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(r, `budget ${budget}`).toMatch(ROW)
    }
    // A JSON answer holds the same budget.
    const full = runTool(d, 'get_context_map', { focus: { paths: ['src/driver/Driver.ts'] }, budget_bytes: 3000, envelope: 'compact' })
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThanOrEqual(3000)
    expect(full.completion.stop_reasons).toContain('max_bytes')
  })

  it('FR923 edge case: a budget smaller than two rows answers one row and a `# more: cursor` line, and the cursor continues the map in order', () => {
    const focus = { paths: ['src/driver/Driver.ts'] }
    const whole = rowsOf(map(d, { focus, budget_bytes: 65536 }).text!)
    const refused = (budget: number) => { try { map(d, { focus, budget_bytes: budget }); return null } catch (e) { return (e as ProofmeshError).details.detail } }
    // The least budget that answers: the header, the first row and the cursor line.
    let lo = 1, least = 4096
    while (lo < least) { const mid = (lo + least) >> 1; if (refused(mid)) lo = mid + 1; else least = mid }
    // Every smaller budget is refused, never answered over it.
    expect(refused(least - 1)).toBe('max_bytes_too_small')
    const one = map(d, { focus, budget_bytes: least })
    expect(Buffer.byteLength(one.text!)).toBe(least)
    expect(rowsOf(one.text!)).toEqual([whole[0]])
    expect(one.text!.split('\n').at(-1)).toMatch(/^# more: cursor \S+$/)
    const next = map(d, { focus, budget_bytes: least + 40, cursor: one.completion.next_cursor })
    expect(rowsOf(next.text!)).toEqual([whole[1]])
  })

  it('FR921 edge case: ties keep a stable order, so two calls give the same map', () => {
    const a = map(d, { focus: { paths: ['src/driver/Driver.ts'] }, budget_bytes: 65536 }).text!
    const b = map(d, { focus: { paths: ['src/driver/Driver.ts'] }, budget_bytes: 65536 }).text!
    expect(b).toBe(a)
    expect(rowsOf(a).length).toBeGreaterThan(15)
  })

  it('FR923 edge case: a focus file no adapter analyses has an empty map, and the limitation names its disposition', () => {
    const a = map(d, { focus: { paths: ['notes.txt'] } })
    expect(rowsOf(a.text!)).toEqual([])
    expect(a.text).toMatch(/^# notes\.txt is (unsupported|excluded) in snapshot snap_\w+, so it has no declarations to map\.$/m)
  })
})

describe('FR921 issue 33 scenario 3 and SC-003: dispatch neighbours outrank two-hop rows', () => {
  it('FR921 scenario 3: for Driver.escape, the callers through the interface and the 12 implementations rank above every depth-2 row', () => {
    const rows = rowsOf(map(d, { focus: { symbols: ['Driver.escape'] }, budget_bytes: 65536 }).text!)
    const near = ['select src/query/Select.ts:2 called_by depth=1', 'insert src/query/Insert.ts:2 called_by depth=1', ...IMPLS.map((i) => `${i}.escape src/driver/${i.toLowerCase()}/${i}.ts:5 implemented_by depth=1`)]
    for (const r of near) expect(rows).toContain(r)
    const firstFar = rows.findIndex((r) => r.endsWith('depth=2'))
    expect(firstFar).toBeGreaterThan(0)
    expect(Math.max(...near.map((r) => rows.indexOf(r)))).toBeLessThan(firstFar)
    expect(rows).toContain('runSelect src/api/run.ts:4 called_by depth=2')
  })

  it('FR920 a symbol name that names nothing, or a path that is no file of the snapshot, is refused, naming it', () => {
    expect(() => map(d, { focus: { symbols: ['Driver.nope'] } })).toThrow(/no symbol named Driver\.nope/)
    expect(() => map(d, { focus: { paths: ['src/drivers/Driver.ts'] } })).toThrow(/path src\/drivers\/Driver\.ts is not found in snapshot/)
  })
})

describe('FR920 issue 33 scenario 4: a diff focus', () => {
  it('FR920 scenario 4: with base and uncommitted edits, the focus is the changed declarations, rows marked changed, then what is around them', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8' })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    fs.writeFileSync(path.join(repo, 'src/query/Select.ts'), FILES['src/query/Select.ts']!.replace('d.escape("a")', 'd.escape("a") + d.escape("z")'))
    const { dataDir } = await indexedDataDir(repo)
    const rows = rowsOf(map(dataDir, { focus: { base: 'HEAD' }, budget_bytes: 65536 }).text!)
    expect(rows[0]).toBe('select src/query/Select.ts:2 changed depth=0')
    expect(rows.filter((r) => / changed depth=0$/.test(r))).toEqual(['select src/query/Select.ts:2 changed depth=0'])
    expect(rows).toContain('runSelect src/api/run.ts:4 called_by depth=1')
    expect(rows).toContain('selectTest src/query/Select.test.ts:3 tests depth=1')
    expect(rows).toContain('Driver.escape src/driver/Driver.ts:4 calls depth=1')
    // A change that only removes lines from a declaration still makes it the focus.
    fs.writeFileSync(path.join(repo, 'src/query/Select.ts'), FILES['src/query/Select.ts']!)
    fs.writeFileSync(path.join(repo, 'src/api/run.ts'), FILES['src/api/run.ts']!.replace('    return runSelect(d) + insert(d)\n', ''))
    const { dataDir: removed } = await indexedDataDir(repo)
    expect(rowsOf(map(removed, { focus: { base: 'HEAD' }, budget_bytes: 65536 }).text!).filter((r) => r.endsWith(' changed depth=0'))).toEqual(['runAll src/api/run.ts:7 changed depth=0'])
  }, 240000)
})

describe('FR923 issue 33 edge case: rows reached through inferred edges', () => {
  it('FR923 a row reached only through a candidate edge is kept and ends inferred, below the observed rows of its depth', async () => {
    const { dataDir } = await indexedDataDir(fixtureRepo('constrained'))
    const rows = rowsOf(map(dataDir, { focus: { paths: ['lib/lib.go'] }, budget_bytes: 65536 }).text!)
    const inferred = rows.filter((r) => r.endsWith(' inferred'))
    expect(inferred).toContainEqual(expect.stringMatching(/^run svc\/main\.go:\d+ called_by depth=1 inferred$/))
    // At each depth no observed row comes after an inferred one.
    for (const depth of [1, 2]) {
      const at = rows.filter((r) => r.includes(` depth=${depth}`)).map((r) => r.endsWith(' inferred'))
      expect(at.indexOf(true) === -1 || !at.slice(at.indexOf(true)).includes(false), `depth ${depth}`).toBe(true)
    }
  }, 180000)
})

describe('FR920 FR922 issue 33: get_context_map over MCP stdio, in the data profile', () => {
  let client: Client
  beforeAll(async () => { client = await mcpClient(d, '--tools', 'core,data') }, 60000)
  afterAll(async () => { await client?.close() })
  it('FR920 FR922 the data profile lists it; it answers lean by default, within budget_bytes', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('get_context_map')
    const r = await client.callTool({ name: 'get_context_map', arguments: { focus: { paths: ['src/driver/Driver.ts'] }, budget_bytes: 1500 } })
    const text = (r.content as Array<{ text: string }>)[0]!.text
    expect(text).toMatch(/^# get_context_map · \d+ rows? · snap_\w+ current\n/)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1500)
  })
})
