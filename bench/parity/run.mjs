// Parity benchmark (#25): ProofMesh, Graphify, scip-typescript, Serena and aider's repository map, asked the twelve
// question classes of bench/graph-bench on one pinned fixture and scored on one truth (bench/graph-bench/truth.mjs).
// Offline: no tool calls a model. A comparator that is missing, at another version or failing reads `not run: <why>`.
//
// Usage: node run.mjs --fixture <dir>   (run.sh builds the fixture). Writes out/parity.md, out/results.json, out/raw/
// (PARITY_OUT moves out/). PARITY_RUNS sets the runs each median is taken over (3).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { McpClient } from '../graph-bench/mcp-client.mjs'
import { makeTruth, score, graphifyAdapter, proofmeshAdapter, queryGraphAdapter, bfs, tarjan, last } from '../graph-bench/lib.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '../..')
const argv = process.argv.slice(2)
const FIX = path.resolve(argv[argv.indexOf('--fixture') + 1] ?? '')
if (!argv.includes('--fixture') || !fs.existsSync(path.join(FIX, 'tsconfig.json'))) { console.error('usage: node run.mjs --fixture <dir>'); process.exit(2) }
const OUT = path.resolve(process.env.PARITY_OUT ?? path.join(HERE, 'out'))
const RUNS = Number(process.env.PARITY_RUNS ?? 3)
const PM_DATA = path.join(OUT, 'pm-data')
const PIN = { graphify: '0.9.108', 'scip-typescript': '0.3.15', scip: '0.10.0', serena: '2.1.0', aider: '0.86.2' }
const EDIT_FILE = 'src/error/TypeORMError.ts'
fs.rmSync(path.join(OUT, 'raw'), { recursive: true, force: true })
fs.mkdirSync(path.join(OUT, 'raw'), { recursive: true })
const raw = (name, data) => fs.writeFileSync(path.join(OUT, 'raw', name), typeof data === 'string' ? data : JSON.stringify(data, null, 1))
const Q = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf8')).questions
const log = (s) => console.error(`parity: ${s}`)
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts })
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : null }
const du = (p) => (fs.existsSync(p) ? Number(run('du', ['-sk', p]).stdout.split('\t')[0]) * 1024 : 0)
const mb = (bytes) => (bytes == null ? '-' : `${Math.round(bytes / 1048576)} MB`)
const s = (ms) => (ms == null ? '-' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)
// Peak RSS of the largest process in the tree, from /usr/bin/time (BSD -l prints bytes, GNU -v prints kbytes).
const TIMEV = os.platform() === 'darwin' ? '-l' : '-v'
const rssOf = (err) => { const b = /(\d+)\s+maximum resident set size/.exec(err); const g = /Maximum resident set size \(kbytes\): (\d+)/.exec(err); return b ? Number(b[1]) : g ? Number(g[1]) * 1024 : null }
function timed(cmd, args, opts = {}) {
  const t0 = performance.now(); const r = run('/usr/bin/time', [TIMEV, cmd, ...args], { cwd: FIX, ...opts })
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0] ?? ''} exited ${r.status}: ${(r.stderr || r.stdout || String(r.error)).trim().split('\n').slice(-3).join(' ')}`)
  return { ms: performance.now() - t0, rss: rssOf(r.stderr), stdout: r.stdout }
}
const versionOf = (cmd, args = ['--version']) => { const r = run(cmd, args); return r.status === 0 ? /\d+\.\d+\.\d+/.exec(r.stdout + r.stderr)?.[0] ?? null : null }
// A comparator runs only at its pinned version (FR-002); anything else is a reason it did not run.
function pinned(name, cmd = name) {
  const v = versionOf(cmd)
  if (!v) return { reason: `${name} is not installed (sh bench/parity/install.sh)` }
  return v === PIN[name] ? { version: v } : { reason: `${name} ${v} is not the pinned ${PIN[name]}` }
}

// ---------- fixture and truth ----------
const fixtureCommit = /^Commit: (\S+)/m.exec(fs.readFileSync(path.join(FIX, 'PROVENANCE'), 'utf8'))?.[1] ?? 'unknown'
const git = (...args) => run('git', ['-C', FIX, ...args])
const CACHES = ['graphify-out/', '.serena/', '.aider.tags.cache.v4/']
const exclude = path.join(FIX, '.git/info/exclude')
const excluded = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
fs.appendFileSync(exclude, CACHES.filter((c) => !excluded.split('\n').includes(c)).map((c) => c + '\n').join(''))
log('truth (TypeScript checker)')
const tr = run('node', [path.join(ROOT, 'bench/graph-bench/truth.mjs'), FIX, path.join(OUT, 'truth.json')])
if (tr.status !== 0) throw new Error(`truth.mjs failed: ${tr.stderr}`)
const truth = makeTruth(JSON.parse(fs.readFileSync(path.join(OUT, 'truth.json'), 'utf8')))
const { T, truthFor, callKeys, srcFiles } = truth
const fileOf = (key) => key.split('::')[0]

// ---------- costs: full build, no-change re-index, one edit; medians of RUNS ----------
let editTag = 0
function edit() {
  const f = path.join(FIX, EDIT_FILE)
  const before = fs.readFileSync(f, 'utf8'), after = before.replace('super(message)\n', `super(message)\n        const parityEdit = "parity ${Date.now()}-${editTag++}"\n`)
  if (after === before) throw new Error(`${EDIT_FILE} has no \`super(message)\` line to add the statement after`)
  fs.writeFileSync(f, after)
}
const restore = () => git('checkout', '--', EDIT_FILE)
function costs(tool) {
  const full = [], rss = [], nochange = [], edited = []
  for (let i = 0; i < RUNS; i++) { tool.cold(); const r = timed(...tool.build()); full.push(tool.ms?.(r) ?? r.ms); rss.push(r.rss) }
  const disk = du(tool.store)
  for (let i = 0; i < RUNS; i++) { const r = timed(...tool.build()); nochange.push(tool.ms?.(r) ?? r.ms) }
  for (let i = 0; i < RUNS; i++) {
    edit()
    try { const r = timed(...tool.build()); edited.push(tool.ms?.(r) ?? r.ms) } finally { restore() }
    timed(...tool.build()) // back to the committed tree, so the questions are asked of it
  }
  return { full_ms: median(full), peak_rss: Math.max(0, ...rss.filter(Boolean)) || null, disk, nochange_ms: median(nochange), edit_ms: median(edited), runs: { full, nochange, edited } }
}

