import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ProofmeshError } from '../core/errors.js'
import { BUILT_IN_REGISTRY, type Registry } from './languages.js'
import { CODEOWNERS_PATHS } from './ownership.js'

export const EXCLUDED_DIRS = ['node_modules', 'dist', 'build', 'bin', 'obj'] as const
export const MAX_FILE_BYTES = 1048576
export const BINARY_PROBE_BYTES = 8192

export type Discovered = {
  path: string
  size: number
  status: 'capture' | 'excluded' | 'unsupported' | 'failed'
  detail: string | null
  language: string | null
  role: 'source' | 'config' | 'ownership' | 'registry' | null
  /** The adapter a file goes to regardless of its language: a SCIP index covers it (A27). */
  adapter?: string
}

export type GitInfo = { available: boolean; reason?: string; commit?: string; ref?: string; behind_remote?: number | null; behind_ref?: string | null; fetched_at?: string | null }

export const analysisConfig = () => ({
  excluded_dirs: EXCLUDED_DIRS.map((d) => `**/${d}/**`),
  max_file_bytes: MAX_FILE_BYTES,
  binary_probe_bytes: BINARY_PROBE_BYTES,
  symlinks: 'not_followed',
  metadata_dirs: ['.git'],
  ignore: 'git',
})

/**
 * What git ignores under the root, asked of git itself so every source of ignore rules applies as git applies it (.gitignore files,
 * .git/info/exclude, the global excludes file) and tracked files are never ignored (A19). Outside a git work tree nothing is ignored.
 */
function gitIgnored(root: string): (rel: string) => boolean {
  const r = spawnSync('git', ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (r.status !== 0) return () => false
  const entries = r.stdout.split('\0').filter(Boolean)
  const files = new Set(entries.filter((e) => !e.endsWith('/')))
  const dirs = entries.filter((e) => e.endsWith('/'))
  return (rel) => files.has(rel) || dirs.some((d) => rel.startsWith(d))
}

/** Every file under the root, each with exactly one discovery status. `.git` is metadata, not content. */
export function discover(root: string, registry: Registry = BUILT_IN_REGISTRY, ignored = gitIgnored(root)): Discovered[] {
  const out: Discovered[] = []
  const walk = (dirRel: string) => {
    const abs = path.join(root, dirRel)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch (e) {
      out.push({ path: dirRel || '.', size: 0, status: 'failed', detail: (e as NodeJS.ErrnoException).code ?? 'EREAD', language: null, role: null })
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const rel = (dirRel ? `${dirRel}/${entry.name}` : entry.name).normalize('NFC')
      if (entry.isSymbolicLink()) {
        out.push({ path: rel, size: 0, status: 'unsupported', detail: 'symlink_not_followed', language: null, role: null })
      } else if (entry.isDirectory()) {
        walk(rel)
      } else if (entry.isFile()) {
        out.push(registry.route(classify(root, rel, ignored, registry), root))
      }
    }
  }
  walk('')
  return out
}

function classify(root: string, rel: string, ignored: (rel: string) => boolean, registry: Registry): Discovered {
  const abs = path.join(root, rel)
  const segments = rel.split('/').slice(0, -1)
  let size = 0
  try {
    size = fs.statSync(abs).size
  } catch (e) {
    return { path: rel, size: 0, status: 'failed', detail: (e as NodeJS.ErrnoException).code ?? 'ESTAT', language: null, role: null }
  }
  const excluded = EXCLUDED_DIRS.find((d) => segments.includes(d))
  if (excluded) return { path: rel, size, status: 'excluded', detail: `**/${excluded}/**`, language: null, role: null }
  if (ignored(rel)) return { path: rel, size, status: 'excluded', detail: 'gitignore', language: null, role: null }
  if (size > MAX_FILE_BYTES) return { path: rel, size, status: 'excluded', detail: `max_file_bytes:${MAX_FILE_BYTES}`, language: null, role: null }
  try {
    const fd = fs.openSync(abs, 'r')
    const probe = Buffer.alloc(Math.min(size, BINARY_PROBE_BYTES))
    fs.readSync(fd, probe, 0, probe.length, 0)
    fs.closeSync(fd)
    if (probe.includes(0)) return { path: rel, size, status: 'unsupported', detail: 'binary', language: null, role: null }
  } catch (e) {
    return { path: rel, size, status: 'failed', detail: (e as NodeJS.ErrnoException).code ?? 'EREAD', language: null, role: null }
  }
  const name = path.posix.basename(rel)
  if (registry.serviceRegistries.includes(rel)) return { path: rel, size, status: 'capture', detail: null, language: 'service-registry', role: 'registry' }
  if ((CODEOWNERS_PATHS as readonly string[]).includes(rel)) return { path: rel, size, status: 'capture', detail: null, language: 'codeowners', role: 'ownership' }
  // A source stays a source when another adapter also reads it as configuration, as the TypeScript adapter reads Prisma schemas (A36)
  // and package.json, which the build adapter analyses as a manifest (FR129).
  const language = registry.sourceLanguage(name) ?? registry.manifestLanguage(name)
  if (language) return { path: rel, size, status: 'capture', detail: null, language, role: 'source' }
  const owner = registry.configOwner(name)
  if (owner) return { path: rel, size, status: 'capture', detail: null, language: `${owner.id}-config`, role: 'config' }
  const ext = path.posix.extname(name)
  return { path: rel, size, status: 'unsupported', detail: `no_adapter:${ext || name}`, language: null, role: null }
}

/** The git facts of a commit-ish in the working tree at root: HEAD unless another is named. */
export function gitInfo(root: string, rev = 'HEAD'): GitInfo {
  if (fs.existsSync(path.join(root, '.git'))) {
    const git = (...args: string[]) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }
    const commit = git('rev-parse', '-q', '--verify', `${rev}^{commit}`)
    // Local refs only, never a fetch: how far the commit is behind the remote default branch as the last fetch left it, naming the
    // branch compared and when that fetch happened, so a stale remote ref is not read as "current".
    const remote = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master'].find((r) => git('rev-parse', '-q', '--verify', r))
    const behind = commit && remote ? git('rev-list', '--count', `${commit}..${remote}`) : null
    const compared = remote ? (git('symbolic-ref', '--short', '-q', remote) || remote.replace('refs/remotes/', '')) : null
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir')
    const fetchHead = common ? path.join(common, 'FETCH_HEAD') : null
    const fetched = fetchHead && fs.existsSync(fetchHead) ? fs.statSync(fetchHead).mtime.toISOString() : null
    const ref = rev === 'HEAD' ? git('symbolic-ref', '--short', '-q', 'HEAD') : git('rev-parse', '--abbrev-ref', rev)
    return { available: true, ...(commit ? { commit } : {}), ref: ref || 'detached', behind_remote: behind === null ? null : Number(behind), behind_ref: compared, fetched_at: fetched }
  }
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return r.status === 0 ? { available: false, reason: 'root_is_not_worktree_top' } : { available: false, reason: 'no_git' }
}

