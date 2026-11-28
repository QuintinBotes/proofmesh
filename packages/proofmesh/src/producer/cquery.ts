import { spawnSync } from 'node:child_process'
import { sha256 } from '../core/hash.js'
import { gitOptions } from '../indexer/discovery.js'
import type Database from 'better-sqlite3'
import { invalid } from './artifact.js'

export type Target = { label: string; configuration: string }
type Witness = { path: string; line: number; evidence_id: string }
export type Graph = { targets: Target[]; edges: { from: Target; to: Target; witness: Witness | null; missing_location?: string }[]; unsupported_edges: number; unknown_labels: number; diagnostics: string[] }

// Bazel's unfactored --output=graph emits a node or edge per line. Preserve the configuration on each endpoint.
export function readCquery(db: Database.Database, dot: string, root: string, revision: string): Graph {
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
  const labels = new Set([...nodes.values()].map((n) => n.label))
  const ids = new Map<string, string | null>()
  const declarations = db.prepare(`select s.name, s.id from symbol s join file f on f.id=s.file_id
    where s.kind='project' and (f.path in ('BUILD','BUILD.bazel') or f.path like '%/BUILD' or f.path like '%/BUILD.bazel')`)
  for (const row of declarations.iterate() as Iterable<{ name: string; id: string }>) {
    if (labels.has(row.name)) ids.set(row.name, ids.has(row.name) ? null : row.id)
  }
  const unknown = [...labels].filter((label) => !ids.get(label)).sort()
  const diagnostics = unknown.slice(0, 20).map((label) => 'Unknown or ambiguous BUILD label: ' + label)
  // A working-tree index may include edits on top of HEAD. Only cite a BUILD file that matches the producer's revision.
  const verified = new Map<string, boolean>()
  function matchesRevision(path: string, hash: string) {
    if (!verified.has(path)) {
      const blob = spawnSync('git', ['-C', root, 'cat-file', 'blob', revision + ':' + path], { ...gitOptions(), encoding: 'buffer' })
      verified.set(path, blob.status === 0 && sha256(blob.stdout) === hash)
    }
    return verified.get(path)
  }
  const site = db.prepare(`select distinct f.path, f.content_hash, e.start_line as line, e.id as evidence_id from assertion a join assertion_evidence ae on ae.assertion_id=a.id
    join evidence e on e.id=ae.evidence_id join file f on f.id=e.file_id where a.source_id=? and a.target_id=? and a.type='depends_on' order by f.path, e.start_byte limit 2`)
  const edges = [...arcs.values()].map(([from, to]) => {
    const hits = site.all(ids.get(from.label) ?? '', ids.get(to.label) ?? '') as (Witness & { content_hash: string })[]
    if (hits.length !== 1) return { from, to, witness: null, missing_location: hits.length ? 'multiple_static_declarations' : 'no_static_declaration' }
    const { content_hash, ...witness } = hits[0]!
    if (!matchesRevision(witness.path, content_hash)) return { from, to, witness: null, missing_location: 'build_file_differs_from_revision' }
    return { from, to, witness }
  })
  return { targets: [...nodes.values()], edges, unknown_labels: unknown.length, unsupported_edges: edges.filter((e) => !e.witness).length, diagnostics }
}
