import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { ProofmeshError } from '../core/errors.js'
import type { Catalog } from '../meshstore/catalog.js'

export const invalid = (message: string): never => { throw new ProofmeshError('INVALID_ARGUMENT', message) }

/** Read from a regular, bounded file. An imported file never supplies a command or a path to follow. */
export function readArtifact(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return invalid('Expected a regular producer artifact of at most 8 MiB.')
    const bytes = Buffer.alloc(stat.size)
    let at = 0
    while (at < bytes.length) {
      const n = fs.readSync(fd, bytes, at, bytes.length - at, null)
      if (!n) return invalid('Artifact changed during import.')
      at += n
    }
    return bytes.toString('utf8')
  } finally { fs.closeSync(fd) }
}

export type Identity = { revision: string; producer: string; name: string }
export function validateIdentity(db: Database.Database, identity: Identity) {
  if (![identity.producer, identity.name].every((v) => typeof v === 'string' && v.trim().length && v.length <= 200)) invalid('Supply a producer and a configuration or mapping name of 1–200 characters.')
  const commit = db.prepare("select json_extract(value, '$.commit') from meta where key = 'git'").pluck().get()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identity.revision) || commit !== identity.revision) invalid('Artifact revision differs from the indexed commit.')
}

export function saveArtifact(catalog: Catalog, repository: string, snapshot: string, kind: 'cquery' | 'generates', id: Identity, evidence: unknown) {
  catalog.db.prepare('insert into producer_import(repository_id,kind,name,snapshot_id,revision,producer,evidence) values (?,?,?,?,?,?,?) on conflict(repository_id,kind,name,snapshot_id) do update set revision=excluded.revision, producer=excluded.producer,evidence=excluded.evidence')
    .run(repository, kind, id.name, snapshot, id.revision, id.producer, JSON.stringify(evidence))
}
