// get_symbols_at (FR119 to FR121): the innermost symbol whose declaration span holds a line. impact_completeness picks the symbol of each
// changed line with the same function, so there is one implementation.

/** What choosing a symbol needs of a row. */
export type Span = { id: string; kind: string; start_line: number; end_line: number }

/** Equal spans are told apart by kind: a function or method first, then a property or variable, then a type. */
const RANK: Record<string, number> = { function: 0, method: 0, constructor: 0, property: 1, variable: 1, field: 1, class: 2, struct: 2, interface: 2, enum: 2, type_alias: 2 }
const rank = (kind: string) => RANK[kind] ?? 3

/**
 * The narrowest of the symbols that hold the line. Equal spans are told apart by kind, then id, so the choice is the same on every run;
 * `byKind` false keeps the order the rows came in, as impact_completeness chose before this tool existed.
 */
export function innermost<T extends Span>(syms: T[], line: number, byKind = true): T | undefined {
  return syms.filter((s) => s.start_line <= line && line <= s.end_line)
    .sort((x, y) => (x.end_line - x.start_line) - (y.end_line - y.start_line) || (byKind ? rank(x.kind) - rank(y.kind) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0) : 0))[0]
}
