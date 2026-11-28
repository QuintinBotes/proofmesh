// Reading a coverage report a test run wrote (#241, FR2060): its executable lines and the lines each test hit, per report path.
// Proofmesh runs no test; it parses the file and nothing else.
import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { ProofmeshError } from '../core/errors.js'

export const FORMATS = ['lcov', 'cobertura', 'jacoco', 'go-cover'] as const
export type Format = (typeof FORMATS)[number]
/** By report path: every executable line, and by test name ('' when the report names none) the lines that test hit. */
export type Report = Map<string, { lines: Set<number>; tests: Map<string, number[]> }>

const attr = (tag: string, name: string) => {
  const v = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
  return v === undefined ? undefined : v.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]!)
}

/** The lines of a file, read 1 MB at a time, so a large LCOV or Go report is never held whole (SC-004 of #241). */
function* linesOf(file: string): Generator<string> {
  // The decoder keeps a character split across two reads whole.
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 20), utf8 = new StringDecoder('utf8')
  try {
    let rest = ''
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
      const parts = (rest + utf8.write(buf.subarray(0, n))).split('\n')
      rest = parts.pop()!
      yield* parts
    }
    rest += utf8.end()
    if (rest) yield rest
  } finally { fs.closeSync(fd) }
}

/** The report's lines; `test` names the one test the whole report is of, over any test names it holds. */
export function readCoverage(file: string, format: Format, test?: string): Report {
  const report: Report = new Map()
  const mark = (p: string, t: string, line: number, hit: boolean) => {
    if (!p || !(line > 0)) return
    let f = report.get(p)
    if (!f) report.set(p, (f = { lines: new Set(), tests: new Map() }))
    f.lines.add(line)
    if (!hit) return
    const name = test ?? t
    let hits = f.tests.get(name)
    if (!hits) f.tests.set(name, (hits = []))
    // An array, not a set: a large report holds millions of hits. A line repeated in one test is left for the reader to merge.
    hits.push(line)
  }
  const refuse = (why: string) => new ProofmeshError('INVALID_ARGUMENT', `${file} is not a ${format} coverage report: ${why}`)
  if (format === 'lcov') {
    let tn = '', sf = '', records = 0
    for (const raw of linesOf(file)) {
      const line = raw.trim()
      if (line.startsWith('TN:')) tn = line.slice(3)
      else if (line.startsWith('SF:')) { sf = line.slice(3); records++ }
      else if (line.startsWith('DA:') && sf) { const [l, h] = line.slice(3).split(','); mark(sf, tn, Number(l), Number(h) > 0) }
      else if (line === 'end_of_record') sf = ''
    }
    if (!records) throw refuse('it has no SF: record')
  } else if (format === 'cobertura' || format === 'jacoco') {
    // shortcut: an XML report is read whole, so it needs about twice its size in memory; stream it if one of several hundred MB appears.
    const text = fs.readFileSync(file, 'utf8')
    if (!new RegExp(format === 'cobertura' ? '<coverage[\\s>]' : '<report[\\s>]').test(text)) throw refuse(`it has no <${format === 'cobertura' ? 'coverage' : 'report'}> element`)
    // A Cobertura line is in a <class filename>; a JaCoCo line in a <sourcefile name> of a <package name>. Method lines repeat class lines.
    let pkg = '', src = ''
    for (const m of text.matchAll(/<(class|package|sourcefile|line)\b[^>]*>/g)) {
      const tag = m[0], kind = m[1]
      if (format === 'cobertura') {
        if (kind === 'class') src = attr(tag, 'filename') ?? ''
        else if (kind === 'line') mark(src, '', Number(attr(tag, 'number')), Number(attr(tag, 'hits')) > 0)
      } else if (kind === 'package') pkg = attr(tag, 'name') ?? ''
      else if (kind === 'sourcefile') src = `${pkg ? `${pkg}/` : ''}${attr(tag, 'name') ?? ''}`
      else if (kind === 'line' && src) mark(src, '', Number(attr(tag, 'nr')), Number(attr(tag, 'ci')) > 0)
    }
  } else {
    let first = true
    for (const l of linesOf(file)) {
      if (first) { if (!/^mode: (set|count|atomic)\s*$/.test(l)) throw refuse('its first line is not mode: set, count or atomic'); first = false; continue }
      const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+ (\d+) (\d+)\s*$/.exec(l)
      if (!m) { if (l.trim()) throw refuse(`${JSON.stringify(l)} is not a block line`); continue }
      if (m[4] === '0') continue
      for (let n = Number(m[2]); n <= Number(m[3]); n++) mark(m[1]!, '', n, Number(m[5]) > 0)
    }
    if (first) throw refuse('it is empty')
  }
  return report
}

export type Unmatched = { path: string; reason: 'not_in_snapshot' | 'ambiguous'; candidates: string[] }

/**
 * Each report path's snapshot path, after stripping `strip`: the same path, else the one indexed path that one of them ends with, the longest
 * shared suffix winning. Paths no indexed path matches, or that two match equally, are returned unmatched (FR2060's edge cases).
 */
export function matchPaths(paths: string[], indexed: string[], strip = ''): { matched: Map<string, string>; unmatched: Unmatched[] } {
  const all = new Set(indexed), byName = new Map<string, string[]>()
  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1)
  for (const p of indexed) byName.set(name(p), [...(byName.get(name(p)) ?? []), p])
  const matched = new Map<string, string>(), unmatched: Unmatched[] = []
  for (const raw of paths) {
    let r = raw.replace(/\\/g, '/')
    if (strip && r.startsWith(strip)) r = r.slice(strip.length)
    r = r.replace(/^(\.?\/)+/, '')
    if (all.has(r)) { matched.set(raw, r); continue }
    const segments = (p: string) => p.split('/').length
    const hits = (byName.get(name(r)) ?? []).filter((p) => r.endsWith(`/${p}`) || p.endsWith(`/${r}`)).map((p) => ({ p, n: Math.min(segments(p), segments(r)) }))
    const best = Math.max(0, ...hits.map((h) => h.n)), top = hits.filter((h) => h.n === best).map((h) => h.p).sort()
    if (top.length === 1) matched.set(raw, top[0]!)
    else unmatched.push({ path: raw, reason: top.length ? 'ambiguous' : 'not_in_snapshot', candidates: top })
  }
  return { matched, unmatched }
}
