// Localisation benchmark (#27): from a problem statement to the files and functions a fix touches, with no model.
// For each instance of the pinned SWE-bench Lite sample (instances.json), the repository at its base commit is indexed
// by ProofMesh and asked search_concepts with the problem statement as text; a BM25 baseline over files and one over
// functions rank the same tree. Truth is the instance's gold patch: its files, and the functions (Python's own ast)
// that hold a line it changes. Acc@k counts an instance when a gold item is among the top k.
// Usage: node bench/localise/run.mjs [--only <id,id>] [--baseline-only] [--jobs <n>]
// Needs network on the first run only (the dataset rows and each base commit, cached under $LOCALISE_CACHE, default
// ~/.cache/proofmesh-localise), git and python3. Writes out/results.md and out/results.json ($LOCALISE_OUT moves them).
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from '../graph-bench/mcp-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const CACHE = process.env.LOCALISE_CACHE ?? path.join(os.homedir(), '.cache', 'proofmesh-localise')
const OUT = process.env.LOCALISE_OUT ?? path.join(HERE, 'out')
const PM_DATA = path.join(CACHE, 'pm-data')
const pinned = JSON.parse(fs.readFileSync(path.join(HERE, 'instances.json'), 'utf8'))
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const only = flag('--only')?.split(',')
const JOBS = Number(flag('--jobs') ?? 2)
const BAR = { file_k: 5, function_k: 10, margin: 10, file_floor: 60 }

/** Seeded Fisher-Yates over the sorted ids (mulberry32): how instances.json was drawn, kept so the draw can be checked. */
export function sample(ids, seed, n) {
  let a = seed
  const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const out = [...ids].sort()
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]] }
  return out.slice(0, n).sort()
}

async function datasetRows() {
  const file = path.join(CACHE, 'swe-bench-lite.json')
  if (!fs.existsSync(file)) {
    const rows = []
    for (let offset = 0; ; offset += 100) {
      const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(pinned.dataset)}&config=default&split=${pinned.split}&offset=${offset}&length=100`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url}: ${res.status}`)
      const page = (await res.json()).rows.map((r) => r.row)
      rows.push(...page)
      if (page.length < 100) break
    }
    fs.mkdirSync(CACHE, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(rows))
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString()

/** The repository at the base commit, fetched once with depth 1 into its own directory. */
function tree(inst) {
  const dir = path.join(CACHE, 'trees', inst.instance_id)
  if (!fs.existsSync(path.join(dir, '.ok'))) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q')
    git(dir, 'fetch', '-q', '--depth', '1', `https://github.com/${inst.repo}.git`, inst.base_commit)
    git(dir, 'checkout', '-q', '--detach', 'FETCH_HEAD')
    fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.ok\n')
    fs.writeFileSync(path.join(dir, '.ok'), '')
  }
  return dir
}

function functionsOf(inst, dir) {
  const file = path.join(CACHE, 'functions', `${inst.instance_id}.json`)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, execFileSync('python3', ['-I', path.join(HERE, 'functions.py'), dir], { maxBuffer: 1 << 28 }))
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')).functions.map(([file, q, s, e]) => ({ file, q, s, e }))
}

/** The gold files of a patch, and the old-side lines it changes: removed lines, and for an insertion the lines around it. */
export function patchLines(patch) {
  const files = new Map()
  let cur = null, old = 0
  for (const line of patch.split('\n')) {
    const m = /^diff --git a\/(\S+) b\//.exec(line)
    if (m) { cur = { removed: new Set(), inserts: [] }; files.set(m[1], cur); continue }
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line)
    if (h) { old = Number(h[1]); continue }
    if (!cur || line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('-')) { cur.removed.add(old); old++ }
    else if (line.startsWith('+')) { const last = cur.inserts.at(-1); if (last && last.at === old) last.text.push(line.slice(1)); else cur.inserts.push({ at: old, text: [line.slice(1)] }) }
    else if (line.startsWith(' ')) old++
  }
  return files
}

