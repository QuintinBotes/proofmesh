import { sha256 } from '../core/hash.js'
import { DETECTION_RULES, type Kind } from './language-detect.js'
import { LINGUIST } from './linguist-table.js'

/** The rows past this many are summed into one `other` row, so the census stays bounded on a repository of many extensions. */
export const MAX_ROWS = 64
export const CENSUS_CAPABILITIES = ['symbols', 'imports', 'references', 'resolved_calls'] as const
export const LEVELS = ['complete', 'partial', 'unsupported', 'failed', 'not_run'] as const
type Counts = Record<(typeof LEVELS)[number], number>

export type CensusFile = {
  label: { language: string; kind: Kind; extension?: string }
  disposition: string
  detail: string | null
  capabilities: Record<string, string>
}
export type CensusRow = {
  language: string
  kind: Kind
  /** Only on `unknown` rows: the extension, or the whole file name when it has none. */
  extension?: string
  files: number
  /** Files of the language the policy flags generated (indexed, FR292) and files left out as vendored (FR293), each already in `files`. */
  generated: number
  vendored: number
  dispositions: { indexed: number; excluded: number; unsupported: number; failed: number }
  /** Files left out by rule, by the rule: the census says how much of the language was not read. */
  excluded: Record<string, number>
  tier: string
  /** The tier of each file that was not excluded, with its file count, largest first. */
  tiers: Array<{ tier: string; files: number }>
  capabilities: Record<(typeof CENSUS_CAPABILITIES)[number], Counts>
  reason: string | null
  remedy: string | null
}

/**
 * The one table of language to precise route (FR140): the built-in adapter that reads it, the SDK and build it needs, and the SCIP
 * indexer a person can run in a repository they trust. docs/proofmesh/languages.md shows this table, and every remedy comes from it.
 */
export type Route = {
  language: string; adapter?: string; sdk?: string; build?: string
  /** The SCIP indexer, the command that runs it where its flags are certain, or its README where they are not, and what it needs first. */
  scip?: string; run?: string; readme?: string; needs?: string
}
const CLANG = { scip: 'scip-clang', run: 'scip-clang --compdb-path=compile_commands.json', needs: 'a compile_commands.json' }
const JAVA = { scip: 'scip-java', run: 'scip-java index' }
const TYPESCRIPT = { scip: 'scip-typescript', run: 'scip-typescript index' }
export const REMEDY_TABLE: Route[] = [
  { language: 'C', ...CLANG },
  { language: 'C#', adapter: 'csharp', sdk: '.NET 10 SDK', build: 'dotnet build adapters/csharp -c Release', scip: 'scip-dotnet', run: 'scip-dotnet index' },
  { language: 'C++', ...CLANG },
  { language: 'Go', scip: 'scip-go', run: 'scip-go' },
  { language: 'HCL', adapter: 'terraform' },
  { language: 'Java', ...JAVA },
  { language: 'JavaScript', adapter: 'typescript', ...TYPESCRIPT },
  { language: 'Kotlin', ...JAVA },
  { language: 'PHP', scip: 'scip-php', readme: 'https://github.com/davidrjenni/scip-php' },
  { language: 'Python', adapter: 'python', scip: 'scip-python', run: 'scip-python index . --project-name <name>' },
  { language: 'Ruby', scip: 'scip-ruby', readme: 'https://github.com/sourcegraph/scip-ruby' },
  { language: 'Rust', scip: 'rust-analyzer scip', run: 'rust-analyzer scip .' },
  { language: 'Scala', ...JAVA },
  { language: 'TypeScript', adapter: 'typescript', ...TYPESCRIPT },
]

/**
 * Part of the manifest hash that identifies a snapshot: derived from the remedy table, the vendored Linguist data and detection's
 * rules, so a change to any of them rebuilds the snapshots that carry the old census. A change to the census logic itself bumps
 * DETECTION_RULES.revision.
 */
export const censusVersion = (table: Route[] = REMEDY_TABLE): string => sha256(JSON.stringify({ table, linguist: LINGUIST, rules: DETECTION_RULES, rows: MAX_ROWS })).slice(0, 16)
export const CENSUS_VERSION = censusVersion()
const route = (language: string) => REMEDY_TABLE.find((r) => r.language === language)

