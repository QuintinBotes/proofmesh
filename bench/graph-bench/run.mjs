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

// ---------- ground truth ----------
const T = JSON.parse(fs.readFileSync(TRUTH, 'utf8'))
const sym = new Map(T.symbols.map((s) => [s.id, s]))
const last = (q) => q.split('.').pop()
const tKey = (id) => { const s = sym.get(id); return s ? `${s.file}::${s.kind === 'module' ? '<module>' : last(s.qname)}` : `${id.split('#')[0]}::<module>` }
const tFind = (file, qname) => T.symbols.find((s) => s.file === file && s.qname === qname && s.kind !== 'module')?.id
const group = (rows, k, v) => { const m = new Map(); for (const r of rows) { const a = r[k]; if (!m.has(a)) m.set(a, new Set()); m.get(a).add(r[v]) } return m }
const callIn = group(T.calls, 'callee', 'caller')
const callOut = group(T.calls, 'caller', 'callee')
const impIn = group(T.imports, 'to', 'from')
const srcFiles = T.files.filter((f) => f.startsWith('src/'))
const callKeys = new Set(T.calls.map((c) => `${tKey(c.caller)}->${tKey(c.callee)}`))
const callNames = new Set(T.calls.map((c) => `${tKey(c.caller).split('::')[1]}->${tKey(c.callee).split('::')[1]}`))
function bfs(start, adj, maxDepth = Infinity) {
  const seen = new Map([[start, 0]]); let frontier = [start]
  while (frontier.length) { const next = []; for (const x of frontier) { const d = seen.get(x); if (d >= maxDepth) continue; for (const y of adj.get(x) ?? []) if (!seen.has(y)) { seen.set(y, d + 1); next.push(y) } } frontier = next }
  seen.delete(start); return seen
}
function tarjan(nodes, adj) {
  let i = 0; const idx = new Map(), low = new Map(), on = new Set(), st = [], out = []
  const sc = (v) => { idx.set(v, i); low.set(v, i); i++; st.push(v); on.add(v)
    for (const w of adj.get(v) ?? []) { if (!nodes.has(w)) continue; if (!idx.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))) } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w))) }
    if (low.get(v) === idx.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w) } while (w !== v); if (c.length > 1) out.push(c) } }
  for (const v of nodes) if (!idx.has(v)) sc(v)
  return out
}
function truthFor(q) {
  const s = q.target?.qname ? tFind(q.target.file, q.target.qname) : null
  switch (q.kind) {
    case 'callers': { const rows = T.calls.filter((c) => c.callee === s); return { items: new Set(rows.map((c) => tKey(c.caller))), files: new Set(rows.map((c) => c.file)), sites: new Set(rows.map((c) => `${c.file}:${c.line}`)), pairs: new Set(rows.map((c) => `${tKey(c.caller)} ${c.file}:${c.line}`)) } }
    case 'implementations': return { items: new Set(T.heritage.filter((h) => h.to === s && h.kind === 'implements').map((h) => tKey(h.from))) }
    case 'importers': return { items: new Set(impIn.get(q.target.file) ?? []) }
    case 'dependents': return { items: new Set(bfs(q.target.file, impIn).keys()) }
    case 'transitive_callers': return { items: new Set([...bfs(s, callIn, q.depth).keys()].map(tKey)) }
    case 'path': { const d = bfs(tFind(q.source.file, q.source.qname), callOut).get(s); return { shortest: d ?? null } }
    case 'type_users': return { items: new Set(T.refs.filter((r) => r.to === s && r.file !== q.target.file).map((r) => r.file)) }
    case 'dead_code': {
      const used = new Set(); for (const r of T.refs) if (r.from !== r.to) used.add(r.to); for (const c of T.calls) if (c.caller !== c.callee) used.add(c.callee)
      return { items: new Set(T.symbols.filter((x) => x.kind === 'function' && x.file.startsWith(q.scope) && !x.qname.includes('.') && !used.has(x.id)).map((x) => tKey(x.id))) }
    }
    case 'cycles': { const adj = group(T.imports, 'from', 'to'); return { items: new Set(tarjan(new Set(srcFiles), adj).flat()) } }
    case 'roots': return { items: new Set(srcFiles.filter((f) => ![...(impIn.get(f) ?? [])].some((x) => x.startsWith(q.scope)))) }
  }
}

