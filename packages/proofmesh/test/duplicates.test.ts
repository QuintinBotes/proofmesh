import Database from 'better-sqlite3'
import { duplicateGroups } from '../src/query/duplicates.js'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Member } from '../src/query/duplicates.js'
import { cli, fixtureRepo, indexedDataDir, tmpDir, tool, withSnapshot } from './helpers.js'

type Answer = { status: string; groups: { symbols: Member[]; tokens: number; members: number; hash: string; callers_overlap: boolean }[]; total_groups: number; too_small: number }
describe('FR2180 FR2181 FR2182 FR2183 FR2184 FR2185 duplicate declarations', () => {
  let dataDir: string, repoId: string, base: string, snapshotId: string
  const repo = tmpDir('pm-clones-')
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
  const duplicates = (input = {}) => tool(dataDir, 'find_duplicates', { snapshot_id: snapshotId, ...input }).data as Answer
  beforeAll(async () => {
    fs.cpSync(fixtureRepo('clones'), repo, { recursive: true })
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'plant clones')
    base = git('rev-parse', 'HEAD')
    ;({ dataDir, repoId, snapshotId } = await indexedDataDir(repo))
  }, 180000)

  it('lists the exact planted copies, filters, shared callers and other members of a keyed symbol', () => {
    const result = duplicates()
    const ts = result.groups.find((g) => g.symbols.some((s) => s.path === 'first.ts'))!
    expect(ts).toMatchObject({ members: 3, hash: expect.stringMatching(/^[0-9a-f]{12}$/), callers_overlap: true })
    expect(ts.symbols.map((s) => s.path)).toEqual(['first.ts', 'second.ts', 'tests/third.ts'])
    expect(ts.symbols[2]!.test).toBe(true)
    expect(duplicates({ include_tests: false, path: 'first.ts' }).groups[0]!.members).toBe(2)
    expect(duplicates({ include_generated: true, path: 'first.ts' }).groups[0]!.members).toBe(4)
    expect(duplicates({ key: ts.symbols[0]!.key }).groups[0]!.symbols.map((s) => s.path)).toEqual(['second.ts', 'tests/third.ts'])
    expect(duplicates({ path: 'different.ts' })).toMatchObject({ status: 'unique', groups: [] })
    expect(duplicates({ min_tokens: 1000 }).too_small).toBeGreaterThanOrEqual(3)
    const multilingual = duplicates({ min_tokens: 10 }).groups.map((g) => g.symbols.map((s) => s.path))
    expect(multilingual).toContainEqual(['one.py', 'two.py'])
    expect(multilingual).toContainEqual(['one.cs', 'two.cs'])
    expect(multilingual.flat()).not.toContain('stubs.ts')
    const first = tool(dataDir, 'find_duplicates', { limits: { max_rows: 1 }, min_tokens: 10 })
    expect(first.completion.next_cursor).toBeTruthy()
    expect(first.data.total_groups).toBe(multilingual.length)
    withSnapshot(dataDir, (db) => expect(db.prepare('explain query plan select id from symbol where body_hash = ?').all('a')).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('symbol_by_body_hash') })])))
    const output = cli(['--data-dir', dataDir, 'duplicates', repoId, '--json'])
    expect(output.status, output.stderr).toBe(0)
    expect(JSON.parse(output.stdout)).toEqual(result)
  })

  it('reports a legacy snapshot with no body hash', () => {
    const legacy = new Database(':memory:')
    try {
      legacy.exec('create table symbol(id text)')
      expect(duplicateGroups(legacy, {}, 0, 10)).toMatchObject({ status: 'no_body_hash', total_groups: 0, groups: [] })
    } finally { legacy.close() }
  })

  it('lists both unchanged twins against the base and leaves default counts and rows alone', async () => {
    const file = path.join(repo, 'first.ts')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('+ 1', '+ 4'))
    git('add', 'first.ts')
    git('commit', '-qm', 'modify one copy')
    const head = git('rev-parse', 'HEAD')
    for (const rev of [base, head]) {
      const indexed = cli(['--data-dir', dataDir, 'index', repoId, '--rev', rev])
      expect(indexed.status, indexed.stderr).toBe(0)
    }
    const normal = tool(dataDir, 'impact_completeness', { base, head }).data
    const { duplicates: twins, ...rest } = tool(dataDir, 'impact_completeness', { base, head, include_duplicates: true }).data
    expect(rest).toEqual(normal)
    expect(twins).toEqual([expect.objectContaining({ symbols: [expect.objectContaining({ path: 'second.ts' }), expect.objectContaining({ path: 'tests/third.ts' })] })])
  }, 180000)
})
