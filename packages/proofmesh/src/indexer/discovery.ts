import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { ProofmeshError } from '../core/errors.js'
import { BUILT_IN_REGISTRY, type Registry } from './languages.js'
import { ADAPTER_LANGUAGE_NAMES, adapterLanguageId, detectLanguage, type Kind } from './language-detect.js'
import { CODEOWNERS_PATHS } from './ownership.js'
import { attributeLookup, isGeneratedFile, type Attributes } from './generated-vendored.js'
import { isDoc } from './doc-links.js'

/** Directories excluded wherever they sit. `build` is not one: it is output only where a manifest names it (FR295). */
export const EXCLUDED_DIRS = ['node_modules', 'dist', 'bin', 'obj'] as const
const GRADLE_MANIFESTS = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']
export const MAX_FILE_BYTES = 1048576
export const BINARY_PROBE_BYTES = 8192

export type Discovered = {
  path: string
  size: number
  status: 'capture' | 'excluded' | 'unsupported' | 'failed'
  detail: string | null
  language: string | null
  role: 'source' | 'config' | 'ownership' | 'registry' | null
  /** A captured file the policy flags generated (FR290, FR291): indexed, and every answer row from it says so. */
  generated?: true
  /** The adapter a file goes to regardless of its language: a SCIP index covers it (A27). */
  adapter?: string
  /** For a file the SCIP adapter takes: the name of the index that covers it, which the file's tier names. */
  scip?: string
  /** The language and kind the census lists the file under, whether or not any adapter reads it. */
  census?: { language: string; kind: Kind; extension?: string }
}

export type GitInfo = { available: boolean; reason?: string; commit?: string; ref?: string; behind_remote?: number | null; behind_ref?: string | null; fetched_at?: string | null }

export const analysisConfig = () => ({
  excluded_dirs: EXCLUDED_DIRS.map((d) => `**/${d}/**`),
  build_output: ['gradle:build', 'maven:target', 'cmake:CMakeCache.txt'],
  max_file_bytes: MAX_FILE_BYTES,
  binary_probe_bytes: BINARY_PROBE_BYTES,
  symlinks: 'not_followed',
  metadata_dirs: ['.git'],
  ignore: 'git',
  ignored_dirs: 'one_entry',
})

/** git ls-files gets this long, then it is killed (SIGKILL, since a hung child may ignore SIGTERM) and discovery fails naming it. */
const gitTimeoutMs = () => Math.max(50, Number(process.env.PROOFMESH_TEST_GIT_TIMEOUT_MS) || 600_000)
const GIT_MAX_BYTES = 512 * 1024 * 1024
/** What git reads: its own variables and the places its config and excludes live, never the rest of the environment. */
const gitEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|HOME|USER|TMPDIR|LANG|LC_.*|GIT_.*|XDG_.*)$/.test(k)))
const gitOptions = () => ({ encoding: 'utf8' as const, env: gitEnv(), timeout: gitTimeoutMs(), killSignal: 'SIGKILL' as const, maxBuffer: GIT_MAX_BYTES })
const ignoredArgs = (root: string) => ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']

/** git's answer as a predicate. Outside a git work tree, or without git, nothing is ignored; a git that hangs or floods is an error, not "nothing ignored". */
function ignoredFrom(root: string, r: { status: number | null; stdout: string; failure?: 'timeout' | 'output' }): (rel: string) => boolean {
  const cannot = 'discovery cannot tell which files git ignores'
  if (r.failure === 'timeout') throw new ProofmeshError('DEPENDENCY_UNAVAILABLE', `git ls-files did not answer within ${gitTimeoutMs() / 1000} s in ${root}; ${cannot}`, { detail: 'git_timeout' })
  if (r.failure === 'output') throw new ProofmeshError('DEPENDENCY_UNAVAILABLE', `git ls-files printed more than ${GIT_MAX_BYTES} bytes in ${root}; ${cannot}`, { detail: 'git_output_too_large' })
  if (r.status !== 0) return () => false
  const entries = r.stdout.split('\0').filter(Boolean)
  const files = new Set(entries.filter((e) => !e.endsWith('/')))
  const dirs = entries.filter((e) => e.endsWith('/'))
  return (rel) => files.has(rel) || dirs.some((d) => rel.startsWith(d))
}

