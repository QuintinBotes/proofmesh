import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { runKit } from '../src/conformance/kit.js'
import { BUILT_IN } from '../src/indexer/languages.js'
import { expectedFor, fixtureRepo, indexedDataDir, indexedRepo, json, rows, symbolId, tmpDir, tool, withSnapshot } from './helpers.js'

const build = () => { const b = BUILT_IN.find((x) => x.id === 'build')!; return { id: 'build', entry: b.entry()!, extensions: b.extensions, configNames: [] } }
const EXPECTED = expectedFor('build-graph')
let fixtureDir: Promise<string> | undefined
const fixtureIndex = () => (fixtureDir ??= indexedDataDir(fixtureRepo('build-graph')).then((r) => r.dataDir))

describe('FR124 FR125 FR126 FR127 the build graph of JavaScript and Go: each file in its declared module, each module its declared dependencies', () => {
  it('FR124 issue 5 scenario 1: find_symbols with kind project returns one project per named manifest, at the line of its name', async () => {
    const d = await fixtureIndex()
    // find_symbols searches by name, so ask for each declared name and keep the projects.
    const names = ['@acme/ui', '@acme/core', 'example.com/svc', 'example.com/lib']
    const hits = names.flatMap((n) => tool(d, 'find_symbols', { text: n, kinds: ['project'] }).data.symbols as Array<{ qualified_name: string; path: string; start_line: number }>)
    const found = [...new Set(hits.map((s) => `${s.qualified_name} ${s.path}:${s.start_line}`))].sort()
    expect(found).toEqual([
      '@acme/core packages/core/package.json:2', '@acme/ui packages/ui/package.json:2', 'example.com/lib lib/go.mod:1', 'example.com/svc svc/go.mod:1',
    ])
  }, 240000)

  it('FR126 issue 5 scenario 2: depends_on rows are resolved, from the configuration adapter, at the line that declares each', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      expect(rows(db, 'depends_on').map((r) => [r.from, r.to, r.resolution, r.origin, r.path, r.line])).toEqual([
        ['@acme/ui', '@acme/core', 'resolved', 'configuration_adapter', 'packages/ui/tsconfig.json', 3],
        ['@acme/ui', '@acme/core', 'resolved', 'configuration_adapter', 'packages/ui/package.json', 5],
        ['example.com/svc', 'example.com/lib', 'resolved', 'configuration_adapter', 'svc/go.mod', 5],
      ])
    })
  }, 240000)

  it('FR127 issue 5 scenario 3: depends_on_package rows are resolved_external with the declared version', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      expect(rows(db, 'depends_on_package').map((r) => [r.from, r.to, r.resolution, r.detail, r.path, r.line])).toEqual([
        ['@acme/ui', 'npm:react', 'resolved_external', { version: '^18.3.1' }, 'packages/ui/package.json', 6],
        ['example.com/svc', 'go:github.com/spf13/cobra', 'resolved_external', { version: 'v1.8.1' }, 'svc/go.mod', 7],
      ])
    })
  }, 240000)

  it('FR125 issue 5 scenario 4: every source file is contained by the project of its nearest named manifest, and a file under none by none', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      const sources = db.prepare("select f.path, (select p.qualified_name from assertion a join symbol p on p.id = a.source_id where a.type = 'contains' and p.kind = 'project' and a.target_id = m.id) as project from symbol m join file f on f.id = m.file_id where m.kind = 'module' order by f.path").all()
      expect(sources).toEqual([
        { path: 'lib/lib.go', project: 'example.com/lib' },
        { path: 'packages/core/src/index.ts', project: '@acme/core' },
        { path: 'packages/ui/src/button.ts', project: '@acme/ui' },
        { path: 'packages/ui/src/theme.ts', project: '@acme/ui' },
        { path: 'scripts/orphan.ts', project: null },
        { path: 'svc/main.go', project: 'example.com/svc' },
      ])
    })
  }, 240000)

  it('FR125 issue 5 scenario 5: analyze_impact groups the dependent of color under its project, not (no project)', async () => {
    const d = await fixtureIndex()
    const data = tool(d, 'analyze_impact', { subject_ids: [symbolId(d, 'packages/ui/src/theme:color')] }).data as { totals: { by_project: Array<{ name: string; count: number }> } }
    expect(data.totals.by_project).toEqual([{ name: '@acme/ui', count: 1 }])
  }, 240000)

  it('FR079 SC015 issue 5 scenario 7: a package.json preinstall script is read, never run', async () => {
    const d = await fixtureIndex()
    // The manifest was read (its project exists), and no script wrote its marker.
    expect(withSnapshot(d, (db) => db.prepare("select qualified_name from symbol where kind = 'project' and qualified_name = '@acme/core'").all())).toHaveLength(1)
    const repo = fixtureRepo('build-graph')
    expect(fs.readdirSync(path.join(repo, 'packages', 'core'))).toEqual(['package.json', 'src'])
    expect(fs.existsSync(path.join(repo, 'MARKER-preinstall'))).toBe(false)
  }, 240000)

  it('FR124 FR126 FR127 the build adapter passes the conformance kit on the fixture, against the hand-written expected facts', async () => {
    const r = await runKit(build(), fixtureRepo('build-graph'), EXPECTED)
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`)).toEqual([])
    expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['golden.symbols', 'golden.structure']))
  }, 240000)
})

describe('FR124 FR126 FR128 manifests that cannot be read, or name the same module twice, or reach outside the repository', () => {
  it('FR128 a manifest that does not parse fails that file with the line, and every other manifest is still read', async () => {
    const { dataDir } = await indexedRepo({
      'a/package.json': json({ name: 'a' }),
      'b/package.json': '{\n  "name": "b",\n  "dependencies": {\n    "x":\n  }\n}\n',
      'c/go.mod': 'module example.com/c\n',
    })
    withSnapshot(dataDir, (db) => {
      expect(db.prepare("select path, disposition, disposition_detail from file where path like '%/package.json' or path like '%go.mod' order by path").all()).toEqual([
        { path: 'a/package.json', disposition: 'indexed', disposition_detail: null },
        { path: 'b/package.json', disposition: 'failed', disposition_detail: expect.stringMatching(/^invalid_json:line 5\b/) },
        { path: 'c/go.mod', disposition: 'indexed', disposition_detail: null },
      ])
      expect((db.prepare("select qualified_name from symbol where kind = 'project' order by 1").all() as Array<{ qualified_name: string }>).map((r) => r.qualified_name)).toEqual(['a', 'example.com/c'])
    })
  }, 240000)

  it('FR126 a replace that points outside the repository is an unresolved depends_on, dependency_missing, naming the path', async () => {
    const { dataDir } = await indexedRepo({
      'svc/go.mod': 'module example.com/svc\n\nrequire example.com/ext v1.0.0\n\nrequire example.com/hole v1.0.0\n\nreplace example.com/ext => ../../outside\n\nreplace example.com/hole => ./hole\n',
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on').map((r) => [r.from, r.to, r.resolution, r.reason, r.detail, r.line])).toEqual([
        ['example.com/svc', null, 'unresolved', 'dependency_missing', { name: 'example.com/ext', path: '../../outside' }, 3],
        ['example.com/svc', null, 'unresolved', 'dependency_missing', { name: 'example.com/hole', path: './hole' }, 5],
      ])
      expect(rows(db, 'depends_on_package')).toEqual([])
    })
  }, 240000)

  it('FR126 two projects with the same name make a dependency on it ambiguous, with both as candidates', async () => {
    const { dataDir } = await indexedRepo({
      'package.json': json({ private: true, workspaces: ['packages/*'] }),
      'packages/a/package.json': json({ name: 'dup' }),
      'packages/b/package.json': json({ name: 'dup' }),
      'packages/c/package.json': json({ name: 'c', dependencies: { dup: 'workspace:*' } }),
    })
    withSnapshot(dataDir, (db) => {
      const [r, ...rest] = rows(db, 'depends_on')
      expect(rest).toEqual([])
      expect([r!.from, r!.resolution, r!.candidates]).toEqual(['c', 'ambiguous', ['dup@packages/a/package.json', 'dup@packages/b/package.json']])
    })
  }, 240000)

  it('FR126 the workspaces object form and its exclusions are honoured: only a member resolves by name', async () => {
    const { dataDir } = await indexedRepo({
      'package.json': json({ private: true, workspaces: { packages: ['pkgs/*', '!pkgs/skip'] } }),
      'pkgs/x/package.json': json({ name: 'x', dependencies: { y: '^1.0.0', w: '^1.0.0', z: '^1.0.0' } }),
      'pkgs/y/package.json': json({ name: 'y' }),
      'pkgs/skip/package.json': json({ name: 'w' }),
      'other/z/package.json': json({ name: 'z' }),
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on').map((r) => [r.from, r.to, r.resolution])).toEqual([['x', 'y', 'resolved']])
      expect(rows(db, 'depends_on_package').map((r) => [r.from, r.to])).toEqual([['x', 'npm:w'], ['x', 'npm:z']])
    })
  }, 240000)

  it('FR125 a package.json that names no package does not hide the project above it', async () => {
    const { dataDir } = await indexedRepo({
      'lib/package.json': json({ name: 'lib' }),
      'lib/index.ts': 'export const a = 1\n',
      'lib/esm/package.json': json({ type: 'module' }),
      'lib/esm/index.ts': 'export const b = 2\n',
    })
    withSnapshot(dataDir, (db) => {
      expect(db.prepare("select f.path, p.qualified_name as project from assertion a join symbol p on p.id = a.source_id join symbol m on m.id = a.target_id join file f on f.id = m.file_id where a.type = 'contains' order by f.path").all()).toEqual([
        { path: 'lib/esm/index.ts', project: 'lib' }, { path: 'lib/index.ts', project: 'lib' },
      ])
    })
  }, 240000)
})

describe('FR129 a manifest reaches the build adapter and every adapter that reads it as configuration', () => {
  it('FR129 package.json is read by the build adapter for its project and dependencies, and by the TypeScript adapter for the packages it declares', async () => {
    const repo = tmpDir('pm-bg-pkg-')
    fs.cpSync(fixtureRepo('ts-packages'), repo, { recursive: true })
    const { dataDir } = await indexedDataDir(repo)
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on_package').map((r) => [r.from, r.to, r.detail])).toEqual([
        ['ts-packages', 'npm:@fx/util', { version: '*' }], ['ts-packages', 'npm:absent-lib', { version: '^2.0.0' }], ['ts-packages', 'npm:greeter', { version: '^1.0.0' }],
      ])
      const adapters = JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value) as Array<{ id: string; external_inputs: string[] }>
      // Declared by package.json and absent from node_modules: only the TypeScript adapter, which was given the file too, can say so.
      expect(adapters.find((a) => a.id === 'typescript')!.external_inputs).toEqual(['npm:@fx/util missing', 'npm:absent-lib missing', 'npm:greeter missing'])
    })
  }, 240000)
})

const edges = (db: Database.Database, type = 'depends_on') => rows(db, type).map((r) => [r.from, r.to, r.resolution, r.reason, r.line] as const)

describe('FR125 FR126 FR127 FR128 workspaces and path dependencies the way npm and pnpm read them', () => {
  it('FR126 a pnpm-workspace.yaml lists the members, with ** matching zero or more directories, braces, and ! exclusions; other dependencies are packages', async () => {
    const { dataDir } = await indexedRepo({
      'package.json': json({ private: true }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'   # the apps\n  - \"libs/**/core\"\n  - 'tools/{x,y}'\n  - '!apps/skip'\nother: true\n",
      'apps/web/package.json': json({ name: 'web', dependencies: { 'lib-core': 'workspace:*', util: '^1.0.0', 'skip-pkg': '^1.0.0', tx: '^1.0.0', tz: '^1.0.0' } }),
      'apps/skip/package.json': json({ name: 'skip-pkg' }),
      'libs/core/package.json': json({ name: 'util' }),
      'libs/a/core/package.json': json({ name: 'lib-core' }),
      'tools/x/package.json': json({ name: 'tx' }),
      'tools/z/package.json': json({ name: 'tz' }),
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on').map((r) => [r.from, r.to, r.resolution]).sort()).toEqual([['web', 'lib-core', 'resolved'], ['web', 'tx', 'resolved'], ['web', 'util', 'resolved']])
      expect(rows(db, 'depends_on_package').map((r) => [r.from, r.to]).sort()).toEqual([['web', 'npm:skip-pkg'], ['web', 'npm:tz']])
    })
  }, 240000)

  it('FR126 the array form of workspaces takes ! exclusions too', async () => {
    const { dataDir } = await indexedRepo({
      'package.json': json({ private: true, workspaces: ['pkgs/*', '!pkgs/skip'] }),
      'pkgs/x/package.json': json({ name: 'x', dependencies: { y: '^1.0.0', w: '^1.0.0' } }),
      'pkgs/y/package.json': json({ name: 'y' }),
      'pkgs/skip/package.json': json({ name: 'w' }),
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on').map((r) => [r.from, r.to])).toEqual([['x', 'y']])
      expect(rows(db, 'depends_on_package').map((r) => [r.from, r.to])).toEqual([['x', 'npm:w']])
    })
  }, 240000)

  it('FR126 without any workspace list a workspace: dependency means a named package of the repository', async () => {
    const { dataDir } = await indexedRepo({
      'a/package.json': json({ name: 'a', dependencies: { b: 'workspace:^', gone: 'workspace:*' } }),
      'b/package.json': json({ name: 'b' }),
    })
    withSnapshot(dataDir, (db) => {
      expect(edges(db)).toEqual([['a', 'b', 'resolved', null, 4], ['a', null, 'unresolved', 'dependency_missing', 5]])
      expect(rows(db, 'depends_on_package')).toEqual([])
    })
  }, 240000)

  it('FR127 a file: or link: dependency on a project is a dependency on it; on a tarball or a directory that is no project it is a package; outside the repository it is missing', async () => {
    const { dataDir } = await indexedRepo({
      'app/package.json': json({ name: 'app', dependencies: { sib: 'file:../sib', ball: 'file:./vendor/ball.tgz', plain: 'link:../plain', far: 'file:../../far' } }),
      'sib/package.json': json({ name: 'sib' }),
      'plain/readme.txt': 'no manifest here\n',
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on').map((r) => [r.from, r.to, r.resolution, r.reason, r.detail])).toEqual([
        ['app', null, 'unresolved', 'dependency_missing', { name: 'far', path: '../../far' }],
        ['app', 'sib', 'resolved', null, null],
      ])
      expect(rows(db, 'depends_on_package').map((r) => [r.to, r.detail])).toEqual([['npm:ball', { version: 'file:./vendor/ball.tgz' }], ['npm:plain', { version: 'link:../plain' }]])
    })
  }, 240000)
})

describe('FR126 FR129 tsconfig references, with comments and trailing commas', () => {
  it('FR126 a reference resolves to the referenced directory\'s own project, and to none when its package.json names nothing', async () => {
    const { dataDir } = await indexedRepo({
      'package.json': json({ name: 'root' }),
      'a/package.json': json({ name: 'a' }),
      'a/tsconfig.json': '// the app\n{\n  /* options */\n  "compilerOptions": { "strict": true, },\n  "references": [\n    { "path": "../c", }, // named\n    { "path": "../b/tsconfig.json" },\n  ],\n}\n',
      'b/package.json': json({ type: 'module' }),
      'c/package.json': json({ name: 'c' }),
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on').map((r) => [r.from, r.to, r.resolution, r.reason, r.detail, r.line])).toEqual([
        ['a', 'c', 'resolved', null, null, 6],
        ['a', null, 'unresolved', 'dependency_missing', { path: '../b/tsconfig.json' }, 7],
      ])
    })
  }, 240000)

  it('FR126 FR129 tsconfig extends is not read: it adds no dependency', async () => {
    const { dataDir } = await indexedRepo({
      'a/package.json': json({ name: 'a' }),
      'a/tsconfig.json': json({ extends: '../b/tsconfig.base.json' }),
      'b/package.json': json({ name: 'b' }),
      'b/tsconfig.base.json': json({}),
    })
    withSnapshot(dataDir, (db) => expect(rows(db, 'depends_on')).toEqual([]))
  }, 240000)
})

describe('FR125 FR126 go.mod and go.work as Go reads them', () => {
  it('FR126 a go.work alone satisfies a require; block forms, indirect comments, a local replace block and a versioned replace are read; a nested go.mod owns its files', async () => {
    const { dataDir } = await indexedRepo({
      'go.work': 'go 1.22\n\nuse (\n\t./a\n\t./b\n)\n',
      'a/go.mod': 'module example.com/a\n\ngo 1.22\n\nrequire (\n\texample.com/b v0.0.0\n\texample.com/ext v1.2.3 // indirect\n\texample.com/old v1.0.0\n\texample.com/c v0.0.0\n)\n\nreplace (\n\texample.com/c => ../c\n)\n\nreplace example.com/old v1.0.0 => example.com/new v2.0.0\n',
      'a/a.go': 'package a\n\nfunc A() {}\n',
      'a/inner/go.mod': 'module example.com/a/inner\n',
      'a/inner/in.go': 'package inner\n\nfunc In() {}\n',
      'b/go.mod': 'module example.com/b\n',
      'c/go.mod': 'module example.com/c\n',
    })
    withSnapshot(dataDir, (db) => {
      expect(edges(db)).toEqual([['example.com/a', 'example.com/b', 'resolved', null, 6], ['example.com/a', 'example.com/c', 'resolved', null, 9]])
      expect(rows(db, 'depends_on_package').map((r) => [r.to, r.detail, r.line])).toEqual([['go:example.com/ext', { version: 'v1.2.3' }, 7], ['go:example.com/old', { version: 'v1.0.0' }, 8]])
      expect(db.prepare("select f.path, p.qualified_name as project from assertion a join symbol p on p.id = a.source_id join symbol m on m.id = a.target_id join file f on f.id = m.file_id where a.type = 'contains' order by f.path").all()).toEqual([
        { path: 'a/a.go', project: 'example.com/a' }, { path: 'a/inner/in.go', project: 'example.com/a/inner' },
      ])
    })
  }, 240000)

  it('FR126 a go.mod under testdata or vendor, and a package.json under either, declare no project', async () => {
    const { dataDir } = await indexedRepo({
      'svc/go.mod': 'module example.com/svc\n',
      'svc/main.go': 'package main\n\nfunc main() {}\n',
      'svc/testdata/go.mod': 'module example.com/fixture\n',
      'svc/testdata/x.go': 'package x\n\nfunc X() {}\n',
      'vendor/v/package.json': json({ name: 'vendored' }),
    })
    withSnapshot(dataDir, (db) => {
      expect((db.prepare("select qualified_name from symbol where kind = 'project'").all() as Array<{ qualified_name: string }>).map((r) => r.qualified_name)).toEqual(['example.com/svc'])
      expect(db.prepare("select f.path from assertion a join symbol m on m.id = a.target_id join file f on f.id = m.file_id where a.type = 'contains' order by f.path").all()).toEqual([{ path: 'svc/main.go' }, { path: 'svc/testdata/x.go' }])
    })
  }, 240000)
})

describe('FR125 a named package.json changes no answer other than the project a file belongs to', () => {
  const files = {
    'package.json': json({ name: 'pkg' }),
    'src/a.ts': 'export function f(): number {\n  return 1\n}\n',
    'src/b.ts': "import { f } from './a'\n\nexport function g(): number {\n  return f()\n}\n",
    'src/a.test.ts': "import { f } from './a'\n\nexport function checksF(): number {\n  return f()\n}\n",
  }
  it('FR125 analyze_impact keeps its dependents and groups them under the project; find_tests keeps its tests and states the project', async () => {
    const { dataDir } = await indexedRepo(files)
    const id = symbolId(dataDir, 'src/a:f')
    const impact = tool(dataDir, 'analyze_impact', { subject_ids: [id] }).data as { totals: { by_project: Array<{ name: string; count: number }> }; dependents: Array<{ qualified_name: string; project: string | null }> }
    expect(impact.dependents.map((d) => [d.qualified_name, d.project])).toEqual([['src/a.test:checksF', 'pkg'], ['src/b:g', 'pkg']])
    expect(impact.totals.by_project).toEqual([{ name: 'pkg', count: 2 }])
    const tests = tool(dataDir, 'find_tests', { subject_ids: [id] }).data as { tests: Array<{ qualified_name: string; project: string | null; depth: number }> }
    expect(tests.tests.map((t) => [t.qualified_name, t.project, t.depth])).toEqual([['src/a.test:checksF', 'pkg', 1]])
  }, 240000)
})

describe('FR125 a manifest is no area of its own in the overview', () => {
  it('FR125 a root package.json does not stop the overview stepping down into src, and a manifest is not listed beside the code', async () => {
    const { dataDir } = await indexedRepo({
      'package.json': json({ name: 'root-pkg' }),
      'src/a.ts': 'export function a(): number {\n  return 1\n}\n',
      'src/b/c.ts': "import { a } from '../a'\nexport function c(): number {\n  return a()\n}\n",
      'src/d/e.ts': "import { a } from '../a'\nexport function e(): number {\n  return a()\n}\n",
    })
    const data = tool(dataDir, 'get_overview', {}).data as { path: string; children: Array<{ name: string }> }
    expect(data.path).toBe('src')
    expect(data.children.map((c) => c.name).sort()).toEqual(['a.ts', 'b', 'd'])
  }, 240000)
})
