import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { discover } from '../src/indexer/discovery.js'
import { BUILT_IN_REGISTRY, type Registry } from '../src/indexer/languages.js'
import { sealedPath } from '../src/meshstore/snapshot.js'
import { GENERATED_POLICY } from '../src/indexer/generated-vendored.js'
import { manifestHash } from '../src/indexer/freshness.js'
import { excludeGeneratedSql, generatedLeftOut, GENERATED_LISTINGS } from '../src/query/generated-policy.js'
import { cli, fixtureRepo, indexedDataDir, indexedRepo, tmpDir, tool, withSnapshot } from './helpers.js'

const write = (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text) }
  return root
}
const tree = (files: Record<string, string>) => write(fs.realpathSync(tmpDir('pm-gv-')), files)
const git = (cwd: string, ...args: string[]) => expect(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).status).toBe(0)
/** path to what discovery decided: `capture`, `capture:generated`, or `excluded:<detail>`. */
const found = (root: string) => Object.fromEntries(discover(root).filter((d) => d.status === 'capture' || d.status === 'excluded').map((d) => [d.path, d.status === 'excluded' ? `excluded:${d.detail}` : d.generated ? 'capture:generated' : 'capture']))
const GO = (head: string) => `${head}\npackage p\n\nfunc F() {}\n`

type Q = Record<string, unknown>
const rowsOf = (d: string, sql: string, ...args: unknown[]) => withSnapshot(d, (db) => db.prepare(sql).all(...args) as Q[])
const copyFixture = () => { const repo = fs.realpathSync(tmpDir('pm-gv-')); fs.cpSync(fixtureRepo('generated-vendored'), repo, { recursive: true }); return repo }

