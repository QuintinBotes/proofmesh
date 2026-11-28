import { last } from '../../graph-bench/lib.mjs'
import { graphQuery, gortexSymbol, quote } from './callers.mjs'
import { queryPages } from './modules.mjs'

export async function callPath(tool, q, call, project) {
  const maxDepth = 12
  if (tool === 'gortex') {
    const source = await gortexSymbol(q.source, call), target = await gortexSymbol(q.target, call)
    if (!source.symbol || !target.symbol) return !source.symbol ? source : target
    const r = await call('trace', { operation: 'path', target: { symbol: source.symbol }, to: { symbol: target.symbol },
      options: { include_references: false, max_depth: maxDepth, k: 1 }, output: { format: 'json' } })
    if (!r.found) return { status: 'no_path', reason: 'No path returned within twelve hops' }
    const p = r.paths[0]
    return { status: 'answered', path: p.nodes.map(id => { const [file, qname] = id.split('::'); return { file, qname } }), kinds: p.edges.map(e => e.kind.toLowerCase()) }
  }
  if (tool === 'gitnexus') {
    const r = await call('trace', { repo: 'parity', from: last(q.source.qname), from_file: q.source.file, to: last(q.target.qname), to_file: q.target.file, maxDepth })
    if (r.status !== 'ok') return { status: r.status ?? 'no_path', reason: r.message ?? 'Trace returned no path' }
    return { status: 'answered', path: r.hops.map(n => ({ file: n.filePath, name: n.name, line: n.startLine + 1 })), kinds: r.edges.map(e => e.relType.toLowerCase()) }
  }
  const query = graphQuery(tool, call, project, { max_output_tokens: 64_000 })
  async function resolve(t) {
    const r = await query(`MATCH (b) WHERE b.file_path = ${quote(t.file)} AND b.name = ${quote(last(t.qname))} RETURN b.qualified_name AS id, b.start_line AS line`)
    if (r.rows.length !== 1) return { status: r.rows.length ? 'ambiguous_target' : 'target_missing', reason: `${r.rows.length} matches for ${t.qname} in ${t.file}` }
    return { id: r.rows[0][0], file: t.file, name: last(t.qname), line: Number(r.rows[0][1]) }
  }
  const source = await resolve(q.source), target = await resolve(q.target)
  if (!source.id || !target.id) return !source.id ? source : target
  const seen = new Map([[source.id, source]])
  let frontier = [source.id]
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = []
    for (let i = 0; i < frontier.length; i += 32) {
      const where = frontier.slice(i, i + 32).map(id => 'a.qualified_name = ' + quote(id)).join(' OR ')
      const edges = await queryPages(query, `MATCH (a)-[r:CALLS]->(b) WHERE (${where}) RETURN DISTINCT a.qualified_name AS src, b.qualified_name AS dst, b.file_path AS file, b.name AS name, b.start_line AS line ORDER BY src, dst`)
      for (const [from, to, file, name, line] of edges) {
        if (seen.has(to) || !file.startsWith('src/')) continue
        seen.set(to, { from, file, name, line: Number(line) })
        if (to === target.id) {
          const path = []
          for (let at = to; at; at = seen.get(at).from) {
            const { file, name, line } = seen.get(at)
            path.unshift({ file, name, line })
          }
          return { status: 'answered', path, kinds: path.slice(1).map(() => 'calls') }
        }
        next.push(to)
      }
    }
    frontier = next
  }
  return { status: 'no_path', reason: frontier.length ? 'No path returned within twelve hops' : 'Exhausted the reachable native call graph' }
}

// Resolve each reported declaration independently, then verify every directed call and both requested endpoints.
export function pathScore(q, answer, compiler) {
  const nodes = answer.path ?? [], kinds = answer.kinds ?? []
  const ids = nodes.map(n => {
    const declarations = compiler.T.symbols.filter(s => s.file === n.file && (n.qname ? s.qname === n.qname : s.name === n.name && s.line === n.line))
    return declarations.length === 1 ? declarations[0].id : null
  })
  const calls = new Set(compiler.T.calls.map(c => c.caller + '\n' + c.callee))
  const hops = ids.slice(1).map((to, i) => ({
    from: ids[i], to, kind: kinds[i], valid: kinds[i] === 'calls' && calls.has(ids[i] + '\n' + to),
  }))
  const endpoints = ids.length >= 2 && ids[0] === compiler.tFind(q.source.file, q.source.qname) && ids.at(-1) === compiler.tFind(q.target.file, q.target.qname)
  return { endpoints, hops, valid: endpoints && kinds.length === hops.length && hops.every(h => h.valid), path: nodes, shortest: compiler.truthFor(q).shortest }
}