const indexer = (r: Route): string => (r.run ? `\`${r.run}\`${r.needs ? ` (needs ${r.needs})` : ''}` : r.readme ? `${r.scip}, see ${r.readme}` : 'none')
export const remedyTableMarkdown = (): string => [
  '| Language | Built-in precise adapter | SDK and build it needs | SCIP indexer |',
  '|---|---|---|---|',
  ...REMEDY_TABLE.map((r) => `| \`${r.language}\` | ${r.adapter ?? 'none'} | ${r.sdk ? `${r.sdk}; \`${r.build}\`` : 'none'} | ${indexer(r)} |`),
].join('\n')

const depth = (tier: string) => (tier === 'none' ? 0 : tier === 'syntax' ? 1 : tier.startsWith('scip:') ? 2 : 3)
const KIND_ORDER: Kind[] = ['code', 'template', 'data', 'prose', 'unknown', 'binary']

/** Why one file stops where it does, or null when nothing holds it back. */
function fileReason(f: CensusFile, tier: string): string | null {
  if (f.label.kind === 'binary') return 'binary'
  if (f.label.kind === 'unknown') return 'unknown_language'
  if (f.disposition === 'failed') return f.detail ?? 'adapter_failure'
  // A data file an adapter read, such as a manifest, has a tier; one nothing reads is simply not code.
  if (f.disposition === 'indexed' && depth(tier) >= 2) return null
  if (f.label.kind === 'data' || f.label.kind === 'prose') return 'not_code'
  if (f.disposition === 'indexed') return f.detail?.startsWith('scip_stale:') || f.detail?.startsWith('scip_revoked:') ? f.detail : 'no_precise_tier'
  return f.detail?.startsWith('no_adapter') || !f.detail ? 'no_grammar' : f.detail
}

/** The advice for a row: advice only, nothing here runs or installs anything. */
/** Where an adapter's entry point can be overridden from the environment, so a remedy can say when the override is the problem. */
const OVERRIDE_ENV: Record<string, string> = { csharp: 'PROOFMESH_CS_ADAPTER' }
export type CensusContext = { overrides?: Record<string, string> }
function remedy(language: string, kind: Kind, reason: string | null, ctx: CensusContext): string | null {
  if (!reason || kind === 'data' || kind === 'prose' || kind === 'binary' || kind === 'unknown') return null
  const r = route(language)
  const name = '`proofmesh scip add <repository> <index.scip>`'
  const scip = (x: Route) => `${x.run ? `Run \`${x.run}\`` : `See ${x.readme} for how to run ${x.scip}`} in a repository you trust${x.needs ? ` (it needs ${x.needs})` : ''}, then name its index with ${name}.`
  if (reason.startsWith('adapter_unavailable:')) {
    const id = reason.slice('adapter_unavailable:'.length)
    const build = r?.adapter === id && r.sdk ? `install the ${r.sdk}, then build the adapter: \`${r.build}\`.` : undefined
    const override = ctx.overrides?.[id]
    // A mistyped override is a different problem from a missing SDK: name the variable and the path it holds.
    if (override && build) return `${OVERRIDE_ENV[id]} names ${override}, which does not exist; correct the path or unset it. Without it, ${build}`
    return build ? build[0]!.toUpperCase() + build.slice(1) : `The ${id} adapter is not present in this install; reinstall Proofmesh or, for an adapter you added, restore its file.`
  }
  if (reason.startsWith('adapter_changed:')) {
    const id = reason.slice('adapter_changed:'.length)
    return `The ${id} adapter changed after it was added; check it with \`proofmesh adapter check ${id} --fixture <dir>\` and add it again.`
  }
  if (reason.startsWith('scip_stale:')) {
    const name = reason.slice('scip_stale:'.length)
    return `The SCIP index ${name} no longer matches these files. Produce it again${r?.run ? ` with \`${r.run}\`` : r?.scip ? ` with ${r.scip}` : ''} and name it again: \`proofmesh scip add <repository> <index.scip> --name ${name}\`.`
  }
  if (reason.startsWith('scip_revoked:')) {
    const [, name, grant] = reason.split(':')
    return `The SCIP index ${name} was produced by an indexer that ran under the build-evaluation grant ${grant}, which was revoked, so it is not read. Grant it again with \`proofmesh repo trust <repository> --build-evaluation\` and run \`proofmesh scip run <repository>\` again, or produce the index yourself and name it with \`proofmesh scip add <repository> <index.scip> --name ${name}\`.`
  }
  if (reason === 'no_precise_tier' || reason === 'no_grammar') return r?.scip ? scip(r) : `Install an adapter that reads ${language}: \`proofmesh adapter add <entry> --id <id> --extension <.ext>=<language>\`.`
  return null
}

const zero = (): Counts => ({ complete: 0, partial: 0, unsupported: 0, failed: 0, not_run: 0 })
const mostCommon = (values: string[]): string => {
  const n = new Map<string, number>()
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0]
}

