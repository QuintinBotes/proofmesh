import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { cli, fixtureRepo, indexedDataDir, tmpDir, tool } from './helpers.js'

function fixture(name: string) {
  const root = tmpDir(), env = { ...process.env }
  fs.cpSync(fixtureRepo(name), root, { recursive: true })
  for (const role of ['AUTHOR', 'COMMITTER']) {
    env['GIT_' + role + '_NAME'] = 'Proofmesh fixture'
    env['GIT_' + role + '_EMAIL'] = 'fixture@example.test'
    env['GIT_' + role + '_DATE'] = '2000-01-01T00:00:00Z'
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8' }).trim()
  git('init', '-q', '--object-format=sha1'); git('add', '.'); git('commit', '-qm', 'fixture')
  return { root, revision: git('rev-parse', 'HEAD'), files: path.dirname(fixtureRepo(name)) }
}
describe('explicit producer evidence', () => {
  it('imports the Linux and macOS Bazel exports and retains each configured instance and dependency witness', async () => {
    const f = fixture('configured-bazel'), { dataDir, repoId } = await indexedDataDir(f.root)
    const call = (...args: string[]) => cli(['--data-dir', dataDir, 'cquery', ...args.slice(0, 1), repoId, ...args.slice(1)])
    expect(f.revision).toBe(fs.readFileSync(path.join(f.files, 'exports/revision'), 'utf8').trim())
    for (const os of ['linux', 'macos']) {
      const file = path.join(f.files, 'exports', os + '.dot')
      const args = [file, 'bazel-cquery-dot/v1', 'Bazel 6.5.0', f.revision, os]
      const imported = call('add', ...args)
      expect(imported.status, imported.stderr).toBe(0)
      expect(JSON.parse(imported.stdout)).toMatchObject({ targets: 5, edges: 4, unknown_labels: 0 })
      const graph = JSON.parse(call('deps', os).stdout)
      const exported = [...fs.readFileSync(file, 'utf8').matchAll(/^  "([^"]+)"$/gm)].map((m) => m[1]).sort()
      expect(graph.targets.map((n: { label: string; configuration: string }) => n.label + ' (' + n.configuration + ')').sort()).toEqual(exported)
      expect(graph.edges.every((e: { witness: { path: string } | null; missing_location?: string }) => e.witness?.path === 'BUILD' || !!e.missing_location)).toBe(true)
      const deps = JSON.parse(call('deps', os, '//:service').stdout)
      expect(deps.configuration).toBe(os)
      expect(deps.edges.map((e: { to: { label: string } }) => e.to.label).sort()).toEqual(['//:common', '//:' + os + '_impl'])
      expect(call('add', file, 'v99', ...args.slice(2)).stderr).toContain('Unsupported')
      expect(call('add', ...args.slice(0, 3), '0'.repeat(40), os).stderr).toContain('revision')
    }
    const unknown = path.join(tmpDir(), 'unknown.dot')
    fs.writeFileSync(unknown, fs.readFileSync(path.join(f.files, 'exports/linux.dot'), 'utf8').replaceAll('//:common', '//:absent'))
    const report = JSON.parse(call('add', unknown, 'bazel-cquery-dot/v1', 'Bazel 6.5.0', f.revision, 'partial').stdout)
    expect(report).toMatchObject({ unknown_labels: 1, unsupported_edges: expect.any(Number), diagnostics: [expect.stringContaining('//:absent')] })
    expect(report.unsupported_edges).toBeGreaterThan(0)
  }, 90000)

  it('navigates exact source and target spans both ways and reports stale or missing producer evidence', async () => {
    const f = fixture('generator-map'), { dataDir, repoId } = await indexedDataDir(f.root)
    const call = (file: string) => cli(['--data-dir', dataDir, 'generates', 'add', repoId, file])
    const file = path.join(f.files, 'mapping.json')
    const result = call(file)
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ mapped: 2, unplaced: 0 })
    const symbol = (name: string, path: string) => tool(dataDir, 'get_symbol', { symbol_id: { name, path } }).data
    const src = symbol('Query.displayName', 'account.graphql')
    expect(src.generation).toHaveLength(2)
    expect(symbol('Query.displayName', 'profile.graphql').generation).toBeUndefined()
    for (const name of ['readDisplayName', 'writeDisplayName']) {
      expect(symbol(name, 'accessors.ts').generation).toEqual([expect.objectContaining({ direction: 'generated_from', revision: f.revision, endpoint: expect.objectContaining({ path: 'account.graphql', start_line: 2, end_line: 2, evidence_id: expect.stringMatching(/^ev_/) }) })])
    }
    const partial = JSON.parse(fs.readFileSync(file, 'utf8')), bad = path.join(tmpDir(), 'bad.json')
    partial.links[0].target.path = 'missing.ts'
    partial.links[1].source.sha256 = '0'.repeat(64)
    fs.writeFileSync(bad, JSON.stringify(partial))
    expect(JSON.parse(call(bad).stdout)).toMatchObject({ mapped: 0, unplaced: 2, diagnostics: [{ reason: 'missing_file' }, { reason: 'stale_content' }] })
    expect(symbol('Query.displayName', 'account.graphql').generation).toBeUndefined()
    partial.revision = '1'.repeat(40)
    fs.writeFileSync(bad, JSON.stringify(partial))
    expect(call(bad).stderr).toContain('revision')
  }, 90000)
})
