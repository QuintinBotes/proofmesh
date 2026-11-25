// `proofmesh scip run` (A38, issue 23): runs a pinned SCIP indexer on a disposable copy of a repository's current snapshot, for a
// repository a person trusted for build evaluation, and names the result. Running an indexer is running another program, so it follows
// the launcher's rules: no shell, an allowlisted environment, SIGKILL on a time or memory limit, capped output, read on close. Only the
// CLI imports this file; a test keeps it out of the MCP and HTTP servers.
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProofmeshError } from '../core/errors.js'
import { sha256File } from '../core/hash.js'
import { REMEDY_TABLE } from '../indexer/census.js'
import { Catalog } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'
import { execute, exportSnapshot } from '../verification/launcher.js'
import { indexCoverage } from './coverage.js'
import { INDEXERS, indexerFor, platform, type Indexer, type IndexerContext } from './indexers.js'

export type ScipRunOptions = {
  language?: string
  /** An image reference pinned by digest (`name@sha256:...`) that has the indexer; the run is then `--network none` with the cache read-only. */
  container?: string
  /** The declared module cache: the only place the indexer may read dependencies from. Default `<data dir>/module-cache`. */
  moduleCache?: string
  timeoutS?: number
  maxMemoryMb?: number
  maxOutputKb?: number
  /** For a test that must act while the indexer runs; not reachable from the command line. */
  whileRunning?: () => void | Promise<void>
}
export type ScipRunResult = { name: string; indexer: string; version: string; digest: string; files: number; isolation: 'container' | 'process'; log: string; grantId: string }

const stripped = (language: string) => language.toLowerCase()
/** The command a person could run themselves, from the census's remedy table (FR140). */
const manualCommand = (language: string) => REMEDY_TABLE.find((r) => stripped(r.language) === stripped(language))?.run
const fail = (code: ConstructorParameters<typeof ProofmeshError>[0], message: string) => new ProofmeshError(code, message)

/** `<data dir>/indexers.json` lets a person pin the indexer they installed: {"scip-go": {"version": "v0.1.26", "sha256": "<hex>"}}. */
function pins(dataDir: string): Record<string, { version?: string; sha256?: string }> {
  const file = path.join(dataDir, 'indexers.json')
  if (!fs.existsSync(file)) return {}
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw fail('INVALID_ARGUMENT', `${file} is not JSON: ${(e as Error).message}`) }
}

/** The first executable of that name on PATH, found without a shell. */
function onPath(name: string, searchPath: string): string | undefined {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name)
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate } catch { /* not here */ }
  }
  return undefined
}

function languagesOf(catalog: Catalog, repositoryId: string): string[] {
  const snapshot = catalog.currentSnapshot(repositoryId)
  if (!snapshot) return []
  const db = openSnapshot(catalog, snapshot)
  try { return (db.prepare("select distinct language from file where content_hash is not null and language is not null").all() as Array<{ language: string }>).map((r) => r.language) } finally { db.close() }
}

/** The argv of a containerised run, named so it can be removed: no network, a read-only root, the cache read-only, and only the copy writable. */
export function containerArgv(image: string, work: string, cache: string, env: Record<string, string>, maxMemoryMb: number, command: string[], name: string): string[] {
  return ['docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only', '--memory', `${maxMemoryMb}m`, '--tmpfs', '/tmp', '-v', `${work}:/work`, '-v', `${cache}:/cache:ro`, '-w', '/work',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), image, ...command]
}

const MAX_INDEX_BYTES = 2 * 1024 ** 3
const lstat = (p: string) => { try { return fs.lstatSync(p) } catch { return undefined } }

/** What `<executable> --version` prints, run under the same rules as an indexer: no shell, a short SIGKILL timeout, capped output. */
async function versionOf(executable: string, dir: string, name: string, searchPath: string): Promise<string> {
  const log = path.join(dir, `${name}-version.log`)
  await execute([executable, '--version'], dir, { PATH: searchPath, HOME: dir }, 15_000, 8 * 1024, log, { group: true })
  const text = fs.readFileSync(log, 'utf8')
  fs.rmSync(log, { force: true })
  return text
}

/** Removing a container by name kills it and waits until it is gone; bounded, no shell. */
function removeContainer(name: string, searchPath: string): Promise<void> {
  return new Promise((resolve) => execFile('docker', ['rm', '-f', name], { timeout: 20_000, killSignal: 'SIGKILL', env: { PATH: searchPath } }, () => resolve()))
}

