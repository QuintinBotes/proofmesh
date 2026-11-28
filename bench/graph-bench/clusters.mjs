// Time the first and next ten MCP cluster calls against a sealed 50,000-symbol synthetic TS repository.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { McpClient } from './mcp-client.mjs'

const cli = path.resolve(import.meta.dirname, '../../packages/proofmesh/bin/proofmesh.mjs')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cluster-bench-'))
const repo = path.join(work, 'repo'), data = path.join(work, 'data')
const run = (...args) => execFileSync(process.execPath, [cli, '--data-dir', data, ...args], { encoding: 'utf8' })
let client
try {
  fs.mkdirSync(repo)
  for (let i = 0; i < 1000; i++) {
    const next = Math.floor(i / 10) * 10 + (i + 1) % 10
    const lines = [`import * as peer from './f${next}'`]
    for (let j = 0; j < 49; j++) lines.push(`export function value${j}(): number { return peer.value${j}() + ${i} }`)
    fs.writeFileSync(path.join(repo, `f${i}.ts`), lines.join('\n'))
  }
  run('init')
  run('repo', 'add', repo)
  const log = run('index', repo)
  console.log(log.trim())
  client = new McpClient(process.execPath, [cli, '--data-dir', data, 'mcp', '--tools', 'extra'])
  await client.init()
  const times = []
  let first
  for (let i = 0; i < 11; i++) {
    const r = await client.call('find_clusters', { envelope: 'compact', limits: { max_rows: 10 } })
    if (r.error || r.isError || r.json?.completion.total !== 100) throw Error(r.text || JSON.stringify(r.error))
    const body = JSON.stringify(r.json.data)
    if (i && body !== first) throw Error('cluster data changed between calls')
    first = body
    times.push(r.ms)
  }
  console.log(JSON.stringify({ cold_ms: times[0], warm_ms: times.slice(1) }))
  if (times[0] >= 5000 || Math.max(...times.slice(1)) >= 100) process.exitCode = 1
} finally {
  client?.close()
  fs.rmSync(work, { recursive: true, force: true })
}