// ---------- ProofMesh ----------
const PM_BIN = path.join(ROOT, 'packages/proofmesh/bin/proofmesh.mjs')
const pmArgs = (...a) => [PM_BIN, '--data-dir', PM_DATA, ...a]
async function runProofMesh() {
  const tool = {
    store: PM_DATA,
    cold() { fs.rmSync(PM_DATA, { recursive: true, force: true }); run('node', pmArgs('init')); run('node', pmArgs('repo', 'add', FIX)) },
    build: () => ['node', pmArgs('index', FIX)],
  }
  const cost = costs(tool)
  const pm = new McpClient('node', pmArgs('mcp'), { cwd: FIX })
  const t0 = performance.now(); await pm.init(); const startMs = performance.now() - t0
  const tools = await pm.tools()
  const ask = proofmeshAdapter(pm, PM_DATA, truth, raw)
  const answers = {}
  for (const q of Q) answers[q.id] = { ...(await ask(q)), ...(['dead_code', 'cycles', 'roots'].includes(q.kind) ? { mark: 'data' } : {}) }
  pm.close()
  // The same twelve questions, each as one query_graph query (#36), from a server that lists the extra profile; asked RUNS times each.
  const pmx = new McpClient('node', pmArgs('mcp', '--tools', 'extra'), { cwd: FIX })
  await pmx.init()
  const query = queryGraphAdapter(pmx, truth, raw, RUNS)
  const query_graph = {}
  for (const q of Q) query_graph[q.id] = await query(q)
  pmx.close()
  return { cost, answers, query_graph, tools_list_bytes: Buffer.byteLength(JSON.stringify(tools)), tools: tools.length, startup_ms: startMs }
}

// ---------- Graphify (CLI, code-only update) ----------
function runGraphify() {
  const store = path.join(FIX, 'graphify-out')
  const cost = costs({ store, cold: () => fs.rmSync(store, { recursive: true, force: true }), build: () => ['graphify', ['update', FIX]] })
  const ask = graphifyAdapter(FIX, truth)
  const answers = {}
  for (const q of Q) { const a = ask(q); if (a.out) raw(`graphify-${q.id}.txt`, `$ ${a.cmd}\n${a.out}`); answers[q.id] = { ...a, ...(a.graph_level ? { mark: 'data' } : {}) } }
  return { cost, answers, tools_list_bytes: null, transport: 'CLI' }
}