/**
 * What git ignores under the root, asked of git itself so every source of ignore rules applies as git applies it (.gitignore files,
 * .git/info/exclude, the global excludes file) and tracked files are never ignored (A19). Outside a git work tree nothing is ignored.
 */
function gitIgnored(root: string): (rel: string) => boolean {
  const r = spawnSync('git', ignoredArgs(root), gitOptions())
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code
  return ignoredFrom(root, { status: r.status, stdout: r.stdout ?? '', failure: code === 'ETIMEDOUT' ? 'timeout' : code === 'ENOBUFS' ? 'output' : undefined })
}

/** gitIgnored without blocking the event loop; git is killed if this process exits first or the signal aborts (FR373), so neither leaves a git behind. */
function gitIgnoredAsync(root: string, signal?: AbortSignal): Promise<(rel: string) => boolean> {
  return new Promise((resolve, reject) => {
    const kill = () => child.kill('SIGKILL')
    // execFile answers on 'close', so every byte git printed is read.
    const child = execFile('git', ignoredArgs(root), gitOptions(), (error, stdout) => {
      process.off('exit', kill)
      signal?.removeEventListener('abort', kill)
      if (signal?.aborted) return reject(new ProofmeshError('CANCELLED', `discovery of ${root} was cancelled`))
      const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
      const failure = e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output' : e?.killed ? 'timeout' : undefined
      try { resolve(ignoredFrom(root, { status: e ? (typeof e.code === 'number' ? e.code : null) : 0, stdout, failure })) } catch (x) { reject(x) }
    })
    process.once('exit', kill)
    signal?.addEventListener('abort', kill, { once: true })
  })
}

/** Every file under the root, each with exactly one discovery status. `.git` is metadata, not content. */
export function discover(root: string, registry: Registry = BUILT_IN_REGISTRY, ignored = gitIgnored(root)): Discovered[] {
  const steps = walk(root, registry, ignored)
  for (;;) { const r = steps.next(); if (r.done) return r.value }
}

/** The event loop gets a turn every this many steps of the walk, so a signal, a timer or a cancel is seen while a large tree is read. */
const YIELD_EVERY = 100
/** How often discoverAsync reports the files it has found. */
const PROGRESS_EVERY = 1000

/**
 * discover for an index: the same walk, giving the event loop a turn every YIELD_EVERY steps so SIGTERM and the progress heartbeat are not
 * held back until the whole tree is read, reporting the files found every PROGRESS_EVERY, and ending as CANCELLED when the signal aborts.
 * shortcut: one filesystem call that never returns (a hung mount) still blocks the loop; move the walk to async fs if that is ever seen.
 */
export async function discoverAsync(root: string, registry: Registry, ignored: ((rel: string) => boolean) | undefined, o: { onFound?: (files: number) => void; signal?: AbortSignal } = {}): Promise<Discovered[]> {
  const cancelled = () => { if (o.signal?.aborted) throw new ProofmeshError('CANCELLED', `discovery of ${root} was cancelled`) }
  cancelled()
  const steps = walk(root, registry, ignored ?? await gitIgnoredAsync(root, o.signal))
  for (let n = 1; ; n++) {
    const r = steps.next()
    if (r.done) return r.value
    if (n % YIELD_EVERY) continue
    if (r.value && r.value % PROGRESS_EVERY === 0) o.onFound?.(r.value)
    await new Promise((resolve) => setImmediate(resolve))
    cancelled()
  }
}

