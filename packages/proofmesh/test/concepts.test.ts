import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { fileTerms, identifierWords, queryTerms, tokenTerms } from '../src/indexer/terms.js'
import { runTool } from '../src/query/tools.js'
import { indexedRepo, ROOT, tool, withSnapshot } from './helpers.js'

// A small repository named as the parity fixture (TypeORM src/) names its relation loading: the words of `lazy relation loader`
// occur only inside identifiers, never as prose, and other classes share some of them.
const FILES: Record<string, string> = {
  'src/query-builder/RelationLoader.ts': [
    'import { buildJoinCondition } from "./JoinBuilder"',
    'export class RelationLoader {',
    '  load(entity: object, relationName: string) { return this.loadManyToOneOrOneToOneOwner(entity, relationName) }',
    '  loadManyToOneOrOneToOneOwner(entity: object, relationName: string) { return buildJoinCondition(entity, relationName) }',
    '  loadOneToManyOrOneToOneNotOwner(entity: object, relationName: string) { return buildJoinCondition(entity, relationName) }',
    '  enableLazyLoad(entity: object) { return this.load(entity, "") }',
    '}',
  ].join('\n'),
  'src/query-builder/JoinBuilder.ts': 'export function buildJoinCondition(a: object, b: string) { return [a, b] }\n',
  'src/metadata/RelationMetadata.ts': 'export class RelationMetadata {\n  isLazy = false\n  inverseSidePropertyPath = ""\n}\n',
  'src/metadata/ColumnMetadata.ts': 'export class ColumnMetadata {\n  propertyName = ""\n  getEntityValue(entity: object) { return entity }\n}\n',
  'src/util/OrmUtils.ts': 'export function mergeDeep(target: object, source: object) { return Object.assign(target, source) }\nexport function getValue(data: object) { return data }\n',
  'src/repository/Repository.ts': 'export class Repository {\n  find(options: object) { return [options] }\n  getValue(data: object) { return data }\n}\n',
  // Test code that names the loader more often than the loader itself does.
  'test/relation-loader.test.ts': 'import { RelationLoader } from "../src/query-builder/RelationLoader"\nexport function testLazyRelationLoader() { return [new RelationLoader(), "lazy relation loader lazy relation loader"] }\n',
  // A generated file that matches every word.
  'src/generated/LazyRelationLoaderProxy.ts': '// @generated\nexport class LazyRelationLoaderProxy { lazyRelationLoader() { return "lazy relation loader" } }\n',
  'tsconfig.json': '{ "compilerOptions": { "strict": false }, "include": ["src", "test"] }\n',
}

type Row = { id: string; kind: string; qualified_name: string; path: string; start_line: number; score: number; terms: string[]; via?: string }
type File = { path: string; line: number; score: number; terms: string[] }
let d: string
const ask = (input: Record<string, unknown>) => tool(d, 'search_concepts', { envelope: 'full', ...input })
const names = (rows: Row[]) => rows.map((r) => r.qualified_name.slice(r.qualified_name.indexOf(':') + 1))

beforeAll(async () => { ({ dataDir: d } = await indexedRepo(FILES)) }, 120000)

describe('FR581 the term index: identifier words, path segments, comments and strings, stored in the snapshot', () => {
  it('FR581 splits camelCase, PascalCase and snake_case, keeps a multi-word identifier whole, and drops stop words', () => {
    expect(identifierWords('HTTPRequestLoader')).toEqual(['http', 'request', 'loader'])
    expect(identifierWords('enableLazyLoad')).toEqual(['enable', 'lazy', 'load'])
    expect(tokenTerms('relation_loader')).toEqual(['relation', 'loader', 'relationloader'])
    expect(queryTerms('lazy relation loader')).toEqual(['lazy', 'relation', 'loader', 'lazyrelation', 'relationloader', 'lazyrelationloader'])
    expect(tokenTerms('the')).toEqual([])
    const terms = fileTerms('src/query/RelationLoader.py', '# loads a lazy relation\nx = "row duplicated"\n')
    expect(Object.fromEntries(terms)).toEqual({ src: [0], query: [0], relation: [0, 1], loader: [0], relationloader: [0], loads: [1], lazy: [1], row: [2], duplicated: [2] })
  })

  it('FR581 is filled at index time, per file, with the path on line 0 and every occurrence by line', () => {
    const rows = withSnapshot(d, (db) => db.prepare("select t.term, t.lines from term t join file f on f.id = t.file_id where f.path = 'src/query-builder/RelationLoader.ts' and t.term in ('loader', 'lazy', 'relationloader')").all())
    expect(rows).toEqual([{ term: 'lazy', lines: '6' }, { term: 'loader', lines: '0 2' }, { term: 'relationloader', lines: '0 2' }])
  })
})

