import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { evidenceTerms } from '../src/discover/index.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { cli, fixtureRepo, indexedDataDir, tmpDir } from './helpers.js'

const FAKE_GH = path.join(import.meta.dirname, 'fake-gh')
/** A copy of a fixture in its own git repository whose origin remote is `url`. */
function anchoredCopy(fixture: string, url: string): string {
  const dir = tmpDir('pm-anchor-')
  fs.cpSync(fixtureRepo(fixture), dir, { recursive: true })
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', url]]) expect(spawnSync('git', ['-C', dir, ...args]).status).toBe(0)
  return dir
}
/** Runs the CLI with the fake gh first on PATH; every gh argv line lands in the log. */
function withGh(answers: Record<string, unknown>) {
  const dir = tmpDir('pm-gh-'), log = path.join(dir, 'log'), file = path.join(dir, 'answers.json')
  fs.writeFileSync(file, JSON.stringify(answers))
  fs.writeFileSync(log, '')
  return { env: { PATH: `${FAKE_GH}:${process.env.PATH}`, GH_LOG: log, GH_ANSWERS: file }, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
}

describe('A10 discover ranks related repositories by snapshot evidence, through read-only gh queries a person invokes', () => {
  it('the terms come from the snapshot: channels, then the first segment of each endpoint path, each once', async () => {
    const { dataDir, repoId, snapshotId } = await indexedDataDir(fixtureRepo('cs-frameworks'))
    expect(evidenceTerms(dataDir, repoId)).toEqual({
      snapshotId,
      terms: [
        { kind: 'channel', term: 'orders.cancelled' }, { kind: 'channel', term: 'orders.placed' },
        { kind: 'endpoint_root', term: 'Orders' }, { kind: 'endpoint_root', term: 'orders' }, { kind: 'endpoint_root', term: 'Invoices' }, { kind: 'endpoint_root', term: 'health' },
        { kind: 'endpoint_root', term: 'inventory' }, { kind: 'endpoint_root', term: 'legacy' }, { kind: 'endpoint_root', term: 'override' }, { kind: 'endpoint_root', term: 'status' },
      ],
    })
  }, 240000)

  it('a package dependency is a term, searched as a repository name', async () => {
    const { dataDir, repoId } = await indexedDataDir(fixtureRepo('ts-packages'))
    // Nothing is installed in the fixture, so every declared dependency is a missing external input, and still evidence.
    expect(evidenceTerms(dataDir, repoId).terms).toEqual([{ kind: 'package', term: '@fx/util' }, { kind: 'package', term: 'absent-lib' }, { kind: 'package', term: 'greeter' }])
    const gh = withGh({ greeter: [{ fullName: 'acme/greeter-docs', size: 40, pushedAt: '2026-10-01T00:00:00Z' }, { fullName: 'acme/greeter', size: 900, pushedAt: '2025-01-01T00:00:00Z' }] })
    const r = cli(['--data-dir', dataDir, 'discover', '--anchor', repoId, '--org', 'acme', '--json'], gh.env)
    expect(r.status, r.stderr).toBe(0)
    // The exact name wins over a more recently pushed repository that only holds the name's tokens.
    expect(JSON.parse(r.stdout).candidates).toEqual([{ repository: 'acme/greeter', score: 1, evidence: [{ kind: 'package', term: 'greeter', hits: 1, via: 'exact_name' }], size: 900, pushed_at: '2025-01-01T00:00:00Z' }])
    expect(gh.calls()).toEqual(['search repos util --owner acme --json fullName,size,pushedAt --limit 10', 'search repos absent-lib --owner acme --json fullName,size,pushedAt --limit 10', 'search repos greeter --owner acme --json fullName,size,pushedAt --limit 10'])
  }, 240000)

  it('candidates score one per distinct term, ties break on hits; every query is read-only and stays inside --org', async () => {
    const { dataDir, repoId } = await indexedDataDir(fixtureRepo('cs-frameworks'))
    const hit = (n: string) => ({ repository: { nameWithOwner: n } })
    const gh = withGh({ 'orders.placed': [hit('acme/orders-worker'), hit('acme/orders-worker'), hit('acme/shop-api')], Orders: [hit('acme/shop-api'), hit('acme/shop-api'), hit('acme/shop-api'), hit('acme/billing')] })
    const r = cli(['--data-dir', dataDir, 'discover', repoId, '--org', 'acme', '--limit', '2'], gh.env)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.split('\n').slice(0, 4)).toEqual([
      expect.stringMatching(/^repo \(snap_\w+\): 10 terms searched within acme through read-only gh queries$/),
      '  2  acme/shop-api  channel orders.placed (1), endpoint_root Orders (3)',
      '  1  acme/orders-worker  channel orders.placed (2)',
      "limitation: the anchor has no GitHub origin remote, so code search could not exclude the anchor's own matches",
    ])
    const calls = gh.calls()
    expect(calls).toHaveLength(10)
    for (const c of calls) expect(c).toMatch(/^search code \S+ --owner acme --json repository --limit 20$/)
  }, 240000)

  it('A10 B22 code search excludes the anchor, named by its origin remote, and the anchor is never a candidate', async () => {
    const repo = anchoredCopy('cs-frameworks', 'https://github.com/acme/shop.git')
    const { dataDir, repoId } = await indexedDataDir(repo)
    const hit = (n: string) => ({ repository: { nameWithOwner: n } })
    const gh = withGh({ Orders: [hit('acme/shop'), hit('acme/shop'), hit('acme/storefront')] })
    const d = JSON.parse(cli(['--data-dir', dataDir, 'discover', '--anchor', repoId, '--org', 'acme', '--json'], gh.env).stdout)
    expect(d.anchor.github).toBe('acme/shop')
    expect(d.limitations).toEqual([])
    for (const c of gh.calls()) expect(c).toMatch(/^search code \S+ --owner acme --json repository --limit 20 -- -repo:acme\/shop$/)
    expect(d.candidates).toEqual([{ repository: 'acme/storefront', score: 1, evidence: [{ kind: 'endpoint_root', term: 'Orders', hits: 1, via: 'code_search' }], size: null, pushed_at: null }])
  }, 240000)

  it('A10 B21 without an exact name, a name maps to the repository holding its tokens, preferring non-empty, then recently pushed', async () => {
    const { dataDir, repoId } = await indexedDataDir(fixtureRepo('ts-packages'))
    const gh = withGh({ greeter: [
      { fullName: 'acme/greeter-sandbox', size: 0, pushedAt: '2026-11-01T00:00:00Z' },
      { fullName: 'acme/greeter-service', size: 300, pushedAt: '2025-06-01T00:00:00Z' },
      { fullName: 'acme/greeter-web', size: 50, pushedAt: '2026-03-01T00:00:00Z' },
      { fullName: 'acme/greet', size: 70, pushedAt: '2026-10-01T00:00:00Z' },
    ] })
    const d = JSON.parse(cli(['--data-dir', dataDir, 'discover', '--anchor', repoId, '--org', 'acme', '--json'], gh.env).stdout)
    // Alphabetical order would pick the empty sandbox, the prototype's bug; `greet` lacks the token `greeter`.
    expect(d.candidates.map((c: { repository: string; evidence: Array<{ via: string }> }) => [c.repository, c.evidence[0]!.via])).toEqual([['acme/greeter-web', 'name_tokens']])
  }, 240000)

  it('A10 B21 candidates tied on score and hits rank non-empty first, then most recently pushed; gh api runs only for the tie', async () => {
    const { dataDir, repoId } = await indexedDataDir(fixtureRepo('cs-frameworks'))
    const hit = (n: string) => ({ repository: { nameWithOwner: n } })
    const gh = withGh({
      'orders.placed': [hit('acme/a-sandbox'), hit('acme/b-old'), hit('acme/c-new'), hit('acme/lead'), hit('acme/lead')],
      'repos/acme/a-sandbox': { size: 0, pushed_at: '2026-11-11T00:00:00Z' }, 'repos/acme/b-old': { size: 10, pushed_at: '2024-01-01T00:00:00Z' }, 'repos/acme/c-new': { size: 10, pushed_at: '2026-09-01T00:00:00Z' },
    })
    const d = JSON.parse(cli(['--data-dir', dataDir, 'discover', '--anchor', repoId, '--org', 'acme', '--json'], gh.env).stdout)
    expect(d.candidates.map((c: { repository: string; size: number | null }) => [c.repository, c.size])).toEqual([['acme/lead', null], ['acme/c-new', 10], ['acme/b-old', 10], ['acme/a-sandbox', 0]])
    expect(gh.calls().filter((c) => c.startsWith('api ')).sort()).toEqual(['api repos/acme/a-sandbox', 'api repos/acme/b-old', 'api repos/acme/c-new'])
  }, 240000)

  it('without gh on PATH the command fails before anything else, and a missing snapshot is refused', async () => {
    const { dataDir, repoId } = await indexedDataDir(fixtureRepo('ts-packages'))
    const r = cli(['--data-dir', dataDir, 'discover', repoId], { PATH: tmpDir('pm-empty-path-') })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('gh is not on PATH')
    const bare = tmpDir()
    for (const args of [['init'], ['repo', 'add', fixtureRepo('ts-packages')]]) expect(cli(['--data-dir', bare, ...args]).status).toBe(0)
    expect(cli(['--data-dir', bare, 'discover', fixtureRepo('ts-packages')]).stderr).toContain('no published snapshot')
  }, 240000)

  it('clone runs gh repo clone for exactly one repository, and --add registers it into a workspace', () => {
    const d = tmpDir(), into = path.join(tmpDir('pm-clones-'), 'repos'), gh = withGh({})
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
    const r = cli(['--data-dir', d, 'clone', 'acme/shop-api', '--into', into, '--add', '--workspace', 'shop'], gh.env)
    expect(r.status, r.stderr).toBe(0)
    expect(gh.calls()).toEqual([`repo clone acme/shop-api ${path.join(into, 'shop-api')}`])
    expect(fs.readFileSync(path.join(into, 'shop-api', 'CLONED'), 'utf8')).toBe('acme/shop-api\n')
    const c = Catalog.open(d)
    try {
      expect(c.repositories().map((x) => x.root)).toEqual([fs.realpathSync(path.join(into, 'shop-api'))])
      expect(c.workspace('shop').members).toEqual([c.repositories()[0]!.id])
    } finally { c.close() }
    expect(cli(['--data-dir', d, 'clone', 'acme/shop-api', '--into', into], gh.env).stderr).toContain('already exists')
    expect(cli(['--data-dir', d, 'clone', 'not-a-repo', '--into', into], gh.env).stderr).toContain('owner/repo')
    expect(gh.calls()).toHaveLength(1)
  })
})
