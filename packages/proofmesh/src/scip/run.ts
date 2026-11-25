// `proofmesh scip run` (A38, issue 23): runs a pinned SCIP indexer on a disposable copy of a repository's current snapshot, for a
// repository a person trusted for build evaluation, and names the result. Running an indexer is running another program, so it follows
// the launcher's rules: no shell, an allowlisted environment, SIGKILL on a time or memory limit, capped output, read on close. Only the
// CLI imports this file; a test keeps it out of the MCP and HTTP servers.
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

/** The argv of a containerised run: no network, a read-only root, the cache read-only, and only the copy writable. */
export function containerArgv(image: string, work: string, cache: string, env: Record<string, string>, maxMemoryMb: number, command: string[]): string[] {
  return ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--memory', `${maxMemoryMb}m`, '--tmpfs', '/tmp', '-v', `${work}:/work`, '-v', `${cache}:/cache:ro`, '-w', '/work',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), image, ...command]
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
      let executable = indexer.tool, digest: string
      if (opts.container) digest = opts.container.slice(opts.container.lastIndexOf('@') + 1)
      else {
        const found = onPath(indexer.tool, searchPath)
        if (!found) throw fail('DEPENDENCY_UNAVAILABLE', `${indexer.tool} is not installed; Proofmesh never downloads an indexer. Install it with: ${indexer.install}`)
        digest = sha256File(found)
        const expected = pin?.sha256 ?? indexer.sha256[platform()]
        if (!expected) throw fail('INTEGRITY_FAILURE', `no digest is pinned for ${indexer.tool} ${version} on ${platform()}. If ${found} is the build you trust, pin it by adding {"${indexer.tool}": {"version": "${version}", "sha256": "${digest}"}} to ${path.join(dataDir, 'indexers.json')}`)
        if (digest !== expected) throw fail('INTEGRITY_FAILURE', `${found} has sha256 ${digest}, not the pinned ${expected} for ${indexer.tool} ${version}; install the pinned one: ${indexer.install}`)
        executable = found
      }

      const base = path.join(dataDir, 'scip-run', repo.id), work = path.join(base, `work-${indexer.tool}`), log = path.join(base, `${indexer.tool}.log`)
      const cache = path.resolve(opts.moduleCache ?? path.join(dataDir, 'module-cache'))
      fs.mkdirSync(cache, { recursive: true })
      fs.rmSync(work, { recursive: true, force: true })
      fs.mkdirSync(path.join(work, '.proofmesh-home'), { recursive: true })
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
        const argv = inside ? containerArgv(opts.container!, work, cache, env, maxMemoryMb, [indexer.tool, ...indexer.args(ctx)]) : [executable, ...indexer.args(ctx)]
        fs.mkdirSync(base, { recursive: true })
        const pending = execute(argv, work, inside ? { PATH: searchPath } : env, (opts.timeoutS ?? 1800) * 1000, (opts.maxOutputKb ?? 256) * 1024, log, { group: true, ...(inside ? {} : { maxRssKb: maxMemoryMb * 1024 }) })
        await opts.whileRunning?.()
        const outcome = await pending
        const tail = () => { const t = fs.readFileSync(log, 'utf8'); return t.length > 2000 ? `...${t.slice(-2000)}` : t }
        if (outcome.error) throw fail('DEPENDENCY_UNAVAILABLE', `${indexer.tool} could not be started: ${outcome.error}`)
        if (outcome.timedOut) throw fail('BUDGET_EXCEEDED', `${indexer.tool} was stopped after ${opts.timeoutS ?? 1800} s; its partial output was discarded and no index was named. Its log is ${log}`)
        if (outcome.memoryExceeded) throw fail('BUDGET_EXCEEDED', `${indexer.tool} was stopped for using more than ${maxMemoryMb} MB; its partial output was discarded and no index was named. Its log is ${log}`)
        if (outcome.code !== 0) throw fail('INTERNAL_ERROR', `${indexer.tool} exited with ${outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.code}`}${outcome.truncated ? ' (output truncated)' : ''}; no index was named. Its log:\n${tail()}`)
        const produced = path.join(work, 'index.scip')
        if (!fs.existsSync(produced)) throw fail('INTERNAL_ERROR', `${indexer.tool} exited cleanly but wrote no index.scip; no index was named. Its log:\n${tail()}`)
        let covered: ReturnType<typeof indexCoverage>
        try { covered = indexCoverage(produced, work, work) } catch (e) { throw fail('INTERNAL_ERROR', `${indexer.tool} wrote a file that is not a SCIP index (${(e as Error).message}); no index was named`) }
        // A grant revoked during the run no longer allows its result; a new one made meanwhile belongs to the next run.
        if (catalog.trustGrant(grant.id)?.revoked_at) throw fail('TRUST_REQUIRED', `the build-evaluation grant ${grant.id} was revoked while ${indexer.tool} ran; its output was discarded and no index was named`)
        const final = path.join(base, `${indexer.tool}.scip`)
        fs.copyFileSync(produced, `${final}.tmp`)
        fs.renameSync(`${final}.tmp`, final)
        const isolation = opts.container ? 'container' : 'process'
        const named = catalog.addScip(repo.id, { name: indexer.tool, path: final, sha256: sha256File(final), tool: covered.tool, files: covered.files, run: { indexer: indexer.tool, version, digest, grant_id: grant.id, isolation, module_cache: cache } }, os.userInfo().username)
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
