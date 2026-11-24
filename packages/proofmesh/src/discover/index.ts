// A10: rank GitHub repositories related to an indexed repository by the evidence in its snapshot, through read-only `gh` queries a
// person invokes, and clone one repository per explicit command. Proofmesh never calls GitHub except through these two commands.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ProofmeshError } from '../core/errors.js'
import { Catalog } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'

export type Term = { kind: 'package' | 'service' | 'channel' | 'endpoint_root'; term: string }
/** How a term reached a repository: its name equals the term, its name holds the term's tokens, or code search found the term in it. */
export type Via = 'exact_name' | 'name_tokens' | 'code_search'
export type Candidate = { repository: string; score: number; evidence: Array<Term & { hits: number; via: Via }>; size: number | null; pushed_at: string | null }
export type Discovery = { anchor: { repository_id: string; name: string; snapshot_id: string; github: string | null }; org: string | null; terms: Term[]; candidates: Candidate[]; limitations: string[] }
type RepoMeta = { size: number; pushedAt: string }

const MAX_TERMS = 20
const READ_ONLY = new Set(['search', 'api'])

/** Runs `gh` from PATH. Only read-only subcommands may pass here; `clone` has its own call so the allowlist stays honest. */
export function gh(args: string[], allow: Set<string> = READ_ONLY): string {
  if (!allow.has(args[0]!)) throw new ProofmeshError('INVALID_ARGUMENT', `gh ${args[0]} is not a read-only query`)
  const r = spawnSync('gh', args, { encoding: 'utf8' })
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') throw new ProofmeshError('INVALID_ARGUMENT', 'gh is not on PATH; install the GitHub CLI and sign in with "gh auth login", then run this command again')
  if (r.status !== 0) throw new ProofmeshError('INTERNAL_ERROR', `gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout
}

/** The names in a snapshot that another repository might share: packages it depends on, services it calls, channels, and endpoint roots. */
export function evidenceTerms(dataDir: string, repositoryId: string): { snapshotId: string; terms: Term[] } {
  const catalog = Catalog.open(dataDir)
  try {
    const snapshot = catalog.currentSnapshot(repositoryId)
    if (!snapshot) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', 'no published snapshot for this repository; run "proofmesh index" first', { detail: 'none' })
    const db = openSnapshot(catalog, snapshot)
    try {
      const seen = new Set<string>(), terms: Term[] = []
      const add = (kind: Term['kind'], term: string) => { const k = `${kind}:${term}`; if (term && !seen.has(k)) { seen.add(k); terms.push({ kind, term }) } }
      // Packages the snapshot's adapters read or found missing (A2), such as `npm:greeter/1.0.0` or `npm:absent-lib missing`, and
      // package references recorded as facts.
      const adapters = JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value) as Array<{ external_inputs?: string[] }>
      const packages = new Set<string>()
      for (const input of adapters.flatMap((a) => a.external_inputs ?? [])) { const m = /^(?:npm|pypi|nuget):((?:@[^/\s]+\/)?[^/\s]+)/.exec(input); if (m) packages.add(m[1]!) }
      for (const r of db.prepare(`select distinct x.name from assertion a join external_symbol x on x.id = a.target_id where a.type = 'depends_on_package'`).all() as Array<{ name: string }>) packages.add(r.name)
      for (const name of [...packages].sort()) add('package', name)
      for (const r of db.prepare(`select distinct kind, qualified_name from symbol where kind in ('service', 'channel', 'endpoint') order by kind, qualified_name`).all() as Array<{ kind: string; qualified_name: string }>) {
        if (r.kind === 'service') add('service', r.qualified_name)
        else if (r.kind === 'channel') add('channel', r.qualified_name.replace(/^[a-z]+:/, ''))
        else {
          // `GET api/v1/Orders/{id}` → `Orders`: the first segment that is not a verb, a version, or a parameter.
          const root = r.qualified_name.split(' ')[1]?.split('/').find((s) => s && !/^(api|v\d+|\{.*\})$/i.test(s))
          if (root) add('endpoint_root', root)
        }
      }
      return { snapshotId: snapshot.id, terms: terms.slice(0, MAX_TERMS) }
    } finally {
      db.close()
    }
  } finally {
    catalog.close()
  }
}

/** The anchor's own GitHub name, from its origin remote, read locally; null when the root has no GitHub origin. */
export function githubName(root: string): string | null {
  if (!fs.existsSync(path.join(root, '.git'))) return null
  const url = spawnSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).stdout.trim()
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null
}

/** `OrdersService` → orders, service; `inv-sync` → inv, sync. */
export function nameTokens(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** Non-empty first, then the most recently pushed, then by name: the tie-break A10 asks for (prototype bug B21). */
function preferred(meta: Map<string, RepoMeta>) {
  return (a: string, b: string): number => {
    const x = meta.get(a), y = meta.get(b)
    const empty = (m?: RepoMeta) => (m === undefined ? 1 : m.size === 0 ? 2 : 0)
    return empty(x) - empty(y) || (y?.pushedAt ?? '').localeCompare(x?.pushedAt ?? '') || a.localeCompare(b)
  }
}

export function discover(dataDir: string, repository: string, opts: { org?: string; limit?: number }): Discovery {
  const catalog = Catalog.open(dataDir)
  const repo = (() => { try { return catalog.repository(repository) } finally { catalog.close() } })()
  const { snapshotId, terms } = evidenceTerms(dataDir, repo.id)
  const anchor = githubName(repo.root)
  const scope = opts.org ? ['--owner', opts.org] : []
  // Code search that excludes the anchor, so its own matches cannot fill the result cap (prototype bug B22).
  const exclude = anchor ? ['--', `-repo:${anchor}`] : []
  const meta = new Map<string, RepoMeta>()
  const found = new Map<string, Candidate>()
  const credit = (name: string, t: Term, hits: number, via: Via) => {
    if (anchor && name.toLowerCase() === anchor.toLowerCase()) return
    const c = found.get(name) ?? { repository: name, score: 0, evidence: [], size: null, pushed_at: null }
    c.score += 1; c.evidence.push({ ...t, hits, via }); found.set(name, c)
  }
  // A name maps to one repository: exact name first, then a repository whose name holds every token of it, ties to `preferred`.
  const byName = (t: Term): boolean => {
    const name = t.term.split('/').pop()!
    const repos = JSON.parse(gh(['search', 'repos', name, ...scope, '--json', 'fullName,size,pushedAt', '--limit', '10'])) as Array<{ fullName: string } & RepoMeta>
    for (const r of repos) meta.set(r.fullName, { size: r.size, pushedAt: r.pushedAt })
    const short = (r: { fullName: string }) => r.fullName.split('/')[1]!
    const want = nameTokens(name)
    const tiers: Array<[Via, string[]]> = [
      ['exact_name', repos.filter((r) => short(r).toLowerCase() === name.toLowerCase()).map((r) => r.fullName)],
      ['name_tokens', repos.filter((r) => { const have = nameTokens(short(r)); return want.length > 0 && want.every((w) => have.some((h) => h.startsWith(w))) }).map((r) => r.fullName)],
    ]
    for (const [via, names] of tiers) {
      const pick = names.filter((n) => !anchor || n.toLowerCase() !== anchor.toLowerCase()).sort(preferred(meta))[0]
      if (pick) { credit(pick, t, 1, via); return true }
    }
    return false
  }
  const codeSearch = (t: Term) => {
    const hits = JSON.parse(gh(['search', 'code', t.term, ...scope, '--json', 'repository', '--limit', '20', ...exclude])) as Array<{ repository: { nameWithOwner: string } }>
    const byRepo = new Map<string, number>()
    for (const h of hits) byRepo.set(h.repository.nameWithOwner, (byRepo.get(h.repository.nameWithOwner) ?? 0) + 1)
    for (const [name, n] of byRepo) credit(name, t, n, 'code_search')
  }
  for (const t of terms) {
    // The repository that builds a package is usually named after it; a service's repository too, or else its name shows in code.
    if (t.kind === 'package') byName(t)
    else if (t.kind === 'service') { if (!byName(t)) codeSearch(t) }
    else codeSearch(t)
  }
  const hits = (c: Candidate) => c.evidence.reduce((s, e) => s + e.hits, 0)
  const ranked = [...found.values()].sort((a, b) => b.score - a.score || hits(b) - hits(a))
  const limit = opts.limit ?? 10
  // Look up size and push time only for candidates tied on score and hits near the cut, the only places the tie-break decides.
  const cut = ranked[limit - 1]
  for (const c of ranked) {
    const tied = ranked.some((o) => o !== c && o.score === c.score && hits(o) === hits(c))
    const near = !cut || c.score > cut.score || (c.score === cut.score && hits(c) >= hits(cut))
    if (tied && near && !meta.has(c.repository)) {
      const r = JSON.parse(gh(['api', `repos/${c.repository}`])) as { size: number; pushed_at: string }
      meta.set(c.repository, { size: r.size, pushedAt: r.pushed_at })
    }
  }
  const order = preferred(meta)
  const candidates = ranked.sort((a, b) => b.score - a.score || hits(b) - hits(a) || order(a.repository, b.repository)).slice(0, limit)
  for (const c of candidates) { const m = meta.get(c.repository); c.size = m?.size ?? null; c.pushed_at = m?.pushedAt ?? null }
  const limitations = anchor ? [] : ["the anchor has no GitHub origin remote, so code search could not exclude the anchor's own matches"]
  return { anchor: { repository_id: repo.id, name: repo.name, snapshot_id: snapshotId, github: anchor }, org: opts.org ?? null, terms, candidates, limitations }
}

/** Clones one repository with `gh repo clone` into `into/<name>`; the directory must not exist yet. */
export function clone(nameWithOwner: string, into: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(nameWithOwner)) throw new ProofmeshError('INVALID_ARGUMENT', `name the repository as owner/repo; got ${nameWithOwner}`)
  const dir = path.join(path.resolve(into), nameWithOwner.split('/')[1]!)
  if (fs.existsSync(dir)) throw new ProofmeshError('INVALID_ARGUMENT', `${dir} already exists`)
  fs.mkdirSync(path.resolve(into), { recursive: true })
  gh(['repo', 'clone', nameWithOwner, dir], new Set(['repo']))
  return dir
}
