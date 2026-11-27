// The scoring and the two tool adapters of the graph benchmark, shared by run.mjs here and bench/parity/run.mjs.
// truthFor answers a question from the TypeScript-checker truth (truth.mjs); score compares an answer with it.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const last = (q) => q.split('.').pop()
const group = (rows, k, v) => { const m = new Map(); for (const r of rows) { const a = r[k]; if (!m.has(a)) m.set(a, new Set()); m.get(a).add(r[v]) } return m }
export function bfs(start, adj, maxDepth = Infinity) {
  const seen = new Map([[start, 0]]); let frontier = [start]
  while (frontier.length) { const next = []; for (const x of frontier) { const d = seen.get(x); if (d >= maxDepth) continue; for (const y of adj.get(x) ?? []) if (!seen.has(y)) { seen.set(y, d + 1); next.push(y) } } frontier = next }
  seen.delete(start); return seen
}
export function tarjan(nodes, adj) {
  let i = 0; const idx = new Map(), low = new Map(), on = new Set(), st = [], out = []
  const sc = (v) => { idx.set(v, i); low.set(v, i); i++; st.push(v); on.add(v)
    for (const w of adj.get(v) ?? []) { if (!nodes.has(w)) continue; if (!idx.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))) } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w))) }
    if (low.get(v) === idx.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w) } while (w !== v); if (c.length > 1) out.push(c) } }
  for (const v of nodes) if (!idx.has(v)) sc(v)
  return out
}
export function score(truth, answer) {
  if (!answer) return { recall: null, precision: null }
  const hit = [...answer].filter((x) => truth.has(x)).length
  return { hits: hit, recall: truth.size ? hit / truth.size : (answer.size ? 0 : 1), precision: answer.size ? hit / answer.size : (truth.size ? null : 1), n_truth: truth.size, n_answer: answer.size, missed: [...truth].filter((x) => !answer.has(x)).slice(0, 15), extra: [...answer].filter((x) => !truth.has(x)).slice(0, 15) }
}

// ---------- ground truth ----------
export function makeTruth(T) {
  const sym = new Map(T.symbols.map((s) => [s.id, s]))
  const tKey = (id) => { const s = sym.get(id); return s ? `${s.file}::${s.kind === 'module' ? '<module>' : last(s.qname)}` : `${id.split('#')[0]}::<module>` }
  const tFind = (file, qname) => T.symbols.find((s) => s.file === file && s.qname === qname && s.kind !== 'module')?.id
  const callIn = group(T.calls, 'callee', 'caller')
  const callOut = group(T.calls, 'caller', 'callee')
  const impIn = group(T.imports, 'to', 'from')
  const srcFiles = T.files.filter((f) => f.startsWith('src/'))
  const callKeys = new Set(T.calls.map((c) => `${tKey(c.caller)}->${tKey(c.callee)}`))
  const callNames = new Set(T.calls.map((c) => `${tKey(c.caller).split('::')[1]}->${tKey(c.callee).split('::')[1]}`))
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
      case 'hubs': {
        // The top symbols by distinct callers and referrers (a symbol's use of itself is none); ties at the cut are listed beside it.
        const users = new Map(); for (const [from, to] of [...T.calls.map((c) => [c.caller, c.callee]), ...T.refs.map((r) => [r.from, r.to])]) if (from !== to && sym.has(to)) { if (!users.has(to)) users.set(to, new Set()); users.get(to).add(from) }
        const ranked = [...users].map(([id, u]) => [tKey(id), u.size]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        const cut = ranked[q.top - 1]?.[1] ?? 0
        return { items: new Set(ranked.slice(0, q.top).map(([k]) => k)), ranked: ranked.slice(0, q.top), tied_at_cut: ranked.filter(([, n]) => n === cut).map(([k]) => k) }
      }
    }
  }
  return { T, sym, tKey, tFind, srcFiles, callKeys, callNames, truthFor }
}

