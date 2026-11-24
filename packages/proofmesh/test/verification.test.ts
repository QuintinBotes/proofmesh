import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cli, fixtureRepo, ROOT, tmpDir, tool } from './helpers.js'

type V = { id: string; state: string; binding: { recipe: { command: string[] } }; record: { record: { exit_code: number | null; truncated: boolean; timed_out: boolean; sandbox: string } } | null; record_valid: boolean | null; error: string | null }

function ready(enabled = true) {
  const d = tmpDir(), repo = tmpDir('pm-vr-')
  fs.cpSync(fixtureRepo('ts-invoicing'), repo, { recursive: true })
  for (const args of [['init'], ['repo', 'add', repo], ['index', repo], ...(enabled ? [['verification', 'enable']] : [])]) expect(cli(['--data-dir', d, ...args]).status, args.join(' ')).toBe(0)
  return { d, repo }
}
const prepare = (d: string, input: Record<string, unknown>) => (tool(d, 'prepare_verification', input).data as { verification: V }).verification
const get = (d: string, id: string) => tool(d, 'get_verification', { verification_id: id }).data as { verification: V; output: string | null }
const approve = (d: string, id: string) => cli(['--data-dir', d, 'verification', 'approve', id])
const run = (d: string, id: string) => cli(['--data-dir', d, 'verification', 'run', id])

describe('FR042 FR043 FR044 FR045 FR046 FR047 FR048 verification execution: prepared by agents, approved and run once by a person, off by default', () => {
  it('FR042 is disabled by default: the tools refuse until a person enables it', () => {
    const { d } = ready(false)
    expect(() => prepare(d, { command: ['true'] })).toThrow(/disabled/)
    expect(cli(['--data-dir', d, 'verification', 'enable']).status).toBe(0)
    expect(prepare(d, { command: ['true'] }).state).toBe('prepared')
    expect(cli(['--data-dir', d, 'verification', 'disable']).status).toBe(0)
    expect(() => prepare(d, { command: ['true'] })).toThrow(/disabled/)
  })

  it('FR043 FR044 prepares a binding without running, and nothing runs until a person approves', () => {
    const { d } = ready()
    const v = prepare(d, { command: ['sh', '-c', 'echo ran > marker'], cwd: 'packages/api', env_allow: ['HOME'], timeout_s: 5 })
    expect(v.binding).toMatchObject({ snapshot_id: expect.stringMatching(/^snap_/), recipe: { command: ['sh', '-c', 'echo ran > marker'], cwd: 'packages/api', env_allow: ['HOME'], network: 'none', timeout_s: 5 }, toolchain: { node: process.version }, expires_at: expect.any(String) })
    expect(fs.existsSync(path.join(d, 'verification'))).toBe(false)
    const r = run(d, v.id)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/APPROVAL_REQUIRED/)
    expect(get(d, v.id).verification.state).toBe('prepared')
  })

  it('FR045 FR046 FR047 an approved recipe runs once in a disposable copy, leaves a signed record, and never runs again', () => {
    const { d, repo } = ready()
    const v = prepare(d, { command: ['sh', '-c', 'echo changed >> packages/format/src/currency.ts && ls packages && echo "$SECRET_X${HOME:+home}"'], env_allow: ['HOME'], timeout_s: 10 })
    expect(approve(d, v.id).stdout).toMatch(/^approved vr_\w+ by \S+ until .*; it runs once/)
    const r = run(d, v.id, )
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/finished: exit 0; sandbox process/)
    const after = get(d, v.id)
    expect(after.verification).toMatchObject({ state: 'finished', record_valid: true, record: { record: { exit_code: 0, truncated: false, timed_out: false, sandbox: 'process' } } })
    expect(after.output).toBe('api\nbilling\nformat\nlegacy\nhome\n')
    // The copy is gone, the repository is untouched, and only the allowlisted variable passed.
    expect(fs.existsSync(path.join(d, 'verification', v.id, 'work'))).toBe(false)
    expect(fs.readFileSync(path.join(repo, 'packages/format/src/currency.ts'), 'utf8')).not.toContain('changed')
    const again = run(d, v.id)
    expect(again.status).not.toBe(0)
    expect(again.stderr).toMatch(/APPROVAL_INVALID/)
    expect(approve(d, v.id).status).not.toBe(0)
  })

  it('FR045 an expired approval is refused, and a tampered record fails verification', async () => {
    const { d } = ready()
    const v = prepare(d, { command: ['true'], expires_in_s: 1 })
    await new Promise((r) => setTimeout(r, 1200))
    expect(approve(d, v.id).stderr).toMatch(/APPROVAL_INVALID/)
    expect(get(d, v.id).verification.state).toBe('expired')

    const w = prepare(d, { command: ['true'] })
    approve(d, w.id); expect(run(d, w.id).status).toBe(0)
    const db = new Database(path.join(d, 'catalog.db'))
    const stored = JSON.parse((db.prepare('select record from verification where id = ?').get(w.id) as { record: string }).record)
    stored.record.exit_code = 1
    db.prepare('update verification set record = ? where id = ?').run(JSON.stringify(stored), w.id); db.close()
    expect(get(d, w.id).verification.record_valid).toBe(false)
  })

  it('FR046 limits hold: output is capped and a run that overstays its time is killed and marked failed', () => {
    const { d } = ready()
    const big = prepare(d, { command: ['sh', '-c', 'yes | head -c 300000'], max_output_kb: 1 })
    approve(d, big.id); expect(run(d, big.id).stdout).toMatch(/output truncated/)
    expect(get(d, big.id).output!.length).toBe(1024)
    const slow = prepare(d, { command: ['sleep', '30'], timeout_s: 1 })
    approve(d, slow.id)
    const r = run(d, slow.id)
    expect(r.status).toBe(1)
    expect(get(d, slow.id).verification).toMatchObject({ state: 'failed', error: 'timed out after 1 s', record: { record: { timed_out: true, exit_code: null } } })
  })

  it('FR048 the query and MCP layers never import the launcher', () => {
    const offenders: string[] = []
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts') && /verification\/launcher/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(ROOT, p)) } }
    for (const dir of ['mcp', 'query', 'http', 'indexer']) walk(path.join(ROOT, 'packages/proofmesh/src', dir))
    expect(offenders).toEqual([])
    expect(fs.readFileSync(path.join(ROOT, 'packages/proofmesh/src/cli/verification.ts'), 'utf8')).toContain("verification/launcher.js'")
  })
})