/**
 * Writes the files of a commit into dir/tree from git objects alone, through a private index file and checkout-index with a
 * prefix, so the working tree at root, its HEAD and its index are never touched. LFS pointers stay pointers: smudging may fetch.
 */
export function checkoutCommit(root: string, rev: string, dir: string): { tree: string; git: GitInfo } {
  const git = rev.startsWith('-') ? undefined : gitInfo(root, rev)
  if (!git?.commit) throw new ProofmeshError('INVALID_ARGUMENT', git && !git.available ? `${root} is not the top of a git working tree, so it has no commits to index` : `${rev} names no commit in ${root}`)
  const tree = path.join(dir, 'tree')
  fs.mkdirSync(tree, { recursive: true })
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index'), GIT_LFS_SKIP_SMUDGE: '1' }
  for (const args of [['read-tree', git.commit], ['checkout-index', '-a', '-f', `--prefix=${tree}${path.sep}`]]) {
    const r = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' })
    if (r.status !== 0) throw new ProofmeshError('INTERNAL_ERROR', `git ${args[0]} of ${git.commit} failed: ${r.stderr.trim()}`)
  }
  return { tree, git }
}

/** Whether newRoot is the top of a working tree of the same git repository as oldRoot, or of one holding the commit a snapshot of it was built from. */
export function sameRepository(oldRoot: string, newRoot: string, commit: string | undefined): boolean {
  const git = (root: string, ...args: string[]) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }
  const common = (root: string) => { const d = fs.existsSync(root) ? git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir') : null; return d && fs.existsSync(d) ? fs.realpathSync(d) : null }
  if (!fs.existsSync(path.join(newRoot, '.git'))) return false
  const shared = common(oldRoot)
  if (shared && shared === common(newRoot)) return true
  return !!commit && git(newRoot, 'cat-file', '-e', `${commit}^{commit}`) !== null
}
