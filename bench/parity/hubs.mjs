// Measure Q13 through MCP, then verify every returned identity and count against the same sealed TypeORM snapshot.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { McpClient } from '../graph-bench/mcp-client.mjs'
import { last, makeTruth, queryGraphQuery, score } from '../graph-bench/lib.mjs'

const [repo, data, truthFile] = process.argv.slice(2)
if (!truthFile) throw new Error('usage: node bench/parity/hubs.mjs <indexed TypeORM checkout> <data directory> <compiler truth.json>')
const root = path.resolve(import.meta.dirname, '../..')
const q = { kind: 'hubs', top: 10 }, [query, params] = queryGraphQuery(q)
const pm = new McpClient('/usr/bin/time', [process.platform === 'darwin' ? '-l' : '-v', process.execPath,
  path.join(root, 'packages/proofmesh/bin/proofmesh.mjs'), '--data-dir', path.resolve(data), 'mcp', '--tools', 'extra'], { cwd: repo })
const times = []
let answer
try {
  await pm.init()
  for (let i = 0; i < 5; i++) {
    const r = await pm.call('query_graph', { query, params, envelope: 'full', limits: { max_rows: 10, timeout_ms: 30000 } })
    assert.ok(r.json?.data?.rows, r.text)
    assert.equal(r.json.completion.truncated, false)
    times.push(Math.round(r.ms))
    answer = r.json
  }
} finally {
  pm.proc.stdin.end()
  await pm.closed
}
const bsd = /(\d+)\s+maximum resident set size/.exec(pm.stderr)
const gnu = /Maximum resident set size \(kbytes\): (\d+)/.exec(pm.stderr)
assert.ok(bsd || gnu, pm.stderr)
const db = new DatabaseSync(path.join(data, 'snapshots', answer.snapshot.id + '.db'), { readOnly: true })
try {
  const sql = `from assertion a join symbol d on d.id = a.target_id join file f on f.id = d.file_id
    left join symbol s on s.id = a.source_id where a.type in ('calls','references') and a.resolution = 'resolved' and d.kind <> 'module'`
  const { assertions } = db.prepare('select count(*) as assertions ' + sql).get()
  const expected = db.prepare(`select d.id, count(distinct case when s.kind = 'module' then s.file_id else a.source_id end) as users
    ${sql} and a.source_id <> d.id group by d.id order by users desc, f.path, d.start_line, d.qualified_name, d.id limit 10`).all()
  const actual = answer.data.rows.map(({ values: [node, n] }) => [node.id, n])
  assert.deepEqual(actual, expected.map(r => [r.id, r.users]))
  const ranked = answer.data.rows.map(({ values: [node, n] }) => [node.path + '::' + last(node.name), n])
  const truth = makeTruth(JSON.parse(fs.readFileSync(truthFile))).truthFor(q)
  console.log(JSON.stringify({ assertions, call_ms: times, server_peak_rss_bytes: bsd ? Number(bsd[1]) : Number(gnu[1]) * 1024,
    snapshot: answer.snapshot.id, ranked, compiler_ranked: truth.ranked, compiler: score(truth.items, new Set(ranked.map(([key]) => key))) }, null, 2))
} finally { db.close() }
