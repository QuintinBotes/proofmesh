// What every language's rules share: the model they read and the three outcomes a row can take (FR171 to FR176).
import type { AnalyzeResponse } from '../../core/generated.js'

/** The most candidates one site lists; the count of the rest is `detail.more`. */
export const CAP = 5

export type Rel = AnalyzeResponse['relationships'][number]
export type Sym = { producer: string; local_id: string; path: string; kind: string; name: string; qualified_name: string; start: number; end: number }
export type Project = { id: string; name: string; manifest: string; dir: string; eco: 'go' | 'maven' | 'gradle' | 'cargo' | 'npm' }
export type Item<P> = { rel: Rel; producer: P }

/** What every language's rules read: symbols, the module graph and file text. */
export type Model = {
  symbols: Sym[]
  /** The module of a file in an ecosystem, if the build graph put it in one. */
  projectOf: (file: string, eco: Array<Project['eco']>) => Project | undefined
  /** A module sees itself and the modules it declares a direct, resolved dependency on for the file's sources (FR172): a test-scope dependency only for test sources, a runtime one for none. Files in no module see each other. */
  sees: (from: Project | undefined, to: Project | undefined, file: string) => boolean
  /** Whether a module declares any dependency of this name, in any scope, inside the repository or not. */
  declares: (from: Project | undefined, name: string) => boolean
  read: (file: string) => Buffer | undefined
}

/** The rows' own words, kept, plus what this pass adds. */
const withDetail = (rel: Rel, extra: Record<string, string>): Rel['detail'] => ({ ...(rel.detail ?? {}), ...extra })

/** The row, bound to its targets: one is a candidate, several are ambiguous with the first CAP of them. The rule is on the row, and the row reads as inferred through its resolution (FR171, FR188). */
export function bind(rel: Rel, targets: Sym[], rule: string, how: { ambiguous?: boolean } = {}): Rel {
  const seen = [...new Map(targets.map((t) => [t.local_id, t])).values()]
  const { reason: _reason, ...rest } = rel
  const detail = withDetail(rel, { rule, ...(seen.length > CAP ? { more: String(seen.length - CAP) } : {}) })
  return { ...rest, resolution: seen.length === 1 && !how.ambiguous ? 'candidate' : 'ambiguous', candidates: seen.slice(0, CAP).map((t) => t.local_id), detail }
}

/** Adds a symbol to the list a map holds under a key. */
export const group = (map: Map<string, Sym[]>, k: string, s: Sym) => { const list = map.get(k); if (list) list.push(s); else map.set(k, [s]) }

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


/** The callee expression of a call, as written before its last argument list: `x.draw` of `x.draw(1)`, `a::f` of `a::f::<T>(2)`, the
 * receiver kept, the generic arguments dropped; undefined when the text does not end in an argument list (a macro, a broken file). */
export function calleeText(call: string): string | undefined {
  const t = call.trimEnd()
  if (!t.endsWith(')')) return undefined
  let i = t.length - 1
  for (let depth = 0; i >= 0; i--) { if (t[i] === ')') depth++; else if (t[i] === '(' && --depth === 0) break }
  let head = t.slice(0, Math.max(i, 0)).trimEnd()
  // Generic arguments at the end: `f::<T>` and `f<T>`.
  if (head.endsWith('>')) {
    let j = head.length - 1
    for (let depth = 0; j >= 0; j--) { if (head[j] === '>') depth++; else if (head[j] === '<' && --depth === 0) break }
    head = head.slice(0, Math.max(j, 0)).replace(/::\s*$/, '').trimEnd()
  }
  return i > 0 ? head : undefined
}

/** How a call names its callee: bare, through a path (`a::f`), or on a receiver (`x.f`, `p->f`), with the receiver as written. */
export function callForm(call: string, callee: string): { form: 'bare' | 'path' | 'member'; before: string } | undefined {
  const head = calleeText(call)
  if (!head?.endsWith(callee) || /[\w$]/.test(head.slice(-callee.length - 1, -callee.length))) return undefined
  const before = head.slice(0, -callee.length).trimEnd()
  if (before.endsWith('.')) return { form: 'member', before: before.slice(0, -1).trim() }
  if (before.endsWith('->')) return { form: 'member', before: before.slice(0, -2).trim() }
  if (before.endsWith('::')) return { form: 'path', before: before.slice(0, -2).trim() }
  return { form: 'bare', before }
}