describe('FR290 FR291 FR292 FR293 FR294 FR295 FR296 FR297 FR298 issue 14 scenarios on fixtures/generated-vendored', () => {
  let repo: string, d: string
  beforeAll(async () => { repo = copyFixture(); d = (await indexedDataDir(repo)).dataDir }, 240000)
  const files = () => Object.fromEntries(rowsOf(d, 'select path, disposition, disposition_detail as detail, capabilities from file').map((f) => [f.path, f]))
  const flagged = (f: Q) => JSON.parse(String(f.capabilities)).generated

  it('FR290 FR291 FR293 FR295 scenario 1: stubs and marked files are indexed and flagged, vendored files are excluded by rule with the rule, a source build/ is indexed, Gradle output is not', () => {
    const f = files()
    expect(['api/v1/user.pb.go', 'docs/gen/client.ts'].map((p) => [f[p]!.disposition, flagged(f[p]!)])).toEqual([['indexed', 'true'], ['indexed', 'true']])
    expect([f['web/marked.ts']!.disposition, flagged(f['web/marked.ts']!)]).toEqual(['indexed', undefined])
    expect(['vendor/modules.txt', 'vendor/github.com/x/y/y.go', 'third_party/lib/lib.c', 'app/build/tmp/x.java'].map((p) => [f[p]!.disposition, f[p]!.detail])).toEqual([
      ['excluded_by_rule', 'vendored:go_vendor'], ['excluded_by_rule', 'vendored:go_vendor'], ['excluded_by_rule', 'vendored:third_party'], ['excluded_by_rule', 'build_output:gradle'],
    ])
    expect(f['tools/build/gen.go']!.disposition).toBe('indexed')
    expect(flagged(f['tools/build/gen.go']!)).toBeUndefined()
  })

  it('FR294 scenario 2: the import of the vendored package is resolved_external with module go:github.com/x/y and detail.vendored; the import of the repository\'s own package is not external', () => {
    const imports = rowsOf(d, `select a.resolution, a.detail, x.module, x.name from assertion a join file f on f.id = a.source_id left join external_symbol x on x.id = a.target_id and a.target_kind = 'external'
      where a.type = 'imports' and f.path = 'main.go' order by a.detail`).map((r) => [r.resolution, r.module, r.name, JSON.parse(String(r.detail)).vendored])
    expect(imports).toContainEqual(['resolved_external', 'go:github.com/x/y', 'github.com/x/y', 'true'])
    expect(imports.filter((r) => r[0] === 'resolved_external')).toHaveLength(1)
  })

  it('FR296 scenario 3: workspace_status states the policy, with the markers, attributes and paths used', () => {
    const policy = (tool(d, 'workspace_status').data as { analysis: { generated_policy: Record<string, unknown> } }).analysis.generated_policy
    expect(policy).toMatchObject({ generated: 'indexed_and_flagged', vendored: 'excluded_by_rule', attributes: ['linguist-generated', 'linguist-vendored'] })
    expect(JSON.stringify(policy)).toContain('Code generated')
    expect(JSON.stringify(policy)).toContain('third_party/')
    expect(String(policy.summary)).toContain('indexed and flagged')
  })

  it('FR297 scenario 3: the census counts generated and vendored files per language', () => {
    const rows = (tool(d, 'workspace_status').data as { languages: Array<{ language: string; files: number; generated: number; vendored: number }> }).languages
    const count = (language: string) => rows.filter((r) => r.language === language).map((r) => [r.files, r.generated, r.vendored])[0]
    expect(count('Go')).toEqual([4, 1, 1])
    expect(count('TypeScript')).toEqual([3, 1, 0])
    expect(count('C')).toEqual([1, 0, 1])
    expect(count('Java')).toEqual([1, 0, 0])
  })

  it('FR292 scenario 4: every answer row from a generated file says generated: true, and a row from another file does not', () => {
    const symbols = (text: string) => (tool(d, 'find_symbols', { text }).data as { symbols: Array<Record<string, unknown>> }).symbols
    expect(symbols('NewUser').filter((s) => s.path === 'api/v1/user.pb.go')).toEqual([expect.objectContaining({ generated: true })])
    expect(symbols('fetchUsers')[0]).toMatchObject({ path: 'docs/gen/client.ts', generated: true })
    expect(symbols('render').find((s) => s.path === 'web/marked.ts')).not.toHaveProperty('generated')
    const id = String(symbols('fetchUsers')[0]!.id)
    expect((tool(d, 'get_symbol', { symbol_id: id }).data as { symbol: Record<string, unknown> }).symbol).toMatchObject({ path: 'docs/gen/client.ts', generated: true })
    const callers = (tool(d, 'get_relationships', { subject_id: id, direction: 'in', types: ['calls'], envelope: 'full' }).data as { relationships: Array<{ other: Record<string, unknown>; site: Record<string, unknown> }> }).relationships
    expect(callers.map((r) => [r.site.path, r.site.generated])).toEqual([['web/app.ts', undefined]])
    const files = (tool(d, 'workspace_status', { files: { disposition: ['indexed'] } }).data as { files: Array<{ path: string; generated?: boolean }> }).files
    expect(files.filter((f) => f.generated).map((f) => f.path)).toEqual(['api/v1/user.pb.go', 'docs/gen/client.ts'])
  })

  it('FR292 a lean row from a generated file carries the tag generated', () => {
    const lean = String((tool(d, 'find_symbols', { text: 'fetchUsers', envelope: 'lean' }) as { text?: string }).text)
    expect(lean.split('\n').find((l) => l.includes('docs/gen/client.ts'))).toMatch(/ generated$| generated /)
    expect(String((tool(d, 'find_symbols', { text: 'render', envelope: 'lean' }) as { text?: string }).text)).not.toContain('generated')
  })

  it('FR298 scenario 4: hubs leave generated files out and say how many generated files there are; include_generated lists them, flagged', () => {
    const status = (input: Q) => tool(d, 'workspace_status', input)
    const hubs = (e: ReturnType<typeof status>) => (e.data as { hubs: Array<{ path: string; generated?: boolean }> }).hubs
    expect(hubs(status({})).filter((h) => h.path === 'docs/gen/client.ts')).toEqual([])
    expect(status({}).limitations).toContain('2 generated files are left out of hubs; pass include_generated: true to list them.')
    const asked = status({ include_generated: true })
    expect(hubs(asked).filter((h) => h.path === 'docs/gen/client.ts').map((h) => h.generated)).toEqual([true, true])
    expect(asked.limitations.join('\n')).not.toContain('left out of hubs')
  })

  it('FR295 scenario 5: the repository\'s own build/ directory is indexed, and the default excluded directories no longer include build', () => {
    expect(files()['tools/build/gen.go']!.disposition).toBe('indexed')
    const config = (tool(d, 'workspace_status').data as { analysis: { config: { excluded_dirs: string[] } } }).analysis.config
    expect(config.excluded_dirs).not.toContain('**/build/**')
  })

  it('FR292 FR299 a change to .gitattributes that flips a flag is a new snapshot, with the file no longer generated', () => {
    const r = copyFixture()
    const data = tmpDir()
    for (const args of [['init'], ['repo', 'add', r], ['index', r]]) expect(cli(['--data-dir', data, ...args]).status).toBe(0)
    const before = tool(data, 'workspace_status', { files: { path_prefix: 'docs/gen' } }).snapshot!.id
    fs.writeFileSync(path.join(r, '.gitattributes'), 'web/marked.ts linguist-generated=false\n')
    expect(cli(['--data-dir', data, 'index', r]).stdout).toMatch(/snapshot snap_/)
    const after = tool(data, 'workspace_status', { files: { path_prefix: 'docs/gen' } })
    expect(after.snapshot!.id).not.toBe(before)
    expect((after.data as { files: Array<{ path: string; generated?: boolean }> }).files.map((f) => f.generated)).toEqual([undefined])
  }, 120000)
})

