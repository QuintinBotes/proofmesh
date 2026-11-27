import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { cli, ROOT, tmpDir, tool } from './helpers.js'

// Cross-repository symbols (#28): a library and an application that calls it, from fixtures/xrepo, in one workspace.
const FIXTURE = path.join(ROOT, 'fixtures', 'xrepo')
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()

/** A copy of one fixture repository, committed, so its snapshot names a commit. */
function copy(name: 'lib' | 'app', installed?: string): { dir: string; commit: string } {
  const dir = tmpDir(`pm-xrepo-${name}-`)
  fs.cpSync(path.join(FIXTURE, name), dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', name)
  // What `npm install` would leave: the library's declarations at the version under test, never committed.
  if (installed) {
    const pkg = path.join(dir, 'node_modules', '@fx', 'geo')
    fs.mkdirSync(pkg, { recursive: true })
    fs.copyFileSync(path.join(FIXTURE, 'installed', 'geo', 'index.d.ts'), path.join(pkg, 'index.d.ts'))
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@fx/geo', version: installed, types: 'index.d.ts' }))
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
