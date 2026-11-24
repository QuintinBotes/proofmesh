import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { cli, fixtureRepo, tmpDir } from './helpers.js'

const index = (d: string, repo: string, env: Record<string, string> = {}) => cli(['--data-dir', d, 'index', repo], { PROOFMESH_INDEX_BATCH: '1', ...env })
const fresh = (repo: string) => {
  const d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  return d
}
const dump = (d: string, id: string) => cli(['--data-dir', d, 'debug', 'dump', '--normalized', id]).stdout

describe('FR007 an interrupted index resumes from its last checkpoint', () => {
  for (const fixture of ['ts-invoicing', 'cs-orders']) {
    it(`${fixture}: a crash after the first batch resumes the rest and seals exactly what a clean index seals`, () => {
      const repo = fixtureRepo(fixture)
      const clean = fresh(repo)
      const cleanRun = index(clean, repo)
      expect(cleanRun.status).toBe(0)
      const id = /snapshot (snap_\w+) published/.exec(cleanRun.stdout)![1]!

      const d = fresh(repo)
      const crashed = index(d, repo, { PROOFMESH_FAULT_POINT: 'after_batch' })
      expect(crashed.status).toBe(70)
      expect(fs.existsSync(path.join(d, 'staging', id, 'snapshot.db'))).toBe(true)
      const resumed = index(d, repo)
      expect(resumed.status).toBe(0)
      expect(resumed.stdout).toContain(`snapshot ${id} published`)
      expect(resumed.stdout).toMatch(/resumed from checkpoint: 1 of \d+ batches were already done/)
      expect(dump(d, id)).toBe(dump(clean, id))
      expect(fs.existsSync(path.join(d, 'staging', id))).toBe(false)
    }, 300000)
  }

  it('a checkpoint written by a different build of the writer is not resumed', () => {
    const repo = fixtureRepo('ts-invoicing')
    const d = fresh(repo)
    expect(index(d, repo, { PROOFMESH_FAULT_POINT: 'after_batch' }).status).toBe(70)
    const staging = fs.readdirSync(path.join(d, 'staging')).find((n) => n.startsWith('snap_'))!
    const db = new Database(path.join(d, 'staging', staging, 'snapshot.db'))
    db.prepare("update resume_meta set value = 'other' where key = 'writer'").run()
    db.close()
    const rerun = index(d, repo)
    expect(rerun.status).toBe(0)
    expect(rerun.stdout).not.toContain('resumed from checkpoint')
  }, 300000)
})