describe('FR290 a generated marker counts only near the top of a file, in a comment', () => {
  it('Go header, @generated and <auto-generated flag a file; the same words in a string or after line 5 or byte 1024 do not', () => {
    const root = tree({
      'go.go': GO('// Code generated by x. DO NOT EDIT.'),
      'at.ts': '// @generated\nexport const a = 1\n',
      'doc.ts': '/**\n * @generated by tool\n */\nexport const a = 1\n',
      'auto.cs': '// <auto-generated>\n// </auto-generated>\nclass A {}\n',
      'fifth.ts': '// 1\n// 2\n// 3\n// 4\n// @generated\nexport const a = 1\n',
      'sixth.ts': '// 1\n// 2\n// 3\n// 4\n// 5\n// @generated\nexport const a = 1\n',
      'deep.go': GO('') + '\n'.repeat(20) + '// Code generated by x. DO NOT EDIT.\n',
      'string.ts': 'export const s = "@generated"\n',
      'prose.go': GO('// This file is not Code generated by anything, so DO NOT EDIT is no marker.'),
      'far.ts': `// ${'x'.repeat(1100)}\n// @generated\nexport const a = 1\n`,
      'plain.ts': 'export const a = 1\n',
    })
    expect(found(root)).toEqual({
      'go.go': 'capture:generated', 'at.ts': 'capture:generated', 'doc.ts': 'capture:generated', 'auto.cs': 'capture:generated', 'fifth.ts': 'capture:generated',
      'sixth.ts': 'capture', 'deep.go': 'capture', 'string.ts': 'capture', 'prose.go': 'capture', 'far.ts': 'capture', 'plain.ts': 'capture',
    })
  })

  it('the output of a known generator is generated by its name alone', () => {
    const root = tree({ 'a.pb.go': GO(''), 'a_pb2.py': 'x = 1\n', 'a_pb2_grpc.py': 'x = 1\n', 'A.g.cs': 'class A {}\n', 'A.Designer.cs': 'class A {}\n', 'a.go': GO(''), 'pb.go': GO('') })
    expect(Object.entries(found(root)).filter(([, v]) => v === 'capture:generated').map(([p]) => p)).toEqual(['A.Designer.cs', 'A.g.cs', 'a.pb.go', 'a_pb2.py', 'a_pb2_grpc.py'])
  })
})