/** Gold functions: the innermost function holding a removed line, or an inserted block that is not itself a new definition. */
function goldFunctions(patch, functions) {
  const keys = new Set()
  const innermost = (file, ok) => functions.filter((f) => f.file === file && ok(f)).sort((a, b) => (a.e - a.s) - (b.e - b.s))[0]
  for (const [file, ch] of patchLines(patch)) {
    for (const ln of ch.removed) { const f = innermost(file, (f) => f.s <= ln && ln <= f.e); if (f) keys.add(`${file}::${f.q}`) }
    for (const ins of ch.inserts) {
      // `at` is the old line the block goes before: inside a function when both neighbours are, or after its last line.
      const both = innermost(file, (f) => f.s <= ins.at - 1 && ins.at <= f.e)
      const after = /^\s*(def |async def |class |@)/.test(ins.text.find((t) => t.trim()) ?? '') ? undefined : innermost(file, (f) => f.s <= ins.at - 1 && ins.at - 1 <= f.e)
      const f = both ?? after
      if (f) keys.add(`${file}::${f.q}`)
    }
  }
  return [...keys]
}

// The BM25 baseline: Okapi BM25 (k1 1.2, b 0.75) over \w+ tokens, lower-cased, the query being the whole problem statement.
const tokenize = (text) => text.toLowerCase().match(/\w+/g) ?? []
export function bm25(docs, query, k1 = 1.2, b = 0.75) {
  const tf = docs.map((d) => { const m = new Map(); for (const t of tokenize(d.text)) m.set(t, (m.get(t) ?? 0) + 1); return m })
  const len = tf.map((m) => [...m.values()].reduce((a, c) => a + c, 0))
  const avg = len.reduce((a, c) => a + c, 0) / (docs.length || 1)
  const df = new Map()
  for (const m of tf) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const q = [...new Set(tokenize(query))]
  return docs.map((d, i) => {
    let s = 0
    for (const t of q) {
      const n = tf[i].get(t)
      if (!n) continue
      const idf = Math.log(1 + (docs.length - df.get(t) + 0.5) / (df.get(t) + 0.5))
      s += idf * (n * (k1 + 1)) / (n + k1 * (1 - b + b * len[i] / avg))
    }
    return { key: d.key, score: s }
  }).filter((r) => r.score > 0).sort((x, y) => y.score - x.score || (x.key < y.key ? -1 : 1)).map((r) => r.key)
}

function baselines(inst, dir, functions, statement) {
  const file = path.join(CACHE, 'baselines', `${inst.instance_id}.json`)
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  const files = [...new Set(functions.map((f) => f.file))]
  for (const f of listPy(dir)) if (!files.includes(f)) files.push(f)
  const text = new Map(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]))
  const fileRank = bm25(files.map((f) => ({ key: f, text: text.get(f) })), statement)
  const fnRank = bm25(functions.map((f) => ({ key: `${f.file}::${f.q}`, text: text.get(f.file).split('\n').slice(f.s - 1, f.e).join('\n') })), statement)
  const out = { files: fileRank.slice(0, 10), functions: fnRank.slice(0, 10) }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(out))
  return out
}

function listPy(dir, rel = '') {
  const out = []
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.')) continue
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...listPy(dir, p))
    else if (e.name.endsWith('.py')) out.push(p)
  }
  return out
}

const PM = ['node', [path.join(ROOT, 'packages/proofmesh/bin/proofmesh.mjs'), '--data-dir', PM_DATA]]
// Call resolution off by default: Pyright takes hours on each of these trees, and the ranking must not rely on it (#27).
const PM_ENV = { ...process.env, PROOFMESH_PYRIGHT_UNANNOTATED: process.env.PROOFMESH_PYRIGHT_UNANNOTATED ?? 'off', PROOFMESH_PYRIGHT: process.env.PROOFMESH_PYRIGHT ?? 'off' }
const pm = (...a) => execFileSync(PM[0], [...PM[1], ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26, env: PM_ENV }).toString()

