// SC-2 of issue 7: mutate a copy of the Orbit repository (the graph-bench corpus) with N random single renames and moves of top-level
// functions, index both trees, and check what compare_snapshots pairs. Pairs must be right, and few mutated symbols may be missed.
// Usage: node identity-mutation.mjs [<orbit-clone-or-url>] [--n 50] [--seed 7] [--out out/identity-mutation.json]
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { McpClient } from './mcp-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const PM = path.join(ROOT, 'packages/proofmesh/bin/proofmesh.mjs')
const Database = createRequire(path.join(ROOT, 'packages/proofmesh/package.json'))('better-sqlite3')
const args = process.argv.slice(2)
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
const SOURCE = positional[0] ?? 'https://github.com/QuintinBotes/orbit.git'
const N = Number(opt('--n', 50)), SEED = Number(opt('--seed', 7)), OUT = opt('--out', path.join(HERE, 'out/identity-mutation.json'))
const COMMIT = '5bd5dffa'

const run = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 28, ...o })
const git = (cwd, ...a) => run('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd })
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-mutation-'))
const repo = path.join(work, 'orbit'), data = path.join(work, 'data')
run('git', ['clone', '--quiet', SOURCE, repo])
git(repo, 'checkout', '-q', COMMIT)
git(repo, 'checkout', '-q', '-b', 'sc2-base')
const pm = (...a) => run('node', [PM, '--data-dir', data, ...a])
pm('init'); pm('repo', 'add', repo)
const indexRev = (rev) => /(snap_\w+) published/.exec(pm('index', repo, '--rev', rev))[1]
const baseSnap = indexRev('sc2-base')

// Candidates: top-level functions whose declaration starts `[export] [async] function name`, one per file.
const db = new Database(path.join(data, 'snapshots', `${baseSnap}.db`), { readonly: true })
const rows = db.prepare("select s.id, s.name, s.qualified_name, s.start_byte, s.end_byte, s.body_tokens, f.path from symbol s join file f on f.id = s.file_id where s.kind = 'function' and f.path like '%.ts' and f.path not like '%.d.ts' order by s.id").all()
const isTop = (r) => r.qualified_name === `${r.path.replace(/\.[^./]*$/, '')}:${r.name}`
const text = (p) => fs.readFileSync(path.join(repo, p))
const usable = rows.filter(isTop).filter((r) => new RegExp(`^(export\\s+)?(default\\s+)?(async\\s+)?function\\s*\\*?\\s*${r.name}\\b`).test(text(r.path).subarray(r.start_byte, r.end_byte).toString('utf8')))
const next = rng(SEED), seen = new Set(), pool = []
for (const r of [...usable].sort(() => next() - 0.5)) if (!seen.has(r.path)) { seen.add(r.path); pool.push(r) }
const chosen = pool.slice(0, N)
const mutations = chosen.map((r, i) => ({ ...r, op: i % 2 ? 'move' : 'rename', to: i % 2 ? path.join(path.dirname(r.path), `moved_${i}.ts`) : r.path, newName: i % 2 ? r.name : `${r.name}Renamed` }))

git(repo, 'checkout', '-q', '-b', 'sc2-head', 'sc2-base')
for (const m of mutations) {
  const buf = text(m.path), span = buf.subarray(m.start_byte, m.end_byte).toString('utf8')
  const before = buf.subarray(0, m.start_byte).toString('utf8'), after = buf.subarray(m.end_byte).toString('utf8')
  if (m.op === 'rename') {
    const renamed = span.replace(new RegExp(`(?<![.\\p{L}\\p{N}_$])${m.name}(?![\\p{L}\\p{N}_$])`, 'gu'), m.newName)
    fs.writeFileSync(path.join(repo, m.path), before + renamed + after)
  } else {
    fs.writeFileSync(path.join(repo, m.path), before + after.replace(/^\n/, ''))
    fs.writeFileSync(path.join(repo, m.to), `${span}\n`)
  }
}
git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'mutate')
const headSnap = indexRev('sc2-head')

const mcp = new McpClient('node', [PM, '--data-dir', data, 'mcp'], { cwd: repo })
await mcp.init()
const r = await mcp.call('compare_snapshots', { base_snapshot_id: baseSnap, snapshot_id: headSnap, limits: { max_rows: 5000, max_bytes: 50000000 } })
mcp.close()
if (r.isError || !r.json) throw new Error(`compare_snapshots failed: ${r.text.slice(0, 300)}`)
const cmp = r.json.data.symbols
if (r.json.completion?.truncated) throw new Error(`compare_snapshots truncated its lists: ${JSON.stringify(r.json.completion)}`)

const paired = new Map(cmp.paired.map((p) => [p.base.id, p]))
const FLOOR = 10
let correct = 0
const missed = []
for (const m of mutations) {
  const p = paired.get(m.id)
  if (p && p.head.name === m.newName && p.head.path === m.to) { correct++; continue }
  missed.push({ name: m.name, op: m.op, path: m.path, body_tokens: m.body_tokens, why: p ? 'wrong pair' : (m.body_tokens ?? 0) < FLOOR ? 'below the pairing floor' : 'not paired' })
}
const expected = new Set(mutations.map((m) => m.id))
const wrong = cmp.paired.filter((p) => !expected.has(p.base.id) || !(p.head.name === mutations.find((m) => m.id === p.base.id).newName && p.head.path === mutations.find((m) => m.id === p.base.id).to))
const eligible = mutations.filter((m) => (m.body_tokens ?? 0) >= FLOOR)
const result = {
  corpus: { source: 'Orbit', commit: COMMIT, candidate_functions: usable.length, files_with_candidates: pool.length },
  mutations: mutations.length, renames: mutations.filter((m) => m.op === 'rename').length, moves: mutations.filter((m) => m.op === 'move').length, seed: SEED,
  paired_correctly: correct, paired_rate: +(correct / mutations.length).toFixed(3),
  eligible: eligible.length, eligible_paired_rate: +(eligible.filter((m) => !missed.some((x) => x.name === m.name && x.path === m.path)).length / Math.max(1, eligible.length)).toFixed(3),
  wrong_pairs: wrong.length, wrong: wrong.slice(0, 10).map((p) => [p.base.qualified_name, p.head.qualified_name]),
  total_pairs: cmp.paired.length, ambiguous: cmp.ambiguous.length, too_small: cmp.counts.too_small, missed,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ ...result, missed: missed.length }, null, 2))
fs.rmSync(work, { recursive: true, force: true })
process.exit(wrong.length === 0 && result.paired_rate >= 0.95 ? 0 : 1)
