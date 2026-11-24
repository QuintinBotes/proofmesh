import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runTool } from '../src/query/tools.js'
import { cli, fixtureRepo, indexedDataDir, symbolId, tmpDir, tool, withSnapshot } from './helpers.js'

const REPO = fixtureRepo('test-reach-kinds')
let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir(REPO)) })

type Row = { name: string; path: string; line: number; evidence: string; depth: number; via?: string; chain: Array<{ name: string; path: string; line: number }> }
/** A subject as the CLI takes it: a path, or path#name for the symbol name declared in that file. */
const subject = (s: string) => s.includes('#') ? { subject_ids: [{ path: s.slice(0, s.indexOf('#')), name: s.slice(s.indexOf('#') + 1) }] } : { paths: [s] }
const ask = (s: string, limits?: Record<string, number>) => tool(d, 'find_tests', { ...subject(s), ...(limits ? { limits } : {}) }) as unknown as { data: { tests: Row[]; totals: { tests: number; executing: number; not_executing: number } }; limitations: string[]; completion: { next_cursor: string | null } }
// The rows as the issue writes them, which is also how `proofmesh tests` prints them.
const line = (t: Row) => t.evidence === 'import_only' ? `${t.path}:${t.line} import_only` : `${t.name} ${t.path}:${t.line} ${t.evidence} depth=${t.depth}${t.via ? ` via ${t.via}` : ''}`
const chain = (t: Row | undefined) => t?.chain.map((h) => `${h.name} ${h.path}:${h.line}`) ?? []
const DISPATCH = 'calls through interfaces and base classes are not followed'
const lean = (s: string) => runTool(d, 'find_tests', { ...subject(s), envelope: 'lean' }).text!.split('\n').slice(1)

describe('FR101 FR103 FR104 FR107 find_tests names how it knows each test reaches the subject, with the chain (scenario 1)', () => {
  const SCENARIO: Array<[string, string[], string[]]> = [
    ['src/core.ts#core', ['serviceDoubles test/service.test.ts:2 transitive_call depth=2'], ['serviceDoubles test/service.test.ts:3', 'service src/service.ts:3', 'core src/core.ts:1']],
    ['src/service.ts#service', ['serviceDoubles test/service.test.ts:2 call depth=1'], ['serviceDoubles test/service.test.ts:3', 'service src/service.ts:2']],
    ['src/shape.ts#Unit', ['areaThroughInterface test/shape.test.ts:2 call depth=1'], ['areaThroughInterface test/shape.test.ts:3', 'Unit src/shape.ts:4']],
    ['src/shape.ts#Unit.area', ['areaThroughInterface test/shape.test.ts:2 dispatch depth=1 via Shape.area'], ['areaThroughInterface test/shape.test.ts:4', 'Unit.area src/shape.ts:5']],
    ['src/consts.ts#LIMIT', ['limitIsTen test/core.test.ts:3 reference depth=1'], ['limitIsTen test/core.test.ts:4', 'LIMIT src/consts.ts:1']],
    ['src/core.ts#untested', ['test/core.test.ts:1 import_only'], []],
    ['src/core.ts', ['serviceDoubles test/service.test.ts:2 transitive_call depth=2', 'test/core.test.ts:1 import_only'], ['serviceDoubles test/service.test.ts:3', 'service src/service.ts:3', 'core src/core.ts:1']],
    ['test/service.test.ts#serviceDoubles', [], []],
  ]
  it.each(SCENARIO)('%s', (subject, rows, first) => {
    const env = ask(subject)
    expect(env.data.tests.map(line)).toEqual(rows)
    expect(chain(env.data.tests[0])).toEqual(first)
    expect(env.limitations).toContain('Test code is recognised by path and project naming, not by test framework attributes.')
  })

  it('a symbol id names the same subject as name and path', () => {
    const id = withSnapshot(d, (db) => (db.prepare("select id from symbol where qualified_name = 'src/core:core'").get() as { id: string }).id)
    expect((tool(d, 'find_tests', { subject_ids: [id] }).data as { tests: Row[] }).tests.map(line)).toEqual(['serviceDoubles test/service.test.ts:2 transitive_call depth=2'])
  })


  it('a file subject pages by max_rows with honest totals and a cursor', () => {
    const first = ask('src/core.ts', { max_rows: 1 })
    expect(first.data.tests.map(line)).toEqual(['serviceDoubles test/service.test.ts:2 transitive_call depth=2'])
    expect(first.data.totals).toMatchObject({ tests: 2, executing: 1, not_executing: 1 })
    const rest = tool(d, 'find_tests', { paths: ['src/core.ts'], limits: { max_rows: 1 }, cursor: first.completion.next_cursor }) as unknown as typeof first
    expect(rest.data.tests.map(line)).toEqual(['test/core.test.ts:1 import_only'])
    expect(rest.completion.next_cursor).toBeNull()
  })
})