describe('FR580 search_concepts ranks symbols and files against a description, with no model', () => {
  it('FR580 SC-003 finds RelationLoader and its load methods in the top 5 from `lazy relation loader`, words that occur only inside identifiers', () => {
    const top = names((ask({ text: 'lazy relation loader' }).data.symbols as Row[]).slice(0, 5))
    expect(top).toContain('RelationLoader')
    expect(top).toContain('RelationLoader.load')
    expect(top.filter((n) => n.startsWith('RelationLoader.load') || n === 'RelationLoader.enableLazyLoad').length).toBeGreaterThanOrEqual(3)
  })

  it('FR580 SC-002 gives every row file:line, a score and at most five matched terms, as lean rows too', () => {
    const env = ask({ text: 'Rows are duplicated when a lazy relation is loaded twice through the RelationLoader; see enableLazyLoad and loadManyToOneOrOneToOneOwner' })
    const { symbols, files } = env.data as { symbols: Row[]; files: File[] }
    expect(symbols.length).toBeGreaterThan(0)
    expect(files.length).toBeGreaterThan(0)
    for (const r of [...symbols, ...files]) {
      expect(r.score).toBeGreaterThan(0)
      expect(r.terms.length).toBeLessThanOrEqual(5)
    }
    // Only a row graph proximity reached may have no term of its own.
    for (const s of symbols) if (!s.via) expect(s.terms.length).toBeGreaterThanOrEqual(1)
    for (const s of symbols) expect(s.start_line).toBeGreaterThanOrEqual(1)
    for (const f of files) expect(f.line).toBeGreaterThanOrEqual(1)
    expect(files[0]!.path).toBe('src/query-builder/RelationLoader.ts')
    const lean = runTool(d, 'search_concepts', { text: 'lazy relation loader', envelope: 'lean' }).text!.split('\n').filter((l) => !l.startsWith('#'))
    expect(lean.length).toBeGreaterThan(0)
    for (const row of lean) expect(row).toMatch(/\S+:\d+ .*score=\d+(\.\d+)?( terms=[^\s,]+(,[^\s,]+){0,4})?( via=\S+)?$/)
    const loader = (ask({ text: 'lazy relation loader' }).data.files as File[]).find((f) => f.path === 'src/query-builder/RelationLoader.ts')!
    expect(lean).toContain(`src/query-builder/RelationLoader.ts:${loader.line} file score=${loader.score} terms=${loader.terms.join(',')}`)
  })

  it('FR582 a symbol reached through graph proximity says via the match it is near, and the ranking is deterministic', () => {
    const first = ask({ text: 'lazy relation loader' }).data.symbols as Row[]
    const join = first.find((r) => r.qualified_name.endsWith(':buildJoinCondition'))
    expect(join?.via).toMatch(/^RelationLoader\.load/)
    expect(join!.terms).toEqual([])
    const lean = runTool(d, 'search_concepts', { text: 'lazy relation loader', envelope: 'lean' }).text!
    expect(lean).toMatch(/^buildJoinCondition src\/query-builder\/JoinBuilder\.ts:1 function score=\S+ via=RelationLoader\.load\S*$/m)
    expect(ask({ text: 'lazy relation loader' }).data.symbols).toEqual(first)
  })

  it('FR583 a query with no match returns no rows and says no indexed term matched', () => {
    const env = ask({ text: 'zyzzyva quuxly frobnicated' })
    expect(env.data).toEqual({ symbols: [], files: [], terms: [] })
    expect(env.limitations.some((l) => l.startsWith('no indexed term matched'))).toBe(true)
    const lean = runTool(d, 'search_concepts', { text: 'zyzzyva', envelope: 'lean' }).text!
    expect(lean.split('\n').filter((l) => !l.startsWith('#'))).toEqual([])
    expect(lean).toContain('# no indexed term matched')
  })
})

