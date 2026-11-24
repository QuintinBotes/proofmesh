import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, tmpDir, tool, withSnapshot } from './helpers.js'

// fixtures/ts-imports: the expected rows below are written by hand from the fixture's source (issue #40, scenario 4).
let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir(fixtureRepo('ts-imports'))) })

const rows = (env: ReturnType<typeof tool>) => env.data.relationships as any[]
const importers = (env: ReturnType<typeof tool>) => rows(env).map((r) => [r.other.path, `${r.site.path}:${r.site.start_line}`, r.resolution, r.detail?.kind]).sort()
const dependents = (env: ReturnType<typeof tool>) => (env.data as any).dependents.map((x: any) => [x.path, x.depth, `${x.site?.path}:${x.site?.start_line}`])
const moduleOf = (dataDir: string, file: string) => {
  const found = tool(dataDir, 'find_symbols', { text: path.posix.basename(file), kinds: ['module'] }).data.symbols as Array<{ id: string; path: string }>
  return found.filter((s) => s.path === file)
}
const B_IMPORTERS = [
  ['src/a.ts', 'src/a.ts:1', 'resolved', 'static'],
  ['src/c.ts', 'src/c.ts:2', 'resolved', 'dynamic'],
  ['src/e.ts', 'src/e.ts:1', 'resolved', 're_export'],
]
const B_DEPENDENTS = [['src/a.ts', 1, 'src/a.ts:1'], ['src/c.ts', 1, 'src/c.ts:2'], ['src/e.ts', 1, 'src/e.ts:1'], ['src/g.ts', 2, 'src/g.ts:1']]

describe('FR089 every tool takes a file by its repository-relative path', () => {
  it('get_relationships path: src/b.ts, in, imports lists the static import, the import() and the re-export', () => {
    expect(importers(tool(d, 'get_relationships', { path: 'src/b.ts', direction: 'in', types: ['imports'] }))).toEqual(B_IMPORTERS)
  })

  it('analyze_impact paths: [src/b.ts], imports reaches a, c and e at depth 1 and g at depth 2', () => {
    expect(dependents(tool(d, 'analyze_impact', { paths: ['src/b.ts'], types: ['imports'] }))).toEqual(B_DEPENDENTS)
  })

  it('trace_paths, get_symbol, find_tests and get_memory take a path too', () => {
    const trace = tool(d, 'trace_paths', { source_path: 'src/g.ts', target_path: 'src/b.ts', types: ['imports'] }).data as any
    expect(trace.conclusion).toBe('path_found')
    expect(trace.paths[0].nodes.map((n: string) => trace.nodes[n].path)).toEqual(['src/g.ts', 'src/e.ts', 'src/b.ts'])
    const [b] = moduleOf(d, 'src/b.ts')
    expect((tool(d, 'get_symbol', { path: 'src/b.ts' }).data as any).symbol.id).toBe(b!.id)
    expect(tool(d, 'find_tests', { paths: ['./src/b.ts'] }).data.tests).toEqual([])
    expect(tool(d, 'get_memory', { path: 'src/b.ts' }).data.notes).toEqual([])
  })

  it('get_memory path: src/b.ts returns only the notes on that file', () => {
    for (const [id, ref] of [['b-note', 'module:src/b'], ['a-note', 'module:src/a']]) tool(d, 'save_memory', { id, title: id, kind: 'invariant', nodes: [ref], body: `about ${ref}` })
    expect((tool(d, 'get_memory', { path: 'src/b.ts' }).data.notes as Array<{ id: string }>).map((n) => n.id)).toEqual(['b-note'])
  })
})