// ---------- scoring ----------
function score(truth, answer) {
  if (!answer) return { recall: null, precision: null }
  const hit = [...answer].filter((x) => truth.has(x)).length
  return { hits: hit, recall: truth.size ? hit / truth.size : (answer.size ? 0 : 1), precision: answer.size ? hit / answer.size : (truth.size ? null : 1), n_truth: truth.size, n_answer: answer.size, missed: [...truth].filter((x) => !answer.has(x)).slice(0, 15), extra: [...answer].filter((x) => !truth.has(x)).slice(0, 15) }
}

// ---------- Graphify ----------
const G = JSON.parse(fs.readFileSync(path.join(REPO, 'graphify-out/graph.json'), 'utf8'))
const gNode = new Map(G.nodes.map((n) => [n.id, n]))
const FILE_LABEL = /\.(m?[jt]sx?|json|md|ya?ml|sh)$/
const gNorm = (label) => (FILE_LABEL.test(label) ? '<module>' : label.replace(/\(\)$/, '').replace(/^\./, '').split('.').pop())
const gKey = (n) => `${n.source_file}::${gNorm(n.label)}`
const gLine = (n) => Number(String(n.source_location ?? '').replace(/^L/, '')) || 0
function gFind(file, qname, line) {
  const c = G.nodes.filter((n) => n.source_file === file && !FILE_LABEL.test(n.label) && gNorm(n.label) === last(qname))
  return c.sort((a, b) => Math.abs(gLine(a) - line) - Math.abs(gLine(b) - line))[0]
}
const gFile = (file) => G.nodes.find((n) => n.source_file === file && FILE_LABEL.test(n.label))
const noKeys = { ...process.env }; for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_API_KEY']) delete noKeys[k]
function gf(args) {
  const t0 = performance.now(); const r = spawnSync('graphify', args, { cwd: REPO, encoding: 'utf8', env: noKeys, maxBuffer: 64 << 20 })
  const out = (r.stdout ?? '') + (r.stderr ?? ''); return { ms: performance.now() - t0, out, bytes: Buffer.byteLength(r.stdout ?? ''), status: r.status, cmd: `graphify ${args.join(' ')}` }
}
const AFFECTED = /^\s*- (.+?) \[([\w_]+)\] (\S+?):L(\d+)/
const parseAffected = (out) => out.split('\n').map((l) => AFFECTED.exec(l)).filter(Boolean).map((m) => ({ label: m[1], rel: m[2], file: m[3], line: Number(m[4]) }))
const FILE_RELS = ['imports_from', 're_exports', 'dynamic_import']
function graphify(q) {
  const tl = (f, qn) => sym.get(tFind(f, qn))?.line ?? 0
  const node = q.target?.qname ? gFind(q.target.file, q.target.qname, tl(q.target.file, q.target.qname)) : q.target ? gFile(q.target.file) : null
  if (q.target && !node) return { note: 'target node not found in graph.json', answer: new Set() }
  const rel = (rels, depth) => gf(['affected', node.id, ...rels.flatMap((r) => ['--relation', r]), '--depth', String(depth)])
  const itemsOf = (rows) => new Set(rows.map((r) => `${r.file}::${gNorm(r.label)}`))
  switch (q.kind) {
    case 'callers': { const r = rel(['calls'], 1); const rows = parseAffected(r.out); return { ...r, answer: itemsOf(rows), files: new Set(rows.map((x) => x.file)), sites: new Set(rows.map((x) => `${x.file}:${x.line}`)), facts: rows.map((x) => ({ item: `${x.file}::${gNorm(x.label)}`, site: `${x.file}:${x.line}` })), cites: rows.length > 0 } }
    case 'implementations': { const r = rel(['implements'], 1); const rows = parseAffected(r.out); return { ...r, answer: itemsOf(rows), facts: rows.map((x) => ({ item: `${x.file}::${gNorm(x.label)}` })), cites: rows.length > 0 } }
    case 'importers': { const r = rel(FILE_RELS, 1); const rows = parseAffected(r.out); return { ...r, answer: new Set(rows.map((x) => x.file)), facts: rows.map((x) => ({ item: x.file })), cites: rows.length > 0 } }
    case 'dependents': { const r = rel(FILE_RELS, 50); const rows = parseAffected(r.out); return { ...r, answer: new Set(rows.map((x) => x.file)), facts: rows.map((x) => ({ item: x.file })), cites: rows.length > 0 } }
    case 'transitive_callers': { const r = rel(['calls'], q.depth); const rows = parseAffected(r.out); return { ...r, answer: itemsOf(rows), facts: rows.map((x) => ({ item: `${x.file}::${gNorm(x.label)}` })), cites: rows.length > 0 } }
    case 'type_users': { const r = rel(['references', 'imports'], 1); const rows = parseAffected(r.out); return { ...r, answer: new Set(rows.map((x) => x.file)), facts: rows.map((x) => ({ item: x.file })), cites: rows.length > 0 } }
    case 'path': {
      const from = gFind(q.source.file, q.source.qname, tl(q.source.file, q.source.qname))
      const r = gf(['path', from.id, node.id])
      // hops: "A --rel [..]--> B" forward, "A <--rel [..]-- B" backward; a call path must be forward calls only
      const line = r.out.split('\n').find((l) => l.includes('--')) ?? ''
      const hops = [...line.matchAll(/(<)?--([\w_]+) \[[^\]]*\]--(>)?/g)].map((m) => ({ rel: m[2], forward: !m[1] && !!m[3] }))
      const labels = line.trim().split(/<?--[\w_]+ \[[^\]]*\]-->?/).map((x) => gNorm(x.trim()))
      const valid = hops.length > 0 && hops.every((h, i) => h.forward && (h.rel === 'calls' || h.rel === 'indirect_call') && callNames.has(`${labels[i]}->${labels[i + 1]}`))
      return { ...r, path_hops: hops.length, path_valid: valid, path_text: line.trim(), cites: false }
    }
    case 'dead_code': {
      const t0 = performance.now(); const USE = new Set(['calls', 'references', 'indirect_call', 'imports', 'inherits', 'implements'])
      const used = new Set(G.links.filter((e) => USE.has(e.relation) && e.source !== e.target).map((e) => e.target))
      const ans = new Set(G.nodes.filter((n) => n.source_file?.startsWith(q.scope) && /\(\)$/.test(n.label) && !n.label.startsWith('.') && !used.has(n.id)).map(gKey))
      return { answer: ans, ms: performance.now() - t0, bytes: 0, note: 'no built-in tool: computed from graph.json', graph_level: true }
    }
    case 'cycles': {
      const t0 = performance.now(); const fileOf = (id) => { const n = gNode.get(id); return n && FILE_LABEL.test(n.label) ? n.source_file : null }
      const adj = new Map(); for (const e of G.links) if (FILE_RELS.includes(e.relation)) { const a = fileOf(e.source), b = fileOf(e.target); if (a && b) { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b) } }
      return { answer: new Set(tarjan(new Set(srcFiles), adj).flat()), ms: performance.now() - t0, bytes: 0, note: 'no built-in tool: computed from graph.json', graph_level: true }
    }
    case 'roots': {
      const t0 = performance.now(); const fileOf = (id) => { const n = gNode.get(id); return n && FILE_LABEL.test(n.label) ? n.source_file : null }
      const imported = new Set(G.links.filter((e) => FILE_RELS.includes(e.relation) && fileOf(e.source)?.startsWith(q.scope)).map((e) => fileOf(e.target)).filter(Boolean))
      const present = new Set(G.nodes.filter((n) => FILE_LABEL.test(n.label)).map((n) => n.source_file))
      return { answer: new Set(srcFiles.filter((f) => present.has(f) && !imported.has(f))), ms: performance.now() - t0, bytes: 0, note: 'no built-in tool: computed from graph.json', graph_level: true }
    }
  }
}

