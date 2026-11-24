import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cli, tmpDir } from './helpers.js'

describe('A13 FR041 mcp-config prints a client registration and edits only the file it is asked to', () => {
  it('prints Claude Code and Codex registrations that start this installation, with the data directory only when given', () => {
    const cc = cli(['mcp-config'])
    expect(cc.status).toBe(0)
    expect(cc.stdout).toMatch(/^# Claude Code \(project scope\)/)
    expect(cc.stdout).toMatch(/claude mcp add -s project proofmesh -- node \S*proofmesh\.mjs mcp\n/)
    expect(cc.stdout).not.toMatch(/--data-dir/)
    const d = tmpDir()
    const codex = cli(['--data-dir', d, 'mcp-config', '--client', 'codex', '--scope', 'user'])
    expect(codex.stdout).toMatch(/^# Codex: add to ~\/.codex\/config.toml\n\[mcp_servers.proofmesh\]\ncommand = "node"\nargs = \[".*proofmesh\.mjs", "--data-dir", ".*", "mcp"\]\n$/)
    expect(cli(['mcp-config', '--client', 'other']).status).not.toBe(0)
  })

  it('writes only a .mcp.json it is pointed at, keeping the other servers, and refuses any other file', () => {
    const dir = tmpDir('pm-mcp-'), file = path.join(dir, '.mcp.json')
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }))
    expect(cli(['mcp-config', '--write', file]).status).toBe(0)
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(Object.keys(json.mcpServers).sort()).toEqual(['other', 'proofmesh'])
    expect(json.mcpServers.proofmesh.args.at(-1)).toBe('mcp')
    const r = cli(['mcp-config', '--write', path.join(dir, 'config.toml')])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/printed, not edited \(FR041\)/)
    expect(fs.existsSync(path.join(dir, 'config.toml'))).toBe(false)
  })
})
