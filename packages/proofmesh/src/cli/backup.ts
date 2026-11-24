// Backup and restore (FR050): the catalog through SQLite's online backup, so it is consistent while the service runs, plus every
// sealed file, link file, evidence object and token, each hashed in a manifest the restore verifies.
import fs from 'node:fs'
import path from 'node:path'
import { ProofmeshError } from '../core/errors.js'
import { sha256File } from '../core/hash.js'
import { Catalog } from '../meshstore/catalog.js'

const SKIP = new Set(['staging', 'catalog.db', 'catalog.db-wal', 'catalog.db-shm'])

function walk(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (!rel && SKIP.has(e.name)) return []
    if (r === 'objects/tmp') return []
    return e.isDirectory() ? walk(dir, r) : [r]
  })
}

export async function backup(dataDir: string, out: string): Promise<{ files: number }> {
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new ProofmeshError('INVALID_ARGUMENT', `${out} is not empty`)
  fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  const catalog = Catalog.open(dataDir)
  try {
    await catalog.db.backup(path.join(out, 'catalog.db'))
  } finally {
    catalog.close()
  }
  const files = ['catalog.db']
  for (const rel of walk(dataDir)) {
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true })
    fs.copyFileSync(path.join(dataDir, rel), path.join(out, rel))
    files.push(rel)
  }
  const manifest = { schema_version: '0.1', created_at: new Date().toISOString(), files: Object.fromEntries(files.sort().map((f) => [f, sha256File(path.join(out, f))])) }
  fs.writeFileSync(path.join(out, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { files: files.length }
}

export function restore(from: string, into: string): { files: number } {
  const manifestFile = path.join(from, 'backup-manifest.json')
  if (!fs.existsSync(manifestFile)) throw new ProofmeshError('INVALID_ARGUMENT', `${from} has no backup-manifest.json`)
  if (fs.existsSync(into) && fs.readdirSync(into).length) throw new ProofmeshError('INVALID_ARGUMENT', `${into} is not empty; restore only into an empty directory`)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { files: Record<string, string> }
  for (const [rel, hash] of Object.entries(manifest.files)) {
    if (!fs.existsSync(path.join(from, rel)) || sha256File(path.join(from, rel)) !== hash) throw new ProofmeshError('INVALID_ARGUMENT', `${rel} is missing from the backup or does not match its hash; nothing restored`)
  }
  fs.mkdirSync(into, { recursive: true, mode: 0o700 })
  fs.chmodSync(into, 0o700)
  for (const rel of Object.keys(manifest.files)) {
    fs.mkdirSync(path.dirname(path.join(into, rel)), { recursive: true, mode: 0o700 })
    fs.copyFileSync(path.join(from, rel), path.join(into, rel))
  }
  for (const sub of ['objects', 'snapshots', 'staging', 'tokens']) fs.mkdirSync(path.join(into, sub), { recursive: true, mode: 0o700 })
  Catalog.open(into).close()
  return { files: Object.keys(manifest.files).length }
}
