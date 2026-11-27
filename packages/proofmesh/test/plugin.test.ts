import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { PROFILE, TOOLS } from '../src/query/tools.js'
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
    expect(JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers.proofmesh).toEqual({ command: 'proofmesh', args: ['mcp', '--tools', 'core,data,claims'] })
    // FR421: every tool the skill and commands name is in a profile the registration loads.
    const docs = ['skills/proofmesh/SKILL.md', ...fs.readdirSync(path.join(PLUGIN, 'commands')).map((f) => `commands/${f}`)].map((f) => fs.readFileSync(path.join(PLUGIN, f), 'utf8')).join('\n')
    const named = TOOLS.filter((t) => new RegExp(`\\b${t}\\b`).test(docs))
    expect(named).toContain('verify_claim')
    expect(named.filter((t) => !['core', 'data', 'claims'].includes(PROFILE[t]))).toEqual([])
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
    expect(fs.readdirSync(state)).toEqual([])
  }, 240000)
})

describe('#133 a plugin installed without the proofmesh CLI says so and how to install it', () => {
  const INSTALL = 'git clone https://github.com/QuintinBotes/proofmesh && cd proofmesh && pnpm install --frozen-lockfile && pnpm build && cd packages/proofmesh && npm link'
  const NO_CLI = () => ({ PATH: `${tmpDir('pm-empty-')}:/usr/bin:/bin`, PROOFMESH_HOOK_STATE: tmpDir('pm-plugin-state-') })

  it('FR660 with no proofmesh on PATH, the SessionStart hook prints one line, exit 0, that names the missing CLI and the install command, to the person and to Claude', () => {
    const env = NO_CLI()
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'fresh.mjs'), 'session'], { input: JSON.stringify({ cwd: tmpDir('pm-plugin-cwd-') }), encoding: 'utf8', env: { ...process.env, ...env } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
    const line = `proofmesh: not installed. The Proofmesh plugin's MCP server and hooks need the proofmesh CLI on PATH; install it: ${INSTALL}`
    expect(JSON.parse(r.stdout)).toEqual({ systemMessage: line, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line } })
    expect(fs.readdirSync(env.PROOFMESH_HOOK_STATE)).toEqual([])
    // An edit with no CLI stays silent: the session-start line already said it, once.
    expect(hook('edited', { cwd: tmpDir('pm-plugin-cwd-'), tool_input: { file_path: '/x/y.ts' } }, NO_CLI())).toBeNull()
  })

  it("FR661 the plugin README's first paragraph gives that install command, not a spec id", () => {
    const first = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8').split('\n\n')[1]
    expect(first).toContain(INSTALL)
    expect(first).not.toMatch(/\(A\d+\)/)
  })
})

describe('FR873 the SessionStart hook names the last index job that failed (#167)', () => {
  it('FR873: with no snapshot and a failed last job, the hook says which job failed, when and why; with no job, it says only that there is no snapshot', () => {
    const repo = tmpDir('pm-plugin-failed-')
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1\n')
    const dataDir = tmpDir()
    cli(['--data-dir', dataDir, 'init'])
    const repoId = cli(['--data-dir', dataDir, 'repo', 'add', repo]).stdout.trim()
    const shim = tmpDir('pm-plugin-bin-')
    fs.writeFileSync(path.join(shim, 'proofmesh'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 })
    const env = { PATH: `${shim}:${process.env.PATH}`, PROOFMESH_DATA_DIR: dataDir, PROOFMESH_HOOK_STATE: tmpDir('pm-plugin-state-') }
    const name = path.basename(repo)
    expect(hook('session', { cwd: repo }, env)?.additionalContext).toBe(`Proofmesh has ${name} registered but no published snapshot of it; run /proofmesh:index before asking it anything.`)
    const c = Catalog.open(dataDir)
    const job = c.createJob(repoId, 'test'), at = new Date().toISOString()
    c.updateJob(job, { state: 'failed', finished_at: at, error: 'the index host was killed by SIGKILL' })
    c.close()
    expect(hook('session', { cwd: repo }, env)?.additionalContext).toBe(`Proofmesh has ${name} registered but no published snapshot of it; last index job ${job} failed at ${at}: the index host was killed by SIGKILL; run /proofmesh:index before asking it anything.`)
    // With a snapshot from an earlier index, the hook names the failure after the snapshot's state.
    expect(cli(['--data-dir', dataDir, 'index', repoId]).status).toBe(0)
    const again = Catalog.open(dataDir)
    const later = again.createJob(repoId, 'test'), when = new Date(Date.now() + 1000).toISOString()
    again.updateJob(later, { state: 'failed', finished_at: when, error: 'the index host exited with code 3' })
    const snapshot = again.currentSnapshot(repoId)!.id
    again.close()
    expect(hook('session', { cwd: repo }, env)?.additionalContext).toBe(`Proofmesh's snapshot ${snapshot} of ${name} matches the working tree. Its last index job ${later} failed at ${when}: the index host exited with code 3.`)
  }, 60000)
})

