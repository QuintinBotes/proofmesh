// `proofmesh observe`: a person imports runtime observations from a metrics file in the Proofmesh schema (A9, A30), or a coverage report a
// test run wrote (#241). Nothing connects anywhere and nothing runs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProofmeshError } from '../core/errors.js'
import { sha256File } from '../core/hash.js'
import { check } from '../core/schemas.js'
import { FORMATS, matchPaths, readCoverage, type Format, type Report } from '../coverage/read.js'
import { noSnapshot, type Catalog, type CoverageImportRecord, type PropertyReadInput } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'

type ObservationsFile = { schema_version?: string; source: string; window: { from: string; to: string }; repository?: string; counts: Array<{ subject: { kind: string; name: string }; metric: string; value: number }>; property_reads?: PropertyReadInput[] }

/** Reads and validates an observations file of any supported version; the schema checks shape, and the window's dates are checked here because formats are not validated. */
export function readObservations(file: string): ObservationsFile {
  let json: ObservationsFile
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not a JSON file: ${(e as Error).message}`) }
  const version = ['0.1', '0.2', '0.3'].includes(String(json?.schema_version)) ? String(json.schema_version) : '0.3'
  const problem = check(`observations/${version}.schema.json`, json)
  if (problem) throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not an observations file (schema ${version}): ${problem}`)
  const from = Date.parse(json.window.from), to = Date.parse(json.window.to)
  if (Number.isNaN(from) || Number.isNaN(to)) throw new ProofmeshError('INVALID_ARGUMENT', `${file}: window.from and window.to must be RFC 3339 date-times`)
  if (from > to) throw new ProofmeshError('INVALID_ARGUMENT', `${file}: window.from is after window.to`)
  return json
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** Executable and hit lines over the given report paths. */
const counted = (report: Report, paths: Iterable<string>) => {
  let lines = 0, hit = 0
  for (const p of paths) { const f = report.get(p)!; lines += f.lines.size; hit += new Set([...f.tests.values()].flatMap((h) => [...h])).size }
  return `${hit} of ${lines} lines covered`
}

/**
 * proofmesh observe import <repository> <file> --format F (FR2060, FR2061): the report's paths matched to the current snapshot's files, each
 * stored with its content hash there. With --test the report is that one test's: it replaces the test's lines in the source's import and keeps the rest.
 */