// ---------- Graphify ----------
// Asks graphify (CLI over <repo>/graphify-out/graph.json) with no model key in its environment.
export function graphifyAdapter(repo, { sym, tFind, srcFiles, callNames }) {
  const G = JSON.parse(fs.readFileSync(path.join(repo, 'graphify-out/graph.json'), 'utf8'))
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
    const t0 = performance.now(); const r = spawnSync('graphify', args, { cwd: repo, encoding: 'utf8', env: noKeys, maxBuffer: 64 << 20 })
    const out = (r.stdout ?? '') + (r.stderr ?? ''); return { ms: performance.now() - t0, out, bytes: Buffer.byteLength(r.stdout ?? ''), status: r.status, cmd: `graphify ${args.join(' ')}` }
  }
  const AFFECTED = /^\s*- (.+?) \[([\w_]+)\] (\S+?):L(\d+)/
  const parseAffected = (out) => out.split('\n').map((l) => AFFECTED.exec(l)).filter(Boolean).map((m) => ({ label: m[1], rel: m[2], file: m[3], line: Number(m[4]) }))
  const FILE_RELS = ['imports_from', 're_exports', 'dynamic_import']
  return function graphify(q) {
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
      case 'hubs': {
        // Distinct sources per target over the use relations, as the truth ranks; god-nodes ranks by degree, which mixes in what a node uses.
        const t0 = performance.now(); const USE = new Set(['calls', 'references', 'indirect_call', 'inherits', 'implements']); const users = new Map()
        for (const e of G.links) if (USE.has(e.relation) && e.source !== e.target) { if (!users.has(e.target)) users.set(e.target, new Set()); users.get(e.target).add(e.source) }
        const top = [...users].filter(([id]) => gNode.get(id) && !FILE_LABEL.test(gNode.get(id).label)).sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1)).slice(0, q.top)
        return { answer: new Set(top.map(([id]) => gKey(gNode.get(id)))), ms: performance.now() - t0, bytes: 0, note: 'computed from graph.json', graph_level: true }
      }
    }
  }
}

// ---------- ProofMesh ----------
// Asked over MCP (an McpClient already initialised) in its default envelope, lean: a header, one `name path:line [tags]`
// row per result, `# ` lines (#41). Q10-Q13 are asked of find_unused, find_cycles, find_entry_points and find_hubs (#34), which are
// in the extra profile: `pmExtra` is a second client started with --tools extra, so `pm` keeps the default core listing.
const TOKEN = /"(?:[^"\\]|\\.)*"(?::\d+)?|\S+/g
const unquote = (t) => (t.startsWith('"') ? JSON.parse(t) : t)
const site = (t) => { const m = /^("(?:[^"\\]|\\.)*"|[^"\s]+):(\d+)$/.exec(t ?? ''); return m ? { path: unquote(m[1]), line: Number(m[2]) } : null }
/** A lean row: `name path:line tags`, or `path:line tags` for a file. */
function parseRow(row) {
  const t = row.match(TOKEN) ?? []
  const named = !site(t[0]) && t[0] !== 'external', at = t[named ? 1 : 0]
  return { name: named ? unquote(t[0]) : null, path: site(at)?.path ?? null, line: site(at)?.line ?? null, tags: t.slice(named ? 2 : 1), row }
}
// A module (top-level code) is a file row: its path and line alone.
const pmKey = (r) => `${r.path}::${r.name === null ? '<module>' : last(String(r.name))}`

export function proofmeshAdapter(pm, pmExtra, { callKeys }, raw) {
  let snapshotId
  async function pmLean(tool, args, client = pm) {
    let rows = [], ms = 0, bytes = 0, calls = 0, cursor, text = ''
    do {
      const r = await client.call(tool, { ...args, ...(cursor ? { cursor } : {}) })
      ms += r.ms; bytes += r.bytes; calls++; text += (text ? '\n' : '') + r.text
      if (r.isError || !r.text.startsWith('# ')) return { rows, ms, bytes, calls, text, error: r.text.slice(0, 400) }
      const lines = r.text.split('\n')
      snapshotId ??= / (snap_[0-9a-z]+) (current|stale)$/.exec(lines[0])?.[1]
      rows = rows.concat(lines.slice(1).filter((l) => !l.startsWith('# ')).map(parseRow))
      cursor = /^# more: cursor (\S+)$/.exec(lines.at(-1))?.[1]
    } while (cursor && calls < 50)
    return { rows, ms, bytes, calls, text }
  }
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
      case 'dead_code': {
        // Top-level functions under the scope; only rows tagged unused answer, not reachable_only_by or possibly_used.
        const r = await pmLean('find_unused', { kinds: ['function'], path_prefix: q.scope, top_level_only: true, limits: { max_rows: 1000 } }, pmExtra)
        const rows = r.rows.filter((x) => x.tags.includes('unused'))
        return done(r, { answer: new Set(rows.map(pmKey)), facts: rows.map((x) => ({ item: pmKey(x) })), cites: cited(r.rows) })
      }
      case 'cycles': {
        // A row is one import inside a cycle: `<imported> <importer>:<line>`; type-only cycles are included, as the truth counts them.
        const r = await pmLean('find_cycles', { path_prefix: q.scope, include_type_only: true, limits: { max_rows: 1000 } }, pmExtra)
        return done(r, { answer: new Set(r.rows.flatMap((x) => [x.path, x.name])), facts: [...new Set(r.rows.flatMap((x) => [x.path, x.name]))].map((item) => ({ item })), cites: cited(r.rows) })
      }
      case 'roots': {
        const r = await pmLean('find_entry_points', { path_prefix: q.scope, limits: { max_rows: 1000 } }, pmExtra)
        const rows = r.rows.filter((x) => x.tags.includes('not_imported'))
        return done(r, { answer: new Set(rows.map((x) => x.path)), facts: rows.map((x) => ({ item: x.path })), cites: cited(r.rows) })
      }
      case 'hubs': {
        const r = await pmLean('find_hubs', { top: q.top, by: 'fan_in' }, pmExtra)
        return done(r, { answer: new Set(r.rows.map(pmKey)), facts: r.rows.map((x) => ({ item: pmKey(x) })), cites: cited(r.rows) })
      }
    }
  }
  proofmesh.snapshotId = () => snapshotId
  return proofmesh
}

