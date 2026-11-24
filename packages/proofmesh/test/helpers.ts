import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { openSnapshot } from '../src/meshstore/snapshot.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { runTool } from '../src/query/tools.js'
import type { Envelope } from '../src/core/generated.js'

export const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
export const fixtureRepo = (name: string) => path.join(ROOT, 'fixtures', name, 'repo')
export const expectedFor = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', name, 'expected.json'), 'utf8'))
export const FIXTURE = fixtureRepo('ts-invoicing')
export const EXPECTED = expectedFor('ts-invoicing')
export const CLI = path.join(ROOT, 'packages', 'proofmesh', 'bin', 'proofmesh.mjs')

export const tmpDir = (prefix = 'pm-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

export function copyFixture(): string {
  const dir = tmpDir('pm-repo-')
  fs.cpSync(FIXTURE, dir, { recursive: true })
  return dir
}

export async function indexedDataDir(repo = FIXTURE): Promise<{ dataDir: string; snapshotId: string; repoId: string }> {
  const dataDir = tmpDir()
  initDataDir(dataDir)
  const catalog = Catalog.open(dataDir)
  const repoId = catalog.addRepository(repo).id
  catalog.close()
  const r = await indexRepository(dataDir, repoId)
  return { dataDir, snapshotId: r.snapshotId, repoId }
}

export function withSnapshot<T>(dataDir: string, fn: (db: Database.Database) => T): T {
  const catalog = Catalog.open(dataDir)
  try {
    const repo = catalog.repositories()[0]!
    const db = openSnapshot(catalog, catalog.currentSnapshot(repo.id)!)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } finally {
    catalog.close()
  }
}

export function evidenceSlice(dataDir: string, db: Database.Database, evidenceId: string): string {
  const e = db.prepare('select object_hash, start_byte, end_byte from evidence where id = ?').get(evidenceId) as { object_hash: string; start_byte: number; end_byte: number }
  const content = fs.readFileSync(path.join(dataDir, 'objects', 'sha256', e.object_hash.slice(0, 2), e.object_hash.slice(2, 4), e.object_hash))
  return content.subarray(e.start_byte, e.end_byte).toString('utf8')
}

export const tool = (dataDir: string, name: string, input: Record<string, unknown> = {}): Envelope => runTool(dataDir, name, input)

export function symbolId(dataDir: string, qualifiedName: string): string {
  const env = tool(dataDir, 'find_symbols', { text: qualifiedName.split(':').pop()! })
  const hit = (env.data.symbols as Array<{ id: string; qualified_name: string }>).find((s) => s.qualified_name === qualifiedName)
  if (!hit) throw new Error(`symbol ${qualifiedName} not found`)
  return hit.id
}

export function cli(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