function importCoverage(catalog: Catalog, repository: string, file: string, format: Format, flags: { source?: string; test?: string; strip?: string }): number {
  const repo = catalog.repository(repository)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not a file`)
  const report = readCoverage(file, format, flags.test)
  const snapshot = catalog.currentSnapshot(repo.id)
  if (!snapshot) throw noSnapshot(catalog, repo.id)
  const db = openSnapshot(catalog, snapshot)
  let hashes: Map<string, string>
  try { hashes = new Map((db.prepare("select path, content_hash from file where disposition = 'indexed'").all() as Array<{ path: string; content_hash: string | null }>).map((f) => [f.path, f.content_hash ?? ''])) } finally { db.close() }
  const { matched, unmatched } = matchPaths([...report.keys()], [...hashes.keys()], flags.strip)
  const source = flags.source ?? path.basename(file).replace(/\.[^.]*$/, '')
  if (!source) throw new ProofmeshError('INVALID_ARGUMENT', '--source takes a name')
  const prior = flags.test === undefined ? undefined : catalog.coverageImports(repo.id).find((c) => c.source === source)
  const files: CoverageImportRecord['files'] = {}
  if (prior) for (const [p, f] of Object.entries(prior.files)) files[p] = { ...f, tests: Object.fromEntries(Object.entries(f.tests).filter(([t]) => t !== flags.test)) }
  const sorted = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b)
  for (const [raw, p] of matched) {
    const r = report.get(raw)!, hash = hashes.get(p)!
    // Lines kept from an earlier import of the source are of the same file content only.
    const had = files[p]?.hash === hash ? files[p]! : { hash, lines: [], tests: {} }
    const tests = { ...had.tests }
    for (const [t, hits] of r.tests) tests[t] = sorted([...(tests[t] ?? []), ...hits])
    files[p] = { hash, lines: sorted([...had.lines, ...r.lines]), tests }
  }
  const mtime = fs.statSync(file).mtime.toISOString()
  const c = catalog.addCoverage(repo.id, { source, format, path: file, sha256: sha256File(file), window: { from: mtime, to: mtime }, files, unmatched }, os.userInfo().username)
  const notIn = unmatched.filter((u) => u.reason === 'not_in_snapshot').length
  console.log(`Coverage report ${path.basename(file)} (${format}) imported for ${repo.name} as source ${c.source}: ${plural(matched.size, 'file')} matched, ${notIn} not in the snapshot, ${unmatched.length - notIn} ambiguous; ${counted(report, matched.keys())}; by ${c.imported_by} at ${c.imported_at}`)
  for (const u of unmatched) console.log(`  ${u.path}: ${u.reason}${u.candidates.length ? ` (${u.candidates.join(', ')})` : ''}`)
  console.log('Proofmesh runs no test. Coverage is shown beside static test reach as what that run executed; after an edit to a file its coverage is stale until you import a new report.')
  return 0
}

export function observe(catalog: Catalog, opts: string[], take: (args: string[], flag: string) => string | undefined): number {
  const format = take(opts, '--format'), source = take(opts, '--source'), test = take(opts, '--test'), strip = take(opts, '--strip-prefix')
  if (format !== undefined && !(FORMATS as readonly string[]).includes(format)) throw new ProofmeshError('INVALID_ARGUMENT', `--format takes lcov, cobertura, jacoco or go-cover; got ${format}`)
  if (format && opts[0] === 'validate' && opts[1]) {
    const file = path.resolve(opts[1]), report = readCoverage(file, format as Format, test)
    const tests = new Set([...report.values()].flatMap((f) => [...f.tests.keys()].filter(Boolean)))
    console.log(`${file} is a valid ${format} coverage report: ${plural(report.size, 'file')}, ${counted(report, report.keys())}, ${plural(tests.size, 'test')} named`)
    return 0
  }
  if (format && opts[0] === 'import' && opts[1] && opts[2]) return importCoverage(catalog, opts[1], path.resolve(opts[2]), format as Format, { source, test, strip })
  if (opts[0] === 'validate' && opts[1]) {
    const file = path.resolve(opts[1]), json = readObservations(file)
    const kinds = (json.property_reads ?? []).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.read_kind ?? 'application']: (acc[r.read_kind ?? 'application'] ?? 0) + 1 }), {})
    console.log(`${file} is a valid observations ${json.schema_version ?? '0.3'} file: ${json.counts.length} counts, ${json.property_reads?.length ?? 0} property reads${Object.keys(kinds).length ? ` (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}, window ${json.window.from} to ${json.window.to}, source ${json.source}`)
    return 0
  }
  if (opts[0] === 'import' && opts[1] && opts[2]) {
    const repo = catalog.repository(opts[1]), file = path.resolve(opts[2])
    const json = readObservations(file)
    if (json.repository && json.repository !== repo.name && json.repository !== repo.id) throw new ProofmeshError('INVALID_ARGUMENT', `${file} names repository ${json.repository}, not ${repo.name}`)
    const r = catalog.importObservations(repo.id, json, os.userInfo().username)
    const reads = json.property_reads?.length ?? 0
    console.log(`${r.written} observations imported for ${repo.name} from ${json.source}, window ${json.window.from} to ${json.window.to}${reads ? ` (${reads} property reads)` : ''}${r.replaced ? `, replacing ${r.replaced}` : ''}`)
    console.log('Observations are reported beside static facts as what was observed in that window, never as load derived from code, and never join snapshot identity.')
    return 0
  }
  if (opts[0] === 'list' && opts[1]) {
    const repo = catalog.repository(opts[1])
    const groups = new Map<string, { count: number; by: string; at: string }>()
    for (const o of [...catalog.observations(repo.id), ...catalog.allPropertyReads(repo.id)]) {
      const k = `${o.source}  ${o.window_from} to ${o.window_to}`
      const g = groups.get(k) ?? { count: 0, by: o.imported_by, at: o.imported_at }
      g.count++; groups.set(k, g)
    }
    const coverage = catalog.coverageImports(repo.id)
    if (!groups.size && !coverage.length) console.log(`no observations imported for ${repo.name}`)
    for (const [k, g] of groups) console.log(`${k}  ${g.count} counts  by ${g.by} at ${g.at}`)
    for (const c of coverage) console.log(`${c.source}  ${c.format}  ${c.path}  ${plural(Object.keys(c.files).length, 'file')} matched, ${c.unmatched.length} not matched  by ${c.imported_by} at ${c.imported_at}`)
    return 0
  }
  throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh observe import <repository> <file.json> | observe import <repository> <report> --format lcov|cobertura|jacoco|go-cover [--source NAME] [--test NAME] [--strip-prefix P] | observe list <repository> | observe validate <file.json> | observe validate <report> --format F')
}
