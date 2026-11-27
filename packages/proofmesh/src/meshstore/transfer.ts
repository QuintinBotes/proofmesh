// Snapshot export and import (#39, FR1080 to FR1085): a sealed snapshot carried to another data directory as one file, so a clone at
// the same commit answers without indexing. The file is untrusted input. Import checks its hashes, its schema against this build's
// snapshot format, its commit and adapters against what is here, and every file against the working tree, before it publishes
// anything, and it never replaces a snapshot the repository already has.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { canonicalJson, sha256, sha256File } from '../core/hash.js'
import { ProofmeshError } from '../core/errors.js'
import { check, readSql, SNAPSHOT_EXPORT_VERSION } from '../core/schemas.js'
import { Catalog, noSnapshot, type ImportedSnapshot } from './catalog.js'
import { acquireIndexLock } from './index-lock.js'
import { FORMAT_VERSION, fsyncPath, openSnapshot, sealedPath } from './snapshot.js'
import { EvidenceStore } from '../evidence/store.js'
import { changes, workingTree } from '../indexer/freshness.js'
import { gitInfo } from '../indexer/discovery.js'
import { registryFor } from '../indexer/languages.js'
import { analysisVersions } from '../indexer/coordinator.js'

const MAGIC = `proofmesh-snapshot ${SNAPSHOT_EXPORT_VERSION}\n`
const SCHEMA = `snapshot-export/${SNAPSHOT_EXPORT_VERSION}.schema.json`
/** The manifest line may be no longer than this; past it the file is not one this build wrote. */
const MAX_MANIFEST = 256 * 1024 * 1024

type Adapter = { id: string; version: string; entry_sha256: string }
type Manifest = {
  schema_version: string; snapshot: { id: string; format_version: string; analysis_mode: 'no_execution' | 'trusted_build'; identity_hash: string }; commit: string
  adapters: Adapter[]; files: Record<string, string>; origin: ImportedSnapshot['origin']; store: { sha256: string; bytes: number }; manifest_sha256: string
}

const refuse = (detail: string, message: string, extra: Record<string, unknown> = {}) => new ProofmeshError('INVALID_ARGUMENT', `snapshot import refused: ${message}; nothing changed`, { detail, ...extra })
const corrupt = (message: string) => refuse('corrupt', `the file is corrupt: ${message}`)

/** The files a snapshot read content from, path to hash: indexed and failed files that kept a hash, and the docs it read mentions from. */
function capturedFiles(db: Database.Database): Map<string, string> {
  const out = new Map((db.prepare("select path, content_hash from file where disposition in ('indexed', 'failed') and content_hash is not null order by path").all() as Array<{ path: string; content_hash: string }>).map((f) => [f.path, f.content_hash]))
  const docs = db.prepare("select value from meta where key = 'doc_links'").get() as { value: string } | undefined
  for (const [p, h] of Object.entries(docs ? (JSON.parse(docs.value) as { docs: Record<string, string> }).docs : {})) {
    // A doc is never also a file row of another content; an import would otherwise check one hash and answer from the other.
    if (out.has(p) && out.get(p) !== h) throw corrupt(`${p} has two content hashes`)
    out.set(p, h)
  }
  return out
}

const OBJECT_HASH = /^[0-9a-f]{64}$/
/** A repository-relative POSIX path as discovery writes it: no absolute path, no `.` or `..` segment, no backslash or NUL. */
const relativePath = (p: string): boolean => p.length > 0 && !p.includes('\\') && !p.includes('\0') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')

/**
 * Every path and object hash the imported store holds, checked before anything reads them: later code joins file paths to directories
 * (a verification's copy of the tree) and object hashes to the evidence store, trusting them because discovery and capture wrote them.
 */
function checkRows(db: Database.Database): void {
  for (const f of db.prepare('select path, content_hash from file').iterate() as Iterable<{ path: string; content_hash: string | null }>) {
    if (!relativePath(f.path)) throw corrupt(`it names a file outside the repository: ${JSON.stringify(f.path)}`)
    if (f.content_hash !== null && !OBJECT_HASH.test(f.content_hash)) throw corrupt(`the content hash of ${f.path} is not a sha256`)
  }
  for (const e of db.prepare('select object_hash from evidence').iterate() as Iterable<{ object_hash: string }>) if (!OBJECT_HASH.test(e.object_hash)) throw corrupt('an evidence object hash is not a sha256')
  for (const [p, h] of capturedFiles(db)) if (!relativePath(p) || !OBJECT_HASH.test(h)) throw corrupt(`it names a doc outside the repository or without a sha256: ${JSON.stringify(p)}`)
}

