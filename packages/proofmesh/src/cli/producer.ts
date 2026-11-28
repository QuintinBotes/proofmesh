import { Catalog, noSnapshot } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'
import { invalid, readArtifact, saveArtifact, validateIdentity } from '../producer/artifact.js'
import { readCquery, type Graph } from '../producer/cquery.js'
import { importGenerates } from '../producer/generates.js'

export function producerCommand(dataDir: string, kind: 'generates' | 'cquery', args: string[]) {
  const [verb, repo, ...rest] = args
  if (!repo) return invalid('Supply a registered repository.')
  const catalog = Catalog.open(dataDir)
  try {
    const r = catalog.repository(repo), snap = catalog.currentSnapshot(r.id)
    if (!snap) throw noSnapshot(catalog, r.id)
    const db = openSnapshot(catalog, snap)
    try {
      let answer: unknown
      if (verb === 'add' && kind === 'generates' && rest.length === 1) answer = importGenerates(catalog, db, r.id, snap.id, readArtifact(rest[0]!))
      else if (verb === 'add' && kind === 'cquery' && rest.length === 5) {
        const [file, format, producer, revision, name] = rest as [string, string, string, string, string]
        if (format !== 'bazel-cquery-dot/v1') return invalid('Unsupported cquery format. Expected bazel-cquery-dot/v1.')
        const identity = { producer, revision, name }
        validateIdentity(db, identity)
        const graph = readCquery(db, readArtifact(file))
        saveArtifact(catalog, r.id, snap.id, kind, identity, graph)
        answer = { ...identity, targets: graph.targets.length, edges: graph.edges.length, unknown_labels: graph.unknown_labels, unsupported_edges: graph.unsupported_edges, diagnostics: graph.diagnostics }
      } else if (kind === 'cquery' && verb === 'deps' && (rest.length === 1 || rest.length === 2)) {
        const row = catalog.db.prepare("select producer,revision,evidence from producer_import where repository_id=? and snapshot_id=? and kind='cquery' and name=?").get(r.id, snap.id, rest[0]) as { producer: string; revision: string; evidence: string } | undefined
        if (!row) return invalid('No configured graph with that name for the current snapshot. Check cquery status and import a matching export.')
        const graph = JSON.parse(row.evidence) as Graph
        const targets = graph.targets.filter((t) => !rest[1] || t.label === rest[1])
        if (rest[1] && !targets.length) return invalid('Target is absent from the configured graph.')
        answer = { configuration: rest[0], revision: row.revision, producer: row.producer, ...graph, targets, edges: graph.edges.filter((e) => !rest[1] || e.from.label === rest[1]) }
      } else if (verb === 'status' && !rest.length) {
        const rows = catalog.db.prepare('select name,producer,revision,snapshot_id,evidence from producer_import where repository_id=? and kind=? order by name,snapshot_id').all(r.id, kind) as { name: string; producer: string; revision: string; snapshot_id: string; evidence: string }[]
        answer = rows.map(({ evidence, ...row }) => ({ ...row, stale: row.snapshot_id !== snap.id, ...(kind === 'generates' ? JSON.parse(evidence) : {}) }))
      } else return invalid('Usage: proofmesh ' + kind + (kind === 'generates' ? ' add <repo> <mapping.json> | status <repo>' : ' add <repo> <graph.dot> bazel-cquery-dot/v1 <producer> <revision> <configuration> | deps <repo> <configuration> [label] | status <repo>'))
      console.log(JSON.stringify(answer))
      return 0
    } finally { db.close() }
  } finally { catalog.close() }
}
