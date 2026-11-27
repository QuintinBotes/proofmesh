// Concept search (FR580 to FR584): from a description to the symbols and files that match it, ranked, with no model and no network.
import type Database from 'better-sqlite3'
import { queryTerms, textTerms } from '../indexer/terms.js'
import { isTestPath, parseRoles, roleTest } from './tests.js'
import { leanName } from './lean.js'

/** The most query terms ranked: a whole issue body keeps its heaviest terms, and the answer says it was cut. */
export const MAX_TERMS = 32
/** BM25's term-frequency saturation and length normalisation (Robertson and Zaragoza's usual values). */
const K1 = 1.2, B = 0.75
/** A word of a symbol's own name counts this many occurrences in its body; a word of its container's name, this many. */
const NAME = 2, CONTAINER = 0.5
/** Files whose symbols are scored, the best by file score; symbols elsewhere are reached only through the graph. */
const TOP_FILES = 200
/** Seeds of graph proximity, and what a neighbour one and two resolved relationships away gains, as a share of its seed's score. */
const SEEDS = 5, HOP = [0.5, 0.25] as const
const PROXIMITY_TYPES = ['calls', 'inherits', 'implements', 'overrides', 'references']
/** A light stemmer for every language: a term also matches the index terms it differs from by an ending of up to STEM letters, the shorter at least STEM_MIN long (`loader` matches `load`, `loads` and `loaded`). */
const STEM = 3, STEM_MIN = 4

export type ConceptSymbol = { id: string; kind: string; name: string; qualified_name: string; path: string; start_line: number; score: number; terms: string[]; via?: string }
export type ConceptFile = { path: string; line: number; score: number; terms: string[] }
type Sym = { id: string; file_id: string; kind: string; name: string; qualified_name: string; start_line: number; end_line: number; body_tokens: number | null; roles: string | null; path: string }

const round = (n: number) => Math.round(n * 1000) / 1000
const top5 = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([t]) => t)
const bm25 = (n: number, len: number, avg: number) => (n * (K1 + 1)) / (n + K1 * (1 - B + (B * len) / avg))

/**
 * Ranks symbols and files against a description. Lexical: BM25 over each file's terms, the path's words adding one occurrence, and over
 * each symbol's span, its name's words adding NAME; the inverse document frequency of a term is over files. A file scores its own BM25
 * plus its best symbol's. Proximity: each symbol one or two resolved relationships from one of the SEEDS best gains HOP of that seed's
 * score, at most once, and names it in `via`. Test code ranks below production code unless tests are included; generated files are left out.
 */