describe('#141 the root README installs the CLI onto PATH, where Claude Code and the plugin can run it', () => {
  const ROOT_DIR = path.join(import.meta.dirname, '..', '..', '..')
  const install = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8').split('\n## Install\n')[1]!.split('\n## ')[0]!

  it('FR690 the Install section links the CLI with npm link from packages/proofmesh, after pnpm install and pnpm build, and defines no alias', () => {
    expect(install).not.toMatch(/\balias proofmesh\b/)
    const at = (s: string) => install.indexOf(s)
    expect(at('pnpm install --frozen-lockfile')).toBeGreaterThan(-1)
    expect(at('pnpm build')).toBeGreaterThan(at('pnpm install --frozen-lockfile'))
    expect(at('cd packages/proofmesh && npm link')).toBeGreaterThan(at('pnpm build'))
  })

  it("FR691 after the Install section's npm link line, a shell that never saw an alias finds proofmesh on PATH and runs it", () => {
    const line = install.split('\n').find((l) => l.includes('npm link'))!.replace(/\s+#.*$/, '')
    const prefix = tmpDir('pm-npm-prefix-')
    // A private npm prefix, offline: the test links into a temporary folder, never the machine's global one, and fetches nothing.
    const link = spawnSync('sh', ['-c', line], { cwd: ROOT_DIR, encoding: 'utf8', env: { ...process.env, npm_config_prefix: prefix, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } })
    expect(link.status, link.stderr).toBe(0)
    const clean = { PATH: `${path.join(prefix, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmpDir('pm-home-') }
    const found = spawnSync('/bin/sh', ['-c', 'command -v proofmesh && proofmesh --version'], { encoding: 'utf8', env: clean })
    expect(found.status, found.stderr).toBe(0)
    expect(found.stdout.trim().split('\n')).toEqual([path.join(prefix, 'bin', 'proofmesh'), JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'packages', 'proofmesh', 'package.json'), 'utf8')).version])
  }, 120000)
})

describe("#113 the plugin's hooks module: the snapshot state under the prompt and /pm-status (its scenarios run under claude plugin test)", () => {
  const MODULE = path.join(PLUGIN, 'hooks', 'register.mjs')

  it('FR480 hooks.json lists the hooks module beside its settings hooks, and the module exports register(on)', async () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'))
    expect(hooks.modules).toEqual(['./register.mjs'])
    expect(Object.keys(hooks.hooks).sort()).toEqual(['PostToolUse', 'SessionStart'])
    expect(typeof (await import(MODULE)).register).toBe('function')
  })

  it("FR486 FR614 FR701 the module reaches ProofMesh only through $.process.run and the plugin's own MCP server, and every tool it calls is listed by the server .mcp.json starts", async () => {
    const source = fs.readFileSync(MODULE, 'utf8')
    expect([...new Set(source.match(/\$\.\w+\.\w+/g))].sort()).toEqual(['$.clock.after', '$.clock.every', '$.clock.now', '$.command.register', '$.fs.stat', '$.mcp.call', '$.mcp.connect', '$.process.run', '$.session.cwd', '$.session.id', '$.ui.close', '$.ui.copy', '$.ui.invalidate', '$.ui.open', '$.ui.panes', '$.ui.resolve', '$.ui.status'])
    expect(source).toContain("$.process.run(['proofmesh', ...args], stdin === undefined ? undefined : { stdin })")
    expect(source).toContain("$.mcp.connect('proofmesh')")
    const called = [...source.matchAll(/callTool\(\$, '(\w+)'/g)].map((m) => m[1])
    // FR614: /pm-trail asks get_session_trail, in the data profile the registration loads; FR700 FR701: the impact pane asks core tools.
    expect(called).toEqual(['workspace_status', 'get_symbols_at', 'get_symbol', 'analyze_impact', 'find_tests', 'get_session_trail'])

    const server = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers.proofmesh as { command: string; args: string[] }
    const dataDir = tmpDir('pm-plugin-mcp-')
    expect(cli(['--data-dir', dataDir, 'init']).status).toBe(0)
    const client = new Client({ name: 'proofmesh-plugin-tests', version: '0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, '--data-dir', dataDir, ...server.args], stderr: 'pipe' }))
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name)
      for (const tool of called) expect(listed).toContain(tool)
    } finally {
      await client.close()
    }
  }, 60000)
})
