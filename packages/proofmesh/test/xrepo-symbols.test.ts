import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { cli, ROOT, tmpDir, tool } from './helpers.js'

// Cross-repository symbols (#28): a library and an application that calls it, from fixtures/xrepo, in one workspace.
const FIXTURE = path.join(ROOT, 'fixtures', 'xrepo')
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()

/** A copy of one fixture repository, committed, so its snapshot names a commit. */
function copy(name: 'lib' | 'app' | 'map', installed?: string): { dir: string; commit: string } {
  const dir = tmpDir(`pm-xrepo-${name}-`)
  fs.cpSync(path.join(FIXTURE, name), dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', name)
  // What `npm install` would leave: the declarations of the package the repository uses, at the version under test, never committed.
  if (installed) {
    const [pkgName, declared] = name === 'map' ? ['fx-app', 'route'] : ['@fx/geo', 'geo']
    const pkg = path.join(dir, 'node_modules', ...pkgName.split('/'))
    fs.mkdirSync(pkg, { recursive: true })
    fs.copyFileSync(path.join(FIXTURE, 'installed', declared, 'index.d.ts'), path.join(pkg, 'index.d.ts'))
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: pkgName, version: installed, types: 'index.d.ts' }))
    fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'node_modules/\n')
  }
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') }
}

/** The library and the application (with @fx/geo at `installed`) indexed into one data directory, in a linked workspace; `extra` are more libraries. */
function workspace(installed = '1.2.0', extra: string[] = []) {
  const d = tmpDir(), lib = copy('lib'), app = copy('app', installed)
  const more = extra.map(() => copy('lib'))
  const run = (...args: string[]) => { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0); return r.stdout.trim() }
  run('init')
  const libId = run('repo', 'add', lib.dir, '--name', 'lib'), appId = run('repo', 'add', app.dir, '--name', 'app')
  more.forEach((m, i) => run('repo', 'add', m.dir, '--name', extra[i]!))
  for (const r of [lib, app, ...more]) run('index', r.dir)
  run('workspace', 'add', 'geo', lib.dir, app.dir, ...more.map((m) => m.dir))
  const linked = run('workspace', 'link', 'geo')
  return { d, lib, app, libId, appId, linked }
}

const find = (d: string, repository_id: string, qualified: string) => {
  const hit = (tool(d, 'find_symbols', { repository_id, text: qualified.split(/[:.]/).pop()! }).data.symbols as Array<{ id: string; qualified_name: string }>).find((s) => s.qualified_name === qualified)
  if (!hit) throw new Error(`no ${qualified}`)
  return hit.id
}

type Rel = { type: string; direction: string; resolution: string; basis?: string; other: { qualified_name?: string }; site: { path: string; start_line: number }; repository?: { id: string; name: string; commit: string | null } }
const shown = (rs: Rel[]) => rs.map((r) => ({ type: r.type, from: r.other.qualified_name, at: `${r.site.path}:${r.site.start_line}`, resolution: r.resolution, basis: r.basis, repository: r.repository }))

