import { spawnSync } from 'node:child_process'
import { asProofmeshError, ProofmeshError } from '../core/errors.js'
import { MAX_LIMITS } from '../core/limits.js'
import { gitInfo } from '../indexer/discovery.js'
import { Catalog } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'
import { cliPath, runTool, treeFreshness } from '../query/tools.js'

const USAGE = 'usage: proofmesh completeness <repository> <base>[..<head>] [--depth N] [--json]'

/**
 * proofmesh completeness (FR114): impact_completeness from base to head, or to the working tree. It indexes a side with no snapshot first
 * and waits, the head first so a commit indexed for the base leaves the current snapshot as it was. Exits 0 when no dependent is neither,
 * 1 when one is, and 2 on a usage error, an unknown commit or a failed index.
 */
export function runCompleteness(dataDir: string, rest: string[], take: (args: string[], flag: string) => string | undefined, has: (args: string[], flag: string) => boolean): number {
  const opts = [...rest], json = has(opts, '--json'), depthFlag = take(opts, '--depth')
  try {
    const depth = depthFlag === undefined ? 1 : Number(depthFlag)
    if (opts.length !== 2 || !Number.isInteger(depth) || depth < 1 || depth > 5) throw new ProofmeshError('INVALID_ARGUMENT', USAGE)
    const [base, head, extra] = opts[1]!.split('..')
    if (!base || head === '' || extra !== undefined) throw new ProofmeshError('INVALID_ARGUMENT', USAGE)
    const catalog = Catalog.open(dataDir)
    let repo: ReturnType<Catalog['repository']>
    try {
      repo = catalog.repository(opts[0]!)
      for (const rev of [head ?? null, base]) {
        const sha = rev === null ? null : rev.startsWith('-') ? undefined : gitInfo(repo.root, rev).commit
        if (rev !== null && !sha) throw new ProofmeshError('INVALID_ARGUMENT', `${rev} names no commit in ${repo.name}`)
        if (sha ? catalog.snapshotOfCommit(repo.id, sha) : currentMatchesTree(catalog, dataDir, repo.id, repo.root)) continue
        const r = spawnSync(process.execPath, [cliPath(), '--data-dir', dataDir, 'index', repo.id, ...(sha ? ['--rev', sha, '--keep-current'] : [])], { stdio: ['ignore', 2, 2] })
        if (r.status !== 0) throw new ProofmeshError('INTERNAL_ERROR', `the index of ${rev ?? 'the working tree'} failed`)
      }
    } finally {
      catalog.close()
    }
    const input = { repository_id: repo.id, base, ...(head ? { head } : {}), depth, envelope: json ? 'full' : 'lean', limits: { max_rows: MAX_LIMITS.max_rows, max_bytes: MAX_LIMITS.max_bytes, timeout_ms: MAX_LIMITS.timeout_ms } }
    const env = runTool(dataDir, 'impact_completeness', input)
    if (json) console.log(JSON.stringify(env, null, 2))
    else {
      // Every row, page by page; the first page's header, summary and limitations once.
      const lines = env.text!.split('\n'), rows = lines.filter((l) => !l.startsWith('# '))
      for (let page = env; page.completion.next_cursor;) {
        page = runTool(dataDir, 'impact_completeness', { ...input, cursor: page.completion.next_cursor })
        rows.push(...page.text!.split('\n').filter((l) => !l.startsWith('# ')))
      }
      const header = lines[0]!.replace(/ · \d+ rows? · /, ` · ${rows.length} row${rows.length === 1 ? '' : 's'} · `)
      console.log([header, ...rows, ...lines.slice(1).filter((l) => l.startsWith('# ') && !l.startsWith('# more:'))].join('\n'))
    }
    const data = env.data as { pending: unknown[]; totals: { neither: number } }
    return data.pending.length ? 2 : data.totals.neither > 0 ? 1 : 0
  } catch (e) {
    const err = asProofmeshError(e)
    process.stderr.write(`proofmesh: ${err.code}: ${err.message}\n`)
    if (json) console.log(JSON.stringify(err.toJSON(), null, 2))
    return 2
  }
}

/** Whether the current snapshot still matches the working tree, so it can stand for the head. */
function currentMatchesTree(catalog: Catalog, dataDir: string, repositoryId: string, root: string): boolean {
  const current = catalog.currentSnapshot(repositoryId)
  if (!current) return false
  const db = openSnapshot(catalog, current)
  try { return treeFreshness(db, dataDir, root, repositoryId).current } finally { db.close() }
}
