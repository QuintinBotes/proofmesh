import type { Kind } from './language-detect.js'

/** Part of snapshot identity: a change to how files are labelled or counted rebuilds the snapshots that carry the old census. */
export const CENSUS_VERSION = '1'
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
export type Route = { language: string; adapter?: string; sdk?: string; build?: string; scip?: string }
export const REMEDY_TABLE: Route[] = [
  { language: 'C', scip: 'scip-clang' },
  { language: 'C#', adapter: 'csharp', sdk: '.NET 10 SDK', build: 'dotnet build adapters/csharp -c Release', scip: 'scip-dotnet' },
  { language: 'C++', scip: 'scip-clang' },
  { language: 'Go', scip: 'scip-go' },
  { language: 'HCL', adapter: 'terraform' },
  { language: 'Java', scip: 'scip-java' },
  { language: 'JavaScript', adapter: 'typescript', scip: 'scip-typescript' },
  { language: 'Kotlin', scip: 'scip-java' },
  { language: 'PHP', scip: 'scip-php' },
  { language: 'Python', adapter: 'python', scip: 'scip-python' },
  { language: 'Ruby', scip: 'scip-ruby' },
  { language: 'Rust', scip: 'rust-analyzer scip' },
  { language: 'Scala', scip: 'scip-java' },
  { language: 'TypeScript', adapter: 'typescript', scip: 'scip-typescript' },
]
const route = (language: string) => REMEDY_TABLE.find((r) => r.language === language)

export const remedyTableMarkdown = (): string => [
  '| Language | Built-in precise adapter | SDK and build it needs | SCIP indexer |',
  '|---|---|---|---|',
  ...REMEDY_TABLE.map((r) => `| \`${r.language}\` | ${r.adapter ?? 'none'} | ${r.sdk ? `${r.sdk}; \`${r.build}\`` : 'none'} | ${r.scip ? `\`${r.scip}\`` : 'none'} |`),
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
  if (f.disposition === 'indexed') return f.detail?.startsWith('scip_stale:') ? f.detail : 'no_precise_tier'
  return f.detail?.startsWith('no_adapter') || !f.detail ? 'no_grammar' : f.detail
}

/** The advice for a row: advice only, nothing here runs or installs anything. */
function remedy(language: string, kind: Kind, reason: string | null): string | null {
  if (!reason || kind === 'data' || kind === 'prose' || kind === 'binary' || kind === 'unknown') return null
  const r = route(language)
  const scip = (cmd: string) => `Run \`${cmd}\` in a repository you trust, then name its index with \`proofmesh scip add <repository> <index.scip>\`.`
  if (reason.startsWith('adapter_unavailable:')) {
    const id = reason.slice('adapter_unavailable:'.length)
    return r?.adapter === id && r.sdk ? `Install the ${r.sdk}, then build the adapter: \`${r.build}\`.` : `The ${id} adapter is not present in this install; reinstall Proofmesh or, for an adapter you added, restore its file.`
  }
  if (reason.startsWith('adapter_changed:')) {
    const id = reason.slice('adapter_changed:'.length)
    return `The ${id} adapter changed after it was added; check it with \`proofmesh adapter check ${id} --fixture <dir>\` and add it again.`
  }
  if (reason.startsWith('scip_stale:')) {
    const name = reason.slice('scip_stale:'.length)
    return `The SCIP index ${name} no longer matches these files. Produce it again${r?.scip ? ` with \`${r.scip}\`` : ''} and name it again: \`proofmesh scip add <repository> <index.scip> --name ${name}\`.`
  }
  if (reason === 'no_precise_tier' || reason === 'no_grammar') return r?.scip ? scip(r.scip) : `Install an adapter that reads ${language}: \`proofmesh adapter add <entry> --id <id> --extension <.ext>=<language>\`.`
  return null
}

const zero = (): Counts => ({ complete: 0, partial: 0, unsupported: 0, failed: 0, not_run: 0 })
const mostCommon = (values: string[]): string => {
  const n = new Map<string, number>()
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0]
}

/** One row per language, every file in exactly one (FR136): the rows are ordered by kind, then file count, then name. */
export function buildCensus(files: CensusFile[]): CensusRow[] {
  const groups = new Map<string, CensusFile[]>()
  for (const f of files) {
    const key = f.label.kind === 'unknown' ? `unknown\u0000${f.label.extension}` : f.label.language
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const rows = [...groups.values()].map((group): CensusRow => {
    const first = group[0]!.label
    const tierOf = (f: CensusFile) => (f.disposition === 'indexed' && f.capabilities.tier ? f.capabilities.tier : 'none')
    const dispositions = { indexed: 0, excluded: 0, unsupported: 0, failed: 0 }
    const excluded: Record<string, number> = {}
    const tiers = new Map<string, number>()
    const capabilities = Object.fromEntries(CENSUS_CAPABILITIES.map((c) => [c, zero()])) as CensusRow['capabilities']
    const open: Array<{ f: CensusFile; tier: string }> = []
    for (const f of group) {
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
    const reason = !open.length ? 'excluded' : reasons.find((r) => r.startsWith('scip_stale:')) ?? (reasons.length ? mostCommon(reasons) : null)
    return {
      language: first.language, kind: first.kind, ...(first.kind === 'unknown' ? { extension: first.extension! } : {}),
      files: group.length, dispositions, excluded, tier: ranked[0]?.tier ?? 'none', tiers: ranked, capabilities, reason, remedy: remedy(first.language, first.kind, reason),
    }
  })
  return rows.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.files - a.files || (a.language < b.language ? -1 : a.language > b.language ? 1 : (a.extension ?? '') < (b.extension ?? '') ? -1 : 1))
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
