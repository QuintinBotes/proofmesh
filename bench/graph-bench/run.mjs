// Head-to-head: Graphify (CLI over graphify-out/graph.json) vs ProofMesh (MCP over its snapshot), scored against the
// TypeScript compiler's ground truth (truth.mjs). Offline and deterministic: no model call by either tool.
//
// Usage: node run.mjs --repo <orbit-copy> [--truth out/truth.json] [--out out]
// Needs: graphify on PATH with a graph already built in <repo>/graphify-out (graphify update <repo>),
//        and ProofMesh indexed through ./pm (pm repo add <repo>; pm index <repo>).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { McpClient } from './mcp-client.mjs'
import { measureSymbolAt } from './symbol-at-latency.mjs'
import { makeTruth, score, graphifyAdapter, proofmeshAdapter } from './lib.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
if (!opt('--repo')) { console.error('usage: node run.mjs --repo <orbit-copy> [--truth out/truth.json] [--out out]'); process.exit(2) }
const REPO = path.resolve(opt('--repo'))
const OUT = path.resolve(HERE, opt('--out', 'out'))
const TRUTH = path.resolve(HERE, opt('--truth', 'out/truth.json'))
const PM = path.join(HERE, 'pm')
const PM_DATA = process.env.PM_DATA_DIR ?? path.resolve(HERE, '../../.bench-data')
fs.mkdirSync(path.join(OUT, 'raw'), { recursive: true })
const Q = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf8')).questions
const raw = (name, data) => fs.writeFileSync(path.join(OUT, 'raw', name), typeof data === 'string' ? data : JSON.stringify(data, null, 1))

// ---------- ground truth, scoring and both tools: lib.mjs ----------
const truthData = makeTruth(JSON.parse(fs.readFileSync(TRUTH, 'utf8')))
const { T, truthFor } = truthData
const graphify = graphifyAdapter(REPO, truthData)
let pm, pmStartMs, proofmesh