/** Index a tree (its snapshot is reused while the tree and ProofMesh are unchanged); resolves with the milliseconds it took. */
function index(dir) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now(), p = spawn(PM[0], [...PM[1], 'index', dir], { stdio: ['ignore', 'ignore', 'pipe'], env: PM_ENV })
    let err = ''
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
    p.on('close', (code) => (code === 0 ? resolve(Date.now() - t0) : reject(new Error(`index ${dir} exited ${code}: ${err}`))))
  })
}

/** Ask search_concepts over MCP with the problem statement. */
async function proofmesh(client, dir, statement, functions, indexMs) {
  const repos = (await client.call('list_repositories', {})).json.data.repositories
  const repo = repos.find((r) => r.root === fs.realpathSync(dir) || r.root === dir)
  const r = await client.call('search_concepts', { repository_id: repo.id, text: statement, envelope: 'full', limits: { max_rows: 50, max_bytes: 200000 } })
  if (r.isError || !r.json) throw new Error(`search_concepts failed: ${r.text.slice(0, 500)}`)
  const d = r.json.data
  // A function row is matched to the ast's by file and qualified name: ProofMesh names a Python def `<module path>:Class.method`.
  const byFile = new Map()
  for (const f of functions) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f) }
  const fnKey = (s) => {
    const local = s.qualified_name.slice(s.qualified_name.lastIndexOf(':') + 1)
    const cands = (byFile.get(s.path) ?? []).filter((f) => local === f.q || local.endsWith(`.${f.q}`))
    return cands.length ? `${s.path}::${cands.sort((a, b) => b.q.length - a.q.length)[0].q}` : null
  }
  const fns = d.symbols.filter((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'constructor').map(fnKey).filter(Boolean)
  return { files: d.files.map((f) => f.path), functions: [...new Set(fns)], index_ms: indexMs, query_ms: r.ms, bytes: r.bytes, terms_dropped: d.terms_dropped ?? 0 }
}

const hit = (ranked, gold, k) => ranked.slice(0, k).some((x) => gold.includes(x))
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0)