describe('FR105 totals split executing from not-executing evidence (scenario 2)', () => {
  it.each([['src/core.ts#core', 1, 0], ['src/core.ts#untested', 0, 1], ['src/consts.ts#LIMIT', 0, 1]])('%s: %i executing, %i not', (subject, executing, notExecuting) => {
    expect(ask(subject).data.totals).toMatchObject({ executing, not_executing: notExecuting })
  })
})

describe('FR101 dispatch is followed where the snapshot records implements and overrides, and the answer says where it is not (scenario 3)', () => {
  it('TypeScript records them, so Unit.area and a function carry no dispatch limitation', () => {
    expect(ask('src/shape.ts#Unit.area').limitations.filter((l) => l.includes(DISPATCH))).toEqual([])
    expect(ask('src/core.ts#core').limitations.filter((l) => l.includes(DISPATCH))).toEqual([])
  })

  it('a method of a language whose adapter records neither carries the limitation, naming that adapter', async () => {
    const repo = tmpDir('pm-reach-py-')
    fs.mkdirSync(path.join(repo, 'src'))
    fs.mkdirSync(path.join(repo, 'tests'))
    fs.writeFileSync(path.join(repo, 'src', 'shape.py'), 'class Unit:\n    def area(self):\n        return 1\n')
    fs.writeFileSync(path.join(repo, 'tests', 'test_shape.py'), 'from src.shape import Unit\n\n\ndef test_area():\n    assert Unit().area() == 1\n')
    const { dataDir } = await indexedDataDir(repo)
    const env = tool(dataDir, 'find_tests', { subject_ids: [symbolId(dataDir, 'src/shape:Unit.area')] })
    expect(env.limitations.filter((l) => l.includes(DISPATCH))).toEqual([expect.stringMatching(/not followed for \S+ code/)])
  }, 120000)
})

describe('FR101 a lean find_tests row is the test at its first call toward the subject, tagged by evidence other than a call', () => {
  it.each([
    ['src/core.ts', ['serviceDoubles test/service.test.ts:3 depth=2', 'test/core.test.ts:1 import_only']],
    ['src/service.ts#service', ['serviceDoubles test/service.test.ts:3 depth=1']],
    ['src/shape.ts#Unit.area', ['areaThroughInterface test/shape.test.ts:4 depth=1 dispatch']],
    ['src/consts.ts#LIMIT', ['limitIsTen test/core.test.ts:4 depth=1 reference']],
  ])('%s', (s, rows) => {
    expect(lean(s).filter((l) => !l.startsWith('# '))).toEqual(rows)
  })
})

describe('FR102 TypeScript records a read of a repository variable, and a function or method used as a value, as a reference', () => {
  it('one value reference per user and target at its first use; a call alone is no reference', async () => {
    const repo = tmpDir('pm-reach-values-')
    fs.mkdirSync(path.join(repo, 'src'))
    fs.writeFileSync(path.join(repo, 'src', 'values.ts'), [
      'export const LIMIT = 10',
      'export function helper(): number { return LIMIT + LIMIT }',
      'export function run(f: () => number): number { return f() }',
      'export function main(): number {',
      '  return run(helper) + helper() + run(helper)',
      '}',
      'export class K {',
      '  m(): number { return 1 }',
      '  use(): number { return run(this.m) }',
      '}',
      '',
    ].join('\n'))
    const { dataDir } = await indexedDataDir(repo)
    const refs = (from: string) => (tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, from), direction: 'out', types: ['references'] }).data.relationships as Array<{ other: { qualified_name: string }; site: { start_line: number }; detail?: { use?: string } }>)
      .map((r) => `${r.other.qualified_name}:${r.site.start_line} ${r.detail?.use}`)
    expect(refs('src/values:helper')).toEqual(['src/values:LIMIT:2 value'])
    expect(refs('src/values:main')).toEqual(['src/values:helper:5 value'])
    expect(refs('src/values:K.use')).toEqual(['src/values:K.m:9 value'])
  }, 120000)
})