describe('FR900 FR901 FR902 FR903 FR904 calls from a registered application into a registered library resolve to the library repository', () => {
  it('FR901 FR902 scenario 1: callers of distance in lib, with include_workspace, are exactly the two call sites in app, each with its repository and commit', () => {
    const { d, app, libId, appId } = workspace()
    const distance = find(d, libId, 'src/index:distance')
    // Without include_workspace the library answers for itself alone, as before.
    expect(tool(d, 'get_relationships', { repository_id: libId, subject_id: distance, direction: 'in' }).data.relationships).toEqual([])
    const env = tool(d, 'get_relationships', { repository_id: libId, subject_id: distance, direction: 'in', include_workspace: true })
    const repository = { id: appId, name: 'app', commit: app.commit }
    expect(shown(env.data.relationships as Rel[])).toEqual([
      { type: 'calls', from: 'src/route:leg', at: 'src/route.ts:5', resolution: 'resolved', basis: 'observed', repository },
      { type: 'calls', from: 'src/route:trip', at: 'src/route.ts:10', resolution: 'resolved', basis: 'observed', repository },
    ])
    expect(env.data.totals).toMatchObject({ in: 2, by_basis: { observed: 2, inferred: 0 } })
    // Each side's freshness, separately (edge case: stale sides).
    const ws = (env.data.workspace as Array<{ name: string; members: Array<{ name: string; commit: string | null; current: boolean }> }>)
    expect(ws.map((w) => [w.name, w.members.map((m) => [m.name, m.commit, m.current])])).toEqual([['geo', [['app', app.commit, true], ['lib', expect.any(String), true]]]])
    // Lean rows name the other repository.
    const lean = tool(d, 'get_relationships', { repository_id: libId, subject_id: distance, direction: 'in', include_workspace: true, envelope: 'lean' }) as unknown as { text: string }
    expect(lean.text).toContain(`leg src/route.ts:5 repo=app@${app.commit.slice(0, 12)}`)
    // A side re-indexed after the link file was sealed is named stale; the rows still come from the sealed file.
    fs.appendFileSync(path.join(app.dir, 'src', 'route.ts'), '\n// changed\n')
    expect(cli(['--data-dir', d, 'index', app.dir]).status).toBe(0)
    const stale = tool(d, 'get_relationships', { repository_id: libId, subject_id: distance, direction: 'in', include_workspace: true })
    expect((stale.data.workspace as typeof ws)[0]!.members.map((m) => [m.name, m.current])).toEqual([['app', false], ['lib', true]])
    expect(stale.limitations.some((l) => l.includes('was built from older snapshots of app;'))).toBe(true)
    expect((stale.data.relationships as Rel[]).length).toBe(2)
  }, 300000)

  it('FR901 FR903 scenario 2: the impact of Point, with include_workspace, reaches the subclass in app at depth 1 and its caller at depth 2', () => {
    const { d, appId, libId } = workspace()
    const point = find(d, libId, 'src/point:Point')
    expect(tool(d, 'analyze_impact', { repository_id: libId, subject_ids: [point] }).data.dependents).toEqual([])
    const env = tool(d, 'analyze_impact', { repository_id: libId, subject_ids: [point], include_workspace: true })
    // Each row carries its line and relationship (FR860) as a local row does, read from the other repository's snapshot.
    const deps = (env.data.dependents as Array<{ qualified_name: string; depth: number; basis: string; line: number; relationship: string; site?: unknown; repository?: { id: string } }>).map((x) => [x.qualified_name, x.depth, x.basis, x.line, x.relationship, x.site, x.repository?.id])
    expect(deps).toEqual([['src/pin:Pin', 1, 'observed', 3, 'inherits', undefined, appId], ['src/route:start', 2, 'observed', 15, 'calls', undefined, appId]])
    expect(env.data.totals).toMatchObject({ dependents: 2, by_depth: { 1: 1, 2: 1 } })
    // A cut answer's total counts the other repository's dependents too.
    const cut = tool(d, 'analyze_impact', { repository_id: libId, subject_ids: [point], include_workspace: true, envelope: 'compact', limits: { max_rows: 1 } })
    expect([(cut.data.dependents as unknown[]).length, cut.completion.truncated, (cut.completion as { total?: number }).total]).toEqual([1, true, 2])
    const lean = (tool(d, 'analyze_impact', { repository_id: libId, subject_ids: [point], include_workspace: true, envelope: 'lean' }) as unknown as { text: string }).text
    expect(lean).toMatch(/^Pin src\/pin\.ts:3 depth=1 inherits repo=app@[0-9a-f]{12}$/m)
    expect(lean).toMatch(/^start src\/route\.ts:15 depth=2 calls repo=app@[0-9a-f]{12}$/m)
  }, 300000)

  it('FR901 FR902 scenario 3: app on @fx/geo 1.1.0 against lib at 1.2.0 still gets the rows, labelled inferred, with the version mismatch', () => {
    const { d, libId } = workspace('1.1.0')
    const env = tool(d, 'get_relationships', { repository_id: libId, subject_id: find(d, libId, 'src/index:distance'), direction: 'in', include_workspace: true })
    expect(shown(env.data.relationships as Rel[]).map((r) => [r.from, r.basis])).toEqual([['src/route:leg', 'inferred'], ['src/route:trip', 'inferred']])
    expect(env.data.totals).toMatchObject({ in: 2, by_basis: { observed: 0, inferred: 2 } })
    expect(env.limitations).toContain('version mismatch: app uses 1.1.0, lib is 1.2.0')
    const impact = tool(d, 'analyze_impact', { repository_id: libId, subject_ids: [find(d, libId, 'src/point:Point')], include_workspace: true })
    expect((impact.data.dependents as Array<{ basis: string }>).map((x) => x.basis)).toEqual(['inferred', 'inferred'])
    expect(impact.limitations).toContain('version mismatch: app uses 1.1.0, lib is 1.2.0')
  }, 300000)

  it('FR901 edge case: two registered repositories building @fx/geo make no link; the sites are candidates naming both', () => {
    const { d, libId, linked } = workspace('1.2.0', ['lib-fork'])
    expect(linked).toMatch(/calls: 2 candidate/)
    const env = tool(d, 'get_relationships', { repository_id: libId, subject_id: find(d, libId, 'src/index:distance'), direction: 'in', include_workspace: true })
    expect(shown(env.data.relationships as Rel[]).map((r) => [r.from, r.resolution, r.basis])).toEqual([['src/route:leg', 'candidate', 'inferred'], ['src/route:trip', 'candidate', 'inferred']])
    const file = path.join(d, 'links', `${/link file (link_\w+)/.exec(linked)![1]}.db`)
    const db = new Database(file, { readonly: true })
    try {
      const rows = db.prepare("select l.resolution, l.reason, count(c.link_id) as n from link l left join link_candidate c on c.link_id = l.id where l.rule = 'package_symbol' and l.type = 'calls' group by l.id").all()
      expect(rows).toEqual([{ resolution: 'candidate', reason: 'ambiguous', n: 2 }, { resolution: 'candidate', reason: 'ambiguous', n: 2 }])
    } finally { db.close() }
  }, 300000)

  it('FR901 edge case: a library that is not registered stays resolved_external, and no package_symbol link is made', () => {
    const d = tmpDir(), app = copy('app', '1.2.0'), other = copy('lib')
    // The workspace holds the application and an unrelated repository: nothing in it builds @fx/geo.
    fs.writeFileSync(path.join(other.dir, 'package.json'), JSON.stringify({ name: '@fx/other', version: '1.0.0' }))
    for (const args of [['init'], ['repo', 'add', app.dir, '--name', 'app'], ['repo', 'add', other.dir, '--name', 'other'], ['index', app.dir], ['index', other.dir], ['workspace', 'add', 'geo', app.dir, other.dir]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const linked = cli(['--data-dir', d, 'workspace', 'link', 'geo']).stdout
    expect(linked).not.toMatch(/^\s*calls:/m)
    const appId = (tool(d, 'list_repositories').data.repositories as Array<{ id: string; name: string }>).find((r) => r.name === 'app')!.id
    const out = tool(d, 'get_relationships', { repository_id: appId, subject_id: find(d, appId, 'src/route:leg'), direction: 'out', include_external: true })
    expect((out.data.relationships as Array<{ resolution: string; other: { module?: string; name?: string } }>).map((r) => [r.resolution, r.other.module, r.other.name])).toEqual([['resolved_external', '@fx/geo', 'distance']])
  }, 300000)
})

/** lib, app (with @fx/geo 1.2.0 installed) and map (with fx-app 1.0.0 installed), three repositories in one linked workspace. */
function three() {
  const d = tmpDir(), lib = copy('lib'), app = copy('app', '1.2.0'), map = copy('map', '1.0.0')
  const run = (...args: string[]) => { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0); return r.stdout.trim() }
  run('init')
  const ids = { lib: run('repo', 'add', lib.dir, '--name', 'lib'), app: run('repo', 'add', app.dir, '--name', 'app'), map: run('repo', 'add', map.dir, '--name', 'map') }
  for (const r of [lib, app, map]) run('index', r.dir)
  run('workspace', 'add', 'geo', lib.dir, app.dir, map.dir)
  return { d, lib, app, map, ids, linked: run('workspace', 'link', 'geo') }
}
type Test = { qualified_name: string; path: string; depth: number; evidence: string; basis: string; chain: Array<{ path: string; line: number }>; repository?: { id: string; name: string; commit: string | null } }
type Trace = { conclusion: string; paths: Array<{ nodes: string[]; assertions: string[]; basis: string }>; nodes: Record<string, { qualified_name: string; repository?: { id: string; name: string; commit: string | null } }>; relationships: Record<string, { type: string; rule: string | null; basis: string; site?: { path: string; start_line: number } }> }

describe('FR1260 FR1261 FR1262 FR1264 find_tests and trace_paths take include_workspace, and a chain continues into a third repository', () => {
  it('FR1260 FR1264 find_tests on distance in lib, with include_workspace, lists the test in app that reaches it through trip, with its repository and commit', () => {
    const { d, app, ids, linked } = three()
    // app builds fx-app 1.0.0, which map installs at 1.0.0: map's call to trip is linked to app, as app's calls are to lib.
    expect(linked).toMatch(/calls: 3 resolved/)
    const distance = find(d, ids.lib, 'src/index:distance')
    const alone = tool(d, 'find_tests', { repository_id: ids.lib, subject_ids: [distance] })
    expect(alone.data.tests).toEqual([])
    expect(alone.limitations).toContain('Tests in the other repositories of this workspace are not searched.')
    const env = tool(d, 'find_tests', { repository_id: ids.lib, subject_ids: [distance], include_workspace: true })
    const repository = { id: ids.app, name: 'app', commit: app.commit }
    // Its chain runs in app, from the test's call to trip to trip's call into lib.
    expect((env.data.tests as Test[]).map((t) => [t.qualified_name, t.path, t.depth, t.evidence, t.basis, t.chain.map((h) => ({ path: h.path, line: h.line })), t.repository])).toEqual([
      ['src/route.test:tripOfNoStopsIsZero', 'src/route.test.ts', 2, 'transitive_call', 'observed', [{ path: 'src/route.test.ts', line: 4 }, { path: 'src/route.ts', line: 10 }], repository],
    ])
    expect(env.data.totals).toMatchObject({ tests: 1, executing: 1, by_basis: { observed: 1, inferred: 0 } })
    expect(env.limitations).not.toContain('Tests in the other repositories of this workspace are not searched.')
    expect((env.data.workspace as Array<{ name: string }>).map((w) => w.name)).toEqual(['geo'])
    const lean = (tool(d, 'find_tests', { repository_id: ids.lib, subject_ids: [distance], include_workspace: true, envelope: 'lean' }) as unknown as { text: string }).text
    expect(lean).toContain(`tripOfNoStopsIsZero src/route.test.ts:4 depth=2 repo=app@${app.commit.slice(0, 12)}`)
  }, 300000)

  it('FR1261 trace_paths from trip in app to distance in lib, with include_workspace, crosses the package_symbol link, each node of lib naming its repository', () => {
    const { d, lib, ids } = three()
    const trip = find(d, ids.app, 'src/route:trip'), distance = find(d, ids.lib, 'src/index:distance')
    // Without include_workspace the target is not in app's snapshot, as before.
    expect(() => tool(d, 'trace_paths', { repository_id: ids.app, source_id: trip, target_id: distance })).toThrow(/is not in snapshot/)
    const env = tool(d, 'trace_paths', { repository_id: ids.app, source_id: trip, target_id: distance, include_workspace: true })
    const data = env.data as unknown as Trace
    expect(data.conclusion).toBe('path_found')
    const p = data.paths[0]!
    expect(p.nodes.map((n) => [data.nodes[n]!.qualified_name, data.nodes[n]!.repository?.name])).toEqual([['src/route:trip', undefined], ['src/index:distance', 'lib']])
    expect(data.nodes[distance]!.repository).toEqual({ id: ids.lib, name: 'lib', commit: lib.commit })
    expect(p.basis).toBe('observed')
    expect(data.relationships[p.assertions[0]!]).toMatchObject({ type: 'calls', rule: 'package_symbol', basis: 'observed', site: { path: 'src/route.ts', start_line: 10 } })
    const lean = (tool(d, 'trace_paths', { repository_id: ids.app, source_id: trip, target_id: distance, include_workspace: true, envelope: 'lean' }) as unknown as { text: string }).text
    expect(lean).toMatch(new RegExp(`^trip src/route\\.ts:10\\ndistance src/index\\.ts:5 repo=lib@${lib.commit.slice(0, 12)}$`, 'm'))
  }, 300000)

  it('FR1262 a chain crosses into a third repository: the impact of distance reaches map through app, and trace_paths runs from tour in map to distance in lib', () => {
    const { d, app, map, ids } = three()
    const distance = find(d, ids.lib, 'src/index:distance')
    const impact = tool(d, 'analyze_impact', { repository_id: ids.lib, subject_ids: [distance], include_workspace: true })
    const deps = (impact.data.dependents as Array<{ qualified_name: string; depth: number; basis: string; line: number; relationship: string; repository?: { id: string; commit: string | null } }>)
    expect(deps.map((x) => [x.qualified_name, x.depth, x.basis, x.line, x.relationship, x.repository?.id, x.repository?.commit])).toEqual([
      ['src/route:leg', 1, 'observed', 5, 'calls', ids.app, app.commit],
      ['src/route:trip', 1, 'observed', 10, 'calls', ids.app, app.commit],
      ['src/route.test:tripOfNoStopsIsZero', 2, 'observed', 4, 'calls', ids.app, app.commit],
      ['src/plan:plan', 2, 'observed', 4, 'calls', ids.map, map.commit],
      ['src/plan:tour', 3, 'observed', 8, 'calls', ids.map, map.commit],
    ])
    expect(impact.data.totals).toMatchObject({ dependents: 5, by_depth: { 1: 2, 2: 2, 3: 1 } })
    // From map's side, the trace runs through app into lib: two repositories crossed.
    const tour = find(d, ids.map, 'src/plan:tour')
    const data = tool(d, 'trace_paths', { repository_id: ids.map, source_id: tour, target_id: distance, include_workspace: true }).data as unknown as Trace
    const p = data.paths[0]!
    expect(p.nodes.map((n) => [data.nodes[n]!.qualified_name, data.nodes[n]!.repository?.name])).toEqual([['src/plan:tour', undefined], ['src/plan:plan', undefined], ['src/route:trip', 'app'], ['src/index:distance', 'lib']])
    expect(p.assertions.map((a) => data.relationships[a]!.rule)).toEqual([null, 'package_symbol', 'package_symbol'])
    // And from lib's side, with the source in another repository.
    const back = tool(d, 'trace_paths', { repository_id: ids.lib, source_id: tour, target_id: distance, include_workspace: true }).data as unknown as Trace
    expect(back.paths[0]!.nodes.map((n) => [back.nodes[n]!.qualified_name, back.nodes[n]!.repository?.name])).toEqual([['src/plan:tour', 'map'], ['src/plan:plan', 'map'], ['src/route:trip', 'app'], ['src/index:distance', undefined]])
  }, 300000)
})

describe('FR1265 a package published from a monorepository resolves through its own manifest', () => {
  it('FR1265 edge case: with @fx/geo at packages/geo of a monorepository with a second package, the callers of distance there are the two call sites in app', () => {
    const d = tmpDir(), app = copy('app', '1.2.0'), mono = tmpDir('pm-xrepo-mono-')
    fs.writeFileSync(path.join(mono, 'package.json'), JSON.stringify({ name: 'fx-mono', private: true, workspaces: ['packages/*'] }))
    fs.cpSync(path.join(FIXTURE, 'lib'), path.join(mono, 'packages', 'geo'), { recursive: true })
    // A second package of the monorepository declaring the same name: matched only when it is the package the application installs.
    fs.mkdirSync(path.join(mono, 'packages', 'other', 'src'), { recursive: true })
    fs.writeFileSync(path.join(mono, 'packages', 'other', 'package.json'), JSON.stringify({ name: '@fx/other', version: '1.0.0' }))
    fs.writeFileSync(path.join(mono, 'packages', 'other', 'src', 'index.ts'), 'export function distance(): number {\n  return 0\n}\n')
    git(mono, 'init', '-q'); git(mono, 'add', '-A'); git(mono, 'commit', '-q', '-m', 'mono')
    const run = (...args: string[]) => { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0); return r.stdout.trim() }
    run('init')
    const monoId = run('repo', 'add', mono, '--name', 'mono')
    run('repo', 'add', app.dir, '--name', 'app')
    run('index', mono); run('index', app.dir)
    run('workspace', 'add', 'geo', mono, app.dir)
    expect(run('workspace', 'link', 'geo')).toMatch(/calls: 2 resolved/)
    const env = tool(d, 'get_relationships', { repository_id: monoId, subject_id: find(d, monoId, 'packages/geo/src/index:distance'), direction: 'in', include_workspace: true })
    expect(shown(env.data.relationships as Rel[]).map((r) => [r.from, r.at, r.resolution, r.basis])).toEqual([['src/route:leg', 'src/route.ts:5', 'resolved', 'observed'], ['src/route:trip', 'src/route.ts:10', 'resolved', 'observed']])
    expect(tool(d, 'get_relationships', { repository_id: monoId, subject_id: find(d, monoId, 'packages/other/src/index:distance'), direction: 'in', include_workspace: true }).data.relationships).toEqual([])
  }, 300000)
})

