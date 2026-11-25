/**
 * The basis of a relationship row (FR181 to FR190): observed when a compiler, an index or a declared configuration proves it, inferred when
 * a convention, a name match or a contract match suggests it. Derived when an answer is built from facts the snapshot already holds, so no
 * snapshot column and no adapter field carries it.
 */
export type Basis = 'observed' | 'inferred'

/** Origins whose assertions suggest a relationship rather than prove it. */
const INFERRING_ORIGINS = ['contract_match', 'documentation', 'model_hypothesis']

/**
 * The rule as SQL over an `assertion` row aliased `a`: 1 when the row is inferred. The same rule as basisOf, so a traversal can label an edge
 * in the query that reads it.
 */
export const inferredSql = (a = 'a') =>
  `(${a}.resolution in ('candidate', 'ambiguous') or ${a}.origin in (${INFERRING_ORIGINS.map((o) => `'${o}'`).join(', ')}) or json_extract(${a}.detail, '$.inferred') is not null)`

/** The basis of an assertion; undefined for an unresolved boundary, which is not a relationship. */
export function basisOf(a: { resolution: string; origin: string; detail: string | Record<string, unknown> | null }): Basis | undefined {
  if (a.resolution === 'unresolved') return undefined
  if (a.resolution === 'candidate' || a.resolution === 'ambiguous' || INFERRING_ORIGINS.includes(a.origin)) return 'inferred'
  const detail = typeof a.detail === 'string' ? (JSON.parse(a.detail) as Record<string, unknown>) : a.detail
  return detail?.inferred != null ? 'inferred' : 'observed'
}

/** Counts of rows by basis, in the order the answers print them. */
export const byBasis = (rows: Array<{ basis?: Basis }>): Record<Basis, number> => ({ observed: rows.filter((r) => r.basis === 'observed').length, inferred: rows.filter((r) => r.basis === 'inferred').length })