describe('FR584 the edge cases of concept search', () => {
  it('FR584 weighs a common identifier down by its frequency in the repository', () => {
    // export is in every file, lazy in a few.
    const terms = ask({ text: 'export the lazy relation' }).data.terms as string[]
    expect(terms.indexOf('lazy')).toBeLessThan(terms.indexOf('export'))
    expect(terms).not.toContain('the')
  })

  it('FR584 ranks test code below production code unless include_tests is true', () => {
    const paths = (input: Record<string, unknown>) => [...new Set([...(ask(input).data.files as File[]).map((f) => f.path)])]
    const ranked = paths({ text: 'lazy relation loader' })
    expect(ranked).toContain('test/relation-loader.test.ts')
    expect(ranked.at(-1)).toBe('test/relation-loader.test.ts')
    expect(paths({ text: 'lazy relation loader', include_tests: true }).indexOf('test/relation-loader.test.ts')).toBeLessThan(ranked.indexOf('test/relation-loader.test.ts'))
  })

  it('FR584 leaves out a file flagged generated', () => {
    const env = ask({ text: 'lazy relation loader proxy' })
    expect([...(env.data.files as File[]).map((f) => f.path), ...(env.data.symbols as Row[]).map((s) => s.path)]).not.toContain('src/generated/LazyRelationLoaderProxy.ts')
  })

  it('FR584 keeps the 32 heaviest terms of a long query and says how many it left out', () => {
    const words = withSnapshot(d, (db) => (db.prepare('select distinct term from term order by term').all() as Array<{ term: string }>).map((r) => r.term))
    expect(words.length).toBeGreaterThan(32)
    const env = ask({ text: words.join(' ') })
    expect(env.data.terms).toHaveLength(32)
    // Every indexed word, and the runs of adjacent words the index also holds whole.
    const dropped = env.data.terms_dropped as number
    expect(dropped).toBeGreaterThanOrEqual(words.length - 32)
    expect(env.limitations).toContain(`The text has ${32 + dropped} indexed terms; only the 32 heaviest were ranked by, and ${dropped} lighter ones were left out.`)
  })

  it('FR580 narrows by path_prefix and kinds', () => {
    const env = ask({ text: 'lazy relation loader', path_prefix: 'src/metadata/', kinds: ['class'] })
    expect((env.data.symbols as Row[]).map((s) => [s.kind, s.path])).toEqual([['class', 'src/metadata/RelationMetadata.ts']])
    expect((env.data.files as File[]).map((f) => f.path)).toEqual(['src/metadata/RelationMetadata.ts'])
  })
})

describe('FR585 the localisation harness under bench/localise', () => {
  it('FR585 indexes Python without Pyright under PROOFMESH_PYRIGHT=off: calls unresolved, and the toolchain says so', async () => {
    const files = { 'shop/cart.py': 'from shop.prices import price\n\ndef total(items):\n    return sum(price(i) for i in items)\n', 'shop/prices.py': 'def price(item):\n    return item\n' }
    process.env.PROOFMESH_PYRIGHT = 'off'
    let off: string
    try { ({ dataDir: off } = await indexedRepo(files)) } finally { delete process.env.PROOFMESH_PYRIGHT }
    const facts = (dir: string) => withSnapshot(dir, (db) => ({
      calls: db.prepare("select a.resolution, json_extract(a.detail, '$.why') as why from assertion a join symbol s on s.id = a.source_id where a.type = 'calls' and s.name = 'total' and json_extract(a.detail, '$.callee') = 'price'").all(),
      pyright: (JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value) as Array<{ id: string; toolchain: { pyright: string } }>).find((a) => a.id === 'python')!.toolchain.pyright,
      symbols: (db.prepare("select qualified_name from symbol where kind = 'function' order by 1").all() as Array<{ qualified_name: string }>).map((r) => r.qualified_name),
    }))
    const { dataDir: on } = await indexedRepo(files)
    expect(facts(off)).toEqual({ calls: [{ resolution: 'unresolved', why: 'pyright_off' }], pyright: 'off', symbols: ['shop/cart:total', 'shop/prices:price'] })
    expect(facts(on).pyright).toMatch(/^\d+\.\d+\.\d+$/)
    expect(facts(on).symbols).toEqual(facts(off).symbols)
  }, 180000)

  it('FR585 pins its sample: 50 ids drawn by the seeded sample() and a base commit for each, with no dataset committed', async () => {
    const { sample, patchLines, bm25 } = await import(path.join(ROOT, 'bench/localise/run.mjs'))
    const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/localise/instances.json'), 'utf8'))
    expect(pinned.ids).toHaveLength(50)
    expect(Object.keys(pinned.base_commits).sort()).toEqual([...pinned.ids].sort())
    expect(sample(['c', 'a', 'b', 'd'], 1, 2)).toEqual(sample(['d', 'b', 'a', 'c'], 1, 2))
    expect(fs.readdirSync(path.join(ROOT, 'bench/localise')).filter((f) => f !== 'out').sort()).toEqual(['README.md', 'functions.py', 'instances.json', 'run.mjs'])
    const lines = patchLines('diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -3,3 +3,3 @@ def f():\n     a = 1\n-    b = 2\n+    b = 3\n     c = 4\n')
    expect([...lines.keys()]).toEqual(['x.py'])
    expect([...lines.get('x.py').removed]).toEqual([4])
    expect(bm25([{ key: 'a', text: 'lazy relation loader' }, { key: 'b', text: 'eager column' }, { key: 'c', text: 'other words' }], 'lazy loader')).toEqual(['a'])
  })
})