describe('FR291 .gitattributes linguist-generated and linguist-vendored, and a value of false overrides every other rule', () => {
  it('the attributes set, unset, set false and reset decide; the deepest line wins; nested files apply below their directory', () => {
    const root = tree({
      '.gitattributes': 'schema/** linguist-generated\nschema/keep.ts linguist-generated=false\nschema/off.ts -linguist-generated\nimported/** linguist-vendored\nthird_party/own/** linguist-vendored=false\n',
      'schema/x.ts': 'export const a = 1\n', 'schema/keep.ts': 'export const a = 1\n', 'schema/off.ts': 'export const a = 1\n',
      'schema/deep/y.ts': 'export const a = 1\n', 'imported/lib.ts': 'export const a = 1\n', 'third_party/own/mine.ts': 'export const a = 1\n', 'third_party/other/o.ts': 'export const a = 1\n',
      'nested/.gitattributes': '*.ts linguist-generated\nplain.ts linguist-generated=false\n', 'nested/n.ts': 'export const a = 1\n', 'nested/plain.ts': 'export const a = 1\n', 'outside.ts': 'export const a = 1\n',
      'gen/g.pb.go': GO(''), 'gen/.gitattributes': '*.pb.go linguist-generated=false\n',
      'marked/m.ts': '// @generated\nexport const a = 1\n', 'marked/.gitattributes': 'm.ts -linguist-generated\n',
    })
    const got = found(root)
    expect([got['schema/x.ts'], got['schema/keep.ts'], got['schema/off.ts'], got['schema/deep/y.ts']]).toEqual(['capture:generated', 'capture', 'capture', 'capture:generated'])
    expect([got['imported/lib.ts'], got['third_party/own/mine.ts'], got['third_party/other/o.ts']]).toEqual(['excluded:vendored:linguist_vendored', 'capture', 'excluded:vendored:third_party'])
    expect([got['nested/n.ts'], got['nested/plain.ts'], got['outside.ts']]).toEqual(['capture:generated', 'capture', 'capture'])
    // False beats the generator's name and a marker in the file.
    expect([got['gen/g.pb.go'], got['marked/m.ts']]).toEqual(['capture', 'capture'])
  })

  it('it needs no git: the same answer in a work tree and outside one', () => {
    const files = { '.gitattributes': 'g/** linguist-generated\n', 'g/a.ts': 'export const a = 1\n' }
    const plain = tree(files), repo = tree(files)
    git(repo, 'init', '-q')
    expect(found(plain)['g/a.ts']).toBe('capture:generated')
    expect(found(repo)['g/a.ts']).toBe('capture:generated')
  })
})

describe('FR293 vendored files are excluded by rule, and git ignore stays the stronger rule', () => {
  it('vendor/ is Go\'s only beside modules.txt; third_party and Pods are vendored; the rule is named', () => {
    const root = tree({
      'go.mod': 'module m\n', 'vendor/modules.txt': '# a/b v1\n', 'vendor/a/b/b.go': GO(''), 'svc/vendor/x.go': GO(''), 'svc/go.mod': 'module s\n',
      'lib/vendor/v/v.go': GO(''), 'lib/third_party/t.c': 'int t;\n', 'ios/Pods/p.m': 'int p;\n', 'src/app.ts': 'export const a = 1\n',
    })
    expect(found(root)).toMatchObject({
      'vendor/modules.txt': 'excluded:vendored:go_vendor', 'vendor/a/b/b.go': 'excluded:vendored:go_vendor', 'svc/vendor/x.go': 'capture', 'lib/vendor/v/v.go': 'capture',
      'lib/third_party/t.c': 'excluded:vendored:third_party', 'ios/Pods/p.m': 'excluded:vendored:pods', 'src/app.ts': 'capture',
    })
  })

  it('a nested vendor directory beside its own modules.txt is vendored', () => {
    const root = tree({ 'svc/vendor/modules.txt': '# a v1\n', 'svc/vendor/a/a.go': GO('') })
    expect(found(root)).toMatchObject({ 'svc/vendor/a/a.go': 'excluded:vendored:go_vendor' })
  })

  it('a vendored directory that git also ignores stays gitignore', () => {
    const root = tree({ '.gitignore': 'third_party/\nvendor/\n', 'third_party/a.c': 'int a;\n', 'vendor/modules.txt': '# a v1\n', 'vendor/a/a.go': GO(''), 'other/third_party/b.c': 'int b;\n' })
    git(root, 'init', '-q')
    // Each directory git ignores as a whole is one gitignore entry (FR380); other/ holds only an ignored third_party/.
    expect(found(root)).toEqual({ 'third_party/': 'excluded:gitignore', 'vendor/': 'excluded:gitignore', 'other/': 'excluded:gitignore' })
  })
})

