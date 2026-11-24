// pnpm conformance: every first-party adapter against its hand-written fixtures.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'conformance.json'), 'utf8'))
const problems = []
const listed = new Set(Object.values(manifest.adapters).flatMap((a) => a.fixtures))
for (const dir of fs.readdirSync(path.join(root, 'fixtures'), { withFileTypes: true }).filter((d) => d.isDirectory())) {
  if (!listed.has(dir.name)) problems.push(`fixtures/${dir.name} is not listed in fixtures/conformance.json`)
}
for (const name of listed) {
  const base = path.join(root, 'fixtures', name)
  const provenance = path.join(base, 'PROVENANCE.md')
  if (!fs.existsSync(provenance)) problems.push(`${name}: PROVENANCE.md is missing`)
  else if (!/Apache-2\.0/.test(fs.readFileSync(provenance, 'utf8'))) problems.push(`${name}: PROVENANCE.md does not state Apache-2.0`)
  if (!manifest.behaviour_only.includes(name) && !fs.existsSync(path.join(base, 'expected.json'))) problems.push(`${name}: expected.json (the hand-written oracle) is missing`)
  // A contract-adapter fixture holds several repositories, repo-a and repo-b; a history fixture, a base/ tree and overlays its test commits.
  if (!fs.existsSync(path.join(base, 'repo')) && !fs.existsSync(path.join(base, 'base')) && !fs.readdirSync(base).some((f) => /^repo-/.test(f))) problems.push(`${name}: repo/ is missing`)
}
const tests = [...new Set(Object.values(manifest.adapters).flatMap((a) => a.tests))]
const out = path.join(os.tmpdir(), `proofmesh-conformance-${process.pid}.json`)
spawnSync(process.execPath, [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=json', `--outputFile=${out}`, ...tests], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] })
const report = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { testResults: [] }
const byFile = new Map(report.testResults.map((r) => [path.relative(root, r.name), r.assertionResults]))
let failed = problems.length
for (const [adapter, spec] of Object.entries(manifest.adapters)) {
  const results = spec.tests.flatMap((t) => byFile.get(t) ?? [{ status: 'missing', fullName: `${t} did not run` }])
  const pass = results.filter((r) => r.status === 'passed').length, skipped = results.filter((r) => r.status === 'skipped' || r.status === 'pending').length
  const bad = results.filter((r) => !['passed', 'skipped', 'pending'].includes(r.status))
  failed += bad.length
  console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${adapter.padEnd(11)} ${pass} passed${skipped ? `, ${skipped} skipped` : ''}${bad.length ? `, ${bad.length} failed` : ''}  fixtures: ${spec.fixtures.join(', ')}`)
  for (const b of bad) console.log(`      ${b.status}: ${b.fullName}`)
}
for (const p of problems) console.log(`FAIL  ${p}`)
fs.rmSync(out, { force: true })
process.exitCode = failed ? 1 : 0
