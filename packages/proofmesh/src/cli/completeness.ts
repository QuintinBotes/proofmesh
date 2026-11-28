import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { asProofmeshError, ProofmeshError } from '../core/errors.js'
import { MAX_LIMITS } from '../core/limits.js'
import { gitInfo } from '../indexer/discovery.js'
import { Catalog } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'
import { DEFAULT_MAX_BYTES, githubCommands, type Indexed, markdownReport, type Report, sarifReport } from '../query/completeness-report.js'
import { cliPath, runTool, treeFreshness } from '../query/tools.js'

const USAGE = 'usage: proofmesh completeness <repository> <base>[..<head>] [--depth N] [--static-only] [--format lean|json|markdown|sarif|github] [--max-bytes N] | proofmesh completeness <repository> --branches [--depth N] [--json]'
const FORMATS = ['lean', 'json', 'markdown', 'sarif', 'github']
const LIMITS = { max_rows: MAX_LIMITS.max_rows, max_bytes: MAX_LIMITS.max_bytes, timeout_ms: MAX_LIMITS.timeout_ms }

/** `<base>[..<head>]`, or a usage error. */
export function parseRange(range: string, usage: string): { base: string; head: string | undefined } {
  const [base, head, extra] = range.split('..')
  if (!base || head === '' || extra !== undefined) throw new ProofmeshError('INVALID_ARGUMENT', usage)
  return { base, head }
}

/** `--depth`, 1 to 5, default 1. */
export function parseDepth(flag: string | undefined, usage: string): number {
  const depth = flag === undefined ? 1 : Number(flag)
  if (!Number.isInteger(depth) || depth < 1 || depth > 5) throw new ProofmeshError('INVALID_ARGUMENT', usage)
  return depth
}

/**
 * The repository, with a snapshot of each side: a side with none is indexed first and waited for, the head first so a commit indexed for
 * the base leaves the current snapshot as it was (FR109). Returns the indexes it ran and how long each took.
 */
export function indexSides(dataDir: string, repository: string, base: string, head: string | undefined): { repo: ReturnType<Catalog['repository']>; indexed: Indexed[] } {
  const catalog = Catalog.open(dataDir)
  const indexed: Indexed[] = []
  try {
    const repo = catalog.repository(repository)
    for (const [side, rev] of [['head', head ?? null], ['base', base]] as const) {
      const sha = rev === null ? null : rev.startsWith('-') ? undefined : gitInfo(repo.root, rev).commit
      if (rev !== null && !sha) throw new ProofmeshError('INVALID_ARGUMENT', `${rev} names no commit in ${repo.name}`)
      if (sha ? catalog.snapshotOfCommit(repo.id, sha) : currentMatchesTree(catalog, dataDir, repo.id, repo.root)) continue
      const started = performance.now()
      const r = spawnSync(process.execPath, [cliPath(), '--data-dir', dataDir, 'index', repo.id, ...(sha ? ['--rev', sha, '--keep-current'] : [])], { stdio: ['ignore', 2, 2] })
      if (r.status !== 0) throw new ProofmeshError('INTERNAL_ERROR', `the index of ${rev ?? 'the working tree'} failed`)
      indexed.push({ side, rev: sha ?? 'the working tree', seconds: (performance.now() - started) / 1000 })
    }
    return { repo, indexed }
  } finally {
    catalog.close()
  }
}

/** The full impact_completeness answer, every page of `changed` joined, and the first page's limitations. */
export function completenessAnswer(dataDir: string, input: Record<string, unknown>): { data: Report & { pending: unknown[] }; limitations: string[] } {
  const env = runTool(dataDir, 'impact_completeness', { ...input, envelope: 'full', limits: LIMITS })
  const data = env.data as Report & { pending: unknown[] }
  for (let page = env; page.completion.next_cursor;) {
    page = runTool(dataDir, 'impact_completeness', { ...input, envelope: 'full', limits: LIMITS, cursor: page.completion.next_cursor })
    data.changed.push(...(page.data as Report).changed)
  }
  return { data, limitations: env.limitations }
}

/**
 * proofmesh completeness (FR114, FR2140): impact_completeness from base to head, or to the working tree, as lean text, the JSON answer, a
 * Markdown report, SARIF or GitHub workflow commands. It indexes a side with no snapshot first and waits. Exits 0 when no dependent is
 * neither, 1 when one is (or, with --static-only, one is covered only by an imported coverage report: FR2064), and 2 on a usage error, an unknown commit or a failed index. With --branches, the open local branches by blast radius.
 */
