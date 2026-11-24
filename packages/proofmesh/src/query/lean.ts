/**
 * The lean envelope (FR095 to FR098): a header line, one `<name> <path>:<line>` row per result with optional space-separated tags,
 * then `# ` lines for the limitations of this answer and the cursor to the next page. Plain text, so a client spends no context on JSON.
 */

/** Quoted as JSON when a space, a quote or a # would make the row ambiguous or read as a comment. */
export const quote = (token: string): string => (token === '' || /[\s"#]/.test(token) ? JSON.stringify(token) : token)

/** The name a row shows: the qualified name without its module prefix (`BudgetLedger.consume`); a module is its file, so a file row. */
export function leanName(s: { kind?: string; name: string; qualified_name?: string; path?: string }): string {
  const q = s.qualified_name
  if (s.kind === 'module') return s.path ?? s.name
  if (!q) return s.name
  const cut = q.indexOf(':'), prefix = q.slice(0, cut)
  // The prefix is the file's module (`src/odd dir/odd`) or another name with no space; `GET /a/:id` and `a::b` keep theirs.
  return cut > 0 && q[cut + 1] !== ':' && (prefix === s.path?.replace(/\.[^./]*$/, '') || !/\s/.test(prefix)) ? q.slice(cut + 1) : q
}

/** One row. A file row is its path and line alone; a row with no site in the repository is the name and `external`. */
export function leanRow(name: string | null, path: string | null, line: number | null, tags: string[] = []): string {
  if (path === null) return [quote(name ?? '?'), 'external', ...tags.filter((t) => t !== 'external')].join(' ')
  return [...(name === null || name === path ? [] : [quote(name)]), `${quote(path)}:${line}`, ...tags].join(' ')
}

export function leanText(tool: string, snapshotId: string, current: boolean, rows: string[], notes: string[], cursor: string | null): string {
  return [
    `# ${tool} · ${rows.length} row${rows.length === 1 ? '' : 's'} · ${snapshotId} ${current ? 'current' : 'stale'}`,
    ...rows,
    ...notes.map((n) => `# ${n}`),
    ...(cursor ? [`# more: cursor ${cursor}`] : []),
  ].join('\n')
}
