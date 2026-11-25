import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { derivedId, randomToken, sha256File } from '../core/hash.js'
import { ProofmeshError } from '../core/errors.js'
import { schemasDir } from '../core/paths.js'
import { readSql } from '../core/schemas.js'

export type RepositoryRow = { id: string; root: string; name: string; created_at: string }
export type SnapshotRow = {
  id: string; repository_id: string; state: 'staging' | 'published' | 'failed' | 'retired'; identity_hash: string
  store_digest: string | null; analysis_mode: 'no_execution' | 'trusted_build'; created_at: string; published_at: string | null; failure: string | null
  /** 1 when a person pinned it, so retention never retires it (FR051). */
  pinned: 0 | 1
}

const now = () => new Date().toISOString()
/** Every catalog/NNNN.sql shipped, in order; the newest is the catalog version. Numbers may have gaps while milestones land in parallel. */
export const CATALOG_MIGRATIONS = fs.readdirSync(path.join(schemasDir(), 'catalog')).map((f) => /^(\d{4})\.sql$/.exec(f)?.[1]).filter((v): v is string => !!v).map(Number).sort((a, b) => a - b)
export const CATALOG_VERSION = CATALOG_MIGRATIONS[CATALOG_MIGRATIONS.length - 1]!
/** A SCIP index a person named (A24): the hash of the index file, and of each file it covers as the tree stood then (A27). */
/** How an index came to be when Proofmesh ran the indexer itself (A38): what ran, under which grant, and how isolated. */
export type ScipRun = { indexer: string; version: string; digest: string; grant_id: string; isolation: 'container' | 'process'; module_cache: string }
export type ScipIndexRecord = { name: string; path: string; sha256: string; tool: string; files: Record<string, { hash: string; language: string }>; added_by: string; added_at: string; run: ScipRun | null }
export type LinkFileRecord = { id: string; workspace: string; digest: string; members: Array<{ repository_id: string; snapshot_id: string }>; sealed_at: string }
export type Observation = { source: string; window_from: string; window_to: string; subject_kind: 'endpoint' | 'table' | 'channel'; subject_name: string; metric: string; value: number; imported_by: string; imported_at: string }
export type PropertyRead = { source: string; window_from: string; window_to: string; endpoint: string; entity: string; property: string; reads: number; read_kind: 'orm' | 'application'; declaring_type: string | null; calls: number | null; callers: string | null; imported_by: string; imported_at: string }
export type PropertyReadInput = { endpoint: string; entity: string; property: string; reads: number; read_kind?: 'orm' | 'application'; declaring_type?: string; calls?: number; callers?: string[] }
/** A verification (D07): what a person approved, bound by hash, and what its one run recorded. */
export type Verification = { id: string; repository_id: string; snapshot_id: string; state: 'prepared' | 'approved' | 'consumed' | 'finished' | 'failed' | 'expired'; binding: Record<string, unknown>; binding_hash: string; prepared_by: string; prepared_at: string; expires_at: string; approved_by: string | null; approved_at: string | null; consumed_at: string | null; record: { record: Record<string, unknown>; mac: string } | null; error: string | null }
export type IndexJob = { id: string; repository_id: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'; requested_by: string; requested_at: string; started_at: string | null; finished_at: string | null; phase: string | null; done: number | null; total: number | null; result: unknown; error: string | null; progress_at: string | null; phase_started_at: string | null; plan: Record<string, { mode: string; analyse: number; reuse: number }> | null; elapsed_ms: number | null }
export type InstalledAdapter = { id: string; entry: string; sha256: string; extensions: Record<string, string>; configNames: string[]; added_by: string; added_at: string; kit: { passed: boolean; checked_at: string; sha256: string; checks: number; failed: string[] } | null }
/** The note source of notes saved by agents rather than synced from a person's directory. */
export const AGENT_NOTES = 'agent:'
/** The index lease owner for this process: its pid and host, so a lease whose process died on this host is free at once. */
export const LEASE_OWNER = `pid:${process.pid}@${os.hostname()}`

function holderAlive(owner: string): boolean {
  const m = /^pid:(\d+)@(.+)$/.exec(owner)
  if (!m || m[2] !== os.hostname()) return true
  try { process.kill(Number(m[1]), 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Applies each catalog/NNNN.sql not yet applied, in order, each in its own transaction; never rewrites an applied migration. */
function migrate(db: Database.Database): void {
  const has = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'schema_migration'").get()
  const applied = new Set(has ? (db.prepare('select version from schema_migration').all() as Array<{ version: number }>).map((r) => r.version) : [])
  for (const next of CATALOG_MIGRATIONS) {
    if (applied.has(next)) continue
    db.transaction(() => {
      db.exec(readSql(`catalog/${String(next).padStart(4, '0')}.sql`))
      db.prepare('insert into schema_migration (version, applied_at) values (?, ?)').run(next, now())
    })()
  }
}

export type Extension = { adapter_id: string; path: string; sha256: string; added_by: string; added_at: string }

export type TrustGrant = { id: string; repository_id: string; mode: 'build_evaluation'; granted_by: string; granted_at: string; revoked_at: string | null }

export function initDataDir(dataDir: string): { created: boolean } {
  const created = !fs.existsSync(path.join(dataDir, 'catalog.db'))
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dataDir, 0o700)
  for (const sub of ['objects', 'snapshots', 'staging', 'tokens']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 })
  const api = path.join(dataDir, 'tokens', 'api')
  if (!fs.existsSync(api)) fs.writeFileSync(api, randomToken() + '\n', { mode: 0o600 })
  Catalog.open(dataDir, { create: true }).close()
  return { created }
}

export class Catalog {
  private constructor(readonly db: Database.Database, readonly dataDir: string) {}

  static open(dataDir: string, { create = false } = {}): Catalog {
    const file = path.join(dataDir, 'catalog.db')
    if (!create && !fs.existsSync(file)) {
      throw new ProofmeshError('INVALID_ARGUMENT', `data directory ${dataDir} is not initialized; run "proofmesh init" first`)
    }
    const db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    migrate(db)
    return new Catalog(db, dataDir)
  }

  close(): void {
    this.db.close()
  }

  addRepository(root: string, name?: string): RepositoryRow {
    const real = fs.realpathSync(root)
    if (!fs.statSync(real).isDirectory()) throw new ProofmeshError('INVALID_ARGUMENT', `${root} is not a directory`)
    const registered = this.db.prepare('select * from repository where root = ?').get(real) as RepositoryRow | undefined
    if (registered) return registered
    let id = derivedId('repo', 12, real)
    // A repository moved away keeps the id its old root derived, so a new registration at that root takes another.
    for (let n = 1; this.db.prepare('select 1 from repository where id = ?').get(id); n++) id = derivedId('repo', 12, real, n)
    this.db.prepare('insert into repository (id, root, name, created_at) values (?, ?, ?, ?)').run(id, real, name ?? path.basename(real), now())
    return this.repository(id)
  }

  /** Re-roots a registration; its id, and so its snapshots, notes, observations and trust, stay. The caller checks it is the same repository. */
  moveRepository(id: string, root: string): RepositoryRow {
    const real = fs.realpathSync(root)
    const other = this.db.prepare('select id from repository where root = ? and id <> ?').get(real, id) as { id: string } | undefined
    if (other) throw new ProofmeshError('INVALID_ARGUMENT', `${real} is already registered as ${other.id}`)
    this.db.prepare('update repository set root = ? where id = ?').run(real, id)
    return this.repository(id)
  }

  repositories(): RepositoryRow[] {
    return this.db.prepare('select * from repository order by id').all() as RepositoryRow[]
  }

  repository(idOrPath: string): RepositoryRow {
    let row = (this.db.prepare('select * from repository where id = ?').get(idOrPath) ?? this.db.prepare('select * from repository where name = ?').get(idOrPath)) as RepositoryRow | undefined
    // A root that no longer exists is still matched as written, so a repository whose checkout moved can be named by its old path.
    if (!row) row = this.db.prepare('select * from repository where root = ?').get(fs.existsSync(idOrPath) ? fs.realpathSync(idOrPath) : path.resolve(idOrPath)) as RepositoryRow | undefined
    if (!row) throw new ProofmeshError('NOT_FOUND', `repository ${idOrPath} is not registered`)
    return row
  }

  /** The repository a request names, or the only registered one. */
  resolveRepository(id?: string): RepositoryRow {
    if (id) return this.repository(id)
    const all = this.repositories()
    if (all.length === 1) return all[0]!
    // The refusal lists what is registered, so a caller with no shell can pick one; list_repositories gives the same list.
    if (all.length) throw new ProofmeshError('INVALID_ARGUMENT', `repository_id is required when several repositories are registered: ${all.map((r) => `${r.id} (${r.name}, ${r.root})`).join('; ')}; list_repositories lists them`, { detail: 'repository_required', repositories: all.map((r) => ({ id: r.id, name: r.name, root: r.root })) })
    throw new ProofmeshError('INVALID_ARGUMENT', 'no repository is registered')
  }

  snapshot(id: string): SnapshotRow | undefined {
    return this.db.prepare('select * from snapshot where id = ?').get(id) as SnapshotRow | undefined
  }

  /** The published snapshot an index of a commit last produced (FR109): the index job's result names the commit and the snapshot. */
  snapshotOfCommit(repositoryId: string, commit: string): SnapshotRow | undefined {
    for (const r of this.db.prepare("select result from index_job where repository_id = ? and state = 'succeeded' and result is not null order by finished_at desc").all(repositoryId) as Array<{ result: string }>) {
      const done = JSON.parse(r.result) as { snapshot_id?: string; commit?: string | null }
      const s = done.commit === commit && done.snapshot_id ? this.snapshot(done.snapshot_id) : undefined
      if (s?.state === 'published') return s
    }
    return undefined
  }

  /** Every published snapshot of a repository, newest first: what Replay may pin (FR010). */
  publishedSnapshots(repositoryId: string): SnapshotRow[] {
    return this.db.prepare("select * from snapshot where repository_id = ? and state = 'published' order by published_at desc, id").all(repositoryId) as SnapshotRow[]
  }

  currentSnapshot(repositoryId: string): SnapshotRow | undefined {
    return this.db.prepare('select s.* from current_snapshot c join snapshot s on s.id = c.snapshot_id where c.repository_id = ?').get(repositoryId) as SnapshotRow | undefined
  }

  beginStaging(id: string, repositoryId: string, identityHash: string, analysisMode: SnapshotRow['analysis_mode']): void {
    this.db.prepare(`insert into snapshot (id, repository_id, state, identity_hash, analysis_mode, created_at)
      values (?, ?, 'staging', ?, ?, ?)
      on conflict(id) do update set state = 'staging', failure = null, store_digest = null, published_at = null, created_at = excluded.created_at`)
      .run(id, repositoryId, identityHash, analysisMode, now())
  }

  markFailed(id: string, failure: string): void {
    this.db.prepare("update snapshot set state = 'failed', failure = ? where id = ? and state <> 'published'").run(failure, id)
  }

  currentSnapshotIds(): string[] {
    return (this.db.prepare('select snapshot_id from current_snapshot').all() as Array<{ snapshot_id: string }>).map((r) => r.snapshot_id)
  }

  /** Every member snapshot a recorded link file was built from; retiring one would leave the link file citing nothing (A28). */
  linkedSnapshotIds(): string[] {
    return (this.db.prepare('select members from link_file').all() as Array<{ members: string }>).flatMap((r) => (JSON.parse(r.members) as Array<{ snapshot_id: string }>).map((m) => m.snapshot_id))
  }

  pin(id: string, pinned: boolean): void {
    if (this.db.prepare("update snapshot set pinned = ? where id = ? and state = 'published'").run(pinned ? 1 : 0, id).changes === 0) throw new ProofmeshError('NOT_FOUND', `no published snapshot ${id}`)
  }

  /** Retention (FR051): a retired snapshot keeps its row and loses its sealed file. The current, pinned and linked ones are never retired. */
  retire(id: string): void {
    if (this.currentSnapshotIds().includes(id) || this.linkedSnapshotIds().includes(id)) throw new ProofmeshError('INVALID_ARGUMENT', `snapshot ${id} is current or a link file member`)
    if (this.db.prepare("update snapshot set state = 'retired', store_digest = null, published_at = null where id = ? and state = 'published' and pinned = 0").run(id).changes === 0) throw new ProofmeshError('INVALID_ARGUMENT', `snapshot ${id} is not published or is pinned`)
  }

  /** Publication: one short transaction that records the digest and moves the current pointer, unless keepCurrent and there is one (FR109). */
  publish(id: string, repositoryId: string, digest: string, keepCurrent = false): void {
    this.db.transaction(() => {
      this.db.prepare("update snapshot set state = 'published', store_digest = ?, published_at = ?, failure = null where id = ?").run(digest, now(), id)
      if (keepCurrent && this.currentSnapshot(repositoryId)) return
      this.db.prepare('insert into current_snapshot (repository_id, snapshot_id) values (?, ?) on conflict(repository_id) do update set snapshot_id = excluded.snapshot_id').run(repositoryId, id)
    })()
  }

  /** Build-evaluation trust is granted only through the CLI (D14); MCP and HTTP have no operation for it. */
  grantTrust(repositoryId: string, grantedBy: string): TrustGrant {
    const existing = this.activeTrust(repositoryId)
    if (existing) return existing
    const id = `trust_${randomToken().slice(0, 16)}`
    this.db.prepare("insert into trust_grant (id, repository_id, mode, granted_by, granted_at) values (?, ?, 'build_evaluation', ?, ?)").run(id, repositoryId, grantedBy, now())
    return this.activeTrust(repositoryId)!
  }

  revokeTrust(repositoryId: string): number {
    return this.db.prepare('update trust_grant set revoked_at = ? where repository_id = ? and revoked_at is null').run(now(), repositoryId).changes
  }

  /** A grant by id, revoked or not: an index a run produced under it is trusted only while the grant is not revoked (A38). */
  trustGrant(id: string): TrustGrant | undefined {
    return this.db.prepare('select * from trust_grant where id = ?').get(id) as TrustGrant | undefined
  }

  activeTrust(repositoryId: string): TrustGrant | undefined {
    return this.db.prepare('select * from trust_grant where repository_id = ? and revoked_at is null order by granted_at desc limit 1').get(repositoryId) as TrustGrant | undefined
  }

  /** The adapter's configuration for a repository, with the workspace's installed extensions appended. */
  adapterConfig(repositoryId: string, adapterId: string): Record<string, unknown> {
    const row = this.db.prepare('select config from adapter_config where repository_id = ? and adapter_id = ?').get(repositoryId, adapterId) as { config: string } | undefined
    const config = row ? (JSON.parse(row.config) as Record<string, unknown>) : {}
    const installed = this.extensions(adapterId).map((e) => e.path)
    return installed.length ? { ...config, extensions: [...((config.extensions as string[] | undefined) ?? []), ...installed] } : config
  }

  /** Installing an extension is trusting its code (D13, A14); only the CLI calls this. */
  addExtension(adapterId: string, file: string, addedBy: string): Extension {
    const full = path.resolve(file)
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new ProofmeshError('INVALID_ARGUMENT', `${full} is not a file`)
    this.db.prepare('insert into extension (adapter_id, path, sha256, added_by, added_at) values (?, ?, ?, ?, ?) on conflict(adapter_id, path) do update set sha256 = excluded.sha256, added_by = excluded.added_by, added_at = excluded.added_at')
      .run(adapterId, full, sha256File(full), addedBy, now())
    return this.extensions(adapterId).find((e) => e.path === full)!
  }

  removeExtension(adapterId: string, file: string): number {
    return this.db.prepare('delete from extension where adapter_id = ? and path = ?').run(adapterId, path.resolve(file)).changes
  }

  extensions(adapterId?: string): Extension[] {
    return (adapterId
      ? this.db.prepare('select * from extension where adapter_id = ? order by path').all(adapterId)
      : this.db.prepare('select * from extension order by adapter_id, path').all()) as Extension[]
  }

  /** Installing an adapter is trusting its code (D13, US18); only the CLI calls this, for a person. */
  installAdapter(a: { id: string; entry: string; extensions: Record<string, string>; configNames: string[] }, addedBy: string): InstalledAdapter {
    const entry = path.resolve(a.entry)
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) throw new ProofmeshError('INVALID_ARGUMENT', `${entry} is not a file`)
    this.db.prepare(`insert into adapter_install (id, entry, sha256, extensions, config_names, added_by, added_at, kit) values (?, ?, ?, ?, ?, ?, ?, null)
      on conflict(id) do update set entry = excluded.entry, sha256 = excluded.sha256, extensions = excluded.extensions, config_names = excluded.config_names, added_by = excluded.added_by, added_at = excluded.added_at, kit = null`)
      .run(a.id, entry, sha256File(entry), JSON.stringify(a.extensions), JSON.stringify(a.configNames), addedBy, now())
    return this.installedAdapters().find((x) => x.id === a.id)!
  }

  removeAdapter(id: string): number {
    return this.db.prepare('delete from adapter_install where id = ?').run(id).changes
  }

  installedAdapters(): InstalledAdapter[] {
    return (this.db.prepare('select * from adapter_install order by id').all() as Array<Record<string, string | null>>).map((r) => ({
      id: r.id!, entry: r.entry!, sha256: r.sha256!, extensions: JSON.parse(r.extensions!), configNames: JSON.parse(r.config_names!), added_by: r.added_by!, added_at: r.added_at!, kit: r.kit ? JSON.parse(r.kit) : null,
    }))
  }

  /** Adds repositories to a workspace, creating it if it is new (A29). Adding a member twice changes nothing. */
  addToWorkspace(name: string, repositoryIds: string[], by: string): void {
    this.db.transaction(() => {
      this.db.prepare('insert into workspace (name, created_by, created_at) values (?, ?, ?) on conflict(name) do nothing').run(name, by, now())
      for (const id of repositoryIds) this.db.prepare('insert into workspace_member (workspace, repository_id, added_at) values (?, ?, ?) on conflict do nothing').run(name, id, now())
    })()
  }

  /** Removes the named members, or with none named the whole workspace and the record of its link files. */
  removeFromWorkspace(name: string, repositoryIds: string[]): number {
    return this.db.transaction(() => {
      if (repositoryIds.length) return repositoryIds.reduce((n, id) => n + this.db.prepare('delete from workspace_member where workspace = ? and repository_id = ?').run(name, id).changes, 0)
      this.db.prepare('delete from workspace_member where workspace = ?').run(name)
      this.db.prepare('delete from link_file where workspace = ?').run(name)
      return this.db.prepare('delete from workspace where name = ?').run(name).changes
    })()
  }

  workspaces(): Array<{ name: string; created_by: string; created_at: string; members: string[] }> {
    return (this.db.prepare('select * from workspace order by name').all() as Array<{ name: string; created_by: string; created_at: string }>).map((w) => ({
      ...w, members: (this.db.prepare('select repository_id from workspace_member where workspace = ? order by repository_id').all(w.name) as Array<{ repository_id: string }>).map((m) => m.repository_id),
    }))
  }

  /** Names the service registry of a workspace member: a path relative to its root (A7). */
  setWorkspaceRegistry(workspace: string, repositoryId: string, registry: string): void {
    this.db.prepare('update workspace_member set registry = ? where workspace = ? and repository_id = ?').run(registry, workspace, repositoryId).changes
  }

  /** The service registry each member of a workspace names, by repository. */
  workspaceRegistries(workspace: string): Map<string, string> {
    return new Map((this.db.prepare('select repository_id, registry from workspace_member where workspace = ? and registry is not null order by repository_id').all(workspace) as Array<{ repository_id: string; registry: string }>).map((r) => [r.repository_id, r.registry]))
  }

  /** Every service registry any workspace names for a repository: the files indexing it captures. */
  registryPaths(repositoryId: string): string[] {
    return (this.db.prepare('select distinct registry from workspace_member where repository_id = ? and registry is not null order by registry').all(repositoryId) as Array<{ registry: string }>).map((r) => r.registry)
  }

  workspace(name: string): { name: string; members: string[] } {
    const w = this.workspaces().find((x) => x.name === name)
    if (!w) throw new ProofmeshError('NOT_FOUND', `no workspace named ${name}`)
    return w
  }

  /** A record of one tool query (NFR008: the input's hash only, never its text or the result). */
  recordQuery(r: { query_id: string; tool: string; repository_id: string; snapshot_id: string; duration_ms: number; truncated: boolean; input_hash: string }): void {
    this.db.prepare('insert into query_record (query_id, tool, repository_id, snapshot_id, requested_at, duration_ms, truncated, input_hash) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.query_id, r.tool, r.repository_id, r.snapshot_id, now(), Math.round(r.duration_ms), r.truncated ? 1 : 0, r.input_hash)
  }

  queryRecords(filter: { repository_id?: string; tool?: string; limit: number }): Array<{ query_id: string; tool: string; repository_id: string; snapshot_id: string; requested_at: string; duration_ms: number; truncated: boolean; input_hash: string }> {
    const rows = this.db.prepare('select * from query_record where (? is null or repository_id = ?) and (? is null or tool = ?) order by requested_at desc, rowid desc limit ?')
      .all(filter.repository_id ?? null, filter.repository_id ?? null, filter.tool ?? null, filter.tool ?? null, filter.limit) as Array<Record<string, string | number>>
    return rows.map((r) => ({ query_id: String(r.query_id), tool: String(r.tool), repository_id: String(r.repository_id), snapshot_id: String(r.snapshot_id), requested_at: String(r.requested_at), duration_ms: Number(r.duration_ms), truncated: r.truncated === 1, input_hash: String(r.input_hash) }))
  }

  recordLinkFile(f: Omit<LinkFileRecord, 'sealed_at'>): void {
    this.db.prepare('insert into link_file (id, workspace, digest, members, sealed_at) values (?, ?, ?, ?, ?) on conflict(id) do nothing').run(f.id, f.workspace, f.digest, JSON.stringify(f.members), now())
  }

  /** The link file sealed last for a workspace, which workspace tools answer from by default. */
  latestLinkFile(workspace: string): LinkFileRecord | undefined {
    const r = this.db.prepare('select id from link_file where workspace = ? order by sealed_at desc, id desc limit 1').get(workspace) as { id: string } | undefined
    return r && this.linkFile(r.id)
  }

  linkFile(id: string): LinkFileRecord | undefined {
    const r = this.db.prepare('select * from link_file where id = ?').get(id) as Record<string, string> | undefined
    return r && { id: r.id!, workspace: r.workspace!, digest: r.digest!, members: JSON.parse(r.members!), sealed_at: r.sealed_at! }
  }

  /** Imports a validated observations file (A30), replacing earlier rows from the same source and window. Returns rows written and replaced. */
  importObservations(repositoryId: string, o: { source: string; window: { from: string; to: string }; counts: Array<{ subject: { kind: string; name: string }; metric: string; value: number }>; property_reads?: PropertyReadInput[] }, by: string): { written: number; replaced: number } {
    return this.db.transaction(() => {
      const key = [repositoryId, o.source, o.window.from, o.window.to] as const
      const replaced = this.db.prepare('delete from observation where repository_id = ? and source = ? and window_from = ? and window_to = ?').run(...key).changes
        + this.db.prepare('delete from observation_property_read where repository_id = ? and source = ? and window_from = ? and window_to = ?').run(...key).changes
      const insert = this.db.prepare('insert or replace into observation (repository_id, source, window_from, window_to, subject_kind, subject_name, metric, value, imported_by, imported_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const c of o.counts) insert.run(...key, c.subject.kind, c.subject.name, c.metric, c.value, by, now())
      const read = this.db.prepare('insert or replace into observation_property_read (repository_id, source, window_from, window_to, endpoint, entity, property, read_kind, reads, declaring_type, calls, callers, imported_by, imported_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const r of o.property_reads ?? []) read.run(...key, r.endpoint, r.entity, r.property, r.read_kind ?? 'application', r.reads, r.declaring_type ?? null, r.calls ?? null, r.callers ? JSON.stringify(r.callers) : null, by, now())
      return { written: o.counts.length + (o.property_reads?.length ?? 0), replaced }
    })()
  }

  /** Observed property reads of the named entities, every source and window. */
  propertyReads(repositoryId: string, entities: string[]): PropertyRead[] {
    if (!entities.length) return []
    return this.db.prepare(`select * from observation_property_read where repository_id = ? and entity in (${entities.map(() => '?').join(',')}) order by source, window_from, endpoint, entity, property, read_kind`).all(repositoryId, ...entities) as PropertyRead[]
  }

  /** Observed property reads by endpoint or by entity (either may be omitted), every source and window. */
  propertyReadsWhere(repositoryId: string, by: { endpoint?: string; entity?: string }): PropertyRead[] {
    const where = ['repository_id = ?', ...(by.endpoint ? ['endpoint = ?'] : []), ...(by.entity ? ['(entity = ? or declaring_type = ?)'] : [])].join(' and ')
    return this.db.prepare(`select * from observation_property_read where ${where} order by source, window_from, endpoint, entity, property, read_kind`).all(repositoryId, ...(by.endpoint ? [by.endpoint] : []), ...(by.entity ? [by.entity, by.entity] : [])) as PropertyRead[]
  }

  /** Every imported property read of a repository, for listing. */
  allPropertyReads(repositoryId: string): PropertyRead[] {
    return this.db.prepare('select * from observation_property_read where repository_id = ? order by source, window_from, endpoint, entity, property').all(repositoryId) as PropertyRead[]
  }

  observations(repositoryId: string, kind?: string): Observation[] {
    return this.db.prepare(`select * from observation where repository_id = ? ${kind ? 'and subject_kind = ?' : ''} order by source, window_from, subject_kind, subject_name, metric`).all(...(kind ? [repositoryId, kind] : [repositoryId])) as Observation[]
  }

  setting(key: string): string | undefined {
    return (this.db.prepare('select value from setting where key = ?').get(key) as { value: string } | undefined)?.value
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('insert into setting (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value)
  }

  prepareVerification(v: Pick<Verification, 'id' | 'repository_id' | 'snapshot_id' | 'binding' | 'binding_hash' | 'prepared_by' | 'expires_at'>): Verification {
    this.db.prepare('insert into verification (id, repository_id, snapshot_id, state, binding, binding_hash, prepared_by, prepared_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(v.id, v.repository_id, v.snapshot_id, 'prepared', JSON.stringify(v.binding), v.binding_hash, v.prepared_by, now(), v.expires_at)
    return this.verification(v.id)!
  }

  verification(id: string): Verification | undefined {
    const r = this.db.prepare('select * from verification where id = ?').get(id) as Record<string, string | null> | undefined
    if (!r) return undefined
    // Expiry is a fact of time, not a transition anyone has to run.
    const state = (r.state === 'prepared' || r.state === 'approved') && r.expires_at! < now() ? 'expired' : (r.state as Verification['state'])
    return { ...(r as unknown as Verification), state, binding: JSON.parse(r.binding!), record: r.record ? JSON.parse(r.record) : null }
  }

  /** A person approves one prepared verification whose binding hash still matches (FR044, FR045). */
  approveVerification(id: string, hash: string, by: string): Verification {
    const n = this.db.prepare("update verification set state = 'approved', approved_by = ?, approved_at = ? where id = ? and state = 'prepared' and binding_hash = ? and expires_at > ?").run(by, now(), id, hash, now()).changes
    if (!n) throw new ProofmeshError('APPROVAL_INVALID', `verification ${id} is not prepared, has expired, or its binding changed; prepare it again`)
    return this.verification(id)!
  }

  /** Consumes an approval before anything runs, so a second run finds nothing to consume (FR045). */
  consumeVerification(id: string, hash: string): boolean {
    return this.db.prepare("update verification set state = 'consumed', consumed_at = ? where id = ? and state = 'approved' and binding_hash = ? and expires_at > ?").run(now(), id, hash, now()).changes === 1
  }

  finishVerification(id: string, state: 'finished' | 'failed', record: Verification['record'], error: string | null): void {
    this.db.prepare("update verification set state = ?, record = ?, error = ? where id = ? and state = 'consumed'").run(state, record ? JSON.stringify(record) : null, error, id)
  }

  /** Naming a SCIP index for a repository; only the CLI calls this, for a person. Naming it again replaces it. */
  addScip(repositoryId: string, s: Omit<ScipIndexRecord, 'added_by' | 'added_at' | 'run'> & { run?: ScipRun }, addedBy: string): ScipIndexRecord {
    this.db.prepare(`insert into scip_index (repository_id, name, path, sha256, tool, files, added_by, added_at, run) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(repository_id, name) do update set path = excluded.path, sha256 = excluded.sha256, tool = excluded.tool, files = excluded.files, added_by = excluded.added_by, added_at = excluded.added_at, run = excluded.run`)
      .run(repositoryId, s.name, s.path, s.sha256, s.tool, JSON.stringify(s.files), addedBy, now(), s.run ? JSON.stringify(s.run) : null)
    return this.scipIndexes(repositoryId).find((x) => x.name === s.name)!
  }

  removeScip(repositoryId: string, name: string): number {
    return this.db.prepare('delete from scip_index where repository_id = ? and name = ?').run(repositoryId, name).changes
  }

  scipIndexes(repositoryId: string): ScipIndexRecord[] {
    return (this.db.prepare('select * from scip_index where repository_id = ? order by name').all(repositoryId) as Array<Record<string, string>>).map((r) => ({
      name: r.name!, path: r.path!, sha256: r.sha256!, tool: r.tool!, files: JSON.parse(r.files!), added_by: r.added_by!, added_at: r.added_at!, run: r.run ? JSON.parse(r.run) : null,
    }))
  }

  /** The conformance kit's last verdict on an installed adapter; a capability is not called supported without a pass (FR072). */
  recordKit(id: string, kit: { passed: boolean; checked_at: string; sha256: string; checks: number; failed: string[] }): void {
    this.db.prepare('update adapter_install set kit = ? where id = ?').run(JSON.stringify(kit), id)
  }

  addNoteSource(dir: string, addedBy: string): string {
    const full = path.resolve(dir)
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new ProofmeshError('INVALID_ARGUMENT', `${full} is not a directory`)
    this.db.prepare('insert into note_source (path, added_by, added_at) values (?, ?, ?) on conflict(path) do nothing').run(full, addedBy, now())
    return full
  }

  noteSources(): string[] {
    return (this.db.prepare('select path from note_source order by path').all() as Array<{ path: string }>).map((r) => r.path)
  }

  /** Replaces the stored notes of every source with what its files say now; an accepted fingerprint survives while the note is unchanged. */
  syncNotes(read: (dir: string) => { notes: Array<{ id: string; title: string; kind: string; status: string | null; target: string | null; refs: string[]; sources: string[]; patterns: string[]; body: string; fingerprint: string | null; file: string }>; problems: string[] }): { notes: number; problems: string[] } {
    const problems: string[] = []
    let count = 0
    this.db.transaction(() => {
      // Notes saved by agents live only in the catalog; syncing a directory never touches them.
      for (const source of this.noteSources().filter((s) => s !== AGENT_NOTES)) {
        const previous = new Map((this.db.prepare('select id, title, refs, patterns, body, fingerprint, accepted_by, accepted_at from note where source_path = ?').all(source) as Array<Record<string, string | null>>).map((r) => [r.id!, r]))
        this.db.prepare('delete from note where source_path = ?').run(source)
        const r = read(source)
        problems.push(...r.problems)
        for (const n of r.notes) {
          const before = previous.get(n.id)
          const same = before && before.title === n.title && before.refs === JSON.stringify(n.refs) && before.patterns === JSON.stringify(n.patterns) && before.body === n.body
          this.db.prepare('insert into note (id, source_path, file, title, kind, status, target, refs, sources, patterns, body, fingerprint, accepted_by, accepted_at, synced_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do nothing')
            .run(n.id, source, n.file, n.title, n.kind, n.status, n.target, JSON.stringify(n.refs), JSON.stringify(n.sources), JSON.stringify(n.patterns), n.body, same ? before!.fingerprint : n.fingerprint, same ? before!.accepted_by : null, same ? before!.accepted_at : null, now())
          count++
        }
      }
    })()
    return { notes: count, problems }
  }

  /** A note an agent proposes: stored in the catalog, never written to a person's notes directory, and unaccepted until a person accepts it. */
  saveAgentNote(n: { id: string; title: string; kind: string; refs: string[]; body: string }): void {
    this.db.prepare('insert into note_source (path, added_by, added_at) values (?, ?, ?) on conflict(path) do nothing').run(AGENT_NOTES, 'tool', now())
    const existing = this.db.prepare('select source_path from note where id = ?').get(n.id) as { source_path: string } | undefined
    if (existing && existing.source_path !== AGENT_NOTES) throw new ProofmeshError('INVALID_ARGUMENT', `note ${n.id} is curated by a person; choose another id`)
    this.db.prepare(`insert into note (id, source_path, file, title, kind, status, target, refs, sources, body, fingerprint, accepted_by, accepted_at, synced_at)
      values (?, ?, '', ?, ?, null, null, ?, '[]', ?, null, null, null, ?) on conflict(id) do update set title = excluded.title, kind = excluded.kind, refs = excluded.refs, body = excluded.body, fingerprint = null, accepted_by = null, accepted_at = null, synced_at = excluded.synced_at`)
      .run(n.id, AGENT_NOTES, n.title, n.kind, JSON.stringify(n.refs), n.body, now())
  }

  notes(): Array<{ id: string; title: string; kind: string; status: string | null; target: string | null; refs: string[]; sources: string[]; patterns: string[]; body: string; fingerprint: string | null; accepted_by: string | null; accepted_at: string | null; file: string }> {
    return (this.db.prepare('select * from note order by id').all() as Array<Record<string, string | null>>).map((r) => ({ ...r, refs: JSON.parse(r.refs!), sources: JSON.parse(r.sources!), patterns: JSON.parse(r.patterns ?? '[]') })) as never
  }

  acceptNote(id: string, fingerprint: string, by: string): void {
    if (!this.db.prepare('update note set fingerprint = ?, accepted_by = ?, accepted_at = ? where id = ?').run(fingerprint, by, now(), id).changes) throw new ProofmeshError('NOT_FOUND', `no note ${id}; run proofmesh notes sync first`)
  }

  /** A claim is stored by the hash of its statement and proposition, so the same claim is one record however often it is checked. */
  storeClaim(statement: string, proposition: unknown): string {
    const id = derivedId('clm', 24, statement, JSON.stringify(proposition))
    this.db.prepare('insert into claim (id, statement, proposition, created_at) values (?, ?, ?, ?) on conflict(id) do nothing').run(id, statement, JSON.stringify(proposition), now())
    return id
  }

  claim(id: string): { id: string; statement: string; proposition: unknown } | undefined {
    const row = this.db.prepare('select id, statement, proposition from claim where id = ?').get(id) as { id: string; statement: string; proposition: string } | undefined
    return row ? { ...row, proposition: JSON.parse(row.proposition) } : undefined
  }

  /** Stored claims, most recently verified first, each with its latest verification run. */
  claims(): Array<{ id: string; statement: string; proposition: unknown; created_at: string; latest: { run_id: string; snapshot_id: string; verdict: string; layers: unknown; dependencies: unknown; verified_at: string } | null }> {
    const rows = this.db.prepare(`select c.id, c.statement, c.proposition, c.created_at, r.id as run_id, r.snapshot_id, r.verdict, r.layers, r.dependencies, r.verified_at
      from claim c left join verification_run r on r.id = (select id from verification_run where claim_id = c.id order by verified_at desc, id desc limit 1)
      order by coalesce(r.verified_at, c.created_at) desc, c.id`).all() as Array<Record<string, string | null>>
    return rows.map((r) => ({ id: r.id!, statement: r.statement!, proposition: JSON.parse(r.proposition!), created_at: r.created_at!,
      latest: r.run_id ? { run_id: r.run_id, snapshot_id: r.snapshot_id!, verdict: r.verdict!, layers: JSON.parse(r.layers!), dependencies: JSON.parse(r.dependencies!), verified_at: r.verified_at! } : null }))
  }

  recordVerification(claimId: string, snapshotId: string, verdict: string, layers: unknown, dependencies: unknown): string {
    const id = `run_${randomToken().slice(0, 16)}`
    this.db.prepare('insert into verification_run (id, claim_id, snapshot_id, verdict, layers, dependencies, verified_at) values (?, ?, ?, ?, ?, ?, ?)').run(id, claimId, snapshotId, verdict, JSON.stringify(layers), JSON.stringify(dependencies), now())
    return id
  }

  /** Refuses to run an extension whose file changed since a person installed it. */
  verifyExtensions(adapterId: string): void {
    for (const e of this.extensions(adapterId)) {
      if (!fs.existsSync(e.path)) throw new ProofmeshError('TRUST_REQUIRED', `extension ${e.path} is missing; reinstall it with proofmesh extension add or remove it`)
      if (sha256File(e.path) !== e.sha256) throw new ProofmeshError('TRUST_REQUIRED', `extension ${e.path} changed since it was installed; review it, then run proofmesh extension add again`)
    }
  }

  setAdapterConfig(repositoryId: string, adapterId: string, config: Record<string, unknown>): void {
    this.db.prepare('insert into adapter_config (repository_id, adapter_id, config) values (?, ?, ?) on conflict(repository_id, adapter_id) do update set config = excluded.config').run(repositoryId, adapterId, JSON.stringify(config))
  }

  acquireLease(owner: string, ttlMs = 30 * 60 * 1000): void {
    this.db.transaction(() => {
      const row = this.leaseHolder()
      if (row && row.owner !== owner) {
        throw new ProofmeshError('INVALID_ARGUMENT', `another index job (${row.owner}) holds the lease until ${row.expires_at}`)
      }
      this.db.prepare('insert into index_lease (singleton, owner, expires_at) values (1, ?, ?) on conflict(singleton) do update set owner = excluded.owner, expires_at = excluded.expires_at')
        .run(owner, new Date(Date.now() + ttlMs).toISOString())
    })()
  }

  /** Long index runs renew their lease as they progress, so it never lapses while the work is alive. */
  renewLease(owner: string, ttlMs = 30 * 60 * 1000): void {
    this.db.prepare('update index_lease set expires_at = ? where singleton = 1 and owner = ?').run(new Date(Date.now() + ttlMs).toISOString(), owner)
  }

  leaseHolder(): { owner: string; expires_at: string } | undefined {
    const row = this.db.prepare('select owner, expires_at from index_lease where singleton = 1').get() as { owner: string; expires_at: string } | undefined
    return row && Date.parse(row.expires_at) > Date.now() && holderAlive(row.owner) ? row : undefined
  }

  /** A job already queued or running for the repository is returned instead of starting a second one. */
  requestJob(repositoryId: string, requestedBy: string): { id: string; created: boolean } {
    const open = this.db.prepare("select id from index_job where repository_id = ? and state in ('queued', 'running') order by requested_at desc limit 1").get(repositoryId) as { id: string } | undefined
    if (open && this.job(open.id)!.state !== 'interrupted') return { id: open.id, created: false }
    return { id: this.createJob(repositoryId, requestedBy), created: true }
  }

  /** A new queued job, whatever else is open: the CLI records every index it runs, and one that cannot take the lease ends failed. */
  createJob(repositoryId: string, requestedBy: string): string {
    const id = `job_${randomToken().slice(0, 16)}`
    this.db.prepare("insert into index_job (id, repository_id, state, requested_by, requested_at) values (?, ?, 'queued', ?, ?)").run(id, repositoryId, requestedBy, now())
    return id
  }

  /** The repository's jobs that are queued or running as job() reports them, oldest first; an interrupted one is not open. */
  openJobs(repositoryId: string): IndexJob[] {
    return (this.db.prepare("select id from index_job where repository_id = ? and state in ('queued', 'running') order by requested_at, id").all(repositoryId) as Array<{ id: string }>)
      .map((r) => this.job(r.id)!).filter((j) => j.state === 'queued' || j.state === 'running')
  }

  updateJob(id: string, patch: Partial<{ state: string; started_at: string; finished_at: string; phase: string; done: number; total: number; result: string; error: string; owner: string; progress_at: string; phase_started_at: string; plan: string }>): void {
    const keys = Object.keys(patch)
    if (keys.length) this.db.prepare(`update index_job set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`).run(...keys.map((k) => (patch as Record<string, unknown>)[k]), id)
  }

  /** A running job whose process no longer holds the index lease was interrupted; it is reported so, not as running. */
  job(id: string): IndexJob | undefined {
    const row = this.db.prepare('select * from index_job where id = ?').get(id) as Record<string, string | number | null> | undefined
    if (!row) return undefined
    const holder = this.leaseHolder()
    const interrupted = (row.state === 'running' && (!holder || holder.owner !== row.owner)) || (row.state === 'queued' && Date.now() - Date.parse(row.requested_at as string) > 120000)
    const { owner: _owner, ...rest } = row
    const started = row.started_at ? Date.parse(row.started_at as string) : null
    const elapsed = started === null ? null : (row.finished_at ? Date.parse(row.finished_at as string) : Date.now()) - started
    return { ...rest, state: interrupted ? 'interrupted' : row.state, result: row.result ? JSON.parse(row.result as string) : null, plan: row.plan ? JSON.parse(row.plan as string) : null, elapsed_ms: elapsed } as never
  }

  releaseLease(owner: string): void {
    this.db.prepare('delete from index_lease where singleton = 1 and owner = ?').run(owner)
  }
}
