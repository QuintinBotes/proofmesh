// Local git history, from a snapshot's commit backwards (FR2024, as FR2001 of #238): the one reader and per-snapshot cache that change
// coupling (#239), hotspots (#238) and symbol history (#240) share. Read-only `git log` on the registered root, run as discovery runs git;
// nothing is fetched. The window ends at the snapshot's commit, never at the clock, so one snapshot always reads the same commits.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ProofmeshError } from '../core/errors.js'
import { gitOptions } from './discovery.js'

/** A file a commit changed, by its path at the window's end (renames followed), and its line counts; null for a binary file. */
export type Change = { path: string; added: number | null; deleted: number | null; renamed_from?: string }
export type Commit = { sha: string; time: number; files: Change[] }
/** A number of commits, or of days counted back from the snapshot commit's date. */
export type Window = { days: number } | { commits: number }
export type History =
  | { available: false; reason: string }
  | { available: true; commit: string; window: Window; commits: Commit[]; shallow: boolean; capped: boolean }

export const DEFAULT_WINDOW: Window = { days: 365 }
/** At most this many commits are read, whatever the window, so an answer stays bounded. */
export const MAX_COMMITS = 10_000
const TIMEOUT_MS = 60_000
const CACHE_SIZE = 16
const cache = new Map<string, History>()

/** The commits of the window ending at commit, newest first; merge commits are left out, so each change is counted once, on its own commit. */
export function readHistory(root: string, commit: string | null | undefined, window: Window = DEFAULT_WINDOW): History {
  if (!commit) return { available: false, reason: 'the snapshot records no commit' }
  const key = JSON.stringify([root, commit, window])
  const hit = cache.get(key)
  if (hit) return hit
  const h = read(root, commit, window)
  cache.set(key, h)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return h
}

function read(root: string, commit: string, window: Window): History {
  if (!fs.existsSync(path.join(root, '.git'))) return { available: false, reason: `${root} is not the top of a git working tree` }
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { ...gitOptions(), timeout: TIMEOUT_MS })
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new ProofmeshError('DEPENDENCY_UNAVAILABLE', `git ${args[0]} did not answer within ${TIMEOUT_MS / 1000} s in ${root}`, { detail: 'git_timeout' })
    return r
  }
  const shown = git('show', '-s', '--format=%ct', `${commit}^{commit}`, '--')
  if (shown.status !== 0) return { available: false, reason: `commit ${commit.slice(0, 12)} is not in the repository at ${root}` }
  const shallow = git('rev-parse', '--is-shallow-repository').stdout.trim() === 'true'
  const limit = 'commits' in window ? Math.min(window.commits, MAX_COMMITS) : MAX_COMMITS
  const since = 'days' in window ? [`--since=${new Date((Number(shown.stdout.trim()) - window.days * 86400) * 1000).toISOString()}`] : []
  const log = git('log', '-z', '--numstat', '-M', '--no-merges', '--no-color', '--no-ext-diff', '--no-textconv', '--format=%x01%H %ct', `--max-count=${limit + 1}`, ...since, commit, '--')
  if (log.status !== 0) throw new ProofmeshError('INTERNAL_ERROR', `git log failed in ${root}: ${log.stderr.trim()}`)
  const commits: Commit[] = []
  const tokens = log.stdout.split('\0')
  const count = (v: string) => (v === '-' ? null : Number(v))
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.replace(/^\n/, '')
    if (t.startsWith('\x01')) {
      const [sha, time] = t.slice(1).split(' ')
      commits.push({ sha: sha!, time: Number(time), files: [] })
      continue
    }
    const m = /^(-|\d+)\t(-|\d+)\t([^]*)$/.exec(t)
    if (!m || !commits.length) continue
    // A rename is `added deleted` then an empty path, the old path and the new path, each its own token.
    if (m[3] === '') { commits.at(-1)!.files.push({ path: tokens[i + 2]!, added: count(m[1]!), deleted: count(m[2]!), renamed_from: tokens[i + 1]! }); i += 2 }
    else commits.at(-1)!.files.push({ path: m[3]!, added: count(m[1]!), deleted: count(m[2]!) })
  }
  const capped = commits.length > limit && limit === MAX_COMMITS
  commits.splice(limit)
  // Newest first: a path an older commit names is the one a later rename gave it, as of the window's end.
  const renamed = new Map<string, string>()
  for (const c of commits) for (const f of c.files) {
    f.path = renamed.get(f.path) ?? f.path
    if (f.renamed_from !== undefined) renamed.set(f.renamed_from, f.path)
  }
  return { available: true, commit, window, commits, shallow, capped }
}
