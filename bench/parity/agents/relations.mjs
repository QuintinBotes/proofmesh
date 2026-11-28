// Native retrieval for questions that expect a set of symbol identities or source files.
import { bfs, last } from '../../graph-bench/lib.mjs'
import { graphQuery, gortexSymbol, quote } from './callers.mjs'
import { moduleGraph } from './modules.mjs'

const output = { format: 'json', max_bytes: 4_000_000 }
const key = (file, name) => file + '::' + name

async function gortex(q, call) {
  const file = q.target.file
  const resolved = await gortexSymbol(q.target, call)
  if (!resolved.symbol) return resolved
  const { symbol } = resolved
  const relations = (operation, options) => call('relations', { operation, target: { symbol }, options, output })
  if (q.kind === 'implementations') {
    const r = await relations('implementations', {})
    if (!Array.isArray(r.implementations)) throw new Error('Missing Gortex implementations')
    return { status: 'answered', items: r.implementations.map(n => key(n.file_path, n.name)), truncated: !!(r.truncated || r._truncated_by_budget || r.implementations.length < r.total) }
  }
  if (q.kind === 'type_users') {
    const r = await relations('usages', { group_by: 'file', limit: 0, max_tokens: 0 })
    if (!Array.isArray(r.groups)) throw new Error('Missing Gortex usage groups')
    const items = r.groups.filter(g => g.file !== file && g.uses.some(u => u.context !== 'import' && u.edge_kind !== 'imports')).map(g => g.file)
    return { status: 'answered', items, truncated: !!(r.truncated || r._truncated_by_budget || r.groups.length < r.file_count) }
  }
  const graph = await relations('callers', { depth: q.depth, limit: 1000, min_tier: 'text_matched' })
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Missing Gortex relationship graph')
  const nodes = new Map(graph.nodes.map(n => [n.id, n]))
  if (!nodes.has(symbol)) return { status: 'target_missing', reason: 'Target absent from returned graph' }
  const incoming = new Map()
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls') continue
    if (!incoming.has(edge.to)) incoming.set(edge.to, [])
    incoming.get(edge.to).push(edge.from)
  }
  const items = Array.from(bfs(symbol, incoming, q.depth).keys(), id => {
    const n = nodes.get(id)
    if (!n) throw new Error('Missing Gortex edge endpoint')
    return key(n.file_path, n.name)
  })
  return { status: 'answered', items, truncated: !!(graph.truncated || graph._truncated_by_budget) }
}

export async function relatedItems(tool, q, call, project) {
  if (['dependents', 'cycles', 'roots'].includes(q.kind) || (tool === 'gortex' && q.kind === 'importers')) return moduleGraph(tool, q, call, project)
  if (tool === 'gortex') return gortex(q, call)
  const cbm = tool === 'codebase-memory-mcp'
  const field = cbm ? 'file_path' : 'filePath'
  const id = cbm ? 'qualified_name' : 'id'
  const files = q.kind === 'importers'
  const condition = 'b.' + field + ' = ' + quote(q.target.file) + (files ? '' : ' AND b.name = ' + quote(last(q.target.qname)))
  const query = graphQuery(tool, call, project)
  const targets = await query(`MATCH (b${files ? ':File' : ''}) WHERE ${condition} RETURN b.${id} AS identity`)
  if (targets.rows.length !== 1) return { status: targets.rows.length ? 'ambiguous_target' : 'target_missing', reason: `${targets.rows.length} matching targets in ${q.target.file}` }
  const relation = { implementations: 'IMPLEMENTS', importers: 'IMPORTS', transitive_callers: 'CALLS', type_users: cbm ? 'USAGE' : 'USES' }[q.kind]
  const match = cbm ? `MATCH (a)-[r:${relation}]->(b) WHERE ` : `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = ${quote(relation)} AND `
  if (q.kind === 'transitive_callers') {
    return transitiveCallers(query, match, id, field, targets.rows[0][0], q.depth)
  }
  // Codebase-Memory imports terminate at Module nodes sharing a path with the File.
  const symbols = q.kind === 'implementations'
  const columns = `a.${field} AS file` + (symbols ? ', a.name AS name' : '')
  const order = symbols ? 'file, name' : 'file'
  const r = await query(match + condition + ` RETURN DISTINCT ${columns} ORDER BY ${order} LIMIT 1000`)
  const items = r.rows.filter(([file]) => q.kind !== 'type_users' || file !== q.target.file)
    .map(([file, name]) => symbols ? key(file, name) : file)
  return { status: 'answered', items, truncated: r.truncated || r.rows.length >= 1000 }
}

async function transitiveCallers(query, match, id, field, target, depth) {
  // Walk native identities. Two methods with the same short name must remain distinct during traversal.
  const seen = new Set([target]), items = new Set()
  let frontier = [target], truncated = false
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const where = '(' + frontier.map(identity => `b.${id} = ${quote(identity)}`).join(' OR ') + ')'
    const r = await query(match + where + ` RETURN DISTINCT a.${field} AS file, a.name AS name, a.${id} AS identity ORDER BY identity LIMIT 1000`)
    truncated ||= r.truncated || r.rows.length >= 1000
    frontier = []
    for (const [file, name, identity] of r.rows) {
      if (seen.has(identity)) continue
      seen.add(identity)
      frontier.push(identity)
      items.add(key(file, name))
    }
  }
  return { status: 'answered', items: [...items], truncated }
}