// ---------- ProofMesh ----------
// Asked over MCP in its default envelope, lean: a header, one `name path:line [tags]` row per result, `# ` lines (#41).
let pm, pmStartMs, snapshotId
const TOKEN = /"(?:[^"\\]|\\.)*"(?::\d+)?|\S+/g
const unquote = (t) => (t.startsWith('"') ? JSON.parse(t) : t)
const site = (t) => { const m = /^("(?:[^"\\]|\\.)*"|[^"\s]+):(\d+)$/.exec(t ?? ''); return m ? { path: unquote(m[1]), line: Number(m[2]) } : null }
function parseRow(row) {
  const t = row.match(TOKEN) ?? []
  const named = !site(t[0]) && t[0] !== 'external', at = t[named ? 1 : 0]
  return { name: named ? unquote(t[0]) : null, path: site(at)?.path ?? null, line: site(at)?.line ?? null, tags: t.slice(named ? 2 : 1), row }
}
async function pmLean(tool, args) {
  let rows = [], ms = 0, bytes = 0, calls = 0, cursor, text = ''
  do {
    const r = await pm.call(tool, { ...args, ...(cursor ? { cursor } : {}) })
    ms += r.ms; bytes += r.bytes; calls++; text += (text ? '\n' : '') + r.text
    if (r.isError || !r.text.startsWith('# ')) return { rows, ms, bytes, calls, text, error: r.text.slice(0, 400) }
    const lines = r.text.split('\n')
    snapshotId ??= / (snap_[0-9a-z]+) (current|stale)$/.exec(lines[0])?.[1]
    rows = rows.concat(lines.slice(1).filter((l) => !l.startsWith('# ')).map(parseRow))
    cursor = /^# more: cursor (\S+)$/.exec(lines.at(-1))?.[1]
  } while (cursor && calls < 50)
  return { rows, ms, bytes, calls, text }
}
// A module (top-level code) is a file row: its path and line alone.
const pmKey = (r) => `${r.path}::${r.name === null ? '<module>' : last(String(r.name))}`
const resolvedOnly = (r) => !r.tags.some((t) => t === 'candidate' || t === 'ambiguous' || t === 'external' || t.startsWith('unresolved:'))
const cited = (rows) => rows.length > 0 && rows.every((r) => r.path && r.line)
async function pmFind(file, qname, kinds) {
  const name = kinds?.includes('module') ? path.basename(file) : last(qname)
  const r = await pmLean('find_symbols', { text: name, path_prefix: file, include_tests: true, include_ids: true, ...(kinds ? { kinds } : {}), limits: { max_rows: 200 } })
  const c = r.rows.filter((s) => s.path === file && (kinds ? kinds.includes(s.tags[0]) : s.name === qname || last(String(s.name)) === name))
  const best = c.find((s) => s.name === qname) ?? c[0]
  return { id: best?.tags.find((t) => t.startsWith('id='))?.slice(3), ms: r.ms, bytes: r.bytes, calls: r.calls }
}
async function proofmesh(q) {
  // The symbol lookup is measured apart from the answering call(s), as Graphify's lookup is not counted (#41). A file question
  // names its file by path, as an agent would, so nothing is looked up for it (#40).
  const byPath = q.kind === 'importers' || q.kind === 'dependents'
  const f = q.target && !byPath ? await pmFind(q.target.file, q.target.qname, q.target.qname ? null : ['module']) : { ms: 0, bytes: 0, calls: 0 }
  const lookup = { ms: f.ms, bytes: f.bytes, calls: f.calls }
  if (q.target && !byPath && !f.id) return { note: 'target symbol not found by find_symbols', answer: new Set(), ms: 0, bytes: 0, calls: 0, lookup }
  const done = (r, extra) => { raw(`pm-${q.id}.txt`, r.text); return { ...extra, ms: r.ms, bytes: r.bytes, calls: r.calls, error: r.error, lookup, rows: r.rows.length } }
  const rels = (id, dir, types) => pmLean('get_relationships', { subject_id: id, direction: dir, types, include_tests: true, limits: { max_rows: 1000 } })
  switch (q.kind) {
    case 'callers': { const r = await rels(f.id, 'in', ['calls']); const rows = r.rows.filter(resolvedOnly); return done(r, { answer: new Set(rows.map(pmKey)), files: new Set(rows.map((x) => x.path)), sites: new Set(rows.map((x) => `${x.path}:${x.line}`)), facts: rows.map((x) => ({ item: pmKey(x), site: `${x.path}:${x.line}` })), cites: cited(r.rows) }) }
    case 'implementations': { const r = await rels(f.id, 'in', ['implements']); return done(r, { answer: new Set(r.rows.filter((x) => x.path).map(pmKey)), facts: r.rows.filter((x) => x.path).map((x) => ({ item: pmKey(x) })), cites: cited(r.rows) }) }
    case 'importers': {
      const r = await pmLean('get_relationships', { path: q.target.file, direction: 'in', types: ['imports'], include_tests: true, limits: { max_rows: 1000 } })
      return done(r, { answer: new Set(r.rows.map((x) => x.path).filter(Boolean)), facts: r.rows.map((x) => ({ item: x.path })), cites: cited(r.rows) })
    }
    case 'type_users': { const r = await rels(f.id, 'in', ['references']); return done(r, { answer: new Set(r.rows.map((x) => x.path).filter(Boolean)), facts: r.rows.map((x) => ({ item: x.path })), cites: cited(r.rows) }) }
    case 'dependents':
    case 'transitive_callers': {
      // A file's dependents are asked by its path (#40); analyze_impact does not page, so the byte budget is raised for them.
      const files = q.kind === 'dependents'
      const r = await pmLean('analyze_impact', { ...(files ? { paths: [q.target.file], types: ['imports'] } : { subject_ids: [f.id], types: ['calls'] }), limits: { max_rows: 5000, max_depth: files ? 12 : q.depth, ...(files ? { max_bytes: 1048576 } : {}) } })
      const key = files ? (x) => x.path : pmKey
      return done(r, { answer: new Set(r.rows.filter((x) => x.path).map(key)), facts: r.rows.filter((x) => x.path).map((x) => ({ item: key(x) })), cites: cited(r.rows) })
    }
    case 'path': {
      const s = await pmFind(q.source.file, q.source.qname)
      Object.assign(lookup, { ms: lookup.ms + s.ms, bytes: lookup.bytes + s.bytes, calls: lookup.calls + s.calls })
      const r = await pmLean('trace_paths', { source_id: s.id, target_id: f.id, limits: { max_depth: 12 } })
      // Every hop is a `name path:line` row, so the path is read from the answer itself, with no get_symbol per node.
      const keys = r.rows.map(pmKey)
      const valid = keys.length > 1 && keys.every((k, i) => i === 0 || callKeys.has(`${keys[i - 1]}->${k}`))
      return done(r, { path_found: keys.length > 0, path_hops: keys.length ? keys.length - 1 : null, path_valid: valid, path_text: keys.join(' -> '), cites: cited(r.rows) })
    }
    case 'dead_code':
    case 'cycles':
    case 'roots': return pmGraphLevel(q)
  }
}
function sql(query) {
  const db = path.join(PM_DATA, 'snapshots', `${snapshotId}.db`)
  const r = spawnSync('sqlite3', ['-readonly', '-json', db, query], { encoding: 'utf8', maxBuffer: 256 << 20 })
  return r.stdout.trim() ? JSON.parse(r.stdout) : []
}
function pmGraphLevel(q) {
  const t0 = performance.now(); const note = 'no MCP tool: computed from the sealed snapshot (SQLite)'
  if (q.kind === 'dead_code') {
    const rows = sql(`select s.name, f.path from symbol s join file f on f.id=s.file_id where s.kind='function' and f.path like '${q.scope}%' and instr(substr(s.qualified_name, instr(s.qualified_name, ':')+1), '.')=0 and not exists (select 1 from edge e where e.dst=s.id and e.src<>s.id)`)
    return { answer: new Set(rows.map((r) => `${r.path}::${last(r.name)}`)), ms: performance.now() - t0, bytes: 0, calls: 0, note, graph_level: true }
  }
  const imp = sql(`select fa.path a, fb.path b from assertion x join file fa on fa.id=x.source_id join file fb on fb.id=x.target_id where x.type='imports' and x.resolution='resolved'`)
  if (q.kind === 'cycles') {
    const adj = new Map(); for (const { a, b } of imp) { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b) }
    return { answer: new Set(tarjan(new Set(srcFiles), adj).flat()), ms: performance.now() - t0, bytes: 0, calls: 0, note, graph_level: true }
  }
  const imported = new Set(imp.filter((r) => r.a.startsWith(q.scope)).map((r) => r.b)); const present = new Set(sql(`select path from file where disposition='indexed'`).map((r) => r.path))
  return { answer: new Set(srcFiles.filter((f) => present.has(f) && !imported.has(f))), ms: performance.now() - t0, bytes: 0, calls: 0, note, graph_level: true }
}

// ---------- run ----------
const t0 = performance.now()
pm = new McpClient(PM, ['mcp'], { cwd: REPO, env: { ...process.env, PM_DATA_DIR: PM_DATA } })
await pm.init(); pmStartMs = performance.now() - t0
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
pm.close()
const meta = { repo: REPO, commit: spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), graphify: spawnSync('graphify', ['--version'], { encoding: 'utf8' }).stdout.trim(), proofmesh_snapshot: snapshotId, pm_mcp_startup_ms: Math.round(pmStartMs), truth: T.tool + ' ' + T.ts_version, when: new Date().toISOString() }
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, results }, null, 1))
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
const md = [`# Graph bench: ${path.basename(REPO)} @ ${meta.commit.slice(0, 8)}`, '', `Graphify ${meta.graphify}; ProofMesh snapshot ${snapshotId} (MCP start ${meta.pm_mcp_startup_ms} ms); truth: ${meta.truth}.`, '', ...lines, '', ...extra, ''].join('\n')
fs.writeFileSync(path.join(OUT, 'results.md'), md)
console.log(md)