describe('FR090 the module symbol find_symbols returns for a file answers file questions as the file does', () => {
  it('find_symbols text b.ts, kind module, gives one row whose id every tool accepts as the file', () => {
    const found = tool(d, 'find_symbols', { text: 'b.ts', kinds: ['module'] }).data.symbols as Array<{ id: string; path: string }>
    expect(found.map((s) => s.path)).toEqual(['src/b.ts'])
    const id = found[0]!.id
    expect(importers(tool(d, 'get_relationships', { subject_id: id, direction: 'in', types: ['imports'] }))).toEqual(B_IMPORTERS)
    expect(dependents(tool(d, 'analyze_impact', { subject_ids: [id], types: ['imports'] }))).toEqual(B_DEPENDENTS)
    const trace = tool(d, 'trace_paths', { source_id: moduleOf(d, 'src/g.ts')[0]!.id, target_id: id, types: ['imports'] }).data as any
    expect(trace.paths[0].nodes.map((n: string) => trace.nodes[n].path)).toEqual(['src/g.ts', 'src/e.ts', 'src/b.ts'])
  })

  it('a module symbol answers its outbound imports as the file does', () => {
    const id = moduleOf(d, 'src/g.ts')[0]!.id
    expect(importers(tool(d, 'get_relationships', { subject_id: id, direction: 'out', types: ['imports'] }))).toEqual([['src/e.ts', 'src/g.ts:1', 'resolved', 'static']])
  })
})

describe('FR091 analyze_impact over imports walks file to file, breadth first, each file once at its shortest depth', () => {
  it('max_depth bounds the walk and says so', () => {
    const env = tool(d, 'analyze_impact', { paths: ['src/b.ts'], types: ['imports'], limits: { max_depth: 1 } })
    expect(dependents(env)).toEqual(B_DEPENDENTS.slice(0, 3))
    expect(env.completion.stop_reasons).toEqual(['max_depth'])
  })

  it('a module symbol subject without imports among the types gets the same hint as its file', () => {
    expect(tool(d, 'analyze_impact', { subject_ids: [moduleOf(d, 'src/b.ts')[0]!.id] }).limitations).toContain('A file is reached only through imports; add imports to types for the files that depend on it.')
  })

  it('a file subject without imports among the types says that files are reached through imports', () => {
    const env = tool(d, 'analyze_impact', { paths: ['src/b.ts'] })
    expect((env.data as any).dependents).toEqual([])
    expect(env.limitations.join(' ')).toMatch(/through imports/)
  })
})

describe('FR092 every import row carries its kind; import() is recorded', () => {
  it('a computed import() is unresolved with reason dynamic_specifier', () => {
    const env = tool(d, 'get_relationships', { path: 'src/h.ts', direction: 'out', types: ['imports'] })
    expect(rows(env).map((r) => [r.resolution, r.reason, `${r.site.path}:${r.site.start_line}`])).toEqual([['unresolved', 'dynamic_specifier', 'src/h.ts:2']])
    expect(env.unresolved).toMatchObject({ count: 1, by_reason: { dynamic_specifier: 1 } })
  })

  it('the fixture has exactly one unresolved import, the h.ts row', () => {
    const unresolved = withSnapshot(d, (db) => db.prepare("select a.reason, f.path from assertion a join file f on f.id = a.source_id where a.type = 'imports' and a.resolution = 'unresolved'").all())
    expect(unresolved).toEqual([{ reason: 'dynamic_specifier', path: 'src/h.ts' }])
  })
})

describe('FR093 a Node.js built-in is resolved_external to node:<name>, without @types/node', () => {
  it('get_relationships path: src/d.ts, out, imports, include_external', () => {
    const env = tool(d, 'get_relationships', { path: 'src/d.ts', direction: 'out', types: ['imports'], include_external: true })
    expect(rows(env).map((r) => [r.other.module, `${r.site.path}:${r.site.start_line}`, r.resolution]).sort()).toEqual([['node:fs', 'src/d.ts:1', 'resolved_external'], ['node:path', 'src/d.ts:2', 'resolved_external']])
  })
})