// ---------- scip-typescript, read with `scip print --json` ----------
// Each non-definition occurrence is attributed to the innermost non-local definition whose enclosing range holds it;
// implementations come from is_implementation relationships. Nothing the index returns is filtered.
function scipIndex(json) {
  const rootPrefix = decodeURIComponent(new URL(json.metadata.project_root).pathname).replace(/^\//, '') + '/'
  const parse = (sym) => {
    if (sym.startsWith('local ')) return null
    const m = /^(.*)`([^`]+\.[cm]?[jt]sx?)`\/(.*)$/.exec(sym.split(' ').slice(4).join(' '))
    if (!m) return null
    const file = (m[1].replace(/`/g, '') + m[2]).replace(rootPrefix, '')
    if (m[3] === '') return { file, name: '<module>', module: true, desc: '' }
    if (/[)\]]$/.test(m[3])) return null // a parameter or a type parameter
    const name = m[3].match(/`[^`]+`|[\w$]+/g)?.at(-1)?.replace(/`/g, '')
    return { file, name: name === '<constructor>' ? 'constructor' : name.replace(/^<[gs]et>/, ''), desc: m[3].replace(/`/g, '') }
  }
  const pos = (r) => [r[0], r[1]]
  const end = (r) => (r.length === 4 ? [r[2], r[3]] : [r[0], r[2]])
  const le = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])
  const info = new Map(), refs = new Map(), impls = new Map()
  for (const doc of json.documents) {
    for (const si of doc.symbols ?? []) for (const rel of si.relationships ?? []) if (rel.is_implementation) { if (!impls.has(rel.symbol)) impls.set(rel.symbol, new Set()); impls.get(rel.symbol).add(si.symbol) }
    const defs = []
    for (const o of doc.occurrences ?? []) { const p = parse(o.symbol); if (p) info.set(o.symbol, p); if ((o.symbol_roles ?? 0) & 1 && o.enclosing_range && p) defs.push(o) }
    for (const o of doc.occurrences ?? []) {
      if ((o.symbol_roles ?? 0) & 1 || !parse(o.symbol)) continue
      let best = null
      for (const d of defs) if (le(pos(d.enclosing_range), pos(o.range)) && le(end(o.range), end(d.enclosing_range)) && (!best || le(pos(best.enclosing_range), pos(d.enclosing_range)))) best = d
      if (!refs.has(o.symbol)) refs.set(o.symbol, [])
      refs.get(o.symbol).push({ file: doc.relative_path, line: o.range[0] + 1, from: best?.symbol ?? null })
    }
  }
  const key = (sym) => { const p = info.get(sym); return p ? `${p.file}::${p.name}` : null }
  const find = (file, qname) => [...info.entries()].find(([, p]) => p.file === file && (qname ? p.desc.replace(/\(\)\.$|[.#]$/, '').replace('#', '.') === qname : p.module))?.[0]
  return { info, refs, impls, key, find }
}
function runScip() {
  const dir = path.join(OUT, 'scip'), index = path.join(dir, 'index.scip')
  const cost = costs({ store: dir, cold: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir) }, build: () => ['scip-typescript', ['index', '--cwd', FIX, '--output', index, '--no-progress-bar']] })
  const t0 = performance.now()
  const S = scipIndex(JSON.parse(run('scip', ['print', '--json', index]).stdout))
  const decodeMs = performance.now() - t0
  const callersOf = (sym) => S.refs.get(sym) ?? []
  const modules = new Map([...S.info].filter(([, p]) => p.module).map(([sym, p]) => [p.file, sym]))
  const importers = new Map([...modules].map(([file, sym]) => [file, new Set(callersOf(sym).map((r) => r.file).filter((f) => f !== file))]))
  const answers = {}
  for (const q of Q) {
    const t = q.target ? S.find(q.target.file, q.target.qname) : null
    const a = (() => {
      switch (q.kind) {
        case 'callers': { const rows = callersOf(t); return { answer: new Set(rows.map((r) => (r.from ? S.key(r.from) : `${r.file}::<module>`))), sites: new Set(rows.map((r) => `${r.file}:${r.line}`)), files: new Set(rows.map((r) => r.file)) } }
        case 'implementations': return { answer: new Set([...(S.impls.get(t) ?? [])].map(S.key).filter(Boolean)) }
        case 'importers': return { answer: importers.get(q.target.file) ?? new Set() }
        case 'dependents': return { answer: new Set(bfs(q.target.file, importers).keys()), mark: 'derived' }
        case 'transitive_callers': {
          const adj = { get: (sym) => callersOf(sym).map((r) => r.from).filter(Boolean) }
          return { answer: new Set([...bfs(t, adj, q.depth).keys()].map(S.key)), mark: 'derived' }
        }
        case 'path': {
          const out = new Map(); for (const [to, rows] of S.refs) for (const r of rows) if (r.from) { if (!out.has(r.from)) out.set(r.from, new Set()); out.get(r.from).add(to) }
          const src = S.find(q.source.file, q.source.qname); const prev = new Map([[src, null]]); let frontier = [src]
          while (frontier.length && !prev.has(t)) { const next = []; for (const x of frontier) for (const y of out.get(x) ?? []) if (!prev.has(y)) { prev.set(y, x); next.push(y) } frontier = next }
          const keys = []; for (let x = prev.has(t) ? t : null; x; x = prev.get(x)) keys.unshift(S.key(x))
          return { path_hops: keys.length ? keys.length - 1 : null, path_valid: keys.length > 1 && keys.every((k, i) => i === 0 || callKeys.has(`${keys[i - 1]}->${k}`)), path_text: keys.join(' -> '), mark: 'derived' }
        }
        case 'type_users': return { answer: new Set(callersOf(t).map((r) => r.file)) }
        case 'dead_code': return { answer: new Set([...S.info].filter(([sym, p]) => p.file.startsWith(q.scope) && /^[\w$]+\(\)\.$/.test(p.desc) && !callersOf(sym).some((r) => r.from !== sym)).map(([sym]) => S.key(sym))), mark: 'data' }
        case 'cycles': { const adj = new Map(); for (const [to, from] of importers) for (const f of from) { if (!adj.has(f)) adj.set(f, new Set()); adj.get(f).add(to) } return { answer: new Set(tarjan(new Set(srcFiles), adj).flat()), mark: 'data' } }
        case 'roots': { const imported = new Set([...importers].filter(([, from]) => [...from].some((f) => f.startsWith(q.scope))).map(([to]) => to)); return { answer: new Set(srcFiles.filter((f) => modules.has(f) && !imported.has(f))), mark: 'data' } }
      }
    })()
    answers[q.id] = { ...a, ms: null, bytes: null }
  }
  return { cost, answers, tools_list_bytes: null, transport: 'index file', decode_ms: decodeMs }
}

// ---------- Serena (language servers over MCP) ----------
// find_referencing_symbols and find_implementations. A referencing callback or local is mapped to its enclosing named
// member, as the truth names callers; Serena's 0-based lines are converted.
const SERENA_ARGS = ['start-mcp-server', '--context', 'claude-code', '--agent-interface', 'tools', '--project', FIX, '--enable-web-dashboard', 'false', '--open-web-dashboard', 'false', '--enable-gui-log-window', 'false']
function serenaCaller(namePath, kind) {
  let parts = namePath.split('/').map((p) => p.replace(/\[\d+\]$/, ''))
  const anon = parts.findIndex((p) => p.startsWith('<') || p.includes('('))
  if (anon >= 0) parts = parts.slice(0, anon)
  // A top-level symbol or its member names a caller; anything deeper is a local of that member, and a top-level
  // symbol's own local variable stands for that symbol.
  if (parts.length > 2) parts = parts.slice(0, 2)
  else if (anon < 0 && (kind === 'Variable' || kind === 'Constant') && parts.length === 2) parts.pop()
  return { name: kind === 'File' || !parts.length ? '<module>' : parts.at(-1), namePath: parts.join('/') }
}
// Serena cuts an answer past its configured size to a summary; the whole answer is asked for, as for every tool.
const MAX_CHARS = 100_000_000
const parseJson = (text) => { try { return JSON.parse(text) } catch { return null } }
async function runSerena() {
  const c = new McpClient('/usr/bin/time', [TIMEV, 'serena', ...SERENA_ARGS], { cwd: FIX })
  const t0 = performance.now(); await c.init(); const startMs = performance.now() - t0
  const tools = await c.tools()
  const refsOf = async (namePath, file) => {
    const r = await c.call('find_referencing_symbols', { name_path: namePath, relative_path: file, max_answer_chars: MAX_CHARS })
    const json = parseJson(r.text)
    if (r.isError || !json) throw new Error(`find_referencing_symbols ${namePath}: ${r.text.slice(0, 200)}`)
    const rows = []
    for (const [f, kinds] of Object.entries(json)) for (const [kind, list] of Object.entries(kinds)) for (const x of list) {
      const line = /^\s*>\s*(\d+):/m.exec(x.content_around_reference ?? '')
      rows.push({ file: f, line: line ? Number(line[1]) + 1 : null, ...serenaCaller(x.name_path, kind) })
    }
    return { rows, ms: r.ms, bytes: r.bytes }
  }
  const np = (qname) => qname.replace(/\./g, '/')
  const answers = {}
  for (const q of Q) {
    try { answers[q.id] = await serenaAnswer(q) } catch (e) { answers[q.id] = { error: String(e.message ?? e) } }
  }
  async function serenaAnswer(q) {
    switch (q.kind) {
      case 'callers': { const r = await refsOf(np(q.target.qname), q.target.file); return { answer: new Set(r.rows.map((x) => `${x.file}::${x.name}`)), sites: new Set(r.rows.filter((x) => x.line).map((x) => `${x.file}:${x.line}`)), files: new Set(r.rows.map((x) => x.file)), ms: r.ms, bytes: r.bytes } }
      case 'type_users': { const r = await refsOf(np(q.target.qname), q.target.file); return { answer: new Set(r.rows.map((x) => x.file)), ms: r.ms, bytes: r.bytes } }
      case 'implementations': {
        const r = await c.call('find_implementations', { name_path: np(q.target.qname), relative_path: q.target.file, max_answer_chars: MAX_CHARS })
        const json = parseJson(r.text)
        if (r.isError || !Array.isArray(json)) throw new Error(`find_implementations: ${r.text.slice(0, 200)}`)
        return { answer: new Set(json.map((x) => `${x.relative_path}::${x.name_path.split('/').at(-1).replace(/\[\d+\]$/, '')}`)), ms: r.ms, bytes: r.bytes }
      }
      case 'transitive_callers': {
        // No tool reaches past one hop: the harness repeats find_referencing_symbols from each caller found.
        const seen = new Map(); let frontier = [{ namePath: np(q.target.qname), file: q.target.file }], ms = 0, bytes = 0
        for (let d = 0; d < q.depth && frontier.length; d++) {
          const next = []
          for (const f of frontier) {
            const r = await refsOf(f.namePath, f.file); ms += r.ms; bytes += r.bytes
            for (const x of r.rows) { const k = `${x.file}::${x.name}`; if (x.name !== '<module>' && !seen.has(k)) { seen.set(k, x); next.push({ namePath: x.namePath, file: x.file }) } }
          }
          frontier = next
        }
        return { answer: new Set(seen.keys()), ms, bytes, mark: 'derived' }
      }
      default: return { none: true }
    }
  }
  c.proc.stdin.end()
  await Promise.race([once(c.proc, 'exit'), new Promise((r) => setTimeout(r, 30000).unref())])
  c.close()
  const peak = rssOf(c.stderr)
  return { cost: { live: true, peak_rss: peak, disk: du(path.join(FIX, '.serena')) }, answers, tools_list_bytes: Buffer.byteLength(JSON.stringify(tools)), tools: tools.length, startup_ms: startMs }
}

// ---------- aider's repository map ----------
// Scored as context: the share of the truth's files its map names, at 1,024 and 4,096 tokens, inbound (callers,
// importers, implementers, type users) and outbound (the target file's imports).
const AIDER_TOKENS = [1024, 4096]
function aiderPython() {
  const bin = run('sh', ['-c', 'command -v aider']).stdout.trim()
  const shebang = bin && fs.readFileSync(bin, 'utf8').split('\n')[0]
  return shebang?.startsWith('#!') ? shebang.slice(2).trim() : null
}
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1)) // aider prints notices before the result
function runAider() {
  const py = aiderPython()
  if (!py) throw new Error('aider has no Python interpreter to run its RepoMap')
  const files = git('ls-files').stdout
  const maps = (jobs) => {
    const r = run(py, ['-I', path.join(HERE, 'aider-map.py'), FIX], { cwd: FIX, input: JSON.stringify(jobs) + '\n' + files })
    if (r.status !== 0) throw new Error(`aider-map.py exited ${r.status}: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`)
    return lastJson(r.stdout)
  }
  const store = path.join(FIX, '.aider.tags.cache.v4')
  const job = [{ file: EDIT_FILE, ident: 'TypeORMError', tokens: 1024 }]
  // The map's own time, read from the run; Python start-up is not index building.
  const cost = costs({ store, cold: () => fs.rmSync(store, { recursive: true, force: true }), build: () => [py, ['-I', path.join(HERE, 'aider-map.py'), FIX], { input: JSON.stringify(job) + '\n' + files }], ms: (r) => lastJson(r.stdout)[0].ms })
  const asked = Q.filter((q) => q.target && q.kind !== 'path')
  const jobs = asked.flatMap((q) => AIDER_TOKENS.map((tokens) => ({ file: q.target.file, ident: q.target.qname ? last(q.target.qname) : path.basename(q.target.file).replace(/\.\w+$/, ''), tokens })))
  const res = maps(jobs)
  const answers = {}
  for (const q of Q) {
    const i = asked.indexOf(q)
    if (i < 0) { answers[q.id] = { none: true }; continue }
    const t = truthFor(q)
    const inbound = new Set([...t.items].map((k) => (k.includes('::') ? fileOf(k) : k)))
    const outbound = new Set(T.imports.filter((x) => x.from === q.target.file).map((x) => x.to))
    const ctx = AIDER_TOKENS.map((tokens, j) => {
      const m = res[i * AIDER_TOKENS.length + j]
      raw(`aider-${q.id}-${tokens}.txt`, m.map)
      const named = new Set(m.map.split('\n').filter((l) => /^\S.*:$/.test(l)).map((l) => l.slice(0, -1)))
      const share = (set) => (set.size ? [...set].filter((f) => named.has(f)).length / set.size : null)
      return { tokens, inbound: share(inbound), outbound: share(outbound), ms: m.ms, bytes: Buffer.byteLength(m.map) }
    })
    answers[q.id] = { context: ctx, ms: ctx[0].ms, bytes: ctx[0].bytes }
  }
  return { cost, answers, tools_list_bytes: null, transport: 'Python API' }
}

// ---------- run every tool ----------
const pmCommit = run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']).stdout.trim()
const pmVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/proofmesh/package.json'), 'utf8')).version
const TOOLS = [
  { id: 'proofmesh', label: 'ProofMesh', check: () => ({ version: `${pmVersion} @ ${pmCommit}` }), run: runProofMesh },
  { id: 'graphify', label: 'Graphify', check: () => pinned('graphify'), run: runGraphify },
  { id: 'scip', label: 'scip-typescript', check: () => { const a = pinned('scip-typescript'); const b = pinned('scip'); return a.reason || b.reason ? { reason: [a.reason, b.reason].filter(Boolean).join('; ') } : { version: `${a.version} (scip CLI ${b.version})` } }, run: runScip },
  { id: 'serena', label: 'Serena', check: () => { const r = pinned('serena'); return r.version ? { version: `${r.version} (claude-code context, tools interface)` } : r }, run: runSerena },
  { id: 'aider', label: 'aider', check: () => pinned('aider'), run: runAider },
]
const results = {}
for (const tool of TOOLS) {
  const c = tool.check()
  if (c.reason) { results[tool.id] = { not_run: c.reason }; log(`${tool.label}: not run: ${c.reason}`); continue }
  log(`${tool.label} ${c.version}`)
  try { results[tool.id] = { version: c.version, ...(await tool.run()) } } catch (e) {
    if (tool.id === 'proofmesh') throw e
    results[tool.id] = { version: c.version, not_run: String(e.message ?? e).replace(/\s+/g, ' ').slice(0, 200) }
    log(`${tool.label}: not run: ${results[tool.id].not_run}`)
  } finally { restore() }
}
const status = git('status', '--porcelain').stdout.trim()

// ---------- score and write ----------
const short = (text) => (text.length > 120 ? `${text.slice(0, 117)}...` : text).replace(/\|/g, '\\|')
const pct = (x) => (x == null ? '-' : String(Math.round(x * 100)))
const pc = (x) => (x == null ? '-' : `${pct(x)}%`)
const rp = (sc) => `${pct(sc.recall)} / ${pct(sc.precision)}`
function cell(toolId, q) {
  const r = results[toolId]
  if (r.not_run) return `not run: ${short(r.not_run)}`
  const a = r.answers[q.id]
  if (!a || a.none) return 'no tool'
  if (a.error) return `error: ${short(a.error)}`
  const mark = a.mark ? ` (${a.mark})` : ''
  if (a.context) return a.context.map((c) => `${c.tokens / 1024}k: in ${pc(c.inbound)} out ${pc(c.outbound)}`).join('; ')
  if (q.kind === 'path') return `${a.path_valid ? 'valid' : 'invalid'} ${a.path_hops ?? '-'} hops (shortest ${truthFor(q).shortest})${mark}`
  return `${rp(score(truthFor(q).items, a.answer))}${mark}`
}
const scored = Q.map((q) => {
  const t = truthFor(q)
  const row = { id: q.id, kind: q.kind, ask: q.ask, truth_n: t.items?.size ?? null, shortest: t.shortest ?? null }
  for (const tool of TOOLS) {
    const a = results[tool.id].answers?.[q.id]
    row[tool.id] = { cell: cell(tool.id, q), ms: a?.ms ?? null, bytes: a?.bytes ?? null, ...(a?.answer ? score(t.items, a.answer) : {}), ...(a?.sites && t.sites ? { sites: score(t.sites, a.sites), files: score(t.files, a.files) } : {}), ...(a?.context ? { context: a.context } : {}) }
  }
  return row
})
const meta = { fixture: `typeorm @ ${fixtureCommit} (src/, ${T.files.length} files)`, proofmesh: `${pmVersion} @ ${pmCommit}`, truth: `${T.tool} ${T.ts_version}`, runs: RUNS, when: new Date().toISOString(), machine: `${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0]?.model ?? ''} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, Node ${process.version}`, fixture_clean: status === '', fixture_status: status }
// query_graph beside the typed tools: its score on the truth, whether its items equal the typed answer's, and its time (#36).
const pmr = results.proofmesh
const qg = Q.map((q) => {
  const a = pmr.query_graph[q.id], typed = pmr.answers[q.id], t = truthFor(q)
  const same = a.error ? 'error' : q.kind === 'path' ? (a.path_hops === typed.path_hops && a.path_valid === typed.path_valid ? 'yes' : `no (${typed.path_hops} hops)`)
    : (() => { const extra = [...a.answer].filter((x) => !typed.answer.has(x)).length, missing = [...typed.answer].filter((x) => !a.answer.has(x)).length; return extra || missing ? `no (+${extra} −${missing})` : 'yes' })()
  const cellOf = () => a.error ? `error: ${short(a.error)}` : q.kind === 'path' ? `${a.path_valid ? 'valid' : 'invalid'} ${a.path_hops ?? '-'} hops (shortest ${t.shortest})` : `${rp(score(t.items, a.answer))}${a.cut ? ' (cut)' : ''}`
  return { id: q.id, kind: q.kind, query: a.query, cell: cellOf(), same, ms: a.ms, all_ms: a.all_ms, bytes: a.bytes, ...(a.answer ? score(t.items, a.answer) : {}) }
})
const allMs = qg.flatMap((r) => r.all_ms ?? []).sort((a, b) => a - b)
const p95 = allMs.length ? allMs[Math.ceil(allMs.length * 0.95) - 1] : null
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, query_graph: { questions: qg, p95_ms: p95 }, tools: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ...v, answers: undefined }])), questions: scored }, (k, v) => (v instanceof Set ? [...v] : v), 1))

const head = `| Q | class | truth | ${TOOLS.map((t) => t.label).join(' | ')} |`
const sep = `|---|---|---|${TOOLS.map(() => '---|').join('')}`
const quality = Q.map((q, i) => `| ${q.id} | ${q.kind} | ${scored[i].truth_n ?? `shortest ${scored[i].shortest}`} | ${TOOLS.map((t) => scored[i][t.id].cell).join(' | ')} |`)
const levels = scored.filter((r) => r.kind === 'callers').map((r) => `| ${r.id} | ${TOOLS.filter((t) => t.id !== 'aider').map((t) => (r[t.id].sites ? `${rp(r[t.id])} · ${rp(r[t.id].sites)} · ${rp(r[t.id].files)}` : r[t.id].cell)).join(' | ')} |`)
const costCell = (r, f) => (r.not_run ? 'not run' : r.cost?.live ? 'live' : f(r.cost))
const costRows = [
  ['Full build', (c) => s(c.full_ms)],
  ['Peak memory (largest process)', (c) => mb(c.peak_rss)],
  ['Disk (own store)', (c) => mb(c.disk)],
  ['No-change re-index', (c) => s(c.nochange_ms)],
  [`One edit (a statement in the constructor of ${EDIT_FILE})`, (c) => s(c.edit_ms)],
].map(([label, f]) => `| ${label} | ${TOOLS.map((t) => { const r = results[t.id]; if (!r.not_run && r.cost?.live && label.startsWith('Peak')) return `${mb(r.cost.peak_rss)} (server and language server, whole session)`; if (!r.not_run && r.cost?.live && label.startsWith('Disk')) return mb(r.cost.disk); return costCell(r, f) }).join(' | ')} |`)
const range = (xs) => { const v = xs.filter((x) => x != null); return v.length ? `${Math.round(Math.min(...v))}–${Math.round(Math.max(...v))}` : '-' }
const perQ = (field) => TOOLS.map((t) => (results[t.id].not_run ? 'not run' : t.id === 'scip' ? `n/a (decode ${s(results.scip.decode_ms)} once)` : range(scored.filter((r) => Number(r.id.slice(1)) <= 9).map((r) => r[t.id][field]))))
costRows.push(`| ms per question, Q1–Q9 | ${perQ('ms').join(' | ')} |`, `| bytes per answer, Q1–Q9 | ${perQ('bytes').join(' | ')} |`)
costRows.push(`| \`tools/list\` bytes (MCP) | ${TOOLS.map((t) => { const r = results[t.id]; return r.not_run ? 'not run' : r.tools_list_bytes != null ? `${r.tools_list_bytes} (${r.tools} tools)` : r.transport }).join(' | ')} |`)
const md = [
  '# Parity benchmark',
  '',
  `Fixture: ${meta.fixture}. ProofMesh ${meta.proofmesh}. Truth: ${meta.truth}. Run ${meta.when.slice(0, 10)} on ${meta.machine}.`,
  '',
  `Versions: ${TOOLS.map((t) => `${t.label} ${results[t.id].version ?? `not run (${results[t.id].not_run})`}`).join('; ')}.`,
  '',
  '## Quality: recall / precision (%)',
  '',
  head, sep, ...quality,
  '',
  '(derived): computed by the harness from an index that has no query for it. (data): computed from stored data; no tool answers it. aider is scored as context: the share of the truth\'s files its map names, inbound and outbound, at 1k and 4k tokens.',
  '',
  '## Callers at three levels: items · `file:line` sites · files',
  '',
  `| Q | ${TOOLS.filter((t) => t.id !== 'aider').map((t) => t.label).join(' | ')} |`, `|---|${TOOLS.filter((t) => t.id !== 'aider').map(() => '---|').join('')}`, ...levels,
  '',
  '## ProofMesh through query_graph: one query per question (#36)',
  '',
  'Each question as one read-only query (extra profile), scored on the same truth, beside the typed tools\' answer. The queries are in `bench/graph-bench/lib.mjs` (`queryGraphQuery`) and each answer in `out/raw/pm-query-<Q>.txt`.',
  '',
  '| Q | class | ProofMesh (typed tools) | ProofMesh query_graph | same items as typed | ms (median) |', '|---|---|---|---|---|---|',
  ...qg.map((r, i) => `| ${r.id} | ${r.kind} | ${scored[i].proofmesh.cell} | ${r.cell} | ${r.same} | ${r.ms == null ? '-' : Math.round(r.ms)} |`),
  '',
  `query_graph p95 over Q1–Q12, ${RUNS} run${RUNS === 1 ? '' : 's'} each: ${p95 == null ? '-' : `${Math.round(p95)} ms`} (target 500 ms).`,
  '',
  `## Cost (medians of ${RUNS} runs)`,
  '',
  `| | ${TOOLS.map((t) => t.label).join(' | ')} |`, `|---|${TOOLS.map(() => '---|').join('')}`, ...costRows,
  '',
  `Fixture after the edit step: ${meta.fixture_clean ? 'clean' : `NOT clean: ${status.replace(/\n/g, ', ')}`} (tool caches ${CACHES.join(', ')} are in .git/info/exclude).`,
  '',
].join('\n')
fs.writeFileSync(path.join(OUT, 'parity.md'), md)
console.log(md)
