import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EvidenceStore } from '../src/evidence/store.js'
import { expect, it } from 'vitest'
import { cli, indexedRepo, tmpDir, tool } from './helpers.js'

it('FR1901 SARIF paths retain repeated, external, stale and unplaced steps beside verified accounting source (#299)', async () => {
  const { repo, dataDir, snapshotId } = await indexedRepo({ 'input.ts': 'export const cents = 199\n', 'normalize.ts': 'export const rounded = Math.round(1.99)\n', 'display.ts': 'export const display = "2"\n' })
  const location = (uri?: string, line?: number) => ({ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } })
  const thread = (...steps: ReturnType<typeof location>[]) => ({ locations: steps.map((s) => ({ location: s })) })
  const input = location('input.ts', 1), mid = location('normalize.ts', 1), output = location('display.ts', 1)
  const report = path.join(tmpDir(), 'rounding.sarif')
  fs.writeFileSync(report, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'Ledger', version: '1' } }, results: [{
    ruleId: 'rounding', locations: [output], codeFlows: [
      { threadFlows: [thread(input, mid, mid, output), thread(location('../external.ts', 1))] },
      { threadFlows: [thread(input, location('normalize.ts'), output)] },
    ],
  }] }] }))
  const add = () => expect(cli(['--data-dir', dataDir, 'sarif', 'add', repo, report]).status).toBe(0)
  const read = (flow_steps?: number, snapshot_id?: string) => (tool(dataDir, 'get_findings', { flow_steps, snapshot_id }).data.findings as any[])[0]
  add()
  expect(read()).not.toHaveProperty('flow')
  expect(read()).not.toHaveProperty('code_flow')
  const first = read(16)
  expect(first.tool).toBe('Ledger 1')
  expect(first.code_flow.steps.map((s: any) => [s.flow,s.thread,s.step,s.status])).toEqual([
    [1,1,1,'verified'],[1,1,2,'verified'],[1,1,3,'verified'],[1,1,4,'verified'],[1,2,1,'outside_repository'],
    [2,1,1,'verified'],[2,1,2,'no_position'],[2,1,3,'verified'],
  ])
  expect(first.code_flow.steps[1].source_line).toContain('Math.round')
  expect(read(2).code_flow).toMatchObject({ total_steps: 8, truncated: true, steps: first.code_flow.steps.slice(0,2) })
  const compact = tool(dataDir, 'get_findings', { flow_steps: 16, envelope: 'compact' })
  const capped = tool(dataDir, 'get_findings', { flow_steps: 16, envelope: 'compact', limits: { max_bytes: Buffer.byteLength(JSON.stringify(compact)) - 500 } })
  expect(capped.completion.stop_reasons).toContain('max_bytes')
  expect(capped.data.findings).toMatchObject([{ rule: 'rounding', code_flow: { total_steps: 8, truncated: true } }])
  add()
  expect(read(16)).toEqual(first)
  fs.writeFileSync(path.join(repo, 'normalize.ts'), 'export const rounded = 2\n')
  expect(cli(['--data-dir', dataDir, 'index', repo]).status).toBe(0)
  expect(read(16)).toMatchObject({ stale: null })
  expect(read(16).code_flow.steps[1]).toMatchObject({ status: 'stale', source_line: null })
  expect(read(16, snapshotId)).toEqual(first)
  const imported = JSON.parse(fs.readFileSync(report, 'utf8'))
  const r = imported.runs[0]
  r.originalUriBaseIds = { ROOT: { uri: pathToFileURL(repo + path.sep).href }, SRC: { uri: './', uriBaseId: 'ROOT' } }
  r.artifacts = [{ location: { uri: 'input.ts', uriBaseId: 'SRC' } }]
  const steps = r.results[0].codeFlows[0].threadFlows[0].locations
  steps[0].location.physicalLocation.artifactLocation = { index: 0 }
  steps[3].location.physicalLocation.artifactLocation.uriBaseId = 'unknown'
  fs.writeFileSync(report, JSON.stringify(imported))
  add()
  expect(read(16).code_flow.steps[0]).toMatchObject({ path: 'input.ts', status: 'verified' })
  expect(read(16).code_flow.steps[3]).toMatchObject({ path: null, status: 'unresolved_location' })
  const hash = first.code_flow.steps[0].object_hash
  fs.writeFileSync(new EvidenceStore(dataDir).objectPath(hash), 'wrong bytes')
  expect(read(16).code_flow.steps[0]).toMatchObject({ status: 'failed', source_line: null })
})
