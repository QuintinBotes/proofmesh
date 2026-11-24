// A13, FR041: configuration proposals for MCP clients. Printed by default; written only to the one file asked for, merging with
// what is there, never silently editing a client's settings.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProofmeshError } from '../core/errors.js'

const USAGE = 'usage: proofmesh mcp-config [--client claude-code|codex] [--scope project|user] [--write <file>]'

/** The command that starts this installation's MCP server, with the data directory only when one was chosen explicitly. */
export function serverCommand(dataDirFlag: string | undefined): { command: string; args: string[] } {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'proofmesh.mjs')
  const bin = fs.existsSync(cli) ? cli : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'proofmesh.mjs')
  return { command: 'node', args: [bin, ...(dataDirFlag ? ['--data-dir', dataDirFlag] : []), 'mcp'] }
}

export function render(client: string, scope: string, server: { command: string; args: string[] }): string {
  const q = (s: string) => (/[\s"']/.test(s) ? JSON.stringify(s) : s)
  if (client === 'claude-code') {
    const add = `claude mcp add -s ${scope} proofmesh -- ${[server.command, ...server.args].map(q).join(' ')}`
    const json = JSON.stringify({ mcpServers: { proofmesh: { command: server.command, args: server.args } } }, null, 2)
    return `# Claude Code (${scope} scope). Either run:\n${add}\n# or merge into ${scope === 'project' ? '.mcp.json in the repository' : '~/.claude.json'}:\n${json}\n`
  }
  if (client === 'codex') {
    return `# Codex: add to ${scope === 'project' ? '.codex/config.toml' : '~/.codex/config.toml'}\n[mcp_servers.proofmesh]\ncommand = ${JSON.stringify(server.command)}\nargs = [${server.args.map((a) => JSON.stringify(a)).join(', ')}]\n`
  }
  throw new ProofmeshError('INVALID_ARGUMENT', USAGE)
}

/** Writes a Claude Code .mcp.json, keeping every other server in it; refuses any other file. */
export function writeMcpJson(file: string, server: { command: string; args: string[] }): void {
  if (path.basename(file) !== '.mcp.json') throw new ProofmeshError('INVALID_ARGUMENT', '--write takes a .mcp.json path; other client files are printed, not edited (FR041)')
  const existing = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> }) : {}
  fs.writeFileSync(file, JSON.stringify({ ...existing, mcpServers: { ...existing.mcpServers, proofmesh: { command: server.command, args: server.args } } }, null, 2) + '\n')
}

export function runMcpConfig(dataDirFlag: string | undefined, rest: string[], take: (args: string[], flag: string) => string | undefined): number {
  const opts = [...rest]
  const client = take(opts, '--client') ?? 'claude-code', scope = take(opts, '--scope') ?? 'project', write = take(opts, '--write')
  if (!['project', 'user'].includes(scope) || opts.length) throw new ProofmeshError('INVALID_ARGUMENT', USAGE)
  const server = serverCommand(dataDirFlag)
  const text = render(client, scope, server)
  if (write) {
    writeMcpJson(path.resolve(write), server)
    console.log(`proofmesh added to ${path.resolve(write)}; other servers in it are kept`)
    return 0
  }
  process.stdout.write(text)
  return 0
}
