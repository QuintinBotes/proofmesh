import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { ProofmeshError } from '../src/core/errors.js'
import { cli, copyFixture, tmpDir, tool } from './helpers.js'

const refusal = (fn: () => unknown): ProofmeshError => {
  try { fn() } catch (e) { return e as ProofmeshError }
  throw new Error('expected a refusal')
}
const poll = async (d: string, id: string) => {
  for (let i = 0; i < 240; i++) {
    const job = (tool(d, 'get_job', { job_id: id }).data as any).job
    if (job.state !== 'queued' && job.state !== 'running') return job
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('job did not finish')
}

describe('FR012 US4 strict freshness answers from the working tree or refuses', () => {
  let d: string, repo: string
  beforeAll(() => {
    d = tmpDir(); repo = copyFixture()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  }, 240000)

  it('an unchanged tree answers as current, with its boundary; the default stays as of the snapshot', () => {
    const strict = tool(d, 'find_symbols', { text: 'invoiceTotal', freshness: 'strict' }) as any
    expect(strict.freshness).toMatchObject({ mode: 'strict', status: 'current', boundary: 'Repository files as discovered now; packages and other external inputs as recorded when the snapshot was built.' })
    expect(Date.parse(strict.freshness.checked_at)).toBeGreaterThan(Date.now() - 60000)
    expect((tool(d, 'find_symbols', { text: 'invoiceTotal' }) as any).freshness).toEqual({ mode: 'snapshot', status: 'as_of_snapshot' })
  })

  it('strict freshness cannot be combined with a pinned snapshot', () => {
    const snapshot = (tool(d, 'workspace_status', { limits: { max_rows: 1 } }) as any).snapshot.id
    expect(refusal(() => tool(d, 'find_symbols', { text: 'x', freshness: 'strict', snapshot_id: snapshot }))).toMatchObject({ code: 'INVALID_ARGUMENT', details: { detail: 'strict_with_pinned_snapshot' } })
  })

  it('an edit, a deletion, and a new file refuse with STALE_INPUT naming them, start an index, and are current once it publishes', async () => {
    const before = (tool(d, 'workspace_status', { limits: { max_rows: 1 } }) as any).snapshot.id
    fs.appendFileSync(path.join(repo, 'packages/format/src/currency.ts'), '\nexport const FRESH = 1\n')
    fs.rmSync(path.join(repo, 'packages/api/src/handler.ts'))
    fs.writeFileSync(path.join(repo, 'packages/format/src/extra.ts'), 'export const extra = 2\n')
    const e = refusal(() => tool(d, 'find_symbols', { text: 'FRESH', freshness: 'strict' }))
    expect(e.code).toBe('STALE_INPUT')
    expect(e.details).toMatchObject({
      detail: 'working_tree_changed', snapshot_id: before, changed_count: 3,
      changed: [
        { path: 'packages/api/src/handler.ts', change: 'deleted' },
        { path: 'packages/format/src/currency.ts', change: 'modified' },
        { path: 'packages/format/src/extra.ts', change: 'added' },
      ],
    })
    const job = await poll(d, e.details.job_id as string)
    expect(job.state).toBe('succeeded')
    const fresh = tool(d, 'find_symbols', { text: 'FRESH', freshness: 'strict' }) as any
    expect(fresh.freshness.status).toBe('current')
    expect(fresh.snapshot.id).not.toBe(before)
    expect(fresh.data.symbols.map((s: any) => s.name)).toContain('FRESH')
  }, 240000)
})

describe('A21 build output and ignored files are not snapshot identity', () => {
  let d: string, repo: string
  beforeAll(() => {
    d = tmpDir(); repo = copyFixture()
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0)
    fs.writeFileSync(path.join(repo, '.gitignore'), 'scratch/\n')
    // FR295: build/ is output only beside a manifest that names it, here a Gradle build file.
    fs.writeFileSync(path.join(repo, 'packages/format/build.gradle'), "plugins { id 'java' }\n")
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  }, 240000)

  it('files appearing under an ignored path or a default excluded directory leave a strict answer current', () => {
    const before = (tool(d, 'workspace_status', { limits: { max_rows: 1 } }) as any).snapshot.id
    fs.mkdirSync(path.join(repo, 'scratch'))
    fs.writeFileSync(path.join(repo, 'scratch', 'graph.json'), '{}\n')
    for (const dir of ['obj', 'bin', 'dist', 'node_modules/left-pad', 'build']) {
      fs.mkdirSync(path.join(repo, 'packages/format', dir), { recursive: true })
      fs.writeFileSync(path.join(repo, 'packages/format', dir, 'out.js'), 'export const generated = 1\n')
    }
    const strict = tool(d, 'find_symbols', { text: 'invoiceTotal', freshness: 'strict' }) as any
    expect(strict.freshness.status).toBe('current')
    expect(strict.snapshot.id).toBe(before)
  })

  it('a strict query while another process indexes names that index and starts no job', () => {
    fs.appendFileSync(path.join(repo, 'packages/format/src/currency.ts'), '\nexport const LEASED = 1\n')
    const owner = `pid:${process.ppid}@${os.hostname()}`
    const catalog = new Database(path.join(d, 'catalog.db'))
    const repoId = (catalog.prepare('select id from repository').get() as { id: string }).id
    const lock = path.join(d, 'locks', `index-${repoId}.lock`)
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), started_at: new Date().toISOString() }))
    const jobs = () => catalog.prepare('select count(*) as n from index_job').get()
    const before = jobs()
    try {
      const e = refusal(() => tool(d, 'find_symbols', { text: 'LEASED', freshness: 'strict' }))
      expect(e.code).toBe('STALE_INPUT')
      expect(e.message).toContain(`index already running in ${owner}`)
      expect(e.details).toMatchObject({ detail: 'working_tree_changed', changed_count: 1, changed: [{ path: 'packages/format/src/currency.ts', change: 'modified' }], indexing_by: owner })
      expect(e.details).not.toHaveProperty('job_id')
      expect(jobs()).toEqual(before)
    } finally {
      fs.rmSync(lock, { force: true })
      catalog.close()
    }
  })
})

describe('FR013 a file edited during indexing keeps the snapshot from publishing', () => {
  it('names exactly the captured files whose content changed or vanished since capture', async () => {
    const { unstable } = await import('../src/indexer/freshness.js')
    const { sha256 } = await import('../src/core/hash.js')
    const root = tmpDir()
    for (const f of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(root, f), `export const ${f[0]} = 1\n`)
    const captured = ['a.ts', 'b.ts', 'c.ts'].map((p) => ({ path: p, hash: sha256(fs.readFileSync(path.join(root, p))) }))
    expect(unstable(root, captured)).toEqual([])
    fs.appendFileSync(path.join(root, 'b.ts'), '// edited\n')
    fs.rmSync(path.join(root, 'c.ts'))
    expect(unstable(root, captured)).toEqual(['b.ts', 'c.ts'])
  })
})