/** The walk: one step per file found (yielding how many so far), then one per census row (yielding 0). It returns every file. */
function* walk(root: string, registry: Registry, ignored: (rel: string) => boolean): Generator<number, Discovered[]> {
  const out: Discovered[] = []
  const attributes = attributeLookup(root)
  function* dir(dirRel: string, inherited: Place): Generator<number, void> {
    const abs = path.join(root, dirRel)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch (e) {
      out.push({ path: dirRel || '.', size: 0, status: 'failed', detail: (e as NodeJS.ErrnoException).code ?? 'EREAD', language: null, role: null })
      yield out.length
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const here = placeOf(entries, inherited)
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const rel = (dirRel ? `${dirRel}/${entry.name}` : entry.name).normalize('NFC')
      if (entry.isSymbolicLink()) {
        out.push({ path: rel, size: 0, status: 'unsupported', detail: 'symlink_not_followed', language: null, role: null })
      } else if (entry.isDirectory() && ignored(`${rel}/`)) {
        // git ignores it as a whole (it lists it with --directory only when nothing inside is tracked or re-included), so it is one entry and never read (FR380).
        out.push({ path: `${rel}/`, size: 0, status: 'excluded', detail: 'gitignore', language: null, role: null })
      } else if (entry.isDirectory()) {
        yield* dir(rel, childPlace(here, entry.name, entries, root, dirRel))
        continue
      } else if (entry.isFile()) {
        const attrs = attributes(rel), before = classify(root, rel, ignored, registry, here, attrs), routed = registry.route(before, root)
        // A file that routing makes a source (a SCIP index covers it) was not one when classified: it is judged for generated now.
        const promoted = routed.status === 'capture' && routed.role === 'source' && !routed.generated && (before.status !== 'capture' || before.role !== 'source')
        out.push(promoted && (attrs.generated ?? isGeneratedFile(path.posix.basename(rel), readHead(path.join(root, rel), BINARY_PROBE_BYTES) ?? '')) ? { ...routed, generated: true } : routed)
      } else continue
      yield out.length
    }
  }
  yield* dir('', {})
  // Every file, links and unreadable directories included, is in one row of the language census.
  for (let i = 0; i < out.length; i++) { out[i] = { ...out[i]!, census: censusLabel(out[i]!, root) }; yield 0 }
  return out
}

/** What the directories above a file make of it: the first rule that applies from the top (FR293, FR295). */
type Place = { vendored?: string; output?: string }
/** A directory holding CMakeCache.txt is a CMake binary directory, with everything in it. */
const placeOf = (entries: fs.Dirent[], inherited: Place): Place =>
  inherited.output || !entries.some((e) => e.name === 'CMakeCache.txt' && e.isFile()) ? inherited : { ...inherited, output: 'build_output:cmake' }
/** The place of a subdirectory: `vendor` is Go's only beside vendor/modules.txt, `build` and `target` are output only beside the manifest that names them. */
function childPlace(here: Place, name: string, entries: fs.Dirent[], root: string, dirRel: string): Place {
  const has = (file: string) => entries.some((e) => e.name === file && e.isFile())
  const vendored = here.vendored ?? (name === 'third_party' ? 'vendored:third_party' : name === 'Pods' ? 'vendored:pods'
    : name === 'vendor' && fs.existsSync(path.join(root, dirRel, 'vendor', 'modules.txt')) ? 'vendored:go_vendor' : undefined)
  const output = here.output ?? (name === 'build' && GRADLE_MANIFESTS.some(has) ? 'build_output:gradle' : name === 'target' && has('pom.xml') ? 'build_output:maven' : undefined)
  return { ...(vendored ? { vendored } : {}), ...(output ? { output } : {}) }
}

function classify(root: string, rel: string, ignored: (rel: string) => boolean, registry: Registry, place: Place, attrs: Attributes): Discovered {
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
  // An attribute set to false overrides the path rules (FR291); one set to true makes a file vendored when no path rule did.
  const vendored = attrs.vendored === false ? undefined : place.vendored ?? (attrs.vendored ? 'vendored:linguist_vendored' : undefined)
  if (vendored) return { path: rel, size, status: 'excluded', detail: vendored, language: null, role: null }
  if (place.output) return { path: rel, size, status: 'excluded', detail: place.output, language: null, role: null }
  if (size > MAX_FILE_BYTES) return { path: rel, size, status: 'excluded', detail: `max_file_bytes:${MAX_FILE_BYTES}`, language: null, role: null }
  let head = ''
  try {
    const fd = fs.openSync(abs, 'r')
    const probe = Buffer.alloc(Math.min(size, BINARY_PROBE_BYTES))
    fs.readSync(fd, probe, 0, probe.length, 0)
    fs.closeSync(fd)
    if (probe.includes(0)) return { path: rel, size, status: 'unsupported', detail: 'binary', language: null, role: null }
    head = probe.toString('utf8')
  } catch (e) {
    return { path: rel, size, status: 'failed', detail: (e as NodeJS.ErrnoException).code ?? 'EREAD', language: null, role: null }
  }
  const name = path.posix.basename(rel)
  const found = classifyCaptured(root, rel, name, head, size, registry)
  // A Markdown doc is flagged as a source is, so a generated one names no code (FR822).
  return ((found.status === 'capture' && found.role === 'source') || isDoc(found)) && (attrs.generated ?? isGeneratedFile(name, head)) ? { ...found, generated: true } : found
}

