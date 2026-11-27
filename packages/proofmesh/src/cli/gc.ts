// Retention and garbage collection (FR051): retire published snapshots beyond the newest N per repository, except the current one,
// pinned ones and members of a recorded link file; then delete evidence objects no remaining snapshot references. Never while an
// index lease is live. Query records and session trails older than --records-days go too (#114).
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ProofmeshError } from '../core/errors.js'
import { Catalog } from '../meshstore/catalog.js'
import { takeGcLock } from '../meshstore/index-lock.js'
import { sealedPath } from '../meshstore/snapshot.js'
import { EvidenceStore } from '../evidence/store.js'

export type GcPlan = { retire: Array<{ id: string; repository_id: string; published_at: string | null }>; keep: number; objects: string[] }

export function plan(catalog: Catalog, keep: number): GcPlan {
  const holder = catalog.leaseHolder()
  if (holder) throw new ProofmeshError('INVALID_ARGUMENT', `an index job (${holder.owner}) holds an index lock since ${holder.started_at}; run gc when it is done`)
  const protectedIds = new Set([...catalog.currentSnapshotIds(), ...catalog.linkedSnapshotIds()])
  const retire: GcPlan['retire'] = []
  for (const repo of catalog.repositories()) {
    // The newest N count the current one; beyond them, only pinned and linked snapshots stay.
    for (const s of catalog.publishedSnapshots(repo.id).slice(keep).filter((s) => !protectedIds.has(s.id) && !s.pinned)) retire.push({ id: s.id, repository_id: repo.id, published_at: s.published_at })
  }
  const retiring = new Set(retire.map((r) => r.id))
  const referenced = new Set<string>()
  for (const repo of catalog.repositories()) {
    for (const s of catalog.publishedSnapshots(repo.id)) {
      if (retiring.has(s.id)) continue
      const file = sealedPath(catalog.dataDir, s.id)
      if (!fs.existsSync(file)) continue
      const db = new Database(file, { readonly: true })
      try {
        for (const r of db.prepare('select distinct object_hash h from evidence union select distinct content_hash h from file where content_hash is not null').all() as Array<{ h: string }>) referenced.add(r.h)
      } finally {
        db.close()
      }
    }
  }
  const objects: string[] = []
  const root = path.join(catalog.dataDir, 'objects', 'sha256')
  if (fs.existsSync(root)) for (const a of fs.readdirSync(root)) for (const b of fs.readdirSync(path.join(root, a))) for (const h of fs.readdirSync(path.join(root, a, b))) if (!referenced.has(h)) objects.push(h)
  return { retire, keep, objects: objects.sort() }
}

export function apply(catalog: Catalog, p: GcPlan): void {
  const store = new EvidenceStore(catalog.dataDir)
  for (const s of p.retire) {
    catalog.retire(s.id)
    fs.rmSync(sealedPath(catalog.dataDir, s.id), { force: true })
  }
  for (const h of p.objects) fs.rmSync(store.objectPath(h), { force: true })
}

export function runGc(dataDir: string, rest: string[], take: (args: string[], flag: string) => string | undefined, has: (args: string[], flag: string) => boolean): number {
  const opts = [...rest]
  const keep = Number(take(opts, '--keep') ?? 3), days = Number(take(opts, '--records-days') ?? 30), dryRun = has(opts, '--dry-run')
  if (!(keep >= 1)) throw new ProofmeshError('INVALID_ARGUMENT', '--keep takes the number of newest published snapshots to keep per repository, at least 1')
  if (!(days >= 0)) throw new ProofmeshError('INVALID_ARGUMENT', '--records-days takes the number of days query records and session trails are kept, 0 or more')
  // Held until gc ends: an index that starts meanwhile waits for it, so it cannot create evidence gc then deletes.
  const gcLock = takeGcLock(dataDir)
  const catalog = Catalog.open(dataDir)
  try {
    const p = plan(catalog, keep)
    for (const s of p.retire) console.log(`${dryRun ? 'would retire' : 'retire'} ${s.id} (${catalog.repository(s.repository_id).name}, published ${s.published_at})`)
    console.log(`${dryRun ? 'would delete' : 'delete'} ${p.objects.length} unreferenced evidence objects`)
    if (!dryRun) apply(catalog, p)
    // Query records and session trails (#114) share one retention, counted from when they were recorded.
    const before = new Date(Date.now() - days * 86_400_000).toISOString()
    const n = catalog.expireRecords(before, dryRun)
    console.log(`${dryRun ? 'would delete' : 'delete'} ${n.queries} query records and ${n.trail} trail entries recorded more than ${days} days ago`)
    console.log(`${dryRun ? 'dry run: ' : ''}keeping the newest ${keep} published snapshots per repository, plus current, pinned and linked ones`)
    return 0
  } finally {
    catalog.close()
    gcLock.release()
  }
}
