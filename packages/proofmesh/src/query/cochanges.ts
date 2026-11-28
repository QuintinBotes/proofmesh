// Change coupling (FR2020 to FR2025): the files that changed in the same commits as a subject file, from git history. Co-change is not a
// relationship: rows carry no basis and no traversal tool follows them (FR023); `linked` only says whether a relationship also joins the pair.
import type Database from 'better-sqlite3'
import type { Commit, History } from '../indexer/history.js'
import { DEFAULT_WINDOW } from '../indexer/history.js'
import { quote } from './lean.js'

export type Thresholds = { min_shared: number; min_degree: number; max_files_per_commit: number }
export const DEFAULT_THRESHOLDS: Thresholds = { min_shared: 3, min_degree: 0.3, max_files_per_commit: 50 }
export type Partner = { path: string; shared: number; subject_commits: number; partner_commits: number; degree: number; linked: boolean; relationship_types: string[]; test: boolean }

/** Commits per file and, for each subject, commits shared with each other file, over the commits that touch at most max_files_per_commit files. */
export function count(commits: Commit[], subjects: string[], max: number): { commits: Map<string, number>; shared: Map<string, Map<string, number>>; bulk: number } {
  const per = new Map<string, number>(), shared = new Map(subjects.map((s) => [s, new Map<string, number>()])), out = { commits: per, shared, bulk: 0 }
  for (const c of commits) {
    const files = [...new Set(c.files.map((f) => f.path))]
    // A formatter run or a licence header touches everything: it says nothing about which files belong together.
    if (files.length > max) { out.bulk++; continue }
    for (const f of files) per.set(f, (per.get(f) ?? 0) + 1)
    for (const s of files) {
      const row = shared.get(s)
      if (row) for (const p of files) if (p !== s) row.set(p, (row.get(p) ?? 0) + 1)
    }
  }
  return out
}

/** The files one relationship joins to a file, either direction, resolved or candidate, with their types (FR2022); containment is not a link. */
export function linkedFiles(db: Database.Database, fileId: string): Map<string, string[]> {
  const rows = db.prepare(`with mine(id) as (select ? union select id from symbol where file_id = ?),
    ends(type, other) as (
      select a.type, case a.target_kind when 'file' then a.target_id else t.file_id end from assertion a left join symbol t on t.id = a.target_id where a.source_id in mine and a.resolution = 'resolved'
      union all select a.type, case a.source_kind when 'file' then a.source_id else s.file_id end from assertion a left join symbol s on s.id = a.source_id where a.target_id in mine and a.resolution = 'resolved'
      union all select a.type, t.file_id from assertion a join assertion_candidate c on c.assertion_id = a.id join symbol t on t.id = c.symbol_id where a.source_id in mine
      union all select a.type, case a.source_kind when 'file' then a.source_id else s.file_id end from assertion_candidate c join assertion a on a.id = c.assertion_id left join symbol s on s.id = a.source_id where c.symbol_id in mine)
    select distinct f.path, e.type from ends e join file f on f.id = e.other where e.type != 'contains' and e.other != ? order by f.path, e.type`).all(fileId, fileId, fileId) as Array<{ path: string; type: string }>
  const out = new Map<string, string[]>()
  for (const r of rows) out.set(r.path, [...(out.get(r.path) ?? []), r.type])
  return out
}

/**
 * Each subject's partners that pass the thresholds, ordered by degree, then shared, then path (FR2020). degree is
 * shared / min(subject_commits, partner_commits) (FR2021); a partner the snapshot does not hold is left out, since it cannot change with it.
 */
export function partners(db: Database.Database, history: History, subjects: Array<{ id: string; path: string }>, t: Thresholds, isTest: (path: string) => boolean): { rows: Array<{ path: string; commits: number; partners: Partner[] }>; bulk: number } {
  const c = history.available ? count(history.commits, subjects.map((s) => s.path), t.max_files_per_commit) : { commits: new Map<string, number>(), shared: new Map<string, Map<string, number>>(), bulk: 0 }
  const held = db.prepare('select 1 from file where path = ?')
  const rows = subjects.map((s) => {
    const mine = c.commits.get(s.path) ?? 0, links = linkedFiles(db, s.id)
    const list = [...(c.shared.get(s.path) ?? [])].map(([p, shared]) => ({ p, shared, theirs: c.commits.get(p)!, ratio: shared / Math.min(mine, c.commits.get(p)!) }))
      .filter((x) => x.shared >= t.min_shared && x.ratio >= t.min_degree && held.get(x.p))
      .sort((a, b) => b.ratio - a.ratio || b.shared - a.shared || (a.p < b.p ? -1 : 1))
      .map((x): Partner => ({ path: x.p, shared: x.shared, subject_commits: mine, partner_commits: x.theirs, degree: Math.round(x.ratio * 100) / 100, linked: links.has(x.p), relationship_types: links.get(x.p) ?? [], test: isTest(x.p) }))
    return { path: s.path, commits: mine, partners: list }
  })
  return { rows, bulk: c.bulk }
}

/** The lean row of a partner (FR2025): `<path> shared=<n> degree=<d> [linked]`, and `test` for test code. */
export const leanPartner = (p: Partner): string => [quote(p.path), `shared=${p.shared}`, `degree=${p.degree}`, ...(p.linked ? ['linked'] : []), ...(p.test ? ['test'] : [])].join(' ')

/** What the history read was, for the answer. */
export function historyHeader(history: History, bulk: number) {
  return history.available
    ? { available: true, commit: history.commit, window: history.window, commits_read: history.commits.length, bulk_commits: bulk, shallow: history.shallow, capped: history.capped }
    : { available: false, commit: null, window: DEFAULT_WINDOW, commits_read: 0, bulk_commits: 0, shallow: false, capped: false }
}

/** The limitations every co-change answer carries: what was read, the thresholds, and why history may be missing or coarse. */
export function historyNotes(history: History, t: Thresholds, bulk: number): string[] {
  if (!history.available) return [`no_history: ${history.reason}, so no co-change is known.`]
  const w = 'days' in history.window ? `${history.window.days} days` : `${history.window.commits} commits`
  return [
    ...(history.shallow ? [`history_shallow: the repository is a shallow clone, so only the ${history.commits.length} commit${history.commits.length === 1 ? '' : 's'} it holds were read; counts may be low.`] : []),
    `Co-change read from ${history.commits.length} commit${history.commits.length === 1 ? '' : 's'} back from ${history.commit.slice(0, 12)} over a window of ${w}, merges left out; a squash merge counts as one commit, so coupling is coarser where they are used.`,
    `Thresholds: min_shared ${t.min_shared}, min_degree ${t.min_degree}, max_files_per_commit ${t.max_files_per_commit}; degree = shared / min(subject_commits, partner_commits). Co-change is not a relationship: no traversal tool follows it.`,
    ...(bulk ? [`${bulk} commit${bulk === 1 ? '' : 's'} touching more than ${t.max_files_per_commit} files formed no pairs.`] : []),
    ...(history.capped ? [`The window holds more commits than the ${history.commits.length} read; the oldest are left out.`] : []),
  ]
}