describe('FR295 build/ is output only where a manifest names it or git ignores it', () => {
  it('Gradle build/ and Maven target/ beside their manifests, and a CMake binary directory, are build output; elsewhere they are source', () => {
    const root = tree({
      'app/build.gradle': "plugins { id 'java' }\n", 'app/build/tmp/x.java': 'class X {}\n', 'kts/build.gradle.kts': 'plugins {}\n', 'kts/build/y.kt': 'class Y\n', 'set/settings.gradle': '\n', 'set/build/z.java': 'class Z {}\n',
      'mvn/pom.xml': '<project/>\n', 'mvn/target/m.java': 'class M {}\n', 'nomvn/target/n.java': 'class N {}\n',
      'cmk/out/CMakeCache.txt': '# cache\n', 'cmk/out/deep/c.c': 'int c;\n', 'cmk/src/c.c': 'int c;\n',
      'tools/build/gen.go': GO(''), 'lib/src/build/src.ts': 'export const a = 1\n', 'app/src/build/inner.java': 'class I {}\n',
    })
    expect(found(root)).toMatchObject({
      'app/build/tmp/x.java': 'excluded:build_output:gradle', 'kts/build/y.kt': 'excluded:build_output:gradle', 'set/build/z.java': 'excluded:build_output:gradle',
      'mvn/target/m.java': 'excluded:build_output:maven', 'nomvn/target/n.java': 'capture',
      'cmk/out/CMakeCache.txt': 'excluded:build_output:cmake', 'cmk/out/deep/c.c': 'excluded:build_output:cmake', 'cmk/src/c.c': 'capture',
      'tools/build/gen.go': 'capture', 'lib/src/build/src.ts': 'capture', 'app/src/build/inner.java': 'capture',
    })
  })

  it('a build/ directory git ignores is excluded as gitignore, and a tracked file in it is still content', () => {
    const root = tree({ '.gitignore': 'build/\n', 'build/o.ts': 'export const a = 1\n', 'build/kept.ts': 'export const a = 1\n', 'src/s.ts': 'export const a = 1\n' })
    git(root, 'init', '-q')
    git(root, 'add', '-f', 'build/kept.ts')
    expect(found(root)).toMatchObject({ 'build/o.ts': 'excluded:gitignore', 'build/kept.ts': 'capture', 'src/s.ts': 'capture' })
  })

  it('build output never makes a snapshot stale, and a flagged file is a different snapshot from the same file unflagged', () => {
    const files = { 'app/build.gradle': "plugins { id 'java' }\n", 'g/a.ts': 'export const a = 1\n', '.gitattributes': 'g/** linguist-generated\n' }
    const root = tree(files)
    const hashes = (r: string) => manifestHash(discover(r), () => 'h')
    const base = hashes(root)
    write(root, { 'app/build/tmp/x.java': 'class X {}\n' })
    expect(hashes(root)).toBe(base)
    write(root, { '.gitattributes': '' })
    expect(hashes(root)).not.toBe(base)
  })
})

describe('FR299 the listings issue 34 builds leave generated files out unless asked, through the hook this change names', () => {
  it('names the listings, and the three that filter are hubs, dead code (find_unused) and entry points (find_entry_points), all implemented', () => {
    expect(GENERATED_LISTINGS).toEqual({ hubs: 'implemented', dead_code: 'implemented', entry_points: 'implemented' })
  })

  it('the SQL condition keeps the rows of files not flagged generated, in any query that joins file f', async () => {
    const { dataDir } = await indexedDataDir(copyFixture())
    const names = (sql: string) => rowsOf(dataDir, `select distinct f.path from symbol s join file f on f.id = s.file_id ${sql} order by f.path`).map((r) => r.path)
    expect(names('')).toContain('api/v1/user.pb.go')
    expect(names(`where ${excludeGeneratedSql()}`)).not.toContain('api/v1/user.pb.go')
    expect(names(`where ${excludeGeneratedSql()}`)).not.toContain('docs/gen/client.ts')
    expect(names(`where ${excludeGeneratedSql()}`)).toContain('web/marked.ts')
  }, 120000)

  it('the note says how many were left out and says nothing when none were or they were asked for', () => {
    expect(generatedLeftOut('dead code', 3, false)).toBe('3 generated files are left out of dead code; pass include_generated: true to list them.')
    expect(generatedLeftOut('entry points', 1, false)).toBe('1 generated file is left out of entry points; pass include_generated: true to list them.')
    expect(generatedLeftOut('dead code', 3, true)).toBeNull()
    expect(generatedLeftOut('dead code', 0, false)).toBeNull()
  })
})

