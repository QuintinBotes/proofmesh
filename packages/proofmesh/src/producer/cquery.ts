import type Database from 'better-sqlite3'
import { invalid } from './artifact.js'

export type Target = { label: string; configuration: string }
type Witness = { path: string; line: number; evidence_id: string }
export type Graph = { targets: Target[]; edges: { from: Target; to: Target; witness: Witness | null; missing_location?: string }[]; unsupported_edges: number; unknown_labels: number; diagnostics: string[] }

// Bazel's unfactored --output=graph emits a node or edge per line. Preserve the configuration on each endpoint.
export function readCquery(db: Database.Database, dot: string): Graph {
  const lines = dot.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.shift() !== 'digraph mygraph {' || lines.pop() !== '}') return invalid('Unsupported cquery format. Supply Bazel unfactored graph output.')
  const nodes = new Map<string, Target>(), arcs = new Map<string, [Target, Target]>()
  function node(text: string) {
    const match = /^(\S+) \(([^()\s]+)\)$/.exec(text)
    if (!match || text.length > 1200 || text.includes('\\')) return invalid('Unsupported cquery target. Use --nograph:factored.')
    const n = { label: match[1]!, configuration: match[2]! }
    nodes.set(text, n)
    return n
  }
  for (const line of lines) {
    if (line === 'node [shape=box];') continue
    const m = /^"([^"]+)"(?:\s*->\s*"([^"]+)")?;?$/.exec(line)
    if (!m) return invalid('Unsupported cquery graph record. Use --output=graph --nograph:factored.')
    const from = node(m[1]!)
    if (m[2]) arcs.set(m[1] + '\0' + m[2], [from, node(m[2])])
  }
  const byLabel = db.prepare("select s.id from symbol s join file f on f.id=s.file_id where s.kind='project' and s.name=? and (f.path in ('BUILD','BUILD.bazel') or f.path like '%/BUILD' or f.path like '%/BUILD.bazel') limit 2")
  const ids = new Map<string, string>(), diagnostics: string[] = []
  const labels = [...new Set([...nodes.values()].map((n) => n.label))].sort()
  for (const label of labels) {
    const hits = byLabel.pluck().all(label)
    if (hits.length === 1) ids.set(label, String(hits[0]))
    else if (diagnostics.length < 20) diagnostics.push('Unknown or ambiguous BUILD label: ' + label)
  }
  const site = db.prepare(`select distinct f.path, e.start_line as line, e.id as evidence_id from assertion a join assertion_evidence ae on ae.assertion_id=a.id
    join evidence e on e.id=ae.evidence_id join file f on f.id=e.file_id where a.source_id=? and a.target_id=? and a.type='depends_on' order by f.path, e.start_byte limit 2`)
  const edges = [...arcs.values()].map(([from, to]) => {
    const hits = site.all(ids.get(from.label) ?? '', ids.get(to.label) ?? '') as Witness[]
    return hits.length === 1 ? { from, to, witness: hits[0]! } : { from, to, witness: null, missing_location: hits.length ? 'multiple_static_declarations' : 'no_static_declaration' }
  })
  return { targets: [...nodes.values()], edges, unknown_labels: labels.length - ids.size, unsupported_edges: edges.filter((e) => !e.witness).length, diagnostics }
}
