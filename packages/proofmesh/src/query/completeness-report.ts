// The impact_completeness answer as a pull request report (FR2140 to FR2142): Markdown for a comment or a step summary, SARIF 2.1.0 for
// code scanning, and GitHub workflow commands for annotations. Pure functions of the answer: nothing here reads a file or the network.
import type { Changed, Dependent } from './completeness.js'

/** One side of the comparison as the answer names it. */
type Side = { commit: string | null; snapshot_id: string | null }
/** The impact_completeness data the renderers read, every page of `changed` joined. */
export type Report = { base: Side; head: Side; changed: Changed[]; totals: { changed_symbols: number; dependents: number; changed: number; tested: number; neither: number } }
/** A side the command indexed before it could answer, and how long that took. */
export type Indexed = { side: 'base' | 'head'; rev: string; seconds: number }

/** The hidden line a workflow finds its earlier comment by. */
export const MARKER = '<!-- proofmesh:impact-completeness -->'
export const RULE_ID = 'proofmesh/untested-dependent'
/** Under GitHub's 65,536-character comment limit. */
export const DEFAULT_MAX_BYTES = 60000

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const neitherOf = (r: Report) => r.changed.flatMap((c) => c.dependents.filter((d) => d.status === 'neither').map((d) => ({ c, d })))

/** The one-line verdict. */
export const verdict = (r: Report) => r.totals.neither ? `${plural(r.totals.neither, 'dependent is', 'dependents are')} neither changed nor tested` : 'No dependent is neither changed nor tested'

/** Repository text as a code span in a table cell: a fence longer than any backtick run in it, `|` escaped, on one line. */
function code(text: string): string {
  const t = text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|')
  const fence = '`'.repeat(Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length)) + 1)
  return /^`|`$/.test(t) ? `${fence} ${t} ${fence}` : `${fence}${t}${fence}`
}
const site = (x: { path: string; line: number }) => code(`${x.path}:${x.line}`)
const testCell = (t: Changed['test']) => (t ? `${code(t.name)} ${site(t)} ${t.evidence}, depth ${t.depth}${t.changed ? ', test changed' : ''}` : 'none')
const ofCell = (c: Changed) => `${code(c.name)} ${c.change}`
const sideText = (name: string, s: Side) => `${name} ${s.commit ? code(s.commit.slice(0, 12)) : 'the working tree'} (snapshot ${s.snapshot_id ? code(s.snapshot_id) : 'none'})`

/**
 * The Markdown report (FR2141): the marker, the verdict, a table of the dependents that are neither, collapsed sections of the tested
 * dependents and of the changed symbols, both sides' commits and snapshots, the indexes this run made, and the limitations. Rows are cut,
 * the changed symbols first and the neither rows last, until the report fits `maxBytes`, and each cut table says how many rows it left out.
 */