const metaOf = (db: Database.Database): Map<string, string> => new Map((db.prepare('select key, value from meta').all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]))
const adaptersOf = (identity: { adapters?: Array<{ id: string; version: string; entry_sha256: string }> }): Adapter[] => (identity.adapters ?? []).map((a) => ({ id: a.id, version: a.version, entry_sha256: a.entry_sha256 }))

/** Writes a published snapshot built here, with its manifest, to a new file (FR1080). */
export function exportSnapshot(dataDir: string, repositoryIdOrPath: string, snapshotId: string | undefined, out: string, writer: string): Manifest {
  const catalog = Catalog.open(dataDir)
  try {
    const repo = catalog.repository(repositoryIdOrPath)
    const snapshot = snapshotId ? catalog.snapshot(snapshotId) : catalog.currentSnapshot(repo.id)
    if (!snapshot) throw snapshotId ? new ProofmeshError('NOT_FOUND', `no snapshot ${snapshotId}`) : noSnapshot(catalog, repo.id)
    if (snapshot.repository_id !== repo.id) throw new ProofmeshError('INVALID_ARGUMENT', `snapshot ${snapshot.id} belongs to repository ${snapshot.repository_id}, not ${repo.id}`)
    // Exported again, an imported snapshot would name this data directory as its origin.
    if (catalog.imported(snapshot.id)) throw new ProofmeshError('INVALID_ARGUMENT', `snapshot ${snapshot.id} was imported; export it from the data directory that built it`, { detail: 'imported' })
    const db = openSnapshot(catalog, snapshot)
    let meta: Map<string, string>, files: Map<string, string>
    try { meta = metaOf(db); files = capturedFiles(db) } finally { db.close() }
    const commit = (JSON.parse(meta.get('git') ?? '{}') as { commit?: string }).commit
    if (!commit) throw new ProofmeshError('INVALID_ARGUMENT', `snapshot ${snapshot.id} records no git commit, so no clone could be checked against it; index a git working tree`, { detail: 'no_commit' })
    const store = sealedPath(dataDir, snapshot.id)
    const body = {
      schema_version: SNAPSHOT_EXPORT_VERSION,
      snapshot: { id: snapshot.id, format_version: meta.get('format_version')!, analysis_mode: snapshot.analysis_mode, identity_hash: snapshot.identity_hash },
      commit, adapters: adaptersOf(JSON.parse(meta.get('identity')!)), files: Object.fromEntries(files),
      origin: { repository_id: repo.id, repository_name: repo.name, writer, exported_at: new Date().toISOString() },
      store: { sha256: snapshot.store_digest!, bytes: fs.statSync(store).size },
    }
    const manifest: Manifest = { ...body, manifest_sha256: sha256(canonicalJson(body)) }
    const problem = check(SCHEMA, manifest)
    if (problem) throw new ProofmeshError('INTERNAL_ERROR', `snapshot export manifest ${problem}`)
    const fd = fs.openSync(out, 'wx', 0o600)
    try {
      fs.writeSync(fd, MAGIC + JSON.stringify(manifest) + '\n')
      copyFrom(fs.openSync(store, 'r'), 0, fd)
      fs.fsyncSync(fd)
    } catch (e) {
      fs.closeSync(fd)
      fs.rmSync(out, { force: true })
      throw e
    }
    fs.closeSync(fd)
    return manifest
  } finally {
    catalog.close()
  }
}

/** Copies `from`, starting at `pos`, to the end of `to` a megabyte at a time, and closes `from`; returns the copied bytes' sha256 and size. */
function copyFrom(from: number, pos: number, to: number): { sha256: string; bytes: number } {
  const chunk = Buffer.alloc(1 << 20), h = crypto.createHash('sha256')
  let bytes = 0
  try {
    for (let n; (n = fs.readSync(from, chunk, 0, chunk.length, pos + bytes)) > 0; bytes += n) {
      h.update(chunk.subarray(0, n))
      fs.writeSync(to, chunk, 0, n)
    }
  } finally {
    fs.closeSync(from)
  }
  return { sha256: h.digest('hex'), bytes }
}