// ---------- ProofMesh, one query_graph query per question (#36) ----------
// The questions proofmeshAdapter asks with the typed tools, each as one query over MCP (the extra profile), scored the same way.
// A target is named by its qualified name: the file's path without its extension, a colon, then the name questions.json gives.
const qnameOf = (t) => `${t.file.replace(/\.[^./]+$/, '')}:${t.qname}`
export function queryGraphQuery(q) {
  const t = q.target, scope = { scope: q.scope }
  switch (q.kind) {
    case 'callers': return ['MATCH ()-[r:calls]->(t {qualified_name: $t}) RETURN r', { t: qnameOf(t) }]
    case 'implementations': return ['MATCH ()-[r:implements]->(t {qualified_name: $t}) RETURN r', { t: qnameOf(t) }]
    case 'importers': return ['MATCH (:file)-[r:imports]->(:file {path: $path}) RETURN r', { path: t.file }]
    case 'dependents': return ['MATCH (d:file)-[:imports*1..6]->(:file {path: $path}) WHERE d.path <> $path RETURN DISTINCT d', { path: t.file }]
    case 'transitive_callers': return [`MATCH (c)-[:calls*1..${q.depth}]->(t {qualified_name: $t}) RETURN DISTINCT c`, { t: qnameOf(t) }]
    case 'path': return ['MATCH p = (s {qualified_name: $s})-[:calls*1..6]->(t {qualified_name: $t}) RETURN p LIMIT 1', { s: qnameOf(q.source), t: qnameOf(t) }]
    case 'type_users': return ['MATCH ()-[r:references]->(t {qualified_name: $t}) RETURN r', { t: qnameOf(t) }]
    case 'dead_code': return ["MATCH (f:function) WHERE f.path STARTS WITH $scope AND f.qualified_name ENDS WITH ':' + f.name AND NOT EXISTS { (x)-->(f) WHERE x <> f } RETURN f", scope]
    case 'cycles': return ['MATCH (a:file)-[:imports*1..6]->(a) WHERE a.path STARTS WITH $scope RETURN a', scope]
    case 'roots': return ["MATCH (f:file) WHERE f.path STARTS WITH $scope AND f.disposition = 'indexed' AND NOT EXISTS { (g:file)-[:imports]->(f) WHERE g.path STARTS WITH $scope } RETURN f", scope]
    // Distinct users by calls and references, as the truth counts them. Every use is held before count, so max_rows bounds what it ranks.
    case 'hubs': return [`MATCH (u)-[:calls|references]->(s) WHERE u <> s WITH s, count(DISTINCT u) AS users RETURN s, users ORDER BY users DESC, s LIMIT ${q.top}`, {}]
  }
}
export function queryGraphAdapter(pm, { callKeys }, raw, runs = 1) {
  return async function queryGraph(q) {
    const [query, params] = queryGraphQuery(q)
    const ms = []
    let r
    for (let i = 0; i < runs; i++) { r = await pm.call('query_graph', { query, params, limits: { max_rows: 1000, max_bytes: 1048576, timeout_ms: 30000 } }); ms.push(r.ms) }
    raw(`pm-query-${q.id}.txt`, `${query}\n${JSON.stringify(params)}\n${r.text}`)
    if (r.isError || !r.text.startsWith('# ')) return { error: r.text.slice(0, 400), ms: ms[0], all_ms: ms, query }
    const rows = r.text.split('\n').slice(1).filter((l) => !l.startsWith('# ')).map(parseRow)
    const base = { ms: [...ms].sort((a, b) => a - b)[(ms.length - 1) >> 1], all_ms: ms, bytes: r.bytes, calls: 1, query, rows: rows.length, cut: /^# Stopped at /m.test(r.text) }
    const files = new Set(rows.map((x) => x.path).filter(Boolean))
    if (q.kind === 'path') {
      const keys = rows.map(pmKey)
      return { ...base, path_found: keys.length > 0, path_hops: keys.length ? keys.length - 1 : null, path_valid: keys.length > 1 && keys.every((k, i) => i === 0 || callKeys.has(`${keys[i - 1]}->${k}`)) }
    }
    if (['importers', 'dependents', 'type_users', 'cycles', 'roots'].includes(q.kind)) return { ...base, answer: files }
    return { ...base, answer: new Set(rows.map(pmKey)), ...(q.kind === 'callers' ? { files, sites: new Set(rows.map((x) => `${x.path}:${x.line}`)) } : {}) }
  }
}
