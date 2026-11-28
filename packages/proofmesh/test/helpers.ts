import { execFileSync, spawnSync } from 'node:child_process'
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

/** A private copy of the fixture's tracked input files, excluding local restore and build output. */
export function copyTrackedFixture(name: string): string {
  const root = fixtureRepo(name)
  const copy = tmpDir('pm-fixture-')
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '.'], { encoding: 'utf8' })
  for (const file of files.split('\0').filter(Boolean)) {
    const dest = path.join(copy, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(root, file), dest)
  }
  return copy
}

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

export type Row = { type: string; from: string; to: string | null; resolution: string; reason: string | null; origin: string; detail: Record<string, string> | null; line: number; path: string; candidates: string[] }
/** Every assertion of the given types, with the line and file where it is declared. */
export function rows(db: Database.Database, ...types: string[]): Row[] {
  const marks = types.map(() => '?').join(', ')
  const found = db.prepare(`select a.id, a.type, a.origin, a.resolution, a.reason, a.detail, s.qualified_name as src, t.qualified_name as dst, x.module as xm, x.name as xn from assertion a join symbol s on s.id = a.source_id left join symbol t on t.id = a.target_id and a.target_kind = 'symbol' left join external_symbol x on x.id = a.target_id and a.target_kind = 'external' where a.type in (${marks})`).all(...types) as Array<{ id: string; type: string; origin: string; resolution: string; reason: string | null; detail: string | null; src: string; dst: string | null; xm: string | null; xn: string | null }>
  return found.map((r) => {
    const ev = db.prepare('select e.start_line, f.path from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ?').get(r.id) as { start_line: number; path: string }
    const candidates = (db.prepare('select s.qualified_name || \'@\' || f.path as n from assertion_candidate c join symbol s on s.id = c.symbol_id join file f on f.id = s.file_id where c.assertion_id = ? order by c.rank').all(r.id) as Array<{ n: string }>).map((c) => c.n)
    return { type: r.type, from: r.src, to: r.xm ? `${r.xm}:${r.xn}` : r.dst, resolution: r.resolution, reason: r.reason, origin: r.origin, detail: r.detail ? JSON.parse(r.detail) : null, line: ev.start_line, path: ev.path, candidates }
  }).sort((a, b) => a.from.localeCompare(b.from) || String(a.to).localeCompare(String(b.to)) || a.line - b.line)
}

/** A throwaway repository, indexed through the same path as a fixture. */
export async function indexedRepo(files: Record<string, string>) {
  const repo = tmpDir('pm-bg-')
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text) }
  return { repo, ...(await indexedDataDir(repo)) }
}
export const json = (o: unknown) => JSON.stringify(o, null, 2) + '\n'

