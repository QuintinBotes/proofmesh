// Cross-repository symbols (#28, FR902, FR903): the sites in other members of this repository's workspaces that reach its symbols through a
// package it builds, read from each workspace's sealed link file (A28) and the member snapshots that file was built from. Nothing is matched
// at query time.
import type Database from 'better-sqlite3'
import type { Catalog, SnapshotRow } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'
import { openLinkFile, PACKAGE_SYMBOL_TYPES } from '../links/index.js'
import type { Basis } from './basis.js'
import { analyzeImpact, type Impact } from './impact.js'

export type Repository = { id: string; name: string; commit: string | null }
/** Each workspace's link file and each member's side of it: the snapshot it was built from, its commit, and whether that is still current. */
export type WorkspaceHeader = { name: string; link_file_id: string | null; members: Array<Repository & { snapshot_id: string; current: boolean }> }
export type Inbound = {
  repository: Repository; snapshot_id: string; into: string; link_id: string; type: string; assertion_id: string; origin: string; resolution: 'resolved' | 'candidate'; basis: Basis; target: string
  source: { id: string; kind: string; name: string; qualified_name: string; path: string; start_line: number; key: string }
  site: { path: string; start_line: number; end_line: number }; evidence_ids: string[]; detail: Record<string, string>
}
/** A resolved package_symbol link out of a member's symbol: the site's assertion and the symbol it reaches in another member. */
export type Outbound = { src: string; assertion_id: string; type: string; repository: Repository; snapshot_id: string; target: string; basis: Basis }
export type Side = Repository & { snapshot_id: string; db: Database.Database }
type Opened = { name: string; links: Database.Database; own: { snapshot_id: string; db: Database.Database }; members: Map<string, Side> }
export type Workspace = {
  /** This repository's id. */
  self: string
  header: WorkspaceHeader[]; limitations: string[]
  /** The sites linked to `ids`: this repository's symbols, or with `target` the symbols of that member, as its side of the link file names them. */
  inbound: (ids: string[], types: readonly string[], target?: string) => Inbound[]
  /** The resolved links out of the given symbols of a member's side (this repository's when its side is this snapshot). */
  outbound: (repositoryId: string, snapshotId: string, ids: string[], types: readonly string[]) => Outbound[]
  member: (repositoryId: string, snapshotId?: string) => Side
  /** The member side whose snapshot holds a symbol or file id, other than this snapshot; null when this snapshot holds it or none does. */
  sideOf: (id: string) => Side | null
}

const commitOf = (db: Database.Database) => (JSON.parse((db.prepare("select value from meta where key = 'git'").get() as { value: string } | undefined)?.value ?? '{}') as { commit?: string }).commit ?? null
const marks = (n: number) => Array.from({ length: n }, () => '?').join(',')
/** The tag a lean row carries for a row of another repository: its name and the commit its snapshot was built from. */
export const repoTag = (r: Repository) => `repo=${r.name}${r.commit ? `@${r.commit.slice(0, 12)}` : ''}`
/** The limitation a version mismatch states, as the issue words it: `version mismatch: app uses 1.1.0, lib is 1.2.0`. */
const mismatch = (from: string, to: string, d: Record<string, string>) => `version mismatch: ${from} uses ${d.installed ?? 'an unknown version'}, ${to} is ${d.built ?? 'unversioned'}`

