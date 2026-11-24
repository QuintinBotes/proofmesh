import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { sha256File } from '../core/hash.js'
import { ProofmeshError } from '../core/errors.js'
import { readSql } from '../core/schemas.js'
import type { Catalog, SnapshotRow } from './catalog.js'

export const FORMAT_VERSION = '0.6'

export const stagingDir = (dataDir: string, snapshotId: string) => path.join(dataDir, 'staging', snapshotId)
export const sealedPath = (dataDir: string, snapshotId: string) => path.join(dataDir, 'snapshots', `${snapshotId}.db`)

export function createStagingStore(file: string): Database.Database {
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = openStagingStore(file)
  db.exec(readSql(`snapshot-format/${FORMAT_VERSION}.sql`))
  return db
}

/** A staging file survives a crash of the indexing process with every committed batch intact, so an interrupted run can resume it. */
export function openStagingStore(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = OFF')
  return db
}

function fsyncPath(p: string): void {
  const fd = fs.openSync(p, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function faultPoint(name: string): void {
  if (process.env.PROOFMESH_FAULT_POINT === name) {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'fault injected', point: name }) + '\n')
    process.exit(70)
  }
}

/** Seal a validated staging file and publish it. A crash before the catalog commit leaves the previous pointer in place. */
export function sealAndPublish(catalog: Catalog, db: Database.Database, staging: string, snapshotId: string, repositoryId: string, keepCurrent = false): string {
  db.pragma('journal_mode = DELETE')
  db.close()
  fsyncPath(staging)
  const digest = sha256File(staging)
  fs.chmodSync(staging, 0o444)
  faultPoint('before_rename')
  const target = sealedPath(catalog.dataDir, snapshotId)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(staging, target)
  fsyncPath(path.dirname(target))
  faultPoint('after_rename')
  catalog.publish(snapshotId, repositoryId, digest, keepCurrent)
  return digest
}

const verified = new Set<string>()

/** Open a published snapshot read only; the digest is verified the first time this process opens it. */
export function openSnapshot(catalog: Catalog, snapshot: SnapshotRow): Database.Database {
  if (snapshot.state !== 'published' || !snapshot.store_digest) {
    throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `snapshot ${snapshot.id} is not published`, { detail: 'not_published' })
  }
  const file = sealedPath(catalog.dataDir, snapshot.id)
  if (!fs.existsSync(file)) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `snapshot ${snapshot.id} is missing from the data directory`, { detail: 'missing' })
  if (!verified.has(snapshot.id)) {
    if (sha256File(file) !== snapshot.store_digest) {
      throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `snapshot ${snapshot.id} does not match its recorded digest`, { detail: 'digest_mismatch' })
    }
    verified.add(snapshot.id)
  }
  const db = new Database(file, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

/** Every regular table as JSON lines, tables by name and rows by primary key, without `meta`. */
export function normalizedDump(db: Database.Database): string {
  const tables = (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'symbol_fts%' and name <> 'meta' order by name").all() as Array<{ name: string }>).map((t) => t.name)
  const lines: string[] = []
  for (const table of tables) {
    const cols = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string; pk: number }>
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
    const order = (pk.length ? pk : cols.map((c) => c.name)).map((c) => `"${c}"`).join(', ')
    for (const row of db.prepare(`select * from "${table}" order by ${order}`).iterate()) lines.push(JSON.stringify({ table, row }))
  }
  const fts = db.prepare('select symbol_id, name, qualified_name from symbol_fts order by symbol_id').all()
  for (const row of fts) lines.push(JSON.stringify({ table: 'symbol_fts', row }))
  return lines.join('\n') + '\n'
}
