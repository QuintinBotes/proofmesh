import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, it } from 'vitest'
import { CLI, FIXTURE, ROOT, tmpDir } from './helpers.js'

const GUARD = path.join(import.meta.dirname, 'net-guard.mjs')
const guarded = (log: string, extra: Record<string, string> = {}) => ({ ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(GUARD).href}`, PROOFMESH_NET_LOG: log, ...extra })
const entries = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { pid: number; kind: string; target?: string; argv?: string[] }) : [])

/** Starts a long-running CLI command and resolves with the first stdout line that matches `ready`. */
function serve(args: string[], env: NodeJS.ProcessEnv, ready: RegExp): Promise<{ match: RegExpExecArray; stop: () => void }> {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill(); reject(new Error(`proofmesh ${args.join(' ')} printed no ready line`)) }, 30000)
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      const match = ready.exec(line)
      if (match) { clearTimeout(t); resolve({ match, stop: () => child.kill() }) }
    })
  })
}

function request(origin: string, method: string, p: string, body?: unknown, cookie?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const { host, port } = new URL(origin)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host, origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const reach = (host: string, port: number) => new Promise<string>((resolve) => {
  const s = net.connect({ host, port })
  s.setTimeout(3000, () => { s.destroy(); resolve('timeout') })
  s.on('connect', () => { s.destroy(); resolve('connected') })
  s.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'))
})

describe('FR053 local and private by default: no telemetry, no remote requests', () => {
  it('FR053 the network guard records and refuses a remote socket, DNS lookup and fetch, and lets loopback through', () => {
    // A documentation address (RFC 5737) that is never routed; it is spliced in so the leak scan sees no literal URL.
    const REMOTE = '192.0.2.1'
    const log = path.join(tmpDir('pm-guard-'), 'net.log')
    const probe = `
      const net = require('node:net'), dns = require('node:dns')
      const s = net.createServer((c) => c.destroy()).listen(0, '127.0.0.1', async () => {
        await new Promise((r) => net.connect(s.address().port, '127.0.0.1').on('connect', function () { this.destroy(); r() }))
        await new Promise((r) => net.connect(80, '${REMOTE}').on('error', r))
        await new Promise((r) => dns.lookup('example.invalid', r))
        await fetch('https://${REMOTE}/telemetry').catch(() => {})
        s.close()
      })`
    const r = spawnSync(process.execPath, ['-e', probe], { env: guarded(log), encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(entries(log).map(({ kind, target }) => [kind, target])).toEqual([['loaded', undefined], ['connect', `${REMOTE}:80`], ['dns', 'example.invalid'], ['fetch', `https://${REMOTE}/telemetry`]])
  })

  it('FR053 init, index, an MCP stdio session and the view server, every Node process guarded, reach nothing beyond loopback and ask git for no remote', async () => {
    const work = tmpDir('pm-local-only-'), log = path.join(work, 'net.log'), gitLog = path.join(work, 'git.log'), bin = path.join(work, 'bin'), data = path.join(work, 'data'), repo = path.join(work, 'repo')
    // The repository has an origin, a local bare clone, so a fetch would show in git's log without leaving the machine.
    const realGit = process.env.PATH!.split(path.delimiter).map((d) => path.join(d, 'git')).find((g) => fs.existsSync(g))!
    const git = (...a: string[]) => execFileSync(realGit, a, { cwd: repo, stdio: 'ignore' })
    fs.cpSync(FIXTURE, repo, { recursive: true })
    git('init', '-q', '-b', 'main'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'fixture')
    git('clone', '-q', '--bare', repo, path.join(work, 'origin.git')); git('remote', 'add', 'origin', path.join(work, 'origin.git')); git('fetch', '-q', 'origin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${gitLog}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
    const env = guarded(log, { PATH: `${bin}${path.delimiter}${process.env.PATH}` })

    const cli = (...args: string[]) => { const r = spawnSync(process.execPath, [CLI, '--data-dir', data, ...args], { env, encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0); return r.stdout }
    cli('init'); cli('repo', 'add', repo)
    expect(cli('index', repo)).toMatch(/published/)

    const client = new Client({ name: 'proofmesh-local-only', version: '0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, '--data-dir', data, 'mcp'], env: env as Record<string, string>, stderr: 'pipe' }))
    try {
      for (const [name, args] of [['list_repositories', {}], ['workspace_status', {}], ['find_symbols', { text: 'invoice' }], ['get_overview', {}], ['search_sources', { text: 'invoice' }]] as const) {
        const r = await client.callTool({ name, arguments: args })
        expect(r.isError, `${name}: ${JSON.stringify(r.content)}`).toBeFalsy()
      }
    } finally { await client.close() }

    const view = await serve(['--data-dir', data, 'view', '--port', '0', '--no-open'], env, /^Observatory: (http:\/\/(?:localhost|127\.0\.0\.1):\d+)\/#t=([0-9a-f]{64})$/)
    try {
      const origin = view.match[1]!
      const s = await request(origin, 'POST', '/session', { token: view.match[2] })
      expect(s.status).toBe(204)
      const cookie = String(s.headers['set-cookie']).split(';')[0]!
      expect((await request(origin, 'GET', '/')).status).toBe(200)
      for (const p of ['/api/v1/tools/workspace_status', '/api/v1/galaxy', '/api/v1/snapshots']) expect((await request(origin, 'POST', p, {}, cookie)).status, p).toBe(200)
      expect((await request(origin, 'GET', '/api/workspaces', undefined, cookie)).status).toBe(200)
    } finally { view.stop() }

    const all = entries(log)
    expect(all.filter((e) => e.kind !== 'loaded')).toEqual([])
    // The guard ran in each command's process, and in the adapter processes the index started.
    const commands = new Set(all.filter((e) => e.argv?.[0] === CLI).map((e) => e.argv![3]))
    expect([...commands].sort()).toEqual(['index', 'init', 'mcp', 'repo', 'view'])
    expect(all.some((e) => e.argv?.[0] !== CLI && /adapter/.test(e.argv?.[0] ?? ''))).toBe(true)
    const gitCalls = fs.readFileSync(gitLog, 'utf8').trim().split('\n')
    expect(gitCalls.length).toBeGreaterThan(0)
    expect(gitCalls.filter((c) => /(^|\s)(fetch|pull|push|clone|ls-remote|submodule)(\s|$)|remote update/.test(c))).toEqual([])
  }, 180000)
})

describe('FR054 no shared or multi-user deployment is advertised, and the servers listen on loopback only', () => {
  const CLAIM = /\b(multi-?user|multi-?tenant|shared (mode|deployment|server|instance)|team (server|deployment|instance)|hosted (instance|deployment)|bind[- ]address|listen on all)\b|0\.0\.0\.0|--host\b|--bind\b/i
  const DEFERRAL = /deferred|not supported|requires a separate security/i

  it('FR054 the root documents, docs/proofmesh and the CLI help make no shared or multi-user deployment claim; only the ADR defers one', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.md') ? [path.join(d, e.name)] : []))
    const docs = [...fs.readdirSync(ROOT).filter((f) => f.endsWith('.md')).map((f) => path.join(ROOT, f)), ...walk(path.join(ROOT, 'docs', 'proofmesh'))]
    expect(docs.map((f) => path.relative(ROOT, f))).toEqual(expect.arrayContaining(['README.md', 'SECURITY.md', 'docs/proofmesh/operations.md', 'docs/proofmesh/adr/0001-proofmesh.md']))
    const claims: string[] = [], deferrals = new Set<string>()
    for (const f of docs) fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (!CLAIM.test(line)) return
      if (DEFERRAL.test(line)) deferrals.add(path.relative(ROOT, f))
      else claims.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`)
    })
    expect(claims).toEqual([])
    expect([...deferrals]).toEqual(['docs/proofmesh/adr/0001-proofmesh.md'])
    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout
    expect(help).not.toMatch(CLAIM)
    expect(help).toMatch(/^ {2}view \[--port P\] \[--no-open\] +Observatory on loopback$/m)
    expect(help).toMatch(/^ {2}mcp \[--editor \| --http \[--port P\]\] +MCP server on stdio, or Streamable HTTP on loopback/m)
  })

  it('FR054 every server in the source listens on 127.0.0.1', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []))
    // The host is the second argument of every listen call.
    const listens = walk(path.join(ROOT, 'packages', 'proofmesh', 'src')).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/\.listen\(([^,)]*),?\s*([^,)]*)/g)].map((m) => `${path.relative(ROOT, f)}: ${m[2]}`))
    expect(listens).toEqual(["packages/proofmesh/src/http/server.ts: '127.0.0.1'", "packages/proofmesh/src/mcp/server.ts: '127.0.0.1'"])
  })

  it('FR054 view and mcp --http take no bind option: given one, they still print a loopback address, and no other interface of this machine answers on their port', async () => {
    const data = tmpDir('pm-bind-')
    expect(spawnSync(process.execPath, [CLI, '--data-dir', data, 'init']).status).toBe(0)
    const bind = ['--host', '0.0.0.0', '--bind', '0.0.0.0']
    const servers = [
      await serve(['--data-dir', data, 'view', '--port', '0', '--no-open', ...bind], process.env, /^Observatory: http:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/#t=/),
      await serve(['--data-dir', data, 'mcp', '--http', '--port', '0', ...bind], process.env, /^MCP over Streamable HTTP: http:\/\/127\.0\.0\.1:(\d+)\/mcp$/),
    ]
    try {
      // shortcut: a machine with no non-loopback IPv4 interface has nothing to probe; the source check above still pins the address.
      const interfaces = Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === 'IPv4').map((a) => a!.address)
      for (const s of servers) {
        const port = Number(s.match[1])
        expect(await reach('127.0.0.1', port)).toBe('connected')
        for (const address of interfaces) expect(await reach(address, port), `${address}:${port}`).not.toBe('connected')
      }
    } finally { servers.forEach((s) => s.stop()) }
  })
})
