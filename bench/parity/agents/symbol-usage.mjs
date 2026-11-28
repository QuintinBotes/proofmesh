import { graphQuery } from './callers.mjs'
import { exportedGraph, queryPages } from './modules.mjs'

const key = (file, name) => file + '::' + name
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0

function ranked(rows, top) {
  rows.sort(([a, ac, ai], [b, bc, bi]) => bc - ac || cmp(a, b) || cmp(ai, bi))
  const ranking = rows.slice(0, top).map(([symbol, count]) => [symbol, count])
  return { status: 'answered', items: ranking.map(([symbol]) => symbol), ranked: ranking, truncated: false }
}

export async function symbolUsage(tool, q, call, project) {
  if (tool === 'gortex') {
    const data = await exportedGraph(call, q.kind)
    return q.kind === 'hubs' ? ranked(data, q.top) : { status: 'answered', items: data, truncated: false }
  }
  const cbm = tool === 'codebase-memory-mcp'
  const field = cbm ? 'file_path' : 'filePath', id = cbm ? 'qualified_name' : 'id'
  const query = graphQuery(tool, call, project, { max_output_tokens: 64_000 })
  const relation = cbm ? 'CALLS|USAGE|WRITES|IMPLEMENTS|INHERITS' : 'CodeRelation'
  const where = cbm ? '' : " WHERE r.type IN ['CALLS','USES','ACCESSES','IMPLEMENTS','EXTENDS']"
  if (q.kind === 'dead_code') {
    const candidates = await queryPages(query, `MATCH (b:Function) RETURN b.${field} AS file, b.name AS name, b.${id} AS id ORDER BY file, name, id`)
    const uses = await queryPages(query, `MATCH (a)-[r:${relation}]->(b:Function)${where} RETURN DISTINCT a.${id} AS src, b.${id} AS dst ORDER BY src, dst`)
    const used = new Set(uses.filter(([a, b]) => a !== b).map(([, b]) => b))
    const modules = cbm ? new Map(await queryPages(query, 'MATCH (m:Module) RETURN m.file_path AS file, m.qualified_name AS id ORDER BY file, id')) : null
    const items = candidates.filter(([file, name, identity]) => file.startsWith(q.scope) && !used.has(identity) &&
      identity === (cbm ? modules.get(file) + '.' + name : 'Function:' + file + ':' + name)).map(([file, name]) => key(file, name))
    return { status: 'answered', items, truncated: false }
  }
  if (!cbm) {
    const r = await query("MATCH (a)-[r:CodeRelation]->(b)" + where +
      " AND a.id <> b.id AND a.filePath STARTS WITH 'src/' AND b.filePath STARTS WITH 'src/' AND NOT (b.id STARTS WITH 'File:')" +
      ` RETURN b.filePath AS file, b.name AS name, b.id AS id, count(DISTINCT a.id) AS users ORDER BY users DESC, file, name, id LIMIT ${q.top}`)
    return ranked(r.rows.map(([file, name, identity, n]) => [key(file, name), Number(n), identity]), q.top)
  }
  // This engine cannot compare two node properties in WHERE. Remove self-uses after fetching distinct edges.
  const edges = await queryPages(query, `MATCH (a)-[r:${relation}]->(b) RETURN DISTINCT a.qualified_name AS src, b.qualified_name AS dst, a.file_path AS origin, b.file_path AS file, b.name AS name, labels(b) AS kind ORDER BY src, dst`)
  const usage = new Map()
  for (const [src, dst, origin, file, name, kind] of edges) {
    if (src === dst || !origin.startsWith('src/') || !file.startsWith('src/') || JSON.parse(kind).some(k => ['File', 'Module', 'Directory', 'Package'].includes(k))) continue
    if (!usage.has(dst)) usage.set(dst, [key(file, name), 0, dst])
    usage.get(dst)[1]++
  }
  return ranked([...usage.values()], q.top)
}
