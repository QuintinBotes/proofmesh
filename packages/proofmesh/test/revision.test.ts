import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cli, tmpDir, tool } from './helpers.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()

/** A git repository with two commits: the first declares `first` in src/a.ts and has src/gone.ts; the second renames it and deletes gone.ts. */
function twoCommits(): string {
  const repo = tmpDir('pm-rev-')
  git(repo, 'init', '-q')
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export function first(): number { return 1 }\n')
  fs.writeFileSync(path.join(repo, 'src/gone.ts'), 'export const gone = 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'first')
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export function second(): number { return 2 }\n')
  fs.rmSync(path.join(repo, 'src/gone.ts'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'second')
  return repo
}
const ok = (r: ReturnType<typeof cli>) => { expect(r.status, r.stderr).toBe(0); return r.stdout }
const names = (d: string, text: string, repository_id: string) => (tool(d, 'find_symbols', { text, repository_id }).data.symbols as Array<{ name: string }>).map((s) => s.name)

describe('#27 index --rev captures a commit from git objects and leaves the registered working tree alone', () => {
  it('indexes the named commit, records its sha, makes it current, and changes neither HEAD, the index, nor the working tree', () => {
    const d = tmpDir(), repo = twoCommits()
    fs.appendFileSync(path.join(repo, 'src/a.ts'), 'export const edited = true\n')
    fs.writeFileSync(path.join(repo, 'untracked.ts'), 'export const untracked = 1\n')
    const older = git(repo, 'rev-parse', 'HEAD~1')
    const state = () => [git(repo, 'status', '--porcelain'), git(repo, 'rev-parse', 'HEAD'), fs.readFileSync(path.join(repo, '.git', 'index')).toString('base64')]
    ok(cli(['--data-dir', d, 'init']))
    const id = ok(cli(['--data-dir', d, 'repo', 'add', repo])).trim()
    const before = state()

    expect(ok(cli(['--data-dir', d, 'index', repo, '--rev', 'HEAD~1']))).toContain(`from commit ${older} (HEAD~1); the working tree was not read`)

    expect(state()).toEqual(before)
    expect(fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8')).toBe('export function second(): number { return 2 }\nexport const edited = true\n')
    const env = tool(d, 'workspace_status', { repository_id: id, files: {} })
    expect(env.snapshot).toMatchObject({ repository_id: id, commit: older, ref: 'detached' })
    expect((env.data.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['src/a.ts', 'src/gone.ts'])
    expect(names(d, 'first', id)).toEqual(['first'])
    expect(names(d, 'second', id)).toEqual([])
    expect(fs.readdirSync(path.join(d, 'staging')).filter((f) => f.startsWith('job-'))).toEqual([])
    expect(ok(cli(['--data-dir', d, 'status', id]))).toContain(`of commit ${older} (detached)`)
  })

  it('refuses a name that is no commit and leaves no temporary tree', () => {
    const d = tmpDir(), repo = twoCommits()
    ok(cli(['--data-dir', d, 'init']))
    ok(cli(['--data-dir', d, 'repo', 'add', repo]))
    const r = cli(['--data-dir', d, 'index', repo, '--rev', 'no-such-branch'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`INVALID_ARGUMENT: no-such-branch names no commit in ${fs.realpathSync(repo)}`)
    expect(fs.readdirSync(path.join(d, 'staging')).filter((f) => f.startsWith('job-'))).toEqual([])
  })
})

describe('#27 repo move re-roots a registration at another working tree of the same repository', () => {
  it('keeps the id and snapshots for a clone holding the snapshot commit, refuses an unrelated repository, and a new registration at the old root gets another id', () => {
    const d = tmpDir(), repo = twoCommits()
    ok(cli(['--data-dir', d, 'init']))
    const id = ok(cli(['--data-dir', d, 'repo', 'add', repo, '--name', 'shop'])).trim()
    ok(cli(['--data-dir', d, 'index', id]))
    const snapshot = tool(d, 'workspace_status', { repository_id: id }).snapshot!.id
    const clone = path.join(tmpDir('pm-move-'), 'shop')
    git(path.dirname(clone), 'clone', '-q', repo, clone)
    const unrelated = twoCommits()

    const refused = cli(['--data-dir', d, 'repo', 'move', id, unrelated])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(`is not the top of a working tree of the same git repository as ${fs.realpathSync(repo)}, nor of one holding commit`)

    ok(cli(['--data-dir', d, 'repo', 'trust', id, '--build-evaluation']))
    const moved = ok(cli(['--data-dir', d, 'repo', 'move', 'shop', clone]))
    expect(moved).toContain(`shop (${id}) moved from ${fs.realpathSync(repo)} to ${fs.realpathSync(clone)}`)
    // Trust was granted for the old checkout; the move revokes it rather than carry it to a tree no person reviewed.
    expect(moved).toContain('Build evaluation trust was revoked by the move')
    expect(ok(cli(['--data-dir', d, 'repo', 'list']))).toBe(`${id}  shop  ${fs.realpathSync(clone)}\n`)
    expect(tool(d, 'workspace_status', { repository_id: id }).snapshot).toMatchObject({ id: snapshot, repository_id: id })
    expect(ok(cli(['--data-dir', d, 'status', id]))).toContain(`snapshot ${snapshot} (no_execution) of commit ${git(clone, 'rev-parse', 'HEAD')}`)
    expect(names(d, 'second', id)).toEqual(['second'])
    expect(ok(cli(['--data-dir', d, 'index', clone]))).toContain(`snapshot ${snapshot} unchanged`)

    const again = ok(cli(['--data-dir', d, 'repo', 'add', repo])).trim()
    expect(again).not.toBe(id)
    expect(ok(cli(['--data-dir', d, 'repo', 'list'])).split('\n').filter(Boolean)).toHaveLength(2)
  })
})