/** Opens every workspace that holds this repository, at its latest link file, for the time of `fn`; every file is opened read-only. */
export function withWorkspace<T>(catalog: Catalog, repo: { id: string; name: string }, snapshot: SnapshotRow, db: Database.Database, fn: (ws: Workspace) => T): T {
  const opened: Opened[] = [], header: WorkspaceHeader[] = [], limitations: string[] = []
  const toClose: Database.Database[] = []
  try {
    const names = catalog.workspaces().filter((w) => w.members.includes(repo.id)).map((w) => w.name).sort()
    if (!names.length) limitations.push(`${repo.name} is in no workspace, so include_workspace adds nothing; add it with "proofmesh workspace add".`)
    for (const name of names) {
      const record = catalog.latestLinkFile(name)
      if (!record) { header.push({ name, link_file_id: null, members: [] }); limitations.push(`Workspace ${name} has no link file; run "proofmesh workspace link ${name}".`); continue }
      const links = openLinkFile(catalog, record)
      toClose.push(links)
      const members = new Map<string, Side>()
      for (const m of links.prepare('select repository_id, snapshot_id, name from member order by name, repository_id').all() as Array<{ repository_id: string; snapshot_id: string; name: string }>) {
        const row = catalog.snapshot(m.snapshot_id)
        if (!row) continue
        const mdb = m.snapshot_id === snapshot.id ? db : openSnapshot(catalog, row)
        if (mdb !== db) toClose.push(mdb)
        members.set(m.repository_id, { id: m.repository_id, name: m.name, commit: commitOf(mdb), snapshot_id: m.snapshot_id, db: mdb })
      }
      const own = members.get(repo.id)
      if (!own) continue
      header.push({ name, link_file_id: record.id, members: [...members.values()].map(({ db: _db, ...m }) => ({ ...m, current: catalog.currentSnapshot(m.id)?.id === m.snapshot_id })) })
      // Stale sides are each named: a member whose current snapshot is newer than the one the link file was built from.
      const stale = [...members.values()].filter((m) => catalog.currentSnapshot(m.id)?.id !== m.snapshot_id).map((m) => m.name)
      if (stale.length) limitations.push(`Link file ${record.id} of workspace ${name} was built from older snapshots of ${stale.join(', ')}; run "proofmesh workspace link ${name}" for rows from their current ones.${own.snapshot_id !== snapshot.id ? ' This snapshot\'s symbols are matched to it by stable key.' : ''}`)
      opened.push({ name, links, own: { snapshot_id: own.snapshot_id, db: own.db }, members })
    }
    const inbound = (ids: string[], types: readonly string[], target?: string): Inbound[] => {
      const wanted = types.filter((t) => PACKAGE_SYMBOL_TYPES.includes(t))
      if (!ids.length || !wanted.length) return []
      const out = new Map<string, Inbound>()
      const to = target ?? repo.id
      for (const o of opened) {
        const into = o.members.get(to)
        if (!into) continue
        // This repository's ids, as the link file's snapshot of it names them: the same snapshot, or the symbol with the same stable key.
        // A member's ids are already of its side.
        const back = new Map<string, string>()
        const key = db.prepare('select stable_key from symbol where id = ?'), there = o.own.db.prepare('select id from symbol where stable_key = ?')
        for (const id of ids) {
          if (target || o.own.snapshot_id === snapshot.id) { back.set(id, id); continue }
          const k = key.get(id) as { stable_key: string } | undefined, t = k && (there.get(k.stable_key) as { id: string } | undefined)
          if (t) back.set(t.id, id)
        }
        const targets = [...back.keys()], rows: Array<{ id: string; type: string; resolution: string; source_repository_id: string; source_symbol_id: string; source_assertion_id: string; detail: string | null; target: string }> = []
        // In chunks: an impact walk can reach more symbols than one statement takes parameters.
        for (let i = 0; i < targets.length; i += 500) {
          const chunk = targets.slice(i, i + 500)
          rows.push(...(o.links.prepare(`select l.*, l.target_symbol_id as target from link l where l.rule = 'package_symbol' and l.type in (${marks(wanted.length)}) and l.resolution = 'resolved' and l.target_repository_id = ? and l.target_symbol_id in (${marks(chunk.length)})
            union all select l.*, c.target_symbol_id as target from link_candidate c join link l on l.id = c.link_id where l.rule = 'package_symbol' and l.type in (${marks(wanted.length)}) and c.target_repository_id = ? and c.target_symbol_id in (${marks(chunk.length)})`)
            .all(...wanted, to, ...chunk, ...wanted, to, ...chunk) as typeof rows))
        }
        for (const l of rows) {
          const side = o.members.get(l.source_repository_id)
          const site = `${l.source_repository_id}:${l.source_assertion_id}`
          if (!side || out.has(site) || l.source_repository_id === to) continue
          const a = side.db.prepare('select origin from assertion where id = ?').get(l.source_assertion_id) as { origin: string } | undefined
          const s = side.db.prepare('select s.id, s.kind, s.name, s.qualified_name, s.stable_key as key, f.path, s.start_line from symbol s join file f on f.id = s.file_id where s.id = ?').get(l.source_symbol_id) as Inbound['source'] | undefined
          if (!a || !s) continue
          const ev = side.db.prepare('select e.id, f.path, e.start_line, e.end_line from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by f.path, e.start_byte').all(l.source_assertion_id) as Array<{ id: string; path: string; start_line: number; end_line: number }>
          const detail = Object.fromEntries(Object.entries({ rule: 'package_symbol', ...(l.detail ? (JSON.parse(l.detail) as Record<string, unknown>) : {}) }).filter(([, v]) => v !== null).map(([k, v]) => [k, String(v)]))
          const candidate = l.resolution !== 'resolved'
          out.set(site, {
            repository: { id: side.id, name: side.name, commit: side.commit }, snapshot_id: side.snapshot_id, into: into.name, link_id: l.id, type: l.type, assertion_id: l.source_assertion_id, origin: a.origin, resolution: candidate ? 'candidate' : 'resolved',
            basis: candidate || detail.inferred ? 'inferred' : 'observed', target: back.get(l.target)!, source: s, site: { path: ev[0]!.path, start_line: ev[0]!.start_line, end_line: ev[0]!.end_line }, evidence_ids: ev.map((e) => e.id), detail,
          })
        }
      }
      return [...out.values()].sort((x, y) => (x.repository.name < y.repository.name ? -1 : x.repository.name > y.repository.name ? 1 : 0) || (x.site.path < y.site.path ? -1 : x.site.path > y.site.path ? 1 : 0) || x.site.start_line - y.site.start_line || (x.assertion_id < y.assertion_id ? -1 : 1))
    }
    const outbound = (from: string, snapshotId: string, ids: string[], types: readonly string[]): Outbound[] => {
      const wanted = types.filter((t) => PACKAGE_SYMBOL_TYPES.includes(t))
      const out = new Map<string, Outbound>()
      if (!ids.length || !wanted.length) return []
      for (const o of opened) {
        if (o.members.get(from)?.snapshot_id !== snapshotId) continue
        const key = o.own.db.prepare('select stable_key from symbol where id = ?'), here = db.prepare('select id from symbol where stable_key = ?')
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500)
          const rows = o.links.prepare(`select source_symbol_id as src, source_assertion_id as assertion_id, type, target_repository_id, target_symbol_id, detail from link where rule = 'package_symbol' and resolution = 'resolved' and type in (${marks(wanted.length)}) and source_repository_id = ? and source_symbol_id in (${marks(chunk.length)}) order by source_assertion_id`)
            .all(...wanted, from, ...chunk) as Array<{ src: string; assertion_id: string; type: string; target_repository_id: string; target_symbol_id: string; detail: string | null }>
          for (const l of rows) {
            const side = o.members.get(l.target_repository_id)
            // A target in this repository is named by this snapshot's id: the same one, or the symbol with the same stable key.
            const own = l.target_repository_id === repo.id
            const k = own && o.own.snapshot_id !== snapshot.id ? (key.get(l.target_symbol_id) as { stable_key: string } | undefined) : undefined
            const target = !own || o.own.snapshot_id === snapshot.id ? l.target_symbol_id : k && (here.get(k.stable_key) as { id: string } | undefined)?.id
            if (!side || !target || out.has(`${l.assertion_id}:${target}`)) continue
            const inferred = l.detail ? (JSON.parse(l.detail) as { inferred?: string }).inferred : undefined
            out.set(`${l.assertion_id}:${target}`, { src: l.src, assertion_id: l.assertion_id, type: l.type, repository: { id: side.id, name: side.name, commit: side.commit }, snapshot_id: own ? snapshot.id : side.snapshot_id, target, basis: inferred ? 'inferred' : 'observed' })
          }
        }
      }
      return [...out.values()]
    }
    const member = (id: string, snapshotId?: string): Side => {
      for (const o of opened) { const m = o.members.get(id); if (m && (!snapshotId || m.snapshot_id === snapshotId)) return m }
      throw new Error(`no workspace member ${id}`)
    }
    const sides = new Map<string, Side | null>()
    const sideOf = (id: string): Side | null => {
      if (!sides.has(id)) {
        const holds = (d: Database.Database) => !!d.prepare('select 1 from symbol where id = ? union all select 1 from file where id = ? union all select 1 from assertion where id = ?').get(id, id, id)
        sides.set(id, holds(db) ? null : opened.flatMap((o) => [...o.members.values()]).find((m) => m.db !== db && holds(m.db)) ?? null)
      }
      return sides.get(id)!
    }
    return fn({ self: repo.id, header, limitations, inbound, outbound, member, sideOf })
  } finally {
    for (const d of toClose) d.close()
  }
}

