import type Database from 'better-sqlite3'
import { type Basis, basisOf, inferredSql } from './basis.js'
import { structure, TYPE_KINDS } from './impact.js'
import { candidatesTo, sitesNaming } from './inferred.js'
import { hasRoles, isTestEntry, parseRoles, rolesSql, type Roles } from './tests.js'

/** How a test is known to reach its subject, strongest first (FR101, FR104). */
export const EVIDENCE = ['call', 'transitive_call', 'dispatch', 'reference', 'import_only'] as const
/** Evidence that a test runs the subject's code (FR105); observed coverage would count too, once coverage can be imported. */
export const EXECUTING = new Set<string>(['call', 'transitive_call', 'dispatch', 'observed'])

type Evidence = (typeof EVIDENCE)[number]
type Hop = { name: string; path: string; line: number }
export type TestRow = { id: string; kind: string; name: string; qualified_name: string; path: string; project: string | null; line: number; depth: number; evidence: Evidence; basis: Basis; via?: string }
/** A node on the way from a subject to a test; `next` leads back to the subject. mode 0 runs the subject, 1 runs it by dispatch, 2 only references it. */
type State = { node: string; mode: number; depth: number; next?: State; assertion?: string; peer?: boolean; via?: string }
type Info = { id: string; kind: string; name: string; qualified_name: string; start_line: number; file_id: string; path: string; roles: string | null }

const NODE_BUDGET = 50000
/** Kinds a call through an interface or base member can reach. */
const DISPATCHABLE = new Set(['method', 'property', 'class', 'struct', 'interface'])
/** A name as rows and chains show it: the qualified name without its module. */
const local = (qn: string) => qn.slice(qn.indexOf(':') + 1)
// shortcut: the names an import brings are read from its statement's text, with string literals and a Python `from module` left out;
// have adapters record imported names if a language's import syntax defeats this.
// `a as b` binds the export a, so b is left out.
export const importedNames = (text: string) => text.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, ' ').replace(/^\s*from\s+\S+/, ' ').replace(/([\w$]+)\s+as\s+[\w$]+/g, '$1').match(/[\w$]+|\*/g) ?? []
/** Relationships that run their target: a call, a render, a hook. Heritage runs nothing of the member above (dispatch covers the way down), nor does injection. */
const RUNS = ['calls', 'renders', 'uses_hook']

const withRoles = new Map<string, Set<string>>()
/** The files in which some symbol has roles, so whose adapter sent them; computed once per open snapshot. shortcut: a role-aware file that happens to hold no test or support symbol is judged by the old rule. */
function filesWithRoles(db: Database.Database, snapshotId: string): Set<string> {
  let hit = withRoles.get(snapshotId)
  if (!hit) withRoles.set(snapshotId, (hit = new Set(hasRoles(db) ? (db.prepare('select distinct file_id from symbol where roles is not null').all() as Array<{ file_id: string }>).map((r) => r.file_id) : [])))
  return hit
}

const projects = new Map<string, Map<string, string>>()
/** The project that contains each file, by its module symbol; computed once per open snapshot, since impact_completeness asks per row. */
function projectsOf(db: Database.Database, snapshotId: string): Map<string, string> {
  const hit = projects.get(snapshotId)
  if (hit) return hit
  const out = new Map<string, string>()
  for (const r of db.prepare("select m.file_id, p.qualified_name from assertion a join symbol p on p.id = a.source_id join symbol m on m.id = a.target_id where a.type = 'contains' and p.kind = 'project'").all() as Array<{ file_id: string; qualified_name: string }>) if (!out.has(r.file_id)) out.set(r.file_id, r.qualified_name)
  projects.set(snapshotId, out)
  return out
}

/**
 * The tests that reach the subjects, each once at its strongest evidence, with the shortest chain of that evidence (FR101, FR103, FR104).
 * Breadth first back from the subjects along resolved relationships, as analyze_impact walks; a reference counts only into a subject.
 * `files` are the subjects named by path, whose every import counts for import_only.
 */
