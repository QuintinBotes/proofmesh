// pnpm bench: index and query timings with the hardware and corpus they were measured on.
// Usage: node bench/run.mjs [--repo PATH --out DIR] [--runs N]. Without --repo it measures the public fixtures and writes
// bench/results/ (gitignored). A private corpus needs an explicit --out, so its numbers never land in a committed path.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'packages', 'proofmesh', 'bin', 'proofmesh.mjs')
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const repo = arg('--repo'), runs = Number(arg('--runs') ?? 20)
if (repo && !arg('--out')) { console.error('a private corpus needs --out DIR outside the repository'); process.exit(2) }
const outDir = arg('--out') ?? path.join(root, 'bench', 'results')
const corpora = repo ? [path.resolve(repo)] : ['ts-invoicing', 'cs-orders', 'cs-frameworks'].map((f) => path.join(root, 'fixtures', f, 'repo'))

const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }
const timed = (args) => {
  // /usr/bin/time reports the peak resident set of the process tree's largest member (the CLI or an adapter).
  const flag = process.platform === 'darwin' ? '-l' : '-v'
  const started = performance.now()
  const r = spawnSync('/usr/bin/time', [flag, process.execPath, cli, ...args], { encoding: 'utf8' })
  const ms = Math.round(performance.now() - started)
  if (r.status !== 0) throw new Error(`proofmesh ${args.join(' ')} failed: ${r.stderr.slice(-400)}`)
  const m = /(\d+)\s+maximum resident set size/.exec(r.stderr) ?? /Maximum resident set size \(kbytes\): (\d+)/.exec(r.stderr)
  const peak = m ? (process.platform === 'darwin' ? Number(m[1]) : Number(m[1]) * 1024) : null
  return { ms, peak_rss_mb: peak ? Math.round(peak / 1048576) : null, stdout: r.stdout }
}

async function mcp(dataDir) {
  const child = spawn(process.execPath, [cli, '--data-dir', dataDir, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const pending = new Map(); let next = 1
  readline.createInterface({ input: child.stdout }).on('line', (line) => { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } })
  const request = (method, params) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proofmesh-bench', version: '0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  return { call: async (name, args) => (await request('tools/call', { name, arguments: args })).structuredContent, close: () => child.kill() }
}
const percentile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }

const environment = {
  os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memory_gb: Math.round(os.totalmem() / 1073741824),
  load_average_1m: os.loadavg()[0], node: process.version, dotnet: sh('dotnet', ['--version']), proofmesh_commit: sh('git', ['-C', root, 'rev-parse', '--short', 'HEAD']),
  measured_at: new Date().toISOString(),
}
const results = []
for (const corpus of corpora) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-bench-'))
  spawnSync(process.execPath, [cli, '--data-dir', dataDir, 'init'])
  spawnSync(process.execPath, [cli, '--data-dir', dataDir, 'repo', 'add', corpus])
  const cold = timed(['--data-dir', dataDir, 'index', corpus])
  const warm = timed(['--data-dir', dataDir, 'index', corpus])
  const status = JSON.parse(spawnSync(process.execPath, [cli, '--data-dir', dataDir, 'status', '--json'], { encoding: 'utf8' }).stdout)
  const snapshotFile = fs.readdirSync(path.join(dataDir, 'snapshots')).find((f) => f.endsWith('.db'))
  const client = await mcp(dataDir)
  const ws = await client.call('workspace_status', { limits: { max_rows: 1 } })
  const hub = ws.data.hubs[0]
  const latencies = {}
  const measure = async (name, args) => { const xs = []; for (let i = 0; i < runs; i++) { const s = performance.now(); await client.call(name, args); xs.push(performance.now() - s) } latencies[name] = { p50_ms: +percentile(xs, 50).toFixed(1), p95_ms: +percentile(xs, 95).toFixed(1) } }
  await measure('workspace_status', { limits: { max_rows: 1 } })
  await measure('find_symbols', { text: hub ? hub.name : 'a', limits: { max_rows: 20 } })
  await measure('get_overview', {})
  if (hub) {
    await measure('get_relationships', { subject_id: hub.id, direction: 'both' })
    await measure('analyze_impact', { subject_ids: [hub.id], limits: { max_depth: 3 } })
  }
  client.close()
  results.push({
    corpus: { name: path.basename(repo ? corpus : path.dirname(corpus)), files_discovered: ws.coverage.files_discovered, dispositions: ws.coverage.dispositions, unresolved: ws.unresolved.count, snapshot_mb: +(fs.statSync(path.join(dataDir, 'snapshots', snapshotFile)).size / 1048576).toFixed(1) },
    index: { cold_ms: cold.ms, cold_peak_rss_mb: cold.peak_rss_mb, warm_ms: warm.ms, warm_status: /unchanged/.test(warm.stdout) ? 'unchanged' : 'republished' },
    queries: latencies, runs_per_query: runs, query_subject: hub ? `${hub.kind} with ${hub.inbound} inbound relationships` : null,
  })
  void status
  fs.rmSync(dataDir, { recursive: true, force: true })
}
fs.mkdirSync(outDir, { recursive: true })
const file = path.join(outDir, `bench-${environment.measured_at.replace(/[:.]/g, '-')}.json`)
const report = { method: 'Each corpus is indexed cold into a fresh data directory, then again unchanged; each tool is called over MCP the stated number of times on the most-referenced symbol. Timings include process start for indexing and the MCP round trip for queries. Load average is recorded because other work on the machine skews every number.', environment, results }
fs.writeFileSync(file, JSON.stringify(report, null, 2))
console.log(JSON.stringify(environment))
for (const r of results) console.log(`${r.corpus.name}: ${r.corpus.files_discovered} files, cold index ${r.index.cold_ms} ms (peak ${r.index.cold_peak_rss_mb} MB), warm ${r.index.warm_ms} ms ${r.index.warm_status}; ${Object.entries(r.queries).map(([k, v]) => `${k} p50 ${v.p50_ms} p95 ${v.p95_ms}`).join('; ')}`)
console.log(`report: ${file}`)