describe('FR101 only calls and dispatch count as executing a subject: not heritage, not a sibling member, not an alias', () => {
  let w: string, rid: string
  const askIn = (s: string) => (tool(w, 'find_tests', { repository_id: rid, ...subject(s) }).data as { tests: Row[] }).tests.map(line)
  beforeAll(async () => {
    const repo = tmpDir('pm-reach-edges-')
    fs.cpSync(REPO, repo, { recursive: true })
    const write = (file: string, lines: string[]) => fs.writeFileSync(path.join(repo, file), [...lines, ''].join('\n'))
    write('src/heritage.ts', ['export interface Sized {', '  size(): number', '}', 'export class Box implements Sized {', '  size(): number {', '    return 2', '  }', '}'])
    write('test/box.test.ts', ["import { Box } from '../src/heritage'", 'export function boxSize(): void {', "  if (new Box().size() !== 2) throw new Error('size')", '}'])
    write('src/holder.ts', ["import { core } from './core'", 'export class Holder {', '  value = core(1)', '  static label(): string {', "    return 'h'", '  }', '}'])
    write('test/holder.test.ts', ["import { Holder } from '../src/holder'", 'export function holderLabel(): void {', "  if (Holder.label() !== 'h') throw new Error('label')", '}'])
    write('test/alias.test.ts', ["import { core as untested } from '../src/core'", 'export const aliased = typeof untested'])
    write('test/fake.test.ts', ["import { Box } from '../src/heritage'", 'export class BigBox extends Box {', '  size(): number {', '    return 3', '  }', '}'])
    write('src/limits.ts', ["import { LIMIT } from './consts'", 'export function limitTwice(): number {', '  return LIMIT * 2', '}'])
    write('src/either.ts', ['export class A {', '  run(): number {', '    return 1', '  }', '}', 'export class B {', '  run(): number {', '    return 2', '  }', '}'])
    write('test/either.test.ts', ["import { A, B } from '../src/either'", 'export function either(x: A | B): number {', '  return x.run()', '}'])
    write('test/twice.test.ts', ["import { limitTwice } from '../src/limits'", 'export function twice(): void {', '  limitTwice()', '}'])
    ;({ dataDir: w, repoId: rid } = await indexedDataDir(repo))
  }, 120000)

  it('a call through a union names each member as a candidate only: the answer counts it and lists no test', () => {
    const env = tool(w, 'find_tests', { repository_id: rid, ...subject('src/either.ts#A.run') })
    expect((env.data as { tests: Row[] }).tests).toEqual([])
    expect(env.limitations).toContain('1 call site with no single resolved target names code on these paths as a candidate; a test that reaches the subject only through one is not listed.')
  })

  it('a test calling the implementation does not execute the interface member it implements', () => {
    expect(askIn('src/heritage.ts#Sized.size')).toEqual([])
  })

  it('a test-code class extending the subject references it; it does not call it', () => {
    expect(askIn('src/heritage.ts#Box')).toEqual(['boxSize test/box.test.ts:2 call depth=1', 'BigBox test/fake.test.ts:2 reference depth=1'])
  })

  it('a test that calls code reading the subject is not a reference of its own', () => {
    expect(askIn('src/consts.ts#LIMIT')).toEqual(['limitIsTen test/core.test.ts:3 reference depth=1'])
  })

  it('a search stopped at the depth limit does not say that find_tests does not page', () => {
    const env = tool(w, 'find_tests', { repository_id: rid, ...subject('src/core.ts#core'), limits: { max_depth: 1 } })
    expect(env.completion.stop_reasons).toContain('max_depth')
    expect(env.limitations.join(' ')).not.toMatch(/does not page/)
  })

  it('in a workspace, says the other repositories\' tests are not searched', async () => {
    const other = tmpDir('pm-reach-other-')
    fs.cpSync(REPO, other, { recursive: true })
    const root = (tool(w, 'list_repositories').data as { repositories: Array<{ id: string; root: string }> }).repositories.find((r) => r.id === rid)!
    expect(tool(w, 'find_tests', { repository_id: rid, ...subject('src/core.ts#core') }).limitations).not.toContain('Tests in the other repositories of this workspace are not searched.')
    for (const args of [['repo', 'add', other], ['index', other], ['workspace', 'add', 'pair', root.root, other]]) expect(cli(['--data-dir', w, ...args]).status).toBe(0)
    expect(tool(w, 'find_tests', { repository_id: rid, ...subject('src/core.ts#core') }).limitations).toContain('Tests in the other repositories of this workspace are not searched.')
  }, 120000)

  it('a test calling a static member of a class whose initializer calls the subject does not reach the subject', () => {
    expect(askIn('src/core.ts#core').filter((r) => r.includes('holder'))).toEqual([])
  })

  it('an import that binds another export under the subject\'s name is not import_only evidence for it', () => {
    expect(askIn('src/core.ts#untested')).toEqual(['test/core.test.ts:1 import_only'])
  })
})