describe('FR1263 bench/parity/xrepo.sh scores the application call sites into the library that resolve to it, against the TypeScript checker', () => {
  it('FR1263 on a pair made of fixtures/xrepo, the harness works on its own copy, counts both calls of distance resolved, removes the copy and exits 0', () => {
    // The layout xrepo.sh fetches the public pair into, here from the project-authored fixture, so no network is used.
    const fix = tmpDir('pm-xrepo-pair-')
    for (const side of ['lib', 'app']) fs.cpSync(path.join(FIXTURE, side), path.join(fix, side), { recursive: true })
    fs.mkdirSync(path.join(fix, 'installed', '@fx', 'geo'), { recursive: true })
    fs.copyFileSync(path.join(FIXTURE, 'installed', 'geo', 'index.d.ts'), path.join(fix, 'installed', '@fx', 'geo', 'index.d.ts'))
    fs.writeFileSync(path.join(fix, 'installed', '@fx', 'geo', 'package.json'), JSON.stringify({ name: '@fx/geo', version: '1.2.0', types: 'index.d.ts' }))
    fs.writeFileSync(path.join(fix, 'pair.json'), JSON.stringify({ package: '@fx/geo', entry: 'lib/src/index.ts' }))
    fs.writeFileSync(path.join(fix, 'PROVENANCE'), 'Project-authored: fixtures/xrepo of ProofMesh.\n')
    const r = spawnSync('sh', [path.join(ROOT, 'bench/parity/xrepo.sh')], { encoding: 'utf8', env: { ...process.env, PARITY_XREPO: fix } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('| src/index.ts#distance | 2 | 2 |  |')
    expect(r.stdout).toMatch(/^2 of 2 application call sites into @fx\/geo resolved to the library's symbol \(100\.0%\); 0 resolved rows the checker does not count\. typescript /m)
    const copyDir = /xrepo: fixture copy (\S+)/.exec(r.stderr)![1]!
    expect(fs.existsSync(copyDir)).toBe(false)
    // A directory that is not a fixture is refused, by name, and left as it was.
    const other = tmpDir('pm-xrepo-other-')
    fs.writeFileSync(path.join(other, 'keep.txt'), 'mine')
    const refused = spawnSync('sh', [path.join(ROOT, 'bench/parity/xrepo.sh')], { encoding: 'utf8', env: { ...process.env, PARITY_XREPO: other } })
    expect([refused.status, refused.stderr.trim()]).toEqual([1, `xrepo: ${other} is not a parity fixture (no PROVENANCE); remove it or set PARITY_XREPO to another directory`])
    expect(fs.readdirSync(other)).toEqual(['keep.txt'])
  }, 300000)
})
