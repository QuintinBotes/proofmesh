// The session trail (#114): what a Claude Code session searched, opened, changed and claimed, recorded only for a repository a
// person turned it on for, and the dependents of what it changed that it never opened. The plugin's side runs under claude plugin test.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { CLI, cli, fixtureRepo, indexedDataDir, tmpDir, tool } from './helpers.js'
import { mcpClient } from './mcp-client.js'

const SESSION = '2f6c1d9e-session-one'
const at = (n: number) => new Date(Date.UTC(2026, 10, 27, 10, 0, n)).toISOString()
type Entry = { session_id: string; repository_id: string; agent_id?: string; at: string; kind: string; tool: string; path?: string; symbol_id?: string; outcome: string }

/** `proofmesh trail record` as the plugin runs it: one JSON entry a line on stdin. */
function record(dataDir: string, entries: object[]) {
  const r = spawnSync(process.execPath, [CLI, '--data-dir', dataDir, 'trail', 'record'], { input: entries.map((e) => JSON.stringify(e)).join('\n') + '\n', encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

async function setup() {
  const repo = tmpDir('pm-trail-repo-')
  fs.cpSync(fixtureRepo('ts-invoicing'), repo, { recursive: true })
  const { dataDir, repoId } = await indexedDataDir(repo)
  const formatAmount = (tool(dataDir, 'find_symbols', { text: 'formatAmount' }).data.symbols as Array<{ id: string; path: string }>).find((s) => s.path === 'packages/format/src/currency.ts')!.id
  return { repo, dataDir, repoId, formatAmount }
}

/** Scenario 2's session: Grep, Read, find_symbols, Edit and verify_claim, as the plugin records them. */
const scenario = (repoId: string, claimed: string): Entry[] => [
  { kind: 'searched', tool: 'Grep', path: 'packages/billing' },
  { kind: 'opened', tool: 'Read', path: 'packages/format/src/currency.ts' },
  { kind: 'searched', tool: 'mcp__plugin_proofmesh_proofmesh__find_symbols', path: '.' },
  { kind: 'changed', tool: 'Edit', path: 'packages/format/src/currency.ts' },
  { kind: 'claimed', tool: 'mcp__plugin_proofmesh_proofmesh__verify_claim', symbol_id: claimed },
].map((e, i) => ({ session_id: SESSION, repository_id: repoId, at: at(i), outcome: 'ok', ...e }))

type Dependent = { id: string; name: string; path: string; line: number; depth: number }
type Trail = { session_id: string; recording: boolean; cut: boolean; entries: Array<Entry & { seq: number }>; changed: Array<{ id: string; name: string; path: string; line: number; never_seen: Dependent[]; searched_only: Dependent[] }> }

describe('#114 the session trail: what a session read, and the dependents of its changes it never opened', () => {
  it('FR611 scenario 1: recording is off by default, so trail record stores nothing, and get_session_trail says how to turn it on', async () => {
    const { dataDir, repoId, formatAmount } = await setup()
    const fresh = () => JSON.parse(cli(['--data-dir', dataDir, 'status', repoId, '--fresh', '--json']).stdout) as { trail_recording: boolean }
    expect(fresh().trail_recording).toBe(false)
    const r = record(dataDir, scenario(repoId, formatAmount))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/recorded 0 entries; refused 5: recording is off for/)
    const env = tool(dataDir, 'get_session_trail', { session_id: SESSION })
    expect(env.data).toMatchObject({ recording: false, entries: [], changed: [] })
    expect(env.limitations.join('\n')).toContain(`proofmesh trail on ${repoId}`)

    expect(cli(['--data-dir', dataDir, 'trail', 'on', repoId]).status).toBe(0)
    expect(fresh().trail_recording).toBe(true)
    expect(cli(['--data-dir', dataDir, 'trail', 'off', repoId]).status).toBe(0)
    expect(fresh().trail_recording).toBe(false)
  }, 120000)

  it('FR612 FR613 scenarios 2 and 4, SC-002: get_session_trail returns the five entries in order and the unopened dependents, exactly analyze_impact minus what was opened', async () => {
    const { repo, dataDir, repoId, formatAmount } = await setup()
    expect(cli(['--data-dir', dataDir, 'trail', 'on', repoId]).status).toBe(0)
    expect(record(dataDir, scenario(repoId, formatAmount)).stdout).toMatch(/^recorded 5 entries/)
    // The edit, and a snapshot published after it.
    const file = path.join(repo, 'packages/format/src/currency.ts')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('toFixed(2)', 'toFixed(3)'))
    const indexed = cli(['--data-dir', dataDir, 'index', repoId])
    expect(indexed.status, indexed.stderr).toBe(0)
    const snapshot = /snapshot (snap_\w+) published/.exec(indexed.stdout)![1]!
    const changedId = (tool(dataDir, 'find_symbols', { text: 'formatAmount' }).data.symbols as Array<{ id: string; path: string }>).find((s) => s.path === 'packages/format/src/currency.ts')!.id

    const client = await mcpClient(dataDir, '--tools', 'data')
    try {
      const full = await client.callTool({ name: 'get_session_trail', arguments: { session_id: SESSION, envelope: 'compact' } })
      const env = full.structuredContent as { snapshot: { id: string }; data: Trail; limitations: string[] }
      expect(env.snapshot.id).toBe(snapshot)
      expect(env.data.entries.map((e) => [e.seq, e.kind, e.tool, e.path ?? e.symbol_id, e.outcome, e.at])).toEqual([
        [1, 'searched', 'Grep', 'packages/billing', 'ok', at(0)],
        [2, 'opened', 'Read', 'packages/format/src/currency.ts', 'ok', at(1)],
        [3, 'searched', 'mcp__plugin_proofmesh_proofmesh__find_symbols', '.', 'ok', at(2)],
        [4, 'changed', 'Edit', 'packages/format/src/currency.ts', 'ok', at(3)],
        [5, 'claimed', 'mcp__plugin_proofmesh_proofmesh__verify_claim', formatAmount, 'ok', at(4)],
      ])
      expect(env.data.changed.map((c) => [c.name, c.path, c.line])).toEqual([['formatAmount', 'packages/format/src/currency.ts', 1]])
      const [changed] = env.data.changed
      // invoiceTotal is in packages/billing, which the Grep searched; handleInvoice is nowhere in the trail.
      expect(changed!.searched_only.map((d) => [d.name, d.path, d.line])).toEqual([['invoiceTotal', 'packages/billing/src/invoice.ts', 9]])
      expect(changed!.never_seen.map((d) => [d.name, d.path, d.line])).toEqual([['handleInvoice', 'packages/api/src/handler.ts', 5]])
      // SC-002: the unopened dependents are analyze_impact's dependents less those whose file the session opened.
      const impact = (tool(dataDir, 'analyze_impact', { subject_ids: [changedId] }).data.dependents as Array<{ id: string; path: string }>)
      const opened = new Set(env.data.entries.filter((e) => e.kind === 'opened').map((e) => e.path))
      expect([...changed!.searched_only, ...changed!.never_seen].map((d) => d.id).sort()).toEqual(impact.filter((d) => !opened.has(d.path)).map((d) => d.id).sort())
      expect(env.limitations.length).toBeGreaterThan(0)

      // Over MCP it answers in the lean envelope by default, naming the snapshot it used and its limitations.
      const lean = ((await client.callTool({ name: 'get_session_trail', arguments: { session_id: SESSION } })).content as Array<{ text: string }>)[0]!.text
      expect(lean.split('\n').slice(0, 9)).toEqual([
        `# get_session_trail · 8 rows · ${snapshot} current`,
        '1 searched Grep packages/billing',
        '2 opened Read packages/format/src/currency.ts',
        '3 searched mcp__plugin_proofmesh_proofmesh__find_symbols .',
        '4 changed Edit packages/format/src/currency.ts',
        `5 claimed mcp__plugin_proofmesh_proofmesh__verify_claim ${formatAmount}`,
        'formatAmount packages/format/src/currency.ts:1 changed',
        'handleInvoice packages/api/src/handler.ts:5 never_seen depth=2',
        'invoiceTotal packages/billing/src/invoice.ts:9 searched_only depth=1',
      ])
      expect(lean).toMatch(/\n# /)
    } finally {
      await client.close()
    }
  }, 240000)

  it('FR615: a failed or denied call is kept as attempted and does not count as opened, and a subagent call keeps its agent id', async () => {
    const { dataDir, repoId, formatAmount } = await setup()
    cli(['--data-dir', dataDir, 'trail', 'on', repoId])
    const base = { session_id: SESSION, repository_id: repoId }
    record(dataDir, [
      { ...base, at: at(0), kind: 'changed', tool: 'Edit', path: 'packages/format/src/currency.ts', outcome: 'ok' },
      { ...base, at: at(1), kind: 'opened', tool: 'Read', path: 'packages/api/src/handler.ts', outcome: 'failed' },
      { ...base, agent_id: 'a1b2c3', at: at(2), kind: 'opened', tool: 'Read', path: 'packages/billing/src/invoice.ts', outcome: 'ok' },
    ])
    const data = tool(dataDir, 'get_session_trail', { session_id: SESSION }).data as Trail
    expect(data.entries.map((e) => [e.outcome, e.agent_id ?? null])).toEqual([['ok', null], ['failed', null], ['ok', 'a1b2c3']])
    expect(data.changed[0]!.id).toBe(formatAmount)
    expect(data.changed[0]!.never_seen.map((d) => d.name)).toEqual(['handleInvoice'])
    expect(data.changed[0]!.searched_only).toEqual([])
  }, 120000)

  it('FR612 SC-003: no stored trail row holds more than a path or a symbol id, none holds a line of the fixture, and record refuses anything else', async () => {
    const { repo, dataDir, repoId, formatAmount } = await setup()
    cli(['--data-dir', dataDir, 'trail', 'on', repoId])
    const base = { session_id: SESSION, repository_id: repoId, at: at(0), kind: 'opened', tool: 'Read', outcome: 'ok' }
    // Source text, an absolute path, a path out of the repository and an unknown field are each refused, and the batch with them.
    for (const bad of [{ ...base, path: 'a.ts', content: 'export function formatAmount' }, { ...base, path: path.join(repo, 'packages/format/src/currency.ts') }, { ...base, path: '../outside.ts' }, { ...base, symbol_id: 'return `${(cents / 100).toFixed(2)} ${currency}`;' }, { ...base, kind: 'read', path: 'a.ts' }]) {
      const r = record(dataDir, [scenario(repoId, formatAmount)[0]!, bad])
      expect(r.status, JSON.stringify(bad)).not.toBe(0)
      expect(r.stderr).toMatch(/INVALID_ARGUMENT/)
    }
    expect(record(dataDir, scenario(repoId, formatAmount)).status).toBe(0)
    const c = Catalog.open(dataDir)
    const rows = c.db.prepare('select * from trail_entry').all() as Array<Record<string, unknown>>
    c.close()
    expect(rows).toHaveLength(5)
    const lines = fs.readdirSync(repo, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(repo, f)).isFile())
      .flatMap((f) => fs.readFileSync(path.join(repo, f), 'utf8').split('\n')).map((l) => l.trim()).filter((l) => l.length > 8)
    for (const row of rows) {
      for (const value of Object.values(row).filter((v): v is string => typeof v === 'string')) {
        expect(value.length).toBeLessThanOrEqual(Math.max(String(row.path ?? '').length, String(row.symbol_id ?? '').length, 64))
        for (const l of lines) expect(value.includes(l), `${value} holds ${l}`).toBe(false)
      }
    }
  }, 120000)

  it('FR612 scenario 5: gc past the retention of query records, and trail purge, delete the trail', async () => {
    const { dataDir, repoId, formatAmount } = await setup()
    cli(['--data-dir', dataDir, 'trail', 'on', repoId])
    const count = () => (tool(dataDir, 'get_session_trail', { session_id: SESSION }).data as Trail).entries.length
    record(dataDir, scenario(repoId, formatAmount))
    expect(cli(['--data-dir', dataDir, 'gc']).stdout).toMatch(/delete \d+ query records and 0 trail entries recorded more than 30 days ago/)
    expect(count()).toBe(5)
    expect(cli(['--data-dir', dataDir, 'gc', '--records-days', '0']).stdout).toMatch(/delete \d+ query records and 5 trail entries recorded more than 0 days ago/)
    expect(count()).toBe(0)
    record(dataDir, scenario(repoId, formatAmount))
    expect(cli(['--data-dir', dataDir, 'trail', 'purge', '--session', 'another']).stdout).toBe('deleted 0 trail entries\n')
    expect(count()).toBe(5)
    expect(cli(['--data-dir', dataDir, 'trail', 'purge', '--session', SESSION]).stdout).toBe('deleted 5 trail entries\n')
    expect(count()).toBe(0)
    record(dataDir, scenario(repoId, formatAmount))
    expect(cli(['--data-dir', dataDir, 'trail', 'purge']).stdout).toBe('deleted 5 trail entries\n')
    expect(count()).toBe(0)
  }, 120000)

  it('FR615: a trail is capped at 10,000 entries a session, and says it was cut', async () => {
    const { dataDir, repoId } = await setup()
    cli(['--data-dir', dataDir, 'trail', 'on', repoId])
    const many = Array.from({ length: 10_001 }, (_, i) => ({ session_id: SESSION, repository_id: repoId, at: at(i % 60), kind: 'opened', tool: 'Read', path: `packages/f${i}.ts`, outcome: 'ok' }))
    expect(record(dataDir, many).stdout).toMatch(/^recorded 10000 entries; dropped 1 past the cap of 10000 a session/)
    const env = tool(dataDir, 'get_session_trail', { session_id: SESSION, limits: { max_rows: 10 } })
    expect((env.data as Trail).cut).toBe(true)
    expect(env.limitations.join('\n')).toMatch(/cut at 10,000 entries/)
  }, 120000)
})
