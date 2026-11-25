// Constrained name matching (FR171 to FR180): the syntax tier names a call, a supertype or an import and never binds it; this pass binds
// the ones the language's own rules allow, for Go and Java, from facts the other adapters already recorded: the module graph (the
// build adapter's `contains` and `depends_on`), each file's imports and package, and visibility. It runs once over every index, on
// the per-file facts the syntax adapter answered (cached or not), so an incremental index equals a clean one (FR014).
//
// A name match is never a resolved edge (FR023). One reachable target is a `candidate`, several are `ambiguous` (at most CAP listed,
// the rest counted), and a name found only in a module the source does not depend on is unresolved `dependency_missing`. Anything the
// rules cannot judge keeps the row the adapter wrote.
import path from 'node:path'
import type { Item, Model, Project, Rel, Sym } from './common.js'
import { resolveGo } from './go.js'
import { resolveJava } from './java.js'

export type { Sym } from './common.js'

/** Bump when a rule changes what is bound: it is part of a snapshot's identity, so an older snapshot is never reused. */
export const RESOLUTION_VERSION = 1
const ECO: Array<[RegExp, Project['eco']]> = [[/^go\.mod$/, 'go'], [/^pom\.xml$/, 'maven'], [/^(settings|build)\.gradle(\.kts)?$/, 'gradle']]
const ecoOf = (manifest: string): Project['eco'] => ECO.find(([re]) => re.test(path.posix.basename(manifest)))?.[1] ?? 'npm'

/** Binds what the rules can bind; every other item is returned as it came. */
export function constrain<P extends { id: string }>(symbols: Sym[], items: Array<Item<P>>, read: (file: string) => Buffer | undefined): Array<Item<P>> {
  const syntaxRels = items.filter((i) => i.producer.id === 'syntax' && (i.rel.origin === 'syntax')).map((i) => i.rel)
  if (!syntaxRels.some((r) => /\.(go|java)$/.test(r.site.path))) return items
  // The module graph: a project's files, and the projects it declares a dependency on.
  const projects = new Map(symbols.filter((s) => s.producer === 'build' && s.kind === 'project').map((s) => [s.local_id, { id: s.local_id, name: s.name, manifest: s.path, dir: path.posix.dirname(s.path) === '.' ? '' : path.posix.dirname(s.path), eco: ecoOf(s.path) } satisfies Project]))
  const containing = new Map<string, Project>()
  const deps = new Map<string, Set<string>>()
  for (const { rel, producer } of items) {
    if (producer.id !== 'build') continue
    const from = rel.source.symbol ? projects.get(rel.source.symbol) : undefined
    if (!from) continue
    if (rel.type === 'contains' && rel.target?.file) containing.set(rel.target.file, from)
    else if (rel.type === 'depends_on' && rel.resolution === 'resolved' && rel.target?.symbol) deps.set(from.id, (deps.get(from.id) ?? new Set()).add(rel.target.symbol))
  }
  const model: Model = {
    symbols: symbols.filter((s) => s.producer === 'syntax'),
    projectOf: (file, eco) => { const p = containing.get(file); return p && eco.includes(p.eco) ? p : undefined },
    sees: (from, to) => from === to || (!!from && !!to && !!deps.get(from.id)?.has(to.id)),
    read,
  }
  const replaced = new Map<Rel, Rel>()
  for (const resolve of [resolveGo, resolveJava]) for (const [from, to] of resolve(model, syntaxRels)) replaced.set(from, to)
  return replaced.size ? items.map((i) => (replaced.has(i.rel) ? { ...i, rel: replaced.get(i.rel)! } : i)) : items
}
