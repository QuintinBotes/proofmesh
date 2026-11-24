// A link file in format 0.1 written from literal rows, so tools that read link files are tested without the builder.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256, sha256File } from '../src/core/hash.js'
import { readSql } from '../src/core/schemas.js'
import { Catalog, type LinkFileRecord } from '../src/meshstore/catalog.js'

export type LinkInput = { type: string; rule: string; source: [string, string]; target?: [string, string | null]; confidence: number; resolution: 'resolved' | 'candidate' | 'unresolved'; reason?: string; candidates?: Array<[string, string | null, number]> }

export function writeLinkFile(dataDir: string, workspace: string, members: Array<{ repository_id: string; snapshot_id: string; name: string }>, links: LinkInput[], rules: Record<string, string> = { http_route: '1' }): LinkFileRecord {
  const identity = canonicalJson({ members: members.map(({ repository_id, snapshot_id }) => ({ repository_id, snapshot_id })), rules })
  const id = `link_${sha256(identity).slice(0, 24)}`
  const file = path.join(dataDir, 'links', `${id}.db`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.rmSync(file, { force: true })
  const db = new Database(file)
  db.exec(readSql('link-format/0.1.sql'))
  const sealedAt = new Date().toISOString()
  for (const [k, v] of Object.entries({ format_version: '0.1', link_file_id: id, workspace, identity, rules: JSON.stringify(rules), sealed_at: sealedAt })) db.prepare('insert into meta (key, value) values (?, ?)').run(k, v)
  for (const m of members) db.prepare('insert into member (repository_id, snapshot_id, name) values (?, ?, ?)').run(m.repository_id, m.snapshot_id, m.name)
  links.forEach((l, i) => {
    const linkId = `lk_${String(i).padStart(4, '0')}`
    db.prepare('insert into link (id, type, rule, source_repository_id, source_symbol_id, source_assertion_id, target_repository_id, target_symbol_id, confidence, resolution, reason, detail) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)')
      .run(linkId, l.type, l.rule, l.source[0], l.source[1], `as_${i}`, l.target?.[0] ?? null, l.target?.[1] ?? null, l.confidence, l.resolution, l.reason ?? null)
    for (const [repo, sym, c] of l.candidates ?? []) db.prepare('insert into link_candidate (link_id, target_repository_id, target_symbol_id, confidence) values (?, ?, ?, ?)').run(linkId, repo, sym, c)
  })
  db.close()
  fs.chmodSync(file, 0o444)
  const catalog = Catalog.open(dataDir)
  try {
    catalog.recordLinkFile({ id, workspace, digest: sha256File(file), members: members.map(({ repository_id, snapshot_id }) => ({ repository_id, snapshot_id })) })
    return catalog.linkFile(id)!
  } finally {
    catalog.close()
  }
}