/** The version mismatches the rows state, once each. */
export const mismatchNotes = (rows: Inbound[]) => [...new Set(rows.filter((r) => r.detail.inferred === 'version_mismatch').map((r) => mismatch(r.repository.name, r.into, r.detail)))]

/** A dependent in another member, with the row fields FR860 gives every impact row, read from that member's snapshot. */
export type WorkspaceDependent = Impact['dependents'][number] & { repository: Repository; line: number; relationship: string; site?: { path: string; start_line: number } }
/** The sites of one member at one depth and basis that a hop across the workspace reached: one walk in that member's snapshot. */
export type Group = { repository: Repository; snapshot_id: string; depth: number; basis: Basis; ids: string[]; rows: Inbound[] }
/**
 * FR903, FR1262: the dependents in other members of what the local walk reached. A member site that reaches a reached symbol through a
 * package is a dependent one deeper; the code that depends on that site in its own repository follows, by the same walk, and so on into
 * the members that use a package that member builds. A dependent reached through an inferred link is inferred.
 */
// shortcut: a chain that comes back into this repository through another member is not followed; its local walk already lists this repository's dependents.
export function workspaceDependents(ws: Workspace, reached: Map<string, number>, types: readonly string[], maxDepth: number): { dependents: WorkspaceDependent[]; stopped: boolean; notes: Inbound[]; groups: Group[] } {
  const found = new Map<string, WorkspaceDependent>()
  const notes: Inbound[] = [], all: Group[] = []
  // Each member's symbols already walked from, at their least depth, so a chain through a cycle of members ends.
  const walked = new Map<string, number>()
  let stopped = false
  let hop = ws.inbound([...reached.keys()], types).map((r) => ({ r, depth: reached.get(r.target)! + 1, basis: r.basis }))
  // FR860: the line of the relationship that reached it when that is in the dependent's own file, else its declaration line and the site.
  const add = (d: Impact['dependents'][number] & { repository: Repository }, declared: number, relationship: string, site?: { path: string; start_line: number }) => {
    const k = `${d.repository.id}:${d.id}`, had = found.get(k)
    if (had && (had.depth < d.depth || (had.depth === d.depth && had.basis === 'observed'))) return
    found.set(k, { ...d, line: site?.path === d.path ? site.start_line : declared, relationship, ...(site && site.path !== d.path ? { site } : {}) })
  }
  while (hop.length) {
    notes.push(...hop.map((h) => h.r))
    // Sources grouped by member, depth and basis, so each group is one walk in that member's snapshot.
    const groups = new Map<string, Group>()
    for (const { r, depth, basis } of hop) {
      if (depth > maxDepth) { stopped = true; continue }
      const s = r.source, w = `${r.repository.id}:${s.id}`
      add({ id: s.id, kind: s.kind, name: s.name, qualified_name: s.qualified_name, path: s.path, project: null, depth, basis, repository: r.repository }, s.start_line, r.type, { path: r.site.path, start_line: r.site.start_line })
      if ((walked.get(w) ?? Infinity) <= depth) continue
      walked.set(w, depth)
      const g = `${r.repository.id}:${r.snapshot_id}:${depth}:${basis}`
      const had = groups.get(g) ?? groups.set(g, { repository: r.repository, snapshot_id: r.snapshot_id, depth, basis, ids: [], rows: [] }).get(g)!
      had.ids.push(s.id); had.rows.push(r)
    }
    const next: typeof hop = []
    for (const g of groups.values()) {
      all.push(g)
      const side = ws.member(g.repository.id, g.snapshot_id)
      const walk = analyzeImpact(side.db, side.snapshot_id, g.ids, types, maxDepth - g.depth, Number.MAX_SAFE_INTEGER)
      if (walk.stopped_by) stopped = true
      const site = side.db.prepare('select f.path, e.start_line, a.type from assertion a join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where a.id = ? order by f.path, e.start_byte limit 1')
      const declared = side.db.prepare('select start_line from symbol where id = ?')
      const there = new Map(g.ids.map((id) => [id, g.depth]))
      for (const d of walk.dependents) {
        const via = walk.reached_by.get(d.id), at = via ? (site.get(via) as { path: string; start_line: number; type: string }) : undefined
        // A file reached through imports has no declaration line; its import statement is its line.
        const decl = (declared.get(d.id) as { start_line: number } | undefined)?.start_line ?? at?.start_line ?? 1
        add({ ...d, depth: d.depth + g.depth, basis: g.basis === 'inferred' ? 'inferred' : d.basis, repository: g.repository }, decl, at?.type ?? 'dispatch', at && { path: at.path, start_line: at.start_line })
        if (!there.has(d.id)) there.set(d.id, d.depth + g.depth)
      }
      // The next hop: the members that reach what this walk reached through a package this member builds (FR1262).
      next.push(...ws.inbound([...there.keys()], types, g.repository.id).filter((r) => r.repository.id !== ws.self).map((r) => ({ r, depth: there.get(r.target)! + 1, basis: g.basis === 'inferred' ? 'inferred' as const : r.basis })))
    }
    hop = next
  }
  return { dependents: [...found.values()], stopped, notes, groups: all }
}