export async function runScip(dataDir: string, repository: string, opts: ScipRunOptions = {}): Promise<ScipRunResult[]> {
  const catalog = Catalog.open(dataDir)
  try {
    const repo = catalog.repository(repository)
    // The grant is read once: one that is made or revoked while the run is in progress is not this run's (A38).
    const grant = catalog.activeTrust(repo.id)
    if (!grant) {
      const manual = (opts.language ? [opts.language] : languagesOf(catalog, repo.id)).map((l) => ({ l, run: manualCommand(l) })).filter((x) => x.run)
      throw fail('TRUST_REQUIRED', `proofmesh scip run starts an indexer, which runs the repository's build logic, so it needs a build-evaluation grant and nothing was run. Grant it with: proofmesh repo trust ${repo.id} --build-evaluation. `
        + (manual.length ? `Or run the indexer yourself in a repository you trust (${manual.map((x) => `\`${x.run}\` for ${x.l}`).join('; ')}) and name its output with: proofmesh scip add ${repo.id} <index.scip>.` : `Or run an indexer yourself and name its output with: proofmesh scip add ${repo.id} <index.scip>.`))
    }
    const snapshot = catalog.currentSnapshot(repo.id)
    if (!snapshot) throw fail('SNAPSHOT_UNAVAILABLE', `${repo.name} has no snapshot to copy; index it first: proofmesh index ${repo.id}`)
    const chosen: Indexer[] = opts.language
      ? [indexerFor(opts.language) ?? (() => { throw fail('INVALID_ARGUMENT', `no pinned indexer reads ${opts.language}; they are ${INDEXERS.map((i) => `${i.tool} (${i.languages.join(', ')})`).join(', ')}`) })()]
      : [...new Set(languagesOf(catalog, repo.id).map((l) => indexerFor(l)).filter((i): i is Indexer => !!i))]
    if (!chosen.length) throw fail('INVALID_ARGUMENT', `the snapshot holds no language a pinned indexer reads (${INDEXERS.map((i) => i.tool).join(', ')})`)
    if (opts.container && !/@sha256:[0-9a-f]{64}$/.test(opts.container)) throw fail('INVALID_ARGUMENT', '--container takes an image pinned by digest: name@sha256:<64 hex digits>')

    const pinned = pins(dataDir), searchPath = process.env.PATH ?? ''
    const results: ScipRunResult[] = []
    for (const indexer of chosen) {
      const pin = pinned[indexer.tool]
      const version = pin?.version ?? indexer.version
      const runId = crypto.randomBytes(6).toString('hex')
      const base = path.join(dataDir, 'scip-run', repo.id)
      fs.mkdirSync(base, { recursive: true })
      let executable = indexer.tool, digest: string
      if (opts.container) digest = opts.container.slice(opts.container.lastIndexOf('@') + 1)
      else {
        const found = onPath(indexer.tool, searchPath)
        if (!found) throw fail('DEPENDENCY_UNAVAILABLE', `${indexer.tool} is not installed; Proofmesh never downloads an indexer. Install it with: ${indexer.install}`)
        // The release assets are archives, so the executable's own digest is not published: its version is checked, and its digest is recorded in the index.
        // A person who pinned a digest in indexers.json gets that enforced too.
        digest = sha256File(found)
        if (pin?.sha256 && digest !== pin.sha256) throw fail('INTEGRITY_FAILURE', `${found} has sha256 ${digest}, not the ${pin.sha256} pinned in ${path.join(dataDir, 'indexers.json')}`)
        const reported = await versionOf(found, base, `${indexer.tool}-${runId}`, searchPath)
        if (!reported.includes(version.replace(/^v/, ''))) throw fail('INTEGRITY_FAILURE', `${found} reports "${reported.trim().slice(0, 200)}", not the pinned ${indexer.tool} ${version}. Install the pinned one: ${indexer.install}`)
        executable = found
      }

      const work = path.join(base, `work-${indexer.tool}-${runId}`), log = path.join(base, `${indexer.tool}-${runId}.log`)
      const cache = path.resolve(opts.moduleCache ?? path.join(dataDir, 'module-cache'))
      fs.mkdirSync(cache, { recursive: true })
      fs.mkdirSync(path.join(work, '.proofmesh-home'), { recursive: true })
      const containerName = `proofmesh-scip-${runId}`
      try {
        exportSnapshot(catalog, snapshot.id, work)
        const inside = !!opts.container
        const ctx: IndexerContext = inside
          ? { dir: '/work', out: '/work/index.scip', cache: '/cache', home: '/work/.proofmesh-home' }
          : { dir: work, out: path.join(work, 'index.scip'), cache, home: path.join(work, '.proofmesh-home') }
        for (const [name, text] of Object.entries(indexer.files?.() ?? {})) fs.writeFileSync(path.join(work, name), text)
        // The allowlist: PATH so the indexer finds its toolchain, a private HOME, and the indexer's offline settings. Nothing else of this environment.
        const env: Record<string, string> = { PATH: searchPath, HOME: ctx.home, ...indexer.env(ctx) }
        const maxMemoryMb = opts.maxMemoryMb ?? 4096
        const argv = inside ? containerArgv(opts.container!, work, cache, env, maxMemoryMb, [indexer.tool, ...indexer.args(ctx)], containerName) : [executable, ...indexer.args(ctx)]
        const pending = execute(argv, work, inside ? { PATH: searchPath } : env, (opts.timeoutS ?? 1800) * 1000, (opts.maxOutputKb ?? 256) * 1024, log, { group: true, ...(inside ? {} : { maxRssKb: maxMemoryMb * 1024 }) })
        await opts.whileRunning?.()
        const outcome = await pending
        // Killing the docker client does not stop the container: the daemon owns it. Remove it by name, which kills it and waits.
        if (inside && (outcome.timedOut || outcome.error)) await removeContainer(containerName, searchPath)
        const tail = () => { const t = fs.readFileSync(log, 'utf8'); return t.length > 2000 ? `...${t.slice(-2000)}` : t }
        if (outcome.error) throw fail('DEPENDENCY_UNAVAILABLE', `${indexer.tool} could not be started: ${outcome.error}`)
        if (outcome.timedOut) throw fail('BUDGET_EXCEEDED', `${indexer.tool} was stopped after ${opts.timeoutS ?? 1800} s; its partial output was discarded and no index was named. Its log is ${log}`)
        if (outcome.memoryExceeded) throw fail('BUDGET_EXCEEDED', `${indexer.tool} was stopped for using more than ${maxMemoryMb} MB; its partial output was discarded and no index was named. Its log is ${log}`)
        if (outcome.code !== 0) throw fail('INTERNAL_ERROR', `${indexer.tool} exited with ${outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.code}`}${outcome.truncated ? ' (output truncated)' : ''}; no index was named. Its log:\n${tail()}`)
        const produced = path.join(work, 'index.scip')
        // The indexer wrote this path: only a regular file under a size cap is read, never a FIFO that blocks or a link that leaves the copy.
        const st = lstat(produced)
        if (!st) throw fail('INTERNAL_ERROR', `${indexer.tool} exited cleanly but wrote no index.scip; no index was named. Its log:\n${tail()}`)
        if (!st.isFile()) throw fail('INTERNAL_ERROR', `${indexer.tool} left index.scip as something other than a regular file; no index was named`)
        if (st.size > MAX_INDEX_BYTES) throw fail('BUDGET_EXCEEDED', `${indexer.tool} wrote an index of ${st.size} bytes, over the ${MAX_INDEX_BYTES} limit; no index was named`)
        let covered: ReturnType<typeof indexCoverage>
        try { covered = indexCoverage(produced, work, work) } catch (e) { throw fail('INTERNAL_ERROR', `${indexer.tool} wrote a file that is not a SCIP index (${(e as Error).message}); no index was named`) }
        // The index file is named by its content, so concurrent runs never overwrite each other's.
        const staged = path.join(base, `${indexer.tool}-${runId}.scip.tmp`)
        fs.copyFileSync(produced, staged)
        const sha = sha256File(staged), final = path.join(base, `${indexer.tool}-${sha.slice(0, 16)}.scip`)
        const previous = catalog.scipIndexes(repo.id).find((i) => i.name === indexer.tool)?.path
        fs.renameSync(staged, final)
        const isolation = opts.container ? 'container' : 'process'
        // The catalog checks the grant in the transaction that names the index: one revoked since the run began discards the result.
        let named
        try {
          named = catalog.addScip(repo.id, { name: indexer.tool, path: final, sha256: sha, tool: covered.tool, files: covered.files, run: { indexer: indexer.tool, version, digest, grant_id: grant.id, isolation, module_cache: cache } }, os.userInfo().username)
        } catch (e) {
          if (!catalog.scipIndexes(repo.id).some((i) => i.path === final)) fs.rmSync(final, { force: true })
          throw e
        }
        if (previous && previous !== final && previous.startsWith(base)) fs.rmSync(previous, { force: true })
        results.push({ name: named.name, indexer: indexer.tool, version, digest, files: Object.keys(covered.files).length, isolation, log, grantId: grant.id })
      } finally {
        fs.rmSync(work, { recursive: true, force: true })
      }
    }
    return results
  } finally {
    catalog.close()
  }
}
