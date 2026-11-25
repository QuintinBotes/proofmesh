// What the Go and Java rules share: the model they read and the three outcomes a row can take (FR171 to FR176).
import type { AnalyzeResponse } from '../../core/generated.js'

/** The most candidates one site lists; the count of the rest is `detail.more`. */
export const CAP = 5

export type Rel = AnalyzeResponse['relationships'][number]
export type Sym = { producer: string; local_id: string; path: string; kind: string; name: string; qualified_name: string; start: number; end: number }
export type Project = { id: string; name: string; manifest: string; dir: string; eco: 'go' | 'maven' | 'gradle' | 'npm' }
export type Item<P> = { rel: Rel; producer: P }

/** What every language's rules read: symbols, the module graph and file text. */
export type Model = {
  symbols: Sym[]
  /** The module of a file in an ecosystem, if the build graph put it in one. */
  projectOf: (file: string, eco: Array<Project['eco']>) => Project | undefined
  /** A module sees itself and the modules it declares a dependency on (FR172); files in no module see each other. */
  sees: (from: Project | undefined, to: Project | undefined) => boolean
  read: (file: string) => Buffer | undefined
}

/** The rows' own words, kept, plus what this pass adds. */
const withDetail = (rel: Rel, extra: Record<string, string>): Rel['detail'] => ({ ...(rel.detail ?? {}), ...extra })

/** The row, bound to its targets: one is a candidate, several are ambiguous with the first CAP of them. The rule and the basis are on the row (FR171). */
export function bind(rel: Rel, targets: Sym[], rule: string): Rel {
  const seen = [...new Map(targets.map((t) => [t.local_id, t])).values()]
  const { reason: _reason, ...rest } = rel
  const detail = withDetail(rel, { rule, inferred: 'name_match', ...(seen.length > CAP ? { more: String(seen.length - CAP) } : {}) })
  return { ...rest, resolution: seen.length === 1 ? 'candidate' : 'ambiguous', candidates: seen.slice(0, CAP).map((t) => t.local_id), detail }
}

/** The row, left unresolved with a reason that says why no rule binds it. */
export const unresolved = (rel: Rel, reason: NonNullable<Rel['reason']>, extra: Record<string, string> = {}): Rel => {
  const { candidates: _c, target: _t, ...rest } = rel
  return { ...rest, resolution: 'unresolved', reason, detail: withDetail(rel, extra) }
}

/** A name only a module the source does not depend on holds (FR172). */
export const undeclared = (rel: Rel, projects: Project[]): Rel => {
  const names = [...new Set(projects.map((p) => p.name))].sort().join(', ')
  return unresolved(rel, 'dependency_missing', { undeclared: names, packages: names })
}

