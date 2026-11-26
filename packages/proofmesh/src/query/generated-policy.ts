// What the generated-code policy asks of a query (FR292, FR298, FR299). Answer rows from a generated file say `generated: true`; a tool
// that lists hubs, dead code or entry points leaves generated files out unless asked, and says how many it left out.
import type Database from 'better-sqlite3'

/**
 * The listings that leave generated files out unless `include_generated` is passed. `hubs` is implemented; `dead_code` and
 * `entry_points` are tools issue 34 has yet to build, and each must filter its rows with `excludeGeneratedSql`, accept
 * `include_generated`, and add `generatedLeftOut`'s note to its limitations.
 */
export const GENERATED_LISTINGS = { hubs: 'implemented', dead_code: 'pending_issue_34', entry_points: 'pending_issue_34' } as const

const IS_GENERATED = "json_extract(f.capabilities, '$.generated') = 'true'"
/** An SQL condition on a joined `file f` that keeps the rows of files not flagged generated. */
export const excludeGeneratedSql = (): string => `coalesce(${IS_GENERATED}, 0) = 0`

/** The files of a snapshot flagged generated. */
export const generatedPaths = (db: Database.Database): Set<string> =>
  new Set((db.prepare(`select f.path from file f where ${IS_GENERATED}`).all() as Array<{ path: string }>).map((r) => r.path))

/** The note a listing carries when it left generated files out; null when there were none or they were asked for. */
export const generatedLeftOut = (listing: string, count: number, included: boolean): string | null =>
  included || count === 0 ? null
    : `${count} generated file${count === 1 ? ' is' : 's are'} left out of ${listing}; pass include_generated: true to list them.`

/** Marks every object that names a path of a generated file, wherever it sits in the answer. */
export function markGenerated(data: unknown, paths: Set<string>): void {
  if (!paths.size) return
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>
      if (typeof o.path === 'string' && paths.has(o.path)) o.generated = true
      for (const v of Object.values(o)) walk(v)
    }
  }
  walk(data)
}

let current = new Set<string>()
/** The generated paths of the snapshot being answered, for lean rows, which are rendered from the data without it (FR292). */
export const withGeneratedPaths = <T>(paths: Set<string>, fn: () => T): T => {
  const before = current
  current = paths
  try { return fn() } finally { current = before }
}
export const isGeneratedPath = (p: string | null): boolean => p !== null && current.has(p)
