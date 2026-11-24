import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { runKit } from '../src/conformance/kit.js'
import { BUILT_IN } from '../src/indexer/languages.js'
import { expectedFor, fixtureRepo, indexedDataDir, symbolId, tmpDir, tool, withSnapshot } from './helpers.js'

const build = () => { const b = BUILT_IN.find((x) => x.id === 'build')!; return { id: 'build', entry: b.entry()!, extensions: b.extensions, configNames: [] } }
const EXPECTED = expectedFor('build-graph')
let fixtureDir: Promise<string> | undefined
const fixtureIndex = () => (fixtureDir ??= indexedDataDir(fixtureRepo('build-graph')).then((r) => r.dataDir))

type Row = { type: string; from: string; to: string | null; resolution: string; reason: string | null; origin: string; detail: Record<string, string> | null; line: number; path: string; candidates: string[] }
/** Every assertion of the given types, with the line and file where it is declared. */
function rows(db: Database.Database, ...types: string[]): Row[] {
  const marks = types.map(() => '?').join(', ')
  const found = db.prepare(`select a.id, a.type, a.origin, a.resolution, a.reason, a.detail, s.qualified_name as src, t.qualified_name as dst, x.module as xm, x.name as xn from assertion a join symbol s on s.id = a.source_id left join symbol t on t.id = a.target_id and a.target_kind = 'symbol' left join external_symbol x on x.id = a.target_id and a.target_kind = 'external' where a.type in (${marks})`).all(...types) as Array<{ id: string; type: string; origin: string; resolution: string; reason: string | null; detail: string | null; src: string; dst: string | null; xm: string | null; xn: string | null }>
  return found.map((r) => {
    const ev = db.prepare('select e.start_line, f.path from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ?').get(r.id) as { start_line: number; path: string }
    const candidates = (db.prepare('select s.qualified_name || \'@\' || f.path as n from assertion_candidate c join symbol s on s.id = c.symbol_id join file f on f.id = s.file_id where c.assertion_id = ? order by c.rank').all(r.id) as Array<{ n: string }>).map((c) => c.n)
    return { type: r.type, from: r.src, to: r.xm ? `${r.xm}:${r.xn}` : r.dst, resolution: r.resolution, reason: r.reason, origin: r.origin, detail: r.detail ? JSON.parse(r.detail) : null, line: ev.start_line, path: ev.path, candidates }
  }).sort((a, b) => a.from.localeCompare(b.from) || String(a.to).localeCompare(String(b.to)) || a.line - b.line)
}

/** A throwaway repository, indexed through the same path as a fixture. */
async function indexedRepo(files: Record<string, string>) {
  const repo = tmpDir('pm-bg-')
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text) }
  return { repo, ...(await indexedDataDir(repo)) }
}
const json = (o: unknown) => JSON.stringify(o, null, 2) + '\n'

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
