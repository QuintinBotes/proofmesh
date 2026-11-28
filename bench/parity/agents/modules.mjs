import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { bfs, tarjan } from '../../graph-bench/lib.mjs'
import { graphQuery } from './callers.mjs'

export async function queryPages(query, projection) {
  const rows = []
  const pageSize = 500
  // The result-byte budget may return fewer rows than LIMIT. Resume after the actual rows received.
  for (;;) {
    const page = await query(projection + ` SKIP ${rows.length} LIMIT ${pageSize}`)
    if (page.truncated && !page.rows.length) throw new Error('Native graph page could not return one row')
    rows.push(...page.rows)
    if (!page.truncated && page.rows.length < pageSize) return rows
    if (rows.length >= 100_000) throw new Error('Native graph exceeded the 100,000-row measurement bound')
  }
}

export function moduleItems(q, files, imports) {
  const nodes = new Set(files.filter(f => f.startsWith('src/')))
  if (q.target && !nodes.has(q.target.file)) return { status: 'target_missing', reason: 'Target file absent from native graph' }
  const incoming = new Map(), outgoing = new Map()
  for (const [from, to] of imports) {
    if (!nodes.has(from) || !nodes.has(to)) continue
    if (!incoming.has(to)) incoming.set(to, new Set())
    if (!outgoing.has(from)) outgoing.set(from, new Set())
    incoming.get(to).add(from)
    outgoing.get(from).add(to)
  }
  let items
  switch (q.kind) {
    case 'importers': items = incoming.get(q.target.file) ?? []; break
    case 'dependents': items = bfs(q.target.file, incoming).keys(); break
    case 'cycles': items = tarjan(nodes, outgoing).flat(); break
    case 'roots': items = [...nodes].filter(f => !incoming.has(f)); break
    default: throw new Error('Unknown module question: ' + q.kind)
  }
  return { status: 'answered', items: [...items], truncated: false, method: 'derived from native file and import graph' }
}

export async function exportedGraph(call, kind) {
  const options = kind === 'modules' ? { kinds: 'file' } : {}
  const xml = await call('edit', { operation: 'export_graph', options, output: { format: 'graphml' } })
  return JSON.parse(execFileSync('python3', [path.join(import.meta.dirname, 'read-graph.py'), kind], { input: xml, encoding: 'utf8', maxBuffer: 16 << 20 }))
}

export async function moduleGraph(tool, q, call, project) {
  if (tool === 'gortex') {
    const data = await exportedGraph(call, 'modules')
    return moduleItems(q, data.files, data.imports)
  }
  const cbm = tool === 'codebase-memory-mcp'
  const field = cbm ? 'file_path' : 'filePath'
  const query = graphQuery(tool, call, project, { max_output_tokens: 64_000 })
  const files = await queryPages(query, `MATCH (a:File) RETURN DISTINCT a.${field} AS file ORDER BY file`)
  const match = cbm ? 'MATCH (a)-[r:IMPORTS]->(b)' : "MATCH (a)-[r:CodeRelation]->(b) WHERE r.type = 'IMPORTS'"
  const imports = await queryPages(query, match + ` RETURN DISTINCT a.${field} AS src, b.${field} AS dst ORDER BY src, dst`)
  return moduleItems(q, files.map(([file]) => file), imports)
}