function classifyCaptured(root: string, rel: string, name: string, head: string, size: number, registry: Registry): Discovered {
  if (registry.serviceRegistries.includes(rel)) return { path: rel, size, status: 'capture', detail: null, language: 'service-registry', role: 'registry' }
  if ((CODEOWNERS_PATHS as readonly string[]).includes(rel)) return { path: rel, size, status: 'capture', detail: null, language: 'codeowners', role: 'ownership' }
  // A source stays a source when another adapter also reads it as configuration, as the TypeScript adapter reads Prisma schemas (A36)
  // and package.json, which the build adapter analyses as a manifest (FR129).
  // A Gradle script in Kotlin is a build manifest before it is Kotlin source (FR160).
  const language = registry.manifestLanguage(name) ?? sourceLanguageOf(registry, root, name, rel, head)
  if (language) return { path: rel, size, status: 'capture', detail: null, language, role: 'source' }
  const owner = registry.configOwner(name)
  if (owner) return { path: rel, size, status: 'capture', detail: null, language: `${owner.id}-config`, role: 'config' }
  const ext = path.posix.extname(name)
  return { path: rel, size, status: 'unsupported', detail: `no_adapter:${ext || name}`, language: null, role: null }
}

/** The first bytes of a file as text, or undefined when it cannot be read. */
function readHead(abs: string, bytes: number): string | undefined {
  try {
    const fd = fs.openSync(abs, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, bytes, 0))
    } finally { fs.closeSync(fd) }
  } catch { return undefined }
}

/**
 * The language an adapter analyses a file as. The extension decides, except where the file's shebang or content settles the language
 * (an extensionless script, a .h that holds C++): then it goes to the syntax tier, whose grammar follows the language it is given.
 */
function sourceLanguageOf(registry: Registry, root: string, name: string, rel: string, head: string): string | undefined {
  const byExtension = registry.sourceLanguage(name)
  if (byExtension && !/\.h$/i.test(name)) return byExtension
  const found = detectLanguage(rel, (bytes) => (bytes && bytes > head.length ? readHead(path.join(root, rel), bytes) : head))
  if (!found.via_content) return byExtension
  // The content settled it: a language the syntax tier reads goes there, any other (Objective-C in a .h) is not given to the extension's parser.
  const id = adapterLanguageId(found.name)
  return id && registry.specs.find((s) => s.languages.has(id))?.id === 'syntax' ? id : undefined
}

/** The row of the language census a file belongs to. Source files take the name of the language their adapter was given. */
function censusLabel(d: Discovered, root: string): NonNullable<Discovered['census']> {
  if (d.detail === 'binary') return { language: 'binary', kind: 'binary' }
  if (d.path.endsWith('/')) return { language: 'unknown', kind: 'unknown', extension: '(ignored directory)' }
  const adapterName = d.role === 'source' && d.language ? ADAPTER_LANGUAGE_NAMES[d.language] : undefined
  if (adapterName) return { language: adapterName, kind: 'code' }
  // A link is never followed and an unreadable file has no text: they are named by their file name alone.
  const readable = d.status !== 'failed' && d.detail !== 'symlink_not_followed'
  const found = detectLanguage(d.path, (bytes = BINARY_PROBE_BYTES) => (readable ? readHead(path.join(root, d.path), bytes) : undefined))
  return found.name === 'unknown' ? { language: 'unknown', kind: 'unknown', extension: found.extension! } : { language: found.name, kind: found.kind }
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