// ---------- run ----------
const t0 = performance.now()
pm = new McpClient(PM, ['mcp'], { cwd: REPO, env: { ...process.env, PM_DATA_DIR: PM_DATA } })
await pm.init(); pmStartMs = performance.now() - t0
proofmesh = proofmeshAdapter(pm, PM_DATA, truthData, raw)
const results = []
for (const q of Q) {
  const truth = truthFor(q)
  const g = graphify(q)
  const p = await proofmesh(q)
  const row = { id: q.id, kind: q.kind, ask: q.ask, truth_n: truth.items?.size ?? null }
  for (const [name, a] of [['graphify', g], ['proofmesh', p]]) {
    const r = { ms: Math.round(a.ms ?? 0), bytes: a.bytes ?? 0, calls: a.calls ?? (a.cmd ? 1 : 0), cites_file_line: !!a.cites, note: a.note ?? null, graph_level: !!a.graph_level, error: a.error ?? null, cmd: a.cmd, ...(a.lookup ? { lookup: { ...a.lookup, ms: Math.round(a.lookup.ms) } } : {}), ...(a.rows !== undefined ? { rows: a.rows } : {}) }
    if (q.kind === 'path') Object.assign(r, { shortest_truth: truth.shortest, path_hops: a.path_hops ?? null, path_valid: !!a.path_valid, path_text: a.path_text })
    else Object.assign(r, score(truth.items, a.answer))
    // Bytes of the answering call(s) per correct row, the lookup apart (#41). A row is correct when what it states is true: for a caller
    // question a true caller at a site where it makes the call (each tool lists a caller once per site it reports), otherwise the item it names.
    if (a.facts) {
      r.answer_rows = a.facts.length
      r.correct_rows = a.facts.filter((x) => truth.items.has(x.item) && (!x.site || !truth.pairs || truth.pairs.has(`${x.item} ${x.site}`))).length
      r.bytes_per_correct_row = r.correct_rows ? Math.round(r.bytes / r.correct_rows) : null
      r.bytes_per_correct_item = r.hits ? Math.round(r.bytes / r.hits) : null
    }
    if (truth.sites && a.sites) r.sites = score(truth.sites, a.sites)
    if (truth.files && a.files) r.files = score(truth.files, a.files)
    row[name] = r
    if (a.out) raw(`gf-${q.id}.txt`, `$ ${a.cmd}\n${a.out}`)
  }
  results.push(row)
  console.error(`${q.id} done`)
}
// get_symbols_at over MCP stdio on this snapshot, warm: 1,000 single-location calls and 100 calls of 100 locations (FR122).
const symbol_at_latency = await measureSymbolAt(async (locations) => { const r = await pm.call('get_symbols_at', { locations }); if (r.isError) throw new Error(r.text.slice(0, 300)); return r }, T.symbols)
console.error(`get_symbols_at p95 ${symbol_at_latency.single_p95_ms} ms single, ${symbol_at_latency.batch_p95_ms} ms for 100 locations`)
pm.close()
const meta = { repo: REPO, commit: spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), graphify: spawnSync('graphify', ['--version'], { encoding: 'utf8' }).stdout.trim(), proofmesh_snapshot: proofmesh.snapshotId(), pm_mcp_startup_ms: Math.round(pmStartMs), truth: T.tool + ' ' + T.ts_version, when: new Date().toISOString() }
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, results, symbol_at_latency }, null, 1))
// table
const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`)
const bound = (r) => {
  const g = r.graphify, p = r.proofmesh
  if (r.kind === 'path') return `${p.bytes} B ${p.bytes <= 2 * g.bytes ? '≤' : '>'} 2x ${g.bytes}: ${p.bytes <= 2 * g.bytes ? 'y' : 'n'}`
  if (p.graph_level) return '-'
  if (!g.bytes_per_correct_row || !p.bytes_per_correct_row) return '-'
  const x = p.bytes_per_correct_row / g.bytes_per_correct_row
  return `${x.toFixed(2)}x: ${x <= 2 ? 'y' : 'n'}`
}
const lines = ['| Q | kind | truth | Graphify R / P | ProofMesh R / P | Graphify ms / bytes | ProofMesh ms / bytes / calls | ProofMesh lookup bytes / calls | correct rows G / P | bytes per correct row G / P | P within 2x of G | file:line G / P |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
for (const r of results) {
  const g = r.graphify, p = r.proofmesh
  const rp = (x) => (r.kind === 'path' ? `${x.path_valid ? 'valid' : 'invalid'} ${x.path_hops ?? '-'} hops (shortest ${x.shortest_truth})` : `${pct(x.recall)} / ${pct(x.precision)}${x.graph_level ? ' (graph)' : ''}`)
  const fl = (x) => (x.cites_file_line ? 'y' : 'n')
  lines.push(`| ${r.id} | ${r.kind} | ${r.truth_n ?? '-'} | ${rp(g)} | ${rp(p)} | ${g.ms} / ${g.bytes} | ${p.ms} / ${p.bytes} / ${p.calls} | ${p.lookup ? `${p.lookup.bytes} / ${p.lookup.calls}` : '-'} | ${g.correct_rows ?? '-'} / ${p.correct_rows ?? '-'} | ${g.bytes_per_correct_row ?? '-'} / ${p.bytes_per_correct_row ?? '-'} | ${bound(r)} | ${g.cites_file_line ? 'y' : 'n'} / ${fl(p)} |`)
}
const extra = results.filter((r) => r.graphify.sites).map((r) => `- ${r.id} call sites (file:line): Graphify R ${pct(r.graphify.sites.recall)} P ${pct(r.graphify.sites.precision)}; ProofMesh R ${pct(r.proofmesh.sites?.recall)} P ${pct(r.proofmesh.sites?.precision)}. Caller files: Graphify R ${pct(r.graphify.files?.recall)} P ${pct(r.graphify.files?.precision)}; ProofMesh R ${pct(r.proofmesh.files?.recall)} P ${pct(r.proofmesh.files?.precision)}`)
extra.push('- ProofMesh answers are its default MCP envelope, lean; bytes are the answering call(s) only, and the symbol lookup (find_symbols) is the lookup column; Q5 and Q6 name their file by path and look nothing up.')
extra.push('- A correct row states a true fact: for callers, a true caller at a site where it makes the call (ProofMesh lists each call site, Graphify one site per caller); otherwise a true caller, implementer, file or dependent. Per correct item instead: ' + results.filter((r) => r.proofmesh.bytes_per_correct_item).map((r) => `${r.id} G ${r.graphify.bytes_per_correct_item ?? '-'} / P ${r.proofmesh.bytes_per_correct_item}`).join('; ') + '.')
extra.push(`- get_symbols_at (FR122), warm, MCP stdio: p95 ${symbol_at_latency.single_p95_ms} ms over ${symbol_at_latency.single_calls} single-location calls (budget ${symbol_at_latency.budget.single_p95_ms} ms), p95 ${symbol_at_latency.batch_p95_ms} ms over ${symbol_at_latency.batch_calls} calls of 100 locations (budget ${symbol_at_latency.budget.batch_p95_ms} ms): ${symbol_at_latency.within_budget ? 'within' : 'OVER'} budget.`)
const md = [`# Graph bench: ${path.basename(REPO)} @ ${meta.commit.slice(0, 8)}`, '', `Graphify ${meta.graphify}; ProofMesh snapshot ${meta.proofmesh_snapshot} (MCP start ${meta.pm_mcp_startup_ms} ms); truth: ${meta.truth}.`, '', ...lines, '', ...extra, ''].join('\n')
fs.writeFileSync(path.join(OUT, 'results.md'), md)
console.log(md)
// The budget can fail the run: the results are written first, so the figures stay for whoever reads them.
if (!symbol_at_latency.within_budget) { console.error('get_symbols_at is over its latency budget'); process.exitCode = 1 }