describe('FR093 an explicit tsconfig paths mapping wins over a Node.js built-in, as tsc resolves it; without one the built-in wins', () => {
  let m: string
  beforeAll(async () => {
    const repo = tmpDir('pm-builtins-')
    const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text) }
    // baseUrl alone would resolve path to src/path.ts too: only a paths entry is an explicit mapping.
    write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'NodeNext', strict: true, baseUrl: './src', paths: { events: ['./events.ts'], '@lib/*': ['./lib/*'] } }, include: ['src'] }))
    write('src/events.ts', 'export const emit = 1\n')
    write('src/path.ts', 'export const join = 1\n')
    write('src/uses.ts', "import { emit } from 'events'\nimport { join } from 'path'\nexport const both = emit + Number(join)\n")
    ;({ dataDir: m } = await indexedDataDir(repo))
  })
  const imports = () => (tool(m, 'get_relationships', { path: 'src/uses.ts', direction: 'out', types: ['imports'], include_external: true }).data.relationships as any[])
    .map((r) => [r.site.start_line, r.resolution, r.other.path ?? r.other.module]).sort((a, b) => a[0] - b[0])

  it('events, mapped by paths to a repository file, is that file', () => {
    expect(imports()[0]).toEqual([1, 'resolved', 'src/events.ts'])
  })

  it('path, which no paths entry maps, is node:path though baseUrl would resolve it to src/path.ts', () => {
    expect(imports()[1]).toEqual([2, 'resolved_external', 'node:path'])
  })
})

describe('FR094 a path that is not in the snapshot is INVALID_ARGUMENT naming the path and its disposition', () => {
  const refused = (input: Record<string, unknown>, tool_ = 'get_relationships') => {
    try { tool(d, tool_, input) } catch (e: any) { return `${e.code}: ${e.message}` }
    return 'answered'
  }
  it('not found, never an empty success', () => {
    expect(refused({ path: 'src/nope.ts' })).toMatch(/^INVALID_ARGUMENT: .*src\/nope\.ts.*not found/)
    expect(refused({ paths: ['src/nope.ts'], types: ['imports'] }, 'analyze_impact')).toMatch(/^INVALID_ARGUMENT: .*not found/)
    expect(refused({ paths: ['src/nope.ts'] }, 'find_tests')).toMatch(/^INVALID_ARGUMENT: .*not found/)
    expect(refused({ path: 'src/nope.ts' }, 'get_memory')).toMatch(/^INVALID_ARGUMENT: .*not found/)
  })
  it('a path leaving the repository is refused', () => {
    expect(refused({ path: '../outside.ts' })).toMatch(/^INVALID_ARGUMENT: .*outside the repository/)
  })
})

