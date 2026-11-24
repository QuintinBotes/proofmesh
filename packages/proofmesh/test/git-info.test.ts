import { describe, expect, it } from 'vitest'
import { gitInfo } from '../src/indexer/discovery.js'
import { indexedDataDir, ROOT, tool } from './helpers.js'

describe('a snapshot names the commit and branch it was built from', () => {
  it('gitInfo reads the commit, the branch and the distance behind the remote default branch from local refs only', () => {
    const g = gitInfo(ROOT)
    expect(g.available).toBe(true)
    expect(g.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof g.ref).toBe('string')
    expect(g.behind_remote === null || Number.isInteger(g.behind_remote)).toBe(true)
  })

  it('every envelope carries commit, ref and behind_remote, null for a repository that is not a git worktree', async () => {
    const { dataDir } = await indexedDataDir()
    const env = tool(dataDir, 'workspace_status', {})
    expect(env.snapshot).toMatchObject({ commit: null, ref: null, behind_remote: null })
  })

  it('#35 a detached head counts the commits of the remote default branch it lacks, names that branch, and says it is a detached head', async () => {
    const { execFileSync } = await import('node:child_process')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { Catalog, initDataDir } = await import('../src/meshstore/catalog.js')
    const { indexRepository } = await import('../src/indexer/coordinator.js')
    const { tmpDir } = await import('./helpers.js')
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
    const origin = tmpDir('pm-origin-')
    git(origin, 'init', '-q', '-b', 'main')
    for (const n of [1, 2, 3]) { fs.writeFileSync(path.join(origin, 'a.ts'), `export const n = ${n}\n`); git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', `c${n}`) }
    const clone = path.join(tmpDir('pm-clone-'), 'repo')
    git(path.dirname(clone), 'clone', '-q', origin, clone)
    git(clone, 'checkout', '-q', '--detach', 'HEAD~2')
    const d = tmpDir()
    initDataDir(d)
    const c = Catalog.open(d)
    const id = c.addRepository(clone).id
    c.close()
    await indexRepository(d, id)
    const env = tool(d, 'workspace_status', { repository_id: id })
    expect(env.snapshot).toMatchObject({ ref: 'detached', behind_remote: 2, behind_ref: 'origin/main' })
    expect(env.limitations.join(' ')).toMatch(/The snapshot is of a detached head; behind_remote counts the commits of origin\/main it lacks, as of the last fetch/)
  })
})