/** Reads the manifest line and copies the snapshot bytes after it to `to`, returning the manifest and the bytes' hash and size. */
function unpack(file: string, to: string): { manifest: unknown; sha256: string; bytes: number } {
  let fd: number
  try { fd = fs.openSync(file, 'r') } catch { throw refuse('unreadable', `${file} cannot be read`) }
  let open = true
  try {
    const chunk = Buffer.alloc(1 << 20), head: Buffer[] = []
    let offset = 0, end = -1, seen = 0
    while (end < 0) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, offset)
      if (!offset && chunk.subarray(0, Math.min(n, MAGIC.length)).toString('utf8') !== MAGIC) throw refuse('not_snapshot_export', `${file} is not a proofmesh snapshot export of format ${SNAPSHOT_EXPORT_VERSION}`)
      if (!n) throw corrupt('it ends before its manifest does')
      const nl = chunk.subarray(0, n).indexOf(0x0a, Math.max(0, MAGIC.length - seen))
      head.push(Buffer.from(chunk.subarray(0, nl < 0 ? n : nl + 1)))
      seen += nl < 0 ? n : nl + 1
      offset += n
      if (nl >= 0) end = seen
      if (seen > MAX_MANIFEST) throw corrupt('its manifest is longer than any this build writes')
    }
    let manifest: unknown
    try { manifest = JSON.parse(Buffer.concat(head).subarray(MAGIC.length).toString('utf8')) } catch { throw corrupt('its manifest is not JSON') }
    const out = fs.openSync(to, 'wx', 0o600)
    try {
      open = false
      return { manifest, ...copyFrom(fd, end, out) }
    } finally {
      fs.closeSync(out)
    }
  } finally {
    if (open) fs.closeSync(fd)
  }
}

/** The tables, indexes and triggers a store of this build's format has: an imported file must have exactly these, so no query reads a view or fires a trigger it brought. */
function formatSchema(db: Database.Database): string {
  return canonicalJson(db.prepare("select type, name, tbl_name, sql from sqlite_master where substr(name, 1, 7) <> 'sqlite_' order by type, name").all())
}
let reference: string | undefined
const referenceSchema = (): string => {
  if (reference) return reference
  const db = new Database(':memory:')
  try { db.exec(readSql(`snapshot-format/${FORMAT_VERSION}.sql`)); return (reference = formatSchema(db)) } finally { db.close() }
}

export type ImportResult = { snapshotId: string; commit: string; origin: ImportedSnapshot['origin']; files: number; stale: string[] }

/**
 * Imports a snapshot file into a registered repository with no snapshot yet (FR1081 to FR1083). Every check runs before anything is
 * published; a refusal names its reason and leaves the data directory as it was, apart from evidence objects, which are content-addressed.
 */