export function runCompleteness(dataDir: string, rest: string[], take: (args: string[], flag: string) => string | undefined, has: (args: string[], flag: string) => boolean): number {
  const opts = [...rest], json = has(opts, '--json'), branches = has(opts, '--branches'), staticOnly = has(opts, '--static-only'), depthFlag = take(opts, '--depth'), formatFlag = take(opts, '--format'), bytesFlag = take(opts, '--max-bytes')
  const format = formatFlag ?? (json ? 'json' : 'lean')
  try {
    const depth = parseDepth(depthFlag, USAGE), maxBytes = bytesFlag === undefined ? DEFAULT_MAX_BYTES : Number(bytesFlag)
    if (!FORMATS.includes(format) || (json && format !== 'json') || !Number.isInteger(maxBytes) || maxBytes < 1) throw new ProofmeshError('INVALID_ARGUMENT', USAGE)
    if (branches) {
      if (opts.length !== 1 || !['lean', 'json'].includes(format)) throw new ProofmeshError('INVALID_ARGUMENT', USAGE)
      return runBranches(dataDir, opts[0]!, depth, format === 'json')
    }
    if (opts.length !== 2) throw new ProofmeshError('INVALID_ARGUMENT', USAGE)
    const { base, head } = parseRange(opts[1]!, USAGE)
    const { repo, indexed } = indexSides(dataDir, opts[0]!, base, head)
    const input = { repository_id: repo.id, base, ...(head ? { head } : {}), depth }
    let data: Report & { pending: unknown[] }
    if (format === 'json') {
      const env = runTool(dataDir, 'impact_completeness', { ...input, envelope: 'full', limits: LIMITS })
      console.log(JSON.stringify(env, null, 2))
      data = env.data as typeof data
    } else if (format === 'lean') {
      // Every row, page by page; the first page's header, summary and limitations once.
      const env = runTool(dataDir, 'impact_completeness', { ...input, envelope: 'lean', limits: LIMITS })
      const lines = env.text!.split('\n'), rows = lines.filter((l) => !l.startsWith('# '))
      for (let page = env; page.completion.next_cursor;) {
        page = runTool(dataDir, 'impact_completeness', { ...input, envelope: 'lean', limits: LIMITS, cursor: page.completion.next_cursor })
        rows.push(...page.text!.split('\n').filter((l) => !l.startsWith('# ')))
      }
      const header = lines[0]!.replace(/ · \d+ rows? · /, ` · ${rows.length} row${rows.length === 1 ? '' : 's'} · `)
      console.log([header, ...rows, ...lines.slice(1).filter((l) => l.startsWith('# ') && !l.startsWith('# more:'))].join('\n'))
      data = env.data as typeof data
    } else {
      const answer = completenessAnswer(dataDir, input)
      data = answer.data
      if (format === 'sarif') console.log(JSON.stringify(sarifReport(data), null, 2))
      else {
        const md = markdownReport(data, answer.limitations, indexed, maxBytes)
        if (format === 'markdown') process.stdout.write(md)
        else {
          console.log(githubCommands(data).join('\n'))
          // Inside GitHub Actions the report also goes to the job's summary page.
          if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
        }
      }
    }
    return data.pending.length ? 2 : data.totals.neither + (staticOnly ? data.totals.covered ?? 0 : 0) > 0 ? 1 : 0
  } catch (e) {
    const err = asProofmeshError(e)
    process.stderr.write(`proofmesh: ${err.code}: ${err.message}\n`)
    if (format === 'json') console.log(JSON.stringify(err.toJSON(), null, 2))
    return 2
  }
}

/**
 * --branches (FR2146): each local branch with commits the checked-out one lacks, compared from their merge base, ranked by blast radius (its
 * changed symbols with a dependent that is neither), then by how many changed symbols it shares with the other branches, then by name.
 * Local refs only: nothing is fetched.
 */
function runBranches(dataDir: string, repository: string, depth: number, json: boolean): number {
  const root = (() => { const c = Catalog.open(dataDir); try { return c.repository(repository).root } finally { c.close() } })()
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new ProofmeshError('INVALID_ARGUMENT', `git ${args[0]} failed in ${root}: ${r.stderr.trim()}`)
    return r.stdout.trim()
  }
  const current = git('rev-parse', '--abbrev-ref', 'HEAD'), tip = git('rev-parse', 'HEAD')
  const rows: Array<{ branch: string; base: string; head: string; blast_radius: number; changed_symbols: number; neither: number; keys: Set<string> }> = []
  for (const name of git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter((b) => b && b !== current).sort()) {
    const head = git('rev-parse', `refs/heads/${name}`), base = git('merge-base', tip, head)
    if (base === head) continue
    const { repo } = indexSides(dataDir, repository, base, head)
    const { data } = completenessAnswer(dataDir, { repository_id: repo.id, base, head, depth })
    if (data.pending.length) throw new ProofmeshError('INTERNAL_ERROR', `the index of ${name} did not finish`)
    rows.push({ branch: name, base, head, blast_radius: data.changed.filter((c) => c.dependents.some((d) => d.status === 'neither')).length, changed_symbols: data.totals.changed_symbols, neither: data.totals.neither, keys: new Set(data.changed.map((c) => c.key)) })
  }
  const ranked = rows.map((r) => {
    const overlaps = rows.filter((o) => o !== r).map((o) => ({ branch: o.branch, shared: [...r.keys].filter((k) => o.keys.has(k)).length })).filter((o) => o.shared > 0)
    const { keys: _keys, ...rest } = r
    return { ...rest, overlap: overlaps.reduce((n, o) => n + o.shared, 0), overlaps }
  }).sort((a, b) => b.blast_radius - a.blast_radius || b.overlap - a.overlap || (a.branch < b.branch ? -1 : 1))
  if (json) console.log(JSON.stringify({ against: current, branches: ranked }, null, 2))
  else {
    console.log(`# branches · ${ranked.length} open branch${ranked.length === 1 ? '' : 'es'} · against ${current}`)
    for (const r of ranked) console.log(`${r.branch} blast=${r.blast_radius} changed=${r.changed_symbols} neither=${r.neither} overlap=${r.overlap}${r.overlaps.length ? ` with ${r.overlaps.map((o) => `${o.branch}:${o.shared}`).join(',')}` : ''}`)
  }
  return 0
}

/** Whether the current snapshot still matches the working tree, so it can stand for the head. */
function currentMatchesTree(catalog: Catalog, dataDir: string, repositoryId: string, root: string): boolean {
  const current = catalog.currentSnapshot(repositoryId)
  if (!current) return false
  const db = openSnapshot(catalog, current)
  try { return treeFreshness(db, dataDir, root, repositoryId).current } finally { db.close() }
}