async function main() {
  const rows = await datasetRows()
  const ids = pinned.ids
  const drawn = sample(rows.map((r) => r.instance_id), pinned.seed, pinned.size)
  if (JSON.stringify(drawn) !== JSON.stringify(ids)) throw new Error('instances.json no longer matches the seeded draw over the dataset rows; the dataset changed')
  const byId = new Map(rows.map((r) => [r.instance_id, r]))
  const results = []
  const withPm = !args.includes('--baseline-only')
  let client
  if (withPm) {
    pm('init')
    client = new McpClient(PM[0], [...PM[1], 'mcp', '--tools', 'all'])
    await client.init()
  }
  try {
    const prepared = (only ?? ids).map((id) => {
      const inst = byId.get(id)
      if (inst.base_commit !== pinned.base_commits[id]) throw new Error(`${id}: base commit ${inst.base_commit} is not the pinned ${pinned.base_commits[id]}`)
      const dir = tree(inst)
      const functions = functionsOf(inst, dir)
      const gold = { files: [...patchLines(inst.patch).keys()], functions: goldFunctions(inst.patch, functions) }
      process.stderr.write(`${id}: prepared\n`)
      return { id, inst, dir, functions, gold, bm25: baselines(inst, dir, functions, inst.problem_statement) }
    })
    // Indexing is the long part: --jobs trees at a time, each its own repository in one data directory.
    const indexMs = new Map(), failed = new Map()
    if (withPm) {
      for (const p of prepared) pm('repo', 'add', p.dir)
      const queue = [...prepared]
      await Promise.all(Array.from({ length: JOBS }, async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          // A tree ProofMesh cannot index scores as a miss on every measure, and the results name it.
          try { indexMs.set(p.id, await index(p.dir)); process.stderr.write(`${p.id}: indexed in ${indexMs.get(p.id)} ms\n`) } catch (e) { failed.set(p.id, e.message.split('\n').find((l) => l.startsWith('proofmesh:')) ?? e.message.slice(0, 300)); process.stderr.write(`${p.id}: index failed: ${failed.get(p.id)}\n`) }
        }
      }))
    }
    for (const { id, inst, dir, functions, gold, bm25: base } of prepared) {
      const row = { id, gold, bm25: base }
      if (withPm) row.proofmesh = failed.has(id) ? { files: [], functions: [], index_failed: failed.get(id) } : await proofmesh(client, dir, inst.problem_statement, functions, indexMs.get(id))
      results.push(row)
      const show = (r) => `files@5 ${hit(r.files, gold.files, 5) ? 'hit' : 'miss'} fns@10 ${gold.functions.length ? (hit(r.functions, gold.functions, 10) ? 'hit' : 'miss') : 'n/a'}`
      process.stderr.write(`${id}: bm25 ${show(row.bm25)}${row.proofmesh ? `; proofmesh ${show(row.proofmesh)} (index ${row.proofmesh.index_ms} ms, query ${Math.round(row.proofmesh.query_ms)} ms)` : ''}\n`)
    }
  } finally {
    client?.close()
  }
  const withFns = results.filter((r) => r.gold.functions.length)
  const score = (pick) => ({
    file_acc: Object.fromEntries([1, 3, 5, 10].map((k) => [k, pct(results.filter((r) => hit(pick(r).files, r.gold.files, k)).length, results.length)])),
    function_acc: Object.fromEntries([5, 10].map((k) => [k, pct(withFns.filter((r) => hit(pick(r).functions, r.gold.functions, k)).length, withFns.length)])),
  })
  const summary = { instances: results.length, with_gold_functions: withFns.length, bm25: score((r) => r.bm25), ...(withPm ? { proofmesh: score((r) => r.proofmesh) } : {}) }
  if (withPm) {
    const p = summary.proofmesh, b = summary.bm25
    summary.bar = {
      file_acc5: { proofmesh: p.file_acc[5], needed: Math.max(BAR.file_floor, b.file_acc[5] + BAR.margin), met: p.file_acc[5] >= BAR.file_floor && p.file_acc[5] >= b.file_acc[5] + BAR.margin },
      function_acc10: { proofmesh: p.function_acc[10], needed: b.function_acc[10] + BAR.margin, met: p.function_acc[10] >= b.function_acc[10] + BAR.margin },
    }
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ summary, results }, null, 1))
  const line = (name, s) => `| ${name} | ${[1, 3, 5, 10].map((k) => s.file_acc[k]).join(' | ')} | ${s.function_acc[5]} | ${s.function_acc[10]} |`
  const md = [
    `# Localisation: ${results.length} SWE-bench Lite instances (seed ${pinned.seed})`, '',
    `Function Acc counts the ${withFns.length} instances whose gold patch changes a line inside a function.`, '',
    '| | file Acc@1 | @3 | @5 | @10 | function Acc@5 | @10 |', '|---|---|---|---|---|---|---|',
    line('BM25', summary.bm25), ...(summary.proofmesh ? [line('ProofMesh search_concepts', summary.proofmesh)] : []), '',
    ...results.filter((r) => r.proofmesh?.index_failed).map((r) => `- ${r.id}: ProofMesh could not index the tree (${r.proofmesh.index_failed}), so it scores a miss.`),
    ...(results.some((r) => r.proofmesh?.index_failed) ? [''] : []),
    ...(summary.bar ? [`Bar: file Acc@5 ${summary.bar.file_acc5.proofmesh} (needs ${summary.bar.file_acc5.needed}) ${summary.bar.file_acc5.met ? 'met' : 'MISSED'}; function Acc@10 ${summary.bar.function_acc10.proofmesh} (needs ${summary.bar.function_acc10.needed}) ${summary.bar.function_acc10.met ? 'met' : 'MISSED'}.`] : []),
  ].join('\n')
  fs.writeFileSync(path.join(OUT, 'results.md'), md + '\n')
  console.log(md)
  if (summary.bar && !(summary.bar.file_acc5.met && summary.bar.function_acc10.met)) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