describe('FR106 proofmesh tests prints the rows and exits by whether a test executes the subject (scenario 5)', () => {
  it('exits 0 for core, printing its row and chain; 1 for untested; 2 for an unknown subject or a usage error', () => {
    const core = cli(['--data-dir', d, 'tests', REPO, 'src/core.ts#core'])
    expect(core.status).toBe(0)
    expect(core.stdout).toContain('serviceDoubles test/service.test.ts:2 transitive_call depth=2\n  serviceDoubles test/service.test.ts:3 -> service src/service.ts:3 -> core src/core.ts:1\n')
    expect(core.stdout).toContain('executing 1, not executing 0')
    const untested = cli(['--data-dir', d, 'tests', REPO, 'src/core.ts#untested'])
    expect(untested.status).toBe(1)
    expect(untested.stdout).toContain('test/core.test.ts:1 import_only\n')
    expect(cli(['--data-dir', d, 'tests', REPO, 'src/core.ts#nothing']).status).toBe(2)
    expect(cli(['--data-dir', d, 'tests', REPO, 'src/nowhere.ts']).status).toBe(2)
    expect(cli(['--data-dir', d, 'tests', REPO]).status).toBe(2)
  })

  it('prints every row past one page, and takes a path holding # as that file', async () => {
    const repo = tmpDir('pm-reach-cli-')
    fs.cpSync(REPO, repo, { recursive: true })
    const many = Array.from({ length: 101 }, (_, i) => `export function t${i}(): void {\n  service(${i})\n}`)
    fs.writeFileSync(path.join(repo, 'test', 'many.test.ts'), ["import { service } from '../src/service'", ...many, ''].join('\n'))
    fs.writeFileSync(path.join(repo, 'src', 'hash#map.ts'), 'export function hashed(): number {\n  return 1\n}\n')
    const { dataDir } = await indexedDataDir(repo)
    const r = cli(['--data-dir', dataDir, 'tests', repo, 'src/service.ts#service'])
    expect(r.status).toBe(0)
    expect(r.stdout.match(/ call depth=1\n/g)).toHaveLength(102)
    expect(cli(['--data-dir', dataDir, 'tests', repo, 'src/hash#map.ts']).status).toBe(1)
  }, 120000)

  it('--json prints the find_tests answer', () => {
    const r = cli(['--data-dir', d, 'tests', REPO, 'src/core.ts', '--json'])
    expect(r.status).toBe(0)
    const env = JSON.parse(r.stdout)
    expect(env.tool).toBe('find_tests')
    expect(env.data.tests).toEqual(ask('src/core.ts').data.tests)
  })
})