export function markdownReport(r: Report, limitations: string[], indexed: Indexed[] = [], maxBytes = DEFAULT_MAX_BYTES): string {
  const tested = r.changed.flatMap((c) => c.dependents.filter((d) => d.status === 'tested').map((d) => ({ c, d })))
  const row = (cells: string[]) => `| ${cells.join(' | ')} |`
  const depRow = ({ c, d }: { c: Changed; d: Dependent }, last: string) => row([code(d.name), site(d), d.relation + (d.via ? ` via ${code(d.via)}` : ''), d.basis, last])
  // Highest priority first: cuts start from the last section.
  const sections = [
    { open: '', head: ['symbol', 'path:line', 'relation', 'basis', 'of'], rows: neitherOf(r).map((x) => depRow(x, ofCell(x.c))), close: '' },
    { open: `<details><summary>${plural(tested.length, 'tested dependent')}</summary>\n\n`, head: ['symbol', 'path:line', 'relation', 'basis', 'test'], rows: tested.map((x) => depRow(x, testCell(x.d.test))), close: '\n\n</details>' },
    { open: `<details><summary>${plural(r.changed.length, 'changed symbol')}</summary>\n\n`, head: ['symbol', 'path:line', 'change', 'test'], rows: r.changed.map((c) => row([code(c.name), site(c), c.change, testCell(c.test)])), close: '\n\n</details>' },
  ]
  const fence = '~'.repeat(Math.max(3, ...limitations.flatMap((l) => [...l.matchAll(/~+/g)].map((m) => m[0].length + 1))))
  const t = r.totals
  const render = (kept: number[]) => [
    MARKER,
    '## ProofMesh impact completeness',
    `**${verdict(r)}.** ${plural(t.changed_symbols, 'changed symbol')}; ${plural(t.dependents, 'dependent')}: ${t.changed} changed, ${t.tested} tested, ${t.neither} neither.`,
    ...sections.flatMap((s, i) => (s.rows.length ? [`${s.open}${[row(s.head), row(s.head.map(() => '---')), ...s.rows.slice(0, kept[i])].join('\n')}${kept[i]! < s.rows.length ? `\n\n_${plural(s.rows.length - kept[i]!, 'more row')} not shown: the report is cut to ${maxBytes} bytes._` : ''}${s.close}`] : [])),
    `${sideText('Base', r.base)} · ${sideText('head', r.head)}`,
    ...(indexed.length ? [`Indexed ${indexed.map((x) => `${x.side} ${x.rev === 'the working tree' ? x.rev : code(x.rev.slice(0, 12))} in ${x.seconds.toFixed(1)} s`).join(', ')}.`] : []),
    ...(limitations.length ? [`<details><summary>${plural(limitations.length, 'limitation')}</summary>\n\n${fence}text\n${limitations.join('\n')}\n${fence}\n\n</details>`] : []),
  ].join('\n\n') + '\n'
  const kept = sections.map((s) => s.rows.length)
  for (let text = render(kept), over = Buffer.byteLength(text) - maxBytes; over > 0; text = render(kept), over = Buffer.byteLength(text) - maxBytes) {
    const i = kept.map((n) => n > 0).lastIndexOf(true)
    if (i < 0) break
    // Drop at least the bytes over, from the end of the last section that still has rows.
    for (let freed = 0; freed < over && kept[i]! > 0;) freed += Buffer.byteLength(sections[i]!.rows[--kept[i]!]!) + 1
  }
  return render(kept)
}

const message = (c: Changed, d: Dependent) => `${d.relation === 'imports' ? d.path : d.name} ${d.relation} ${c.name} (${c.path}:${c.line}, ${c.change})${d.via ? ` via ${d.via}` : ''}; the change neither updates nor tests it.${d.basis === 'inferred' ? ' Inferred: reached through a candidate edge.' : ''}`

/** SARIF 2.1.0 (FR2142): one result per dependent that is neither, at its site, `warning`, or `note` when inferred. */
export function sarifReport(r: Report): object {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'ProofMesh', rules: [{ id: RULE_ID, name: 'UntestedDependent', shortDescription: { text: 'A dependent of a changed symbol that the change neither updates nor tests' }, defaultConfiguration: { level: 'warning' } }] } },
      results: neitherOf(r).map(({ c, d }) => ({
        ruleId: RULE_ID, ruleIndex: 0, level: d.basis === 'inferred' ? 'note' : 'warning',
        message: { text: message(c, d) },
        locations: [{ physicalLocation: { artifactLocation: { uri: d.path, uriBaseId: '%SRCROOT%' }, region: { startLine: d.line } } }],
        properties: { relation: d.relation, basis: d.basis, changed: { name: c.name, path: c.path, line: c.line, change: c.change } },
      })),
      properties: { base: r.base, head: r.head, totals: r.totals },
    }],
  }
}

// Workflow command escaping: data escapes %, CR and LF; a property also : and ,.
const data = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const prop = (s: string) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

/** GitHub workflow commands (FR2140): a `warning`, or a `notice` when inferred, per dependent that is neither, then the verdict. */
export const githubCommands = (r: Report): string[] => [
  ...neitherOf(r).map(({ c, d }) => `::${d.basis === 'inferred' ? 'notice' : 'warning'} file=${prop(d.path)},line=${d.line},title=${prop('Untested dependent')}::${data(message(c, d))}`),
  `ProofMesh: ${verdict(r)}.`,
]