describe('FR089 FR091 FR092 FR094 edge cases: resolution forms, cycles, JSON, two kinds from one file, path spellings', () => {
  let e: string, repo: string
  beforeAll(async () => {
    repo = tmpDir('pm-imports-')
    const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text) }
    write('package.json', JSON.stringify({ name: '@edge/self', exports: { './dep': './src/dep.ts' } }))
    write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'NodeNext', strict: true, resolveJsonModule: true, paths: { '@lib/*': ['./src/lib/*'] } }, include: ['src'] }))
    write('src/util/index.ts', 'export const u = 1\n')
    write('src/lib/l.ts', 'export const l = 1\n')
    write('src/dep.ts', 'export const dep = 1\n')
    write('src/t.ts', 'export type T = number\nexport const tv = 1\n')
    write('src/mixed.ts', "import type { T } from './t.js'\nimport { tv } from './t.js'\nexport const m: T = tv\n")
    write('src/data.json', '{ "x": 1 }\n')
    write('src/forms.ts', "import { u } from './util'\nimport { l } from '@lib/l.js'\nimport { dep } from '@edge/self/dep'\nimport type { T } from './t.js'\nimport pkg from '../package.json'\nimport data from './data.json'\nexport const all: T = u + l + dep + Number(!!pkg) + Number(!!data)\n")
    write('src/both.ts', "import { l } from './lib/l.js'\nexport const later = () => import('./lib/l.js')\nexport const now = l\n")
    write('src/cyc/x.ts', "import { y } from './y.js'\nexport const x = () => y()\n")
    write('src/cyc/y.ts', "import { x } from './x.js'\nexport const y = (): number => (x ? 1 : 0)\n")
    write('src/cyc/p.ts', "import { x } from './x.js'\nexport const p = x\n")
    write('node_modules/dep/index.ts', 'export const dep = 1\n')
    write('src/reexp.ts', "export type { T } from './t.js'\nexport { tv } from './t.js'\n")
    ;({ dataDir: e } = await indexedDataDir(repo))
  })
  const out = (file: string) => (tool(e, 'get_relationships', { path: file, direction: 'out', types: ['imports'] }).data.relationships as any[])
    .map((r) => [r.site.start_line, r.resolution, r.other.path ?? r.reason, r.detail?.kind]).sort((a, b) => a[0] - b[0])

  it('./dir, .js to .ts, tsconfig paths, package self-import, import type, and JSON imports', () => {
    expect(out('src/forms.ts')).toEqual([
      [1, 'resolved', 'src/util/index.ts', 'static'],
      [2, 'resolved', 'src/lib/l.ts', 'static'],
      [3, 'resolved', 'src/dep.ts', 'static'],
      [4, 'resolved', 'src/t.ts', 'type_only'],
      [5, 'resolved', 'package.json', 'static'],
      [6, 'unresolved', 'not_indexed', 'static'],
    ])
  })

  it('a file both imported and dynamically imported by the same file gives two rows, one per kind', () => {
    expect(out('src/both.ts')).toEqual([[1, 'resolved', 'src/lib/l.ts', 'static'], [2, 'resolved', 'src/lib/l.ts', 'dynamic']])
  })

  it('statements between the same two files stay one row (AC05), of the strongest kind, with every statement as evidence', () => {
    const [row, ...rest] = tool(e, 'get_relationships', { path: 'src/mixed.ts', direction: 'out', types: ['imports'] }).data.relationships as any[]
    expect(rest).toEqual([])
    expect([row.other.path, row.detail.kind, row.evidence_ids.length]).toEqual(['src/t.ts', 'static', 2])
    const [re, ...more] = tool(e, 'get_relationships', { path: 'src/reexp.ts', direction: 'out', types: ['imports'] }).data.relationships as any[]
    expect(more).toEqual([])
    expect([re.other.path, re.detail.kind, re.evidence_ids.length]).toEqual(['src/t.ts', 're_export', 2])
  })

  it('the impact walk terminates on an import cycle and reports each file once', () => {
    expect(dependents(tool(e, 'analyze_impact', { paths: ['src/cyc/y.ts'], types: ['imports'] }))).toEqual([['src/cyc/x.ts', 1, 'src/cyc/x.ts:1'], ['src/cyc/p.ts', 2, 'src/cyc/p.ts:1']])
  })

  it('.., absolute paths and backslashes are normalised; unsupported and excluded files are refused by disposition', () => {
    const expected = out('src/cyc/x.ts')
    for (const spelling of ['src\\cyc\\x.ts', './src/lib/../cyc/x.ts', path.join(repo, 'src', 'cyc', 'x.ts')]) expect(out(spelling)).toEqual(expected)
    const refused = (p: string) => { try { tool(e, 'get_relationships', { path: p }) } catch (err: any) { return `${err.code}: ${err.message}` } return 'answered' }
    expect(refused('src/data.json')).toMatch(/^INVALID_ARGUMENT: .*src\/data\.json.*unsupported/)
    expect(refused('node_modules/dep/index.ts')).toMatch(/^INVALID_ARGUMENT: .*node_modules\/dep\/index\.ts.*excluded/)
    expect(refused(path.join(path.dirname(repo), 'elsewhere.ts'))).toMatch(/^INVALID_ARGUMENT: .*outside the repository/)
  })
})