export function searchConcepts(db: Database.Database, input: { text: string; kinds?: string[]; pathPrefix?: string; includeTests: boolean; rows: number; generated: Set<string> }): { symbols: ConceptSymbol[]; files: ConceptFile[]; terms: string[]; dropped: number; matched: number } {
  const counts = new Map<string, number>()
  for (const t of queryTerms(input.text)) counts.set(t, (counts.get(t) ?? 0) + 1)
  const N = (db.prepare('select count(*) as n from term_file').get() as { n: number }).n
  const longer = db.prepare('select distinct term from term where term > ? and term < ? and length(term) <= ?')
  const variants = (t: string): string[] => t.length < STEM_MIN ? [t] : [...new Set([t,
    ...(longer.all(t, `${t}\uffff`, t.length + STEM) as Array<{ term: string }>).map((r) => r.term),
    ...Array.from({ length: Math.min(STEM, t.length - STEM_MIN) }, (_, i) => t.slice(0, t.length - 1 - i)),
  ])]
  const weighed = [...counts].flatMap(([t, c]) => {
    const v = variants(t)
    const d = (db.prepare(`select count(distinct file_id) as n from term where term in (${v.map(() => '?').join(',')})`).get(...v) as { n: number }).n
    return d ? [{ t, v, w: (1 + Math.log(c)) * Math.log(1 + (N - d + 0.5) / (d + 0.5)) }] : []
  }).sort((a, b) => b.w - a.w || (a.t < b.t ? -1 : 1))
  const query = weighed.slice(0, MAX_TERMS)
  const none = { symbols: [], files: [], terms: [], dropped: 0, matched: 0 }
  if (!query.length) return none

  const fileRows = new Map((db.prepare("select f.id, f.path, t.terms from file f join term_file t on t.file_id = f.id").all() as Array<{ id: string; path: string; terms: number }>).map((f) => [f.id, f]))
  const avg = [...fileRows.values()].reduce((n, f) => n + f.terms, 0) / (fileRows.size || 1)
  const inScope = (p: string) => (!input.pathPrefix || p.startsWith(input.pathPrefix)) && !input.generated.has(p)
  /** Per file: its score, the lines of each query term in it, and what each term added. */
  const files = new Map<string, { score: number; lines: Map<string, number[]>; by: Map<string, number> }>()
  for (const { t, v, w } of query) {
    // Each file's lines of the term and its variants, merged.
    const merged = new Map<string, number[]>()
    for (const p of db.prepare(`select file_id, lines from term where term in (${v.map(() => '?').join(',')})`).all(...v) as Array<{ file_id: string; lines: string }>) {
      merged.set(p.file_id, [...(merged.get(p.file_id) ?? []), ...p.lines.split(' ').map(Number)])
    }
    for (const [fileId, all] of merged) {
      const f = fileRows.get(fileId)
      if (!f || !inScope(f.path)) continue
      all.sort((a, b) => a - b)
      const lines = all.filter((l) => l > 0)
      const s = w * (bm25(lines.length, f.terms, avg) + (all[0] === 0 ? 1 : 0))
      let e = files.get(fileId)
      if (!e) files.set(fileId, (e = { score: 0, lines: new Map(), by: new Map() }))
      e.score += s; e.lines.set(t, lines); e.by.set(t, s)
    }
  }
  if (!files.size) return { ...none, terms: query.map((q) => q.t), dropped: weighed.length - query.length }

  const SYM = "select s.id, s.file_id, s.kind, s.name, s.qualified_name, s.start_line, s.end_line, s.body_tokens, s.roles, f.path from symbol s join file f on f.id = s.file_id where s.kind <> 'module'"
  const symbolsOf = db.prepare(`${SYM} and s.file_id = ?`)
  const kinds = input.kinds ? new Set(input.kinds) : null
  const scored = new Map<string, { s: Sym; score: number; by: Map<string, number>; via?: string }>()
  const avgSpan = 120
  const scoreSymbol = (s: Sym) => {
    const e = files.get(s.file_id)
    const own = new Set(textTerms(s.name)), container = new Set(textTerms(leanName(s).slice(0, -s.name.length)))
    const by = new Map<string, number>()
    let score = 0
    for (const { t, v, w } of query) {
      const n = (e?.lines.get(t) ?? []).filter((l) => s.start_line <= l && l <= s.end_line).length
      const bonus = v.some((x) => own.has(x)) ? NAME : v.some((x) => container.has(x)) ? CONTAINER : 0
      if (!n && !bonus) continue
      const add = w * (bm25(n, s.body_tokens ?? (s.end_line - s.start_line + 1) * 8, avgSpan) + bonus)
      score += add; by.set(t, add)
    }
    return { s, score, by }
  }
  const ranked = [...files].sort((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_FILES)
  for (const [fileId] of ranked) {
    for (const s of symbolsOf.all(fileId) as Sym[]) {
      if (kinds && !kinds.has(s.kind)) continue
      const r = scoreSymbol(s)
      if (r.score > 0) scored.set(s.id, r)
    }
  }
  const order = (a: { s: Sym; score: number }, b: { s: Sym; score: number }) => {
    const ta = input.includeTests ? 0 : testSymbol(a.s), tb = input.includeTests ? 0 : testSymbol(b.s)
    return ta - tb || b.score - a.score || (a.s.path < b.s.path ? -1 : a.s.path > b.s.path ? 1 : a.s.start_line - b.s.start_line || (a.s.id < b.s.id ? -1 : 1))
  }

  // Graph proximity: from the best lexical matches, along resolved relationships either way, one hop then two.
  const seeds = [...scored.values()].sort(order).slice(0, SEEDS)
  const edges = db.prepare(`select dst as id from edge where src = ? and resolution = 'resolved' and type in (${PROXIMITY_TYPES.map(() => '?').join(',')}) union select src from edge where dst = ? and resolution = 'resolved' and type in (${PROXIMITY_TYPES.map(() => '?').join(',')})`)
  const symbolById = db.prepare(`${SYM} and s.id = ?`)
  const boost = new Map<string, { gain: number; via: string }>()
  for (const seed of seeds) {
    let frontier = [seed.s.id]
    // A seed is reached by its own words: it gains nothing from another seed.
    const seen = new Set(seeds.map((x) => x.s.id))
    for (const share of HOP) {
      const next: string[] = []
      for (const id of frontier) {
        for (const { id: n } of edges.all(id, ...PROXIMITY_TYPES, id, ...PROXIMITY_TYPES) as Array<{ id: string }>) {
          if (seen.has(n)) continue
          seen.add(n); next.push(n)
          const gain = share * seed.score
          if (gain > (boost.get(n)?.gain ?? 0)) boost.set(n, { gain, via: leanName(seed.s) })
        }
      }
      frontier = next
    }
  }
  for (const [id, b] of boost) {
    let r = scored.get(id)
    if (!r) {
      const s = symbolById.get(id) as Sym | undefined
      if (!s || (kinds && !kinds.has(s.kind)) || !inScope(s.path)) continue
      r = scoreSymbol(s)
      scored.set(id, r)
    }
    r.score += b.gain; r.via = b.via
  }

  const symbols = [...scored.values()].sort(order)
  const best = new Map<string, (typeof symbols)[number]>()
  for (const r of symbols) if (!best.has(r.s.file_id)) best.set(r.s.file_id, r)
  for (const id of best.keys()) if (!files.has(id) && fileRows.has(id)) files.set(id, { score: 0, lines: new Map(), by: new Map() })
  const fileList = [...files].map(([id, e]) => {
    const path = fileRows.get(id)!.path, b = best.get(id)
    const by = new Map(e.by)
    for (const [t, v] of b?.by ?? []) by.set(t, (by.get(t) ?? 0) + v)
    const first = Math.min(...[...e.lines.values()].flatMap((l) => l.slice(0, 1)))
    return { path, test: input.includeTests ? 0 : isTestPath(path) ? 1 : 0, score: e.score + (b?.score ?? 0), line: b?.s.start_line ?? (Number.isFinite(first) ? first : 1), terms: top5(by) }
  }).sort((a, b) => a.test - b.test || b.score - a.score || (a.path < b.path ? -1 : 1))

  return {
    symbols: symbols.slice(0, input.rows).map((r) => ({ id: r.s.id, kind: r.s.kind, name: r.s.name, qualified_name: r.s.qualified_name, path: r.s.path, start_line: r.s.start_line, score: round(r.score), terms: top5(r.by), ...(r.via ? { via: r.via } : {}) })),
    files: fileList.slice(0, input.rows).map(({ path, line, score, terms }) => ({ path, line, score: round(score), terms })),
    terms: query.map((q) => q.t), dropped: weighed.length - query.length, matched: files.size,
  }
}

const testSymbol = (s: Sym) => (isTestPath(s.path) || roleTest(parseRoles(s.roles)) ? 1 : 0)