describe('FR294 only a package the vendor directory holds is external', () => {
  it('an import of a vendored package of another module path and one the vendor directory lacks stay as they were', async () => {
    const repo = tree({
      'go.mod': 'module example.com/app\n', 'vendor/modules.txt': '# github.com/x/y v1.0.0\n## explicit\ngithub.com/x/y\ngithub.com/x/y/sub\n', 'vendor/github.com/x/y/y.go': GO(''), 'vendor/github.com/x/y/sub/s.go': GO(''),
      'main.go': 'package main\n\nimport (\n\t"github.com/x/y"\n\t"github.com/x/y/sub"\n\t"github.com/x/z"\n)\n\nfunc main() { y.F(); sub.F(); z.F() }\n',
    })
    const { dataDir } = await indexedDataDir(repo)
    const got = rowsOf(dataDir, `select a.resolution, x.module, x.name, a.detail from assertion a join file f on f.id = a.source_id left join external_symbol x on x.id = a.target_id and a.target_kind = 'external'
      where a.type = 'imports' and f.path = 'main.go'`).map((r) => [r.resolution, r.module, r.name, JSON.parse(String(r.detail)).module]).sort((a, b) => String(a[3]).localeCompare(String(b[3])))
    expect(got).toEqual([
      ['resolved_external', 'go:github.com/x/y', 'github.com/x/y', 'github.com/x/y'],
      ['resolved_external', 'go:github.com/x/y', 'github.com/x/y/sub', 'github.com/x/y/sub'],
      ['unresolved', null, null, 'github.com/x/z'],
    ])
  }, 120000)
})

describe('FR291 a .gitattributes that is a symlink is not read', () => {
  it('a link to a file outside the repository controls no exclusion, and is recorded as a symlink not followed', () => {
    const outside = tree({ 'attrs': 'g/** linguist-generated\nv/** linguist-vendored\n' })
    const root = tree({ 'g/a.ts': 'export const a = 1\n', 'v/b.ts': 'export const b = 1\n' })
    fs.symlinkSync(path.join(outside, 'attrs'), path.join(root, '.gitattributes'))
    expect(found(root)).toEqual({ 'g/a.ts': 'capture', 'v/b.ts': 'capture' })
    expect(discover(root).find((d) => d.path === '.gitattributes')).toMatchObject({ status: 'unsupported', detail: 'symlink_not_followed' })
  })
})

describe('FR291 quoted .gitattributes patterns are read as git unquotes them', () => {
  it('a quoted pattern with a space, an escaped quote, and octal bytes matches the path it names', () => {
    const root = tree({
      '.gitattributes': '"sp ace/**" linguist-generated\n"caf\\303\\251/**" linguist-generated\n"q\\"x/**" linguist-vendored\n',
      'sp ace/a.ts': 'export const a = 1\n', 'café/b.ts': 'export const b = 1\n', 'q"x/c.ts': 'export const c = 1\n', 'plain/d.ts': 'export const d = 1\n',
    })
    expect(found(root)).toEqual({ 'sp ace/a.ts': 'capture:generated', 'café/b.ts': 'capture:generated', 'q"x/c.ts': 'excluded:vendored:linguist_vendored', 'plain/d.ts': 'capture' })
  })
})

describe('FR290 FR292 a file another rule promotes to a source after discovery is still flagged generated', () => {
  it('a file the registry routes to an adapter (as a SCIP index does) keeps the marker and attribute checks', () => {
    const promoting = Object.assign(Object.create(BUILT_IN_REGISTRY), {
      route: (d: { path: string }) => (d.path.endsWith('.zz') ? { ...d, status: 'capture', detail: null, role: 'source', language: 'go' } : d),
    }) as Registry
    const root = tree({ 'marked.zz': '// Code generated by x. DO NOT EDIT.\nx\n', 'plain.zz': 'x\n', 'attr.zz': 'x\n', '.gitattributes': 'attr.zz linguist-generated\n' })
    const got = Object.fromEntries(discover(root, promoting).filter((d) => d.path.endsWith('.zz')).map((d) => [d.path, d.status === 'capture' && d.generated === true]))
    expect(got).toEqual({ 'marked.zz': true, 'plain.zz': false, 'attr.zz': true })
  })
})