export async function importSnapshot(dataDir: string, repositoryIdOrPath: string, file: string, importedBy: string): Promise<ImportResult> {
  const catalog = Catalog.open(dataDir)
  const repo = (() => { try { return catalog.repository(repositoryIdOrPath) } catch (e) { catalog.close(); throw e } })()
  let held: { release(): void } | undefined
  const work = path.join(dataDir, 'staging', `import-${process.pid}-${Date.now()}`)
  try {
    // An index publishing beside the import could be replaced by it; holding the repository's index lock rules that out.
    held = await acquireIndexLock(dataDir, repo.id, repo.name, { wait: false })
    const current = catalog.currentSnapshot(repo.id)
    if (current) throw refuse('has_snapshot', `repository ${repo.name} already has snapshot ${current.id}, and an import never replaces a local snapshot`, { snapshot_id: current.id })
    fs.mkdirSync(work, { recursive: true, mode: 0o700 })
    const store = path.join(work, 'snapshot.db')
    const packed = unpack(file, store)
    const problem = check(SCHEMA, packed.manifest)
    if (problem) throw corrupt(`its manifest ${problem}`)
    const m = packed.manifest as Manifest
    const { manifest_sha256, ...body } = m
    if (sha256(canonicalJson(body)) !== manifest_sha256) throw corrupt('the manifest hash does not match its content')
    if (packed.sha256 !== m.store.sha256 || packed.bytes !== m.store.bytes) throw corrupt('the snapshot bytes do not match the hash in its manifest')
    if (m.snapshot.format_version !== FORMAT_VERSION) throw refuse('format', `the snapshot is of format ${m.snapshot.format_version}, and this build reads ${FORMAT_VERSION}`)

    let meta: Map<string, string>, files: Map<string, string>
    const db = new Database(store, { readonly: true, fileMustExist: true })
    try {
      db.pragma('trusted_schema = OFF')
      db.pragma('query_only = ON')
      const integrity = db.pragma('quick_check', { simple: true })
      if (integrity !== 'ok') throw corrupt(`the snapshot store fails SQLite's check: ${String(integrity)}`)
      if (formatSchema(db) !== referenceSchema()) throw refuse('format', `the snapshot's tables are not those of format ${FORMAT_VERSION}`)
      checkRows(db)
      meta = metaOf(db)
      files = capturedFiles(db)
    } finally {
      db.close()
    }
    const identityJson = meta.get('identity') ?? ''
    let identity: Record<string, unknown> & { adapters?: Adapter[] }
    try { identity = JSON.parse(identityJson) } catch { throw corrupt('the snapshot has no identity') }
    // The id is the hash of the identity, so an identity edited to pass the checks below would no longer name this snapshot.
    if (meta.get('snapshot_id') !== m.snapshot.id || `snap_${sha256(identityJson).slice(0, 24)}` !== m.snapshot.id || sha256(identityJson) !== m.snapshot.identity_hash) throw corrupt('the snapshot id does not match its identity')
    const commit = (JSON.parse(meta.get('git') ?? '{}') as { commit?: string }).commit
    const matches = meta.get('format_version') === FORMAT_VERSION && identity.analysis_mode === m.snapshot.analysis_mode && meta.get('analysis_mode') === m.snapshot.analysis_mode && commit === m.commit
      && canonicalJson(adaptersOf(identity)) === canonicalJson(m.adapters) && canonicalJson(Object.fromEntries(files)) === canonicalJson(m.files)
    if (!matches) throw corrupt('the manifest does not match the snapshot it carries')
    const versions = Object.entries(analysisVersions()).filter(([k, v]) => identity[k] !== v).map(([k, v]) => `${k} ${String(identity[k])} where this build has ${v}`)
    if (versions.length) throw refuse('analysis_version', `the snapshot was built by another version of proofmesh (${versions.join('; ')})`)

    const head = gitInfo(repo.root).commit
    if (head !== m.commit) throw refuse('commit', `the snapshot is of commit ${m.commit}, and ${repo.root} is ${head ? `at commit ${head}` : 'not a git working tree with a commit'}`, { snapshot_commit: m.commit, local_commit: head ?? null })
    // NFR004: an adapter's facts are trusted only from the same adapter code; an adapter missing here could not index the clone either.
    const registry = registryFor(dataDir, repo.id)
    const differ = m.adapters.flatMap((a) => {
      const spec = registry.specs.find((s) => s.id === a.id)
      const entry = spec?.entry()
      const here = spec ? (spec.sha256 ?? (entry ? sha256File(entry) : undefined)) : undefined
      return here === a.entry_sha256 ? [] : [`${a.id} ${a.version} (${here ? 'its code differs from the one installed here' : 'not installed here'})`]
    })
    if (differ.length) throw refuse('adapter', `the snapshot was built by adapters that differ from those here: ${differ.join('; ')}`, { adapters: differ })

    // Every file the snapshot read is compared with the working tree; those that differ are published stale, never trusted.
    const tree = workingTree(repo.root, registry)
    // File by file, not by the identity's manifest hash: the file table is what answers name, and it is not part of the identity.
    const stale = new Set(changes(files, tree.hashes).map((c) => c.path))
    // Evidence comes from this clone's own bytes, read only for paths discovery found here, so no path named in the file is ever opened.
    // Not fsynced one by one, which took 5 s for 505 files on macOS: an object lost to a crash reads as unavailable or failed, never as other text,
    // and the next index writes it again from the working tree.
    const objects = new EvidenceStore(dataDir)
    for (const [p, hash] of tree.hashes) {
      if (stale.has(p) || files.get(p) !== hash) continue
      if (objects.put(fs.readFileSync(path.join(repo.root, p)), false) !== hash) stale.add(p)
    }
    const target = sealedPath(dataDir, m.snapshot.id)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    try { fs.copyFileSync(store, target, fs.constants.COPYFILE_EXCL) } catch { throw refuse('already_present', `snapshot ${m.snapshot.id} is already in this data directory`) }
    fs.chmodSync(target, 0o444)
    fsyncPath(target)
    try {
      catalog.publishImported({ id: m.snapshot.id, repository_id: repo.id, identity_hash: m.snapshot.identity_hash, store_digest: m.store.sha256, analysis_mode: m.snapshot.analysis_mode }, { origin: m.origin, imported_by: importedBy, stale: [...stale].sort() })
    } catch (e) {
      fs.rmSync(target, { force: true })
      throw e
    }
    return { snapshotId: m.snapshot.id, commit: m.commit, origin: m.origin, files: files.size, stale: [...stale].sort() }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    held?.release()
    catalog.close()
  }
}