/** One row per language, every file in exactly one (FR136): the rows are ordered by kind, then file count, then name. */
export function buildCensus(files: CensusFile[], ctx: CensusContext = {}): CensusRow[] {
  const groups = new Map<string, CensusFile[]>()
  for (const f of files) {
    const key = f.label.kind === 'unknown' ? `unknown\u0000${f.label.extension}` : f.label.language
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const rowOf = (group: CensusFile[], forced?: CensusFile['label']): CensusRow => {
    // A language has one kind whichever of its files comes first.
    const first = forced ?? group.map((f) => f.label).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))[0]!
    const tierOf = (f: CensusFile) => (f.disposition === 'indexed' && f.capabilities.tier ? f.capabilities.tier : 'none')
    const dispositions = { indexed: 0, excluded: 0, unsupported: 0, failed: 0 }
    const excluded: Record<string, number> = {}
    const tiers = new Map<string, number>()
    const capabilities = Object.fromEntries(CENSUS_CAPABILITIES.map((c) => [c, zero()])) as CensusRow['capabilities']
    const open: Array<{ f: CensusFile; tier: string }> = []
    let generated = 0, vendored = 0
    for (const f of group) {
      if (f.capabilities.generated === 'true') generated++
      if (f.disposition === 'excluded_by_rule' && f.detail?.startsWith('vendored:')) vendored++
      for (const c of CENSUS_CAPABILITIES) capabilities[c][(LEVELS as readonly string[]).includes(f.capabilities[c]!) ? (f.capabilities[c] as keyof Counts) : 'not_run']++
      if (f.disposition === 'excluded_by_rule') {
        dispositions.excluded++
        excluded[f.detail ?? 'rule'] = (excluded[f.detail ?? 'rule'] ?? 0) + 1
        continue
      }
      dispositions[f.disposition === 'indexed' ? 'indexed' : f.disposition === 'failed' ? 'failed' : 'unsupported']++
      const tier = tierOf(f)
      tiers.set(tier, (tiers.get(tier) ?? 0) + 1)
      open.push({ f, tier })
    }
    const ranked = [...tiers].map(([tier, n]) => ({ tier, files: n })).sort((a, b) => b.files - a.files || depth(b.tier) - depth(a.tier) || (a.tier < b.tier ? -1 : 1))
    // The files that hold the row back: those at its weakest tier. A stale index is named before a plain lack of one.
    const weakest = Math.min(...open.map((o) => depth(o.tier)))
    const reasons = open.filter((o) => depth(o.tier) === weakest).map((o) => fileReason(o.f, o.tier)).filter((r): r is string => r !== null)
    const reason = !open.length ? 'excluded' : reasons.find((r) => r.startsWith('scip_revoked:')) ?? reasons.find((r) => r.startsWith('scip_stale:')) ?? (reasons.length ? mostCommon(reasons) : null)
    return {
      language: first.language, kind: first.kind, ...(first.kind === 'unknown' ? { extension: first.extension! } : {}),
      files: group.length, generated, vendored, dispositions, excluded, tier: ranked[0]?.tier ?? 'none', tiers: ranked, capabilities, reason, remedy: remedy(first.language, first.kind, reason, ctx),
    }
  }
  const order = (a: CensusRow, b: CensusRow) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.files - a.files || (a.language < b.language ? -1 : a.language > b.language ? 1 : (a.extension ?? '') < (b.extension ?? '') ? -1 : 1)
  const ranked = [...groups.values()].map((g) => ({ g, row: rowOf(g) })).sort((a, b) => order(a.row, b.row))
  if (ranked.length <= MAX_ROWS) return ranked.map((r) => r.row)
  // Past the cap the smallest rows are summed into one `other` row, last, so the rows still sum to the inventory.
  const other = rowOf(ranked.slice(MAX_ROWS - 1).flatMap((r) => r.g), { language: 'other', kind: 'unknown', extension: '(other)' })
  const { extension: _e, ...rest } = other
  return [...ranked.slice(0, MAX_ROWS - 1).map((r) => r.row), { ...rest, reason: 'row_cap', remedy: null }]
}

const BADNESS = ['failed', 'not_run', 'unsupported', 'partial', 'complete']
/** A capability's level over a row's files: uniform when every file agrees, complete when the rest are unsupported, else partial. */
function level(c: Counts, files: number): string {
  for (const l of ['complete', 'unsupported', 'failed', 'not_run'] as const) if (c[l] === files) return l
  return c.complete + c.unsupported === files ? 'complete' : 'partial'
}
/** The capability a row is weakest in, for the one line `proofmesh status` prints. */
export function weakestCapability(row: CensusRow): { capability: string; level: string } {
  const levels = CENSUS_CAPABILITIES.map((capability) => ({ capability, level: level(row.capabilities[capability], row.files) }))
  return levels.sort((a, b) => BADNESS.indexOf(a.level) - BADNESS.indexOf(b.level))[0]!
}
