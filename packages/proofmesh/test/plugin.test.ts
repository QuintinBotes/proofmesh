import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { cli, fixtureRepo, indexedDataDir, tmpDir } from './helpers.js'

const PLUGIN = path.join(import.meta.dirname, '..', '..', 'proofmesh-plugin')
const BIN = path.join(import.meta.dirname, '..', 'bin', 'proofmesh.mjs')

/** Runs the plugin's hook script as Claude Code would: the event's JSON on stdin, `proofmesh` on PATH. */
function hook(mode: 'edited' | 'session', input: object, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'fresh.mjs'), mode], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput as { hookEventName: string; additionalContext: string }) : null
}

async function until(check: () => boolean, ms = 180000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) if (check()) return
  throw new Error('timed out')
}

describe('A13 the Claude Code plugin: skill, MCP registration, commands, and hooks that keep the snapshot fresh after edits', () => {
  it('A13 the manifest, MCP registration, hooks and commands are well formed, and every command says what it does', () => {
    expect(JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('proofmesh')
    expect(JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers.proofmesh).toEqual({ command: 'proofmesh', args: ['mcp'] })
    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'SessionStart'])
    expect(hooks.PostToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit')
    for (const event of Object.values(hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      for (const h of event.flatMap((e) => e.hooks)) expect(h.command).toMatch(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/fresh\.mjs" (edited|session)$/)
    }
    const commands = fs.readdirSync(path.join(PLUGIN, 'commands')).sort()
    expect(commands).toEqual(['impact.md', 'index.md', 'status.md', 'trace.md', 'verify-claim.md'])
    for (const c of commands) expect(fs.readFileSync(path.join(PLUGIN, 'commands', c), 'utf8')).toMatch(/^---\ndescription: \S.+\n/)
  })

  it('A13 an edit inside a registered repository starts one debounced background index, which publishes a snapshot matching the working tree', async () => {
    const repo = tmpDir('pm-plugin-repo-')
    fs.cpSync(fixtureRepo('ts-invoicing'), repo, { recursive: true })
    const { dataDir, repoId, snapshotId } = await indexedDataDir(repo)
    const shim = tmpDir('pm-plugin-bin-')
    fs.writeFileSync(path.join(shim, 'proofmesh'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 })
    const state = tmpDir('pm-plugin-state-')
    // The quiet period outlasts the gap between the two hook calls below even on a loaded machine (each spawns Node and the CLI), so
    // the second edit lands while the runner waits, which is what the single-index assertion is about.
    const env = { PATH: `${shim}:${process.env.PATH}`, PROOFMESH_DATA_DIR: dataDir, PROOFMESH_HOOK_QUIET_MS: '10000', PROOFMESH_HOOK_STATE: state }
    const fresh = () => JSON.parse(cli(['--data-dir', dataDir, 'status', repoId, '--fresh', '--json']).stdout) as { current: boolean; changed_count: number; snapshot_id: string }
    const current = () => { const c = Catalog.open(dataDir); try { return c.currentSnapshot(repoId)!.id } finally { c.close() } }

    expect(fresh()).toMatchObject({ current: true, changed_count: 0, snapshot_id: snapshotId })
    expect(hook('session', { cwd: repo }, env)).toEqual({ hookEventName: 'SessionStart', additionalContext: `Proofmesh's snapshot ${snapshotId} of ${path.basename(repo)} matches the working tree.` })
    expect(fs.existsSync(path.join(state, `${repoId}.lock`))).toBe(false)

    const edited = fs.readdirSync(repo, { recursive: true }).map(String).find((f) => f.endsWith('.ts') && !f.includes('node_modules'))!
    fs.appendFileSync(path.join(repo, edited), '\nexport function addedByAnAgent(): number { return 1 }\n')
    expect(fresh()).toMatchObject({ current: false, changed_count: 1 })
    expect(hook('edited', { cwd: repo, tool_name: 'Edit', tool_input: { file_path: edited } }, env)?.additionalContext).toMatch(/^Proofmesh is re-indexing .+ in the background after this edit\./)
    // A second edit while the runner waits only moves the quiet period on; it starts nothing and says nothing.
    fs.appendFileSync(path.join(repo, edited), '\nexport function andAnother(): number { return 2 }\n')
    expect(hook('edited', { cwd: repo, tool_name: 'Write', tool_input: { file_path: path.join(repo, edited) } }, env)).toBeNull()

    await until(() => current() !== snapshotId && !fs.existsSync(path.join(state, `${repoId}.lock`)))
    expect(fresh()).toMatchObject({ current: true, changed_count: 0 })
    expect(fs.readFileSync(path.join(state, `${repoId}.log`), 'utf8').match(/index exit 0/g)).toHaveLength(1)

    // At session start a tree that moved on is reported and indexed in the background.
    fs.appendFileSync(path.join(repo, edited), '\nexport function third(): number { return 3 }\n')
    const before = current()
    expect(hook('session', { cwd: repo }, env)?.additionalContext).toBe(`Proofmesh's snapshot ${before} of ${path.basename(repo)} is behind the working tree: 1 files changed. A background index has started; until it publishes, answers are as of that snapshot.`)
    await until(() => current() !== before && !fs.existsSync(path.join(state, `${repoId}.lock`)))
    expect(fresh().current).toBe(true)
  }, 600000)

  it('A13 an edit outside every registered repository, or without Proofmesh installed, does nothing', async () => {
    const { dataDir } = await indexedDataDir(fixtureRepo('ts-invoicing'))
    const outside = path.join(tmpDir('pm-plugin-outside-'), 'notes.md')
    fs.writeFileSync(outside, 'x')
    const state = tmpDir('pm-plugin-state-')
    const shim = tmpDir('pm-plugin-bin-')
    fs.writeFileSync(path.join(shim, 'proofmesh'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 })
    expect(hook('edited', { cwd: path.dirname(outside), tool_input: { file_path: outside } }, { PATH: `${shim}:${process.env.PATH}`, PROOFMESH_DATA_DIR: dataDir, PROOFMESH_HOOK_STATE: state })).toBeNull()
    expect(hook('session', { cwd: path.dirname(outside) }, { PATH: `${tmpDir('pm-empty-')}:/usr/bin:/bin`, PROOFMESH_HOOK_STATE: state })).toBeNull()
    expect(fs.readdirSync(state)).toEqual([])
  }, 240000)
})