export function testReach(db: Database.Database, snapshotId: string, subjects: string[], files: string[], read: (hash: string) => Buffer | undefined, maxDepth: number, isTest: (path: string, project: string | null, roles?: Roles) => boolean, follow = false, budget = NODE_BUDGET) {
  const { membersOf, kindOf } = structure(db, snapshotId)
  const projectOfFile = projectsOf(db, snapshotId)
  const infos = new Map<string, Info>()
  const load = (ids: string[]) => {
    const todo = [...new Set(ids)].filter((id) => !infos.has(id))
    for (let i = 0; i < todo.length; i += 500) {
      const chunk = todo.slice(i, i + 500)
      for (const r of db.prepare(`select s.id, s.kind, s.name, s.qualified_name, s.start_line, s.file_id, f.path, ${rolesSql(db)} as roles from symbol s join file f on f.id = s.file_id where s.id in (${chunk.map(() => '?').join(',')})`).all(...chunk) as Info[]) infos.set(r.id, r)
    }
  }
  const testCode = (i: Info) => isTest(i.path, projectOfFile.get(i.file_id) ?? null, parseRoles(i.roles))
  // In a file whose adapter sent roles, only an entry point is a test and a helper in test code is not (FR194); in any other file (an adapter that
  // sends none, such as protocol 1.0, or a snapshot that predates roles) every symbol in test code counts as a test.
  const aware = filesWithRoles(db, snapshotId)
  const isTestRow = (i: Info) => (aware.has(i.file_id) ? isTestEntry(parseRoles(i.roles)) : testCode(i))

  // What a call to a node may run of it: a subject type's own members, and by dispatch the members of the interfaces it implements;
  // for a member, the interface and base members it implements or overrides. A type reached on the way runs only what reached it.
  const above = db.prepare(`select e.dst, ${inferredSql()} as inferred from edge e join assertion a on a.id = e.assertion_id where e.src = ? and e.type in ('implements', 'overrides') and e.resolution = 'resolved'`)
  load(subjects)
  // A test does not test itself: a subject in test code has no rows.
  const roots = subjects.filter((id) => infos.has(id) && !testCode(infos.get(id)!))

  /** One breadth-first walk; with observedOnly it follows no inferred edge, so a test it reaches is reached by a chain of observed hops alone (FR184). */
  const walk = (observedOnly: boolean) => {
    let sawInferred = false
    const peers = (id: string, subject: boolean): Array<{ id: string; dispatch: boolean }> => {
      const up = (above.all(id) as Array<{ dst: string; inferred: number }>).filter((r) => { if (r.inferred) sawInferred = true; return !(observedOnly && r.inferred) }).map((r) => r.dst)
      if (!TYPE_KINDS.has(kindOf.get(id) ?? '')) return up.map((m) => ({ id: m, dispatch: true }))
      return subject ? [...(membersOf.get(id) ?? []).map((m) => ({ id: m, dispatch: false })), ...up.flatMap((i) => (membersOf.get(i) ?? []).map((m) => ({ id: m, dispatch: true })))] : []
    }
    const states = new Map<string, State>()
    // A state is kept only when no state of its node is as strong; breadth first, the kept one is the shortest of its mode.
    const add = (s: State, into: State[]) => {
      for (let m = 0; m <= s.mode; m++) if (states.has(`${s.node}\u0000${m}`)) return
      states.set(`${s.node}\u0000${s.mode}`, s)
      into.push(s)
      for (const p of peers(s.node, s.depth === 0)) add({ node: p.id, mode: p.dispatch ? Math.max(s.mode, 1) : s.mode, depth: s.depth, next: s, peer: true, via: p.dispatch ? p.id : s.via }, into)
    }
    let frontier: State[] = []
    for (const id of roots) add({ node: id, mode: 0, depth: 0 }, frontier)
    let stopped: 'max_depth' | 'node_budget' | null = null
    for (let depth = 1; frontier.length; depth++) {
      if (depth > maxDepth) { stopped = 'max_depth'; break }
      // A test that reads or passes the subject references it; only the subject's own references count.
      const types: string[] = depth === 1 ? [...RUNS, 'references'] : RUNS
      const at = new Map<string, State[]>()
      // A reference ends its chain: calling code that reads the subject is not reading it.
      for (const s of frontier) if (s.mode < 2) at.set(s.node, [...(at.get(s.node) ?? []), s])
      const nodes = [...at.keys()], next: State[] = []
      for (let i = 0; i < nodes.length; i += 500) {
        const chunk = nodes.slice(i, i + 500)
        const rows = db.prepare(`select e.src, e.dst, e.type, e.assertion_id, ${inferredSql()} as inferred from edge e join assertion a on a.id = e.assertion_id where e.dst in (${chunk.map(() => '?').join(',')}) and e.type in (${types.map(() => '?').join(',')}) and e.resolution in ('resolved', 'resolved_external')`).all(...chunk, ...types) as Array<{ src: string; dst: string; type: string; assertion_id: string; inferred: number }>
        // A candidate call names its caller through assertion_candidate; it is a call only while following (FR205).
        if (follow) rows.push(...candidatesTo(db, chunk, types).map((c) => ({ ...c, inferred: 1 })))
        for (const r of rows) {
          if (r.inferred) sawInferred = true
          if (observedOnly && r.inferred) continue
          for (const s of at.get(r.dst)!) add({ node: r.src, mode: r.type === 'references' ? 2 : s.mode, depth, next: s, assertion: r.assertion_id, via: s.via }, next)
          // Checked per row, so a hub with thousands of callers cannot overshoot the budget within one level (FR210).
          if (states.size > budget) break
        }
        if (states.size > budget) break
      }
      if (states.size > budget) { stopped = 'node_budget'; break }
      frontier = next
    }

    const reached = [...states.values()].filter((s) => s.depth > 0)
    load(reached.flatMap((s) => [s.node, ...(s.via ? [s.via] : [])]))
    const best = new Map<string, State>()
    for (const s of reached) if (!best.has(s.node) || s.mode < best.get(s.node)!.mode) best.set(s.node, s)
    const rows: TestRow[] = [], chainStart = new Map<string, State>()
    for (const [id, s] of best) {
      const i = infos.get(id)
      if (!i || !isTestRow(i)) continue
      const evidence: Evidence = s.mode === 2 ? 'reference' : s.mode === 1 ? 'dispatch' : s.depth === 1 ? 'call' : 'transitive_call'
      rows.push({ id, kind: i.kind, name: i.name, qualified_name: i.qualified_name, path: i.path, project: projectOfFile.get(i.file_id) ?? null, line: i.start_line, depth: s.depth, evidence, basis: 'observed', ...(s.mode === 1 && s.via ? { via: local(infos.get(s.via)!.qualified_name) } : {}) })
      chainStart.set(id, s)
    }
    return { states, reached, rows, chainStart, stopped, sawInferred }
  }
  // A test is observed when a chain of observed hops reaches it, with that chain and its evidence; one only a chain through an inferred hop
  // reaches is inferred. Only a walk that met an inferred edge can differ, so the second walk runs only then.
  const all = walk(false)
  const proved = all.sawInferred ? walk(true) : all
  const { states, reached, stopped } = all
  // A row of the observed walk replaces the all-edges row only when its evidence is at least as strong; a weaker observed chain would lose an executing test.
  const observedRows = new Map(proved.rows.map((r) => [r.id, r]))
  const useObserved = (r: TestRow) => { const o = observedRows.get(r.id); return o !== undefined && EVIDENCE.indexOf(o.evidence) <= EVIDENCE.indexOf(r.evidence) }
  const rows: TestRow[] = proved === all ? [...all.rows] : all.rows.map((r) => (useObserved(r) ? observedRows.get(r.id)! : { ...r, basis: 'inferred' as const }))
  const chainStart = new Map<string, State>(all.chainStart)
  if (proved !== all) for (const r of rows) if (r.basis === 'observed') chainStart.set(r.id, proved.chainStart.get(r.id)!)

  // import_only: a test file that imports the subject (for a file subject, the file) and in which nothing reaches it.
  const touched = new Set(reached.map((s) => infos.get(s.node)?.file_id))
  const wanted = new Map<string, Set<string> | 'any'>()
  const pathOf = db.prepare('select path from file where id = ?')
  for (const f of files) if (!isTest((pathOf.get(f) as { path: string }).path, projectOfFile.get(f) ?? null)) wanted.set(f, 'any')
  for (const id of roots) {
    const i = infos.get(id)!, w = wanted.get(i.file_id), name = local(i.qualified_name)
    // Only a module's top-level declarations can be imported by name.
    if (w === 'any' || i.kind === 'module' || name.includes('.')) continue
    wanted.set(i.file_id, (w ?? new Set<string>()).add(name))
  }
  const imports = wanted.size ? db.prepare(`select a.source_id as file, a.target_id as target, f.path, e.start_line as line, e.object_hash as hash, e.start_byte as start, e.end_byte as end, a.origin, a.resolution, a.detail
    from assertion a join file f on f.id = a.source_id join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id
    where a.type = 'imports' and a.resolution = 'resolved' and a.target_id in (${[...wanted.keys()].map(() => '?').join(',')}) order by f.path, e.start_byte`).all(...wanted.keys()) as Array<{ file: string; target: string; path: string; line: number; hash: string; start: number; end: number; origin: string; resolution: string; detail: string | null }> : []
  const listed = new Set<string>()
  for (const r of imports) {
    if (listed.has(r.file) || touched.has(r.file) || !isTest(r.path, projectOfFile.get(r.file) ?? null)) continue
    const w = wanted.get(r.target)!
    if (w !== 'any' && !importedNames(read(r.hash)?.subarray(r.start, r.end).toString('utf8') ?? '').some((n) => n === '*' || w.has(n))) continue
    listed.add(r.file)
    rows.push({ id: r.file, kind: 'file', name: r.path.slice(r.path.lastIndexOf('/') + 1), qualified_name: r.path, path: r.path, project: projectOfFile.get(r.file) ?? null, line: r.line, depth: 1, evidence: 'import_only', basis: basisOf(r)! })
  }
  rows.sort((a, b) => EVIDENCE.indexOf(a.evidence) - EVIDENCE.indexOf(b.evidence) || a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || (a.id < b.id ? -1 : 1))

  // Each hop names a symbol and the line of its call toward the subject; the last names the subject at its declaration (FR103).
  const site = db.prepare('select f.path, e.start_line as line from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by e.start_byte limit 1')
  const chain = (row: TestRow): Hop[] => {
    const hops: Hop[] = []
    for (let s = chainStart.get(row.id); s; s = s.next) {
      if (s.peer) continue
      const i = infos.get(s.node)!
      hops.push(s.next ? { name: local(i.qualified_name), ...(site.get(s.assertion) as { path: string; line: number }) } : { name: local(i.qualified_name), path: i.path, line: i.start_line })
    }
    return hops
  }

  // Calls with no single resolved target that name code of this walk as a candidate: a test behind one is not listed.
  const nodes = [...new Set([...states.values()].map((s) => s.node))]
  const ambiguous = new Set<string>()
  for (let i = 0; i < nodes.length; i += 500) {
    const chunk = nodes.slice(i, i + 500)
    for (const r of db.prepare(`select distinct c.assertion_id as id from assertion_candidate c join assertion a on a.id = c.assertion_id where a.type = 'calls' and c.symbol_id in (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ id: string }>) ambiguous.add(r.id)
  }
  // The candidate sites naming code of this walk that it never follows, for their cap (FR202); the others were followed or, off, are counted above.
  const sites = sitesNaming(db, nodes, ['calls'])
  // Dispatch is followed only where an adapter records implements and overrides; a subject that dispatch could reach, declared by
  // an adapter that recorded none, may miss tests.
  // shortcut: an adapter that records heritage but met none in this repository is named too; harmless, since there is then no dispatch to miss.
  const extractor = db.prepare('select e.extractor from symbol s join evidence e on e.id = s.evidence_id where s.id = ?')
  const records = db.prepare("select 1 from assertion where resolution = 'resolved' and type in ('implements', 'overrides') and adapter = ? limit 1")
  const unfollowed = [...new Set(roots.filter((id) => DISPATCHABLE.has(infos.get(id)!.kind)).map((id) => (extractor.get(id) as { extractor: string }).extractor))].filter((a) => !records.get(a)).sort()

  return { rows, chain, stopped_by: stopped, ambiguous: ambiguous.size, sites, unfollowed }
}
