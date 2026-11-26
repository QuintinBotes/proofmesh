#!/usr/bin/env node
// Synthetic large tier (issue 89): generates a repository of N C# projects holding M files in all, indexes it with the CLI, and records the
// peak memory of the index host and of the adapter, beside the budget and heap the machine rule gave them.
//
//   node bench/graph-bench/synthetic-large.mjs --projects 300 --files 30000 [--out result.json] [--adapter <entry>] [--sample-ms 500] [--keep]
//
// Each project references the one before it, so references flow the way they do in a real solution. Files hold one small class each.
// --adapter names an adapter entry for C# (PROOFMESH_CS_ADAPTER); without it the built C# adapter is used. The result is printed as JSON and,
// with --out, written there. It is run by hand: 30,000 files need the C# adapter and many GB. Small runs are covered by the tests.
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const projects = Number(flag('projects', 20)), files = Number(flag('files', 200)), sampleMs = Number(flag('sample-ms', 500))
if (!Number.isInteger(projects) || !Number.isInteger(files) || projects < 1 || files < projects) { console.error('--projects and --files must be whole numbers with files >= projects'); process.exit(2) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(root, 'packages', 'proofmesh', 'bin', 'proofmesh.mjs')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-synthetic-'))
const repo = path.join(work, 'repo'), data = path.join(work, 'data')

for (let p = 0; p < projects; p++) {
  const name = `P${String(p).padStart(4, '0')}`, dir = path.join(repo, name)
  fs.mkdirSync(dir, { recursive: true })
  const ref = p ? `<ItemGroup><ProjectReference Include="../P${String(p - 1).padStart(4, '0')}/P${String(p - 1).padStart(4, '0')}.csproj" /></ItemGroup>` : ''
  fs.writeFileSync(path.join(dir, `${name}.csproj`), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>${ref}</Project>\n`)
  const mine = Math.floor(files / projects) + (p < files % projects ? 1 : 0)
  for (let f = 0; f < mine; f++) {
    const callee = p ? `\n        public int Next() => new P${String(p - 1).padStart(4, '0')}.C0().Value() + ${f};` : ''
    fs.writeFileSync(path.join(dir, `C${f}.cs`), `namespace ${name};\n\npublic class C${f}\n{\n    public int Value() => ${f};${f === 0 ? callee : ''}\n}\n`)
  }
}

const env = {}
for (const [k, v] of Object.entries(process.env)) if (/^(PATH|HOME|TMPDIR|LANG|PROOFMESH_.*|DOTNET_.*|NUGET_.*)$/.test(k)) env[k] = v
const adapter = flag('adapter')
if (adapter) env.PROOFMESH_CS_ADAPTER = path.resolve(adapter)
const run = (a) => new Promise((resolve) => { const c = spawn(process.execPath, [cli, '--data-dir', data, ...a], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { err += d }); c.on('close', (code) => resolve({ code, out, err })) })
await run(['init']); await run(['repo', 'add', repo])

// The tree under the CLI process: the index host is its direct node child, the adapter is everything else below it.
let hostKb = 0, adapterKb = 0
const sample = (rootPid) => new Promise((resolve) => execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { env: { PATH: env.PATH ?? '' }, timeout: 5000, killSignal: 'SIGKILL' }, (e, out) => {
  if (e) return resolve()
  const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)), kids = new Map()
  for (const [pid, ppid, rss] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), { pid, rss }])
  const host = (kids.get(rootPid) ?? [])[0]
  const below = (pid) => (kids.get(pid) ?? []).flatMap((k) => [k, ...below(k.pid)])
  if (host) { hostKb = Math.max(hostKb, host.rss); adapterKb = Math.max(adapterKb, below(host.pid).reduce((s, k) => s + k.rss, 0)) }
  resolve()
}))
const started = Date.now()
const child = spawn(process.execPath, [cli, '--data-dir', data, 'index', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = '', err = ''
child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
const timer = setInterval(() => void sample(child.pid), sampleMs)
const code = await new Promise((resolve) => child.on('close', resolve))
clearInterval(timer)
const line = (re) => re.exec(out)?.[0] ?? null
const result = {
  projects, files, exit_code: code, seconds: Math.round((Date.now() - started) / 1000), machine_memory_mb: Math.round(os.totalmem() / 1048576),
  host_peak_mb: Math.round(hostKb / 1024), adapter_peak_mb: Math.round(adapterKb / 1024),
  memory_line: line(/^adapter memory budget .*$/m), peak_line: line(/^adapter peak memory .*$/m), failure: code === 0 ? null : err.trim().split('\n').slice(-3).join(' | '),
}
if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true })
const text = JSON.stringify(result, null, 2)
console.log(text)
if (flag('out')) fs.writeFileSync(flag('out'), `${text}\n`)
process.exit(code === 0 ? 0 : 1)
