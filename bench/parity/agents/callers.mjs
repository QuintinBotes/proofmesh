// Native MCP retrieval for the direct-caller questions. Separate caller identities from actual call-site lines.
import { last } from '../../graph-bench/lib.mjs'

export const pins = { gortex: '0.64.11', gitnexus: '1.6.12', 'codebase-memory-mcp': '0.12.1' }

export function requireOperation(tools, name, args) {
  const tool = tools.get(name)
  const choices = tool?.inputSchema?.properties?.operation?.enum
  if (!tool || (args.operation && Array.isArray(choices) && !choices.includes(args.operation))) {
    const operation = args.operation ? name + '.' + args.operation : name
    throw Object.assign(new Error(operation + ' is absent from native tool discovery'), { code: 'unsupported_operation' })
  }
}

export function payload(reply) {
  if (reply.error) throw new Error(reply.error.message)
  const result = reply.result
  const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? ''
  if (result.isError) throw new Error(text)
  const data = result.structuredContent ?? JSON.parse(text.split('\n\n---\n')[0])
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error))
  return data
}

function nexusRows(result) {
  if (Array.isArray(result) && !result.length) return []
  if (typeof result.markdown !== 'string') throw new Error('GitNexus returned no Cypher table')
  const rows = result.markdown.split('\n').slice(2).map(line => line.slice(2, -2).split(' | '))
  if (rows.length !== result.row_count) throw new Error('GitNexus returned an incomplete Cypher table')
  return rows
}

export const quote = s => "'" + s.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'"

export function graphQuery(tool, call, project, options = {}) {
  const cbm = tool === 'codebase-memory-mcp'
  return async function query(statement) {
    if (!cbm) return { rows: nexusRows(await call('cypher', { repo: 'parity', statement })), truncated: false }
    const r = await call('query_graph', { project, query: statement, format: 'json', max_rows: 1000, ...options })
    if (!Array.isArray(r.rows)) throw new Error('Codebase-Memory returned no Cypher rows')
    return { rows: r.rows, truncated: !!(r.has_more || r.truncated) }
  }
}

export async function gortexSymbol({ file, qname }, call) {
  const found = await call('search', { operation: 'symbols', query: last(qname), options: { path: file, limit: 100 }, output: { format: 'json' } })
  if (!Array.isArray(found.results)) throw new Error('Gortex symbol search returned no results array')
  const matches = found.results.filter(n => n.file_path === file && n.name === last(qname))
  const exact = matches.find(n => n.id.endsWith('::' + qname))
  const target = exact ?? (matches.length === 1 ? matches[0] : null)
  if (!target) return { status: matches.length || found.truncated ? 'ambiguous_target' : 'target_missing', reason: `Gortex search returned ${matches.length} matching declarations in ${file}` }
  return { symbol: target.id }
}

export async function directCallers(tool, q, call, project) {
  const { file, qname } = q.target
  if (tool === 'gortex') {
    const resolved = await gortexSymbol(q.target, call)
    if (!resolved.symbol) return resolved
    const { symbol } = resolved
    const graph = await call('relations', { operation: 'callers', target: { symbol }, options: { depth: 1, limit: 1000 }, output: { format: 'json' } })
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Gortex returned no graph')
    if (!graph.nodes.some(n => n.id === symbol)) return { status: 'target_missing', reason: graph.caveat?.message ?? 'Target absent from graph' }
    const nodes = new Map(graph.nodes.map(n => [n.id, n]))
    const facts = graph.edges.filter(e => e.kind === 'calls' && e.to === symbol).map(e => {
      const from = nodes.get(e.from)
      if (!from) throw new Error('Caller edge has no source node')
      return { file: from.file_path, caller: from.name, site: e.line > 0 ? e.file_path + ':' + e.line : null }
    })
    return { status: 'answered', facts, truncated: !!(graph.truncated || graph._truncated_by_budget) }
  }

  const cbm = tool === 'codebase-memory-mcp'
  const field = cbm ? 'file_path' : 'filePath'
  const target = `b.${field} = ${quote(file)} AND b.name = ${quote(last(qname))}`
  const query = graphQuery(tool, call, project)
  const matches = await query(`MATCH (b) WHERE ${target} RETURN b.${cbm ? 'qualified_name' : 'id'} AS identity`)
  if (matches.rows.length !== 1) return { status: matches.rows.length ? 'ambiguous_target' : 'target_missing', reason: `${matches.rows.length} matching declarations in ${file}` }
  const relation = cbm ? 'CALLS' : 'CodeRelation'
  const filter = cbm ? '' : "r.type = 'CALLS' AND "
  const r = await query(`MATCH (a)-[r:${relation}]->(b) WHERE ${filter}${target} RETURN a.${field} AS file, a.name AS caller${cbm ? ', r.line AS line' : ''} ORDER BY file, caller${cbm ? ', line' : ''} LIMIT 1000`)
  return { status: 'answered', facts: r.rows.map(([file, caller, line]) => ({ file, caller, site: cbm && Number(line) > 0 ? file + ':' + line : null })), truncated: r.truncated || r.rows.length === 1000,
    ...(cbm ? {} : { site_limitation: 'CodeRelation.CALLS has no call-site line property' }) }
}