describe('FR294 a vendor directory that modules.txt does not list is not guessed at', () => {
  it('an import of a package no listed module owns stays unresolved', async () => {
    const repo = tree({
      'go.mod': 'module example.com/app\n', 'vendor/modules.txt': '# github.com/x/y v1.0.0\n## explicit\ngithub.com/x/y\n', 'vendor/github.com/x/y/y.go': GO(''), 'vendor/github.com/q/r/r.go': GO(''),
      'main.go': 'package main\n\nimport (\n\t"github.com/x/y"\n\t"github.com/q/r"\n)\n\nfunc main() { y.F(); r.F() }\n',
    })
    const { dataDir } = await indexedDataDir(repo)
    const got = rowsOf(dataDir, `select a.resolution, x.module from assertion a join file f on f.id = a.source_id left join external_symbol x on x.id = a.target_id and a.target_kind = 'external'
      where a.type = 'imports' and f.path = 'main.go' order by a.detail`).map((r) => [r.resolution, r.module])
    expect(got).toEqual([['unresolved', null], ['resolved_external', 'go:github.com/x/y']])
  }, 120000)
})

describe('FR292 FR296 answers tag generated files by the snapshot that answers, and say what policy built it', () => {
  it('an unresolved sample in the envelope that names a generated file carries generated: true', async () => {
    const { dataDir } = await indexedRepo({ 'go.mod': 'module m\n', 'g/x.pb.go': 'package g\n\nfunc F() { Missing() }\n', 'h/y.go': 'package h\n\nfunc H() { Missing() }\n' })
    const sample = (name: string) => {
      const id = String((tool(dataDir, 'find_symbols', { text: name }).data as { symbols: Array<{ id: string }> }).symbols[0]!.id)
      return tool(dataDir, 'get_relationships', { subject_id: id, direction: 'out', types: ['calls'], envelope: 'full' }).unresolved.sample as Array<Record<string, unknown>>
    }
    expect(sample('F').map((s) => [s.file, s.generated])).toEqual([['g/x.pb.go', true]])
    expect(sample('H').map((s) => [s.file, s.generated])).toEqual([['h/y.go', undefined]])
  }, 120000)

  it('workspace_status reports the policy the snapshot was built with, read from the snapshot', async () => {
    const { dataDir, snapshotId } = await indexedRepo({ 'a.ts': 'export const a = 1\n' })
    expect(withSnapshot(dataDir, (db) => JSON.parse((db.prepare("select value from meta where key = 'generated_policy'").get() as { value: string }).value))).toEqual(JSON.parse(JSON.stringify(GENERATED_POLICY)))
    const file = sealedPath(dataDir, snapshotId)
    fs.chmodSync(file, 0o600)
    const w = new Database(file)
    w.prepare("update meta set value = ? where key = 'generated_policy'").run(JSON.stringify({ summary: 'built by an older policy' }))
    w.close()
    const policy = (tool(dataDir, 'workspace_status').data as { analysis: { generated_policy: { summary: string } } }).analysis.generated_policy
    expect(policy.summary).toBe('built by an older policy')
  }, 120000)

  it('compare_snapshots tags a removed row from the base snapshot and an added row from the head, each by its own', async () => {
    const repo = tree({ '.gitattributes': 'gen/** linguist-generated\n', 'gen/a.ts': 'export function old() { return 1 }\n' })
    const data = tmpDir()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', data, ...args]).status).toBe(0)
    const idA = tool(data, 'workspace_status').snapshot!.id
    write(repo, { '.gitattributes': '', 'gen/a.ts': 'export function fresh() { return 2 }\n' })
    expect(cli(['--data-dir', data, 'index', repo]).status).toBe(0)
    const idB = tool(data, 'workspace_status').snapshot!.id
    const flags = (base: string, head: string) => {
      const sy = (tool(data, 'compare_snapshots', { base_snapshot_id: base, snapshot_id: head, envelope: 'full' }).data as { symbols: { added: Array<Record<string, unknown>>; removed: Array<Record<string, unknown>> } }).symbols
      const f = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.kind === 'function').map((r) => [r.qualified_name, r.generated])
      return { added: f(sy.added), removed: f(sy.removed) }
    }
    expect(flags(idA, idB)).toEqual({ added: [['gen/a:fresh', undefined]], removed: [['gen/a:old', true]] })
    expect(flags(idB, idA)).toEqual({ added: [['gen/a:old', true]], removed: [['gen/a:fresh', undefined]] })
  }, 180000)
})
