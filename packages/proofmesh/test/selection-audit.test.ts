import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { ROOT, tmpDir } from './helpers.js'

it('FR2143 full-suite replay distinguishes a selected failure, an omitted runtime test, unmapped tests and a green run (#303)', () => {
  const dir = tmpDir(), xml = path.join(dir, 'suite.xml'), selected = path.join(dir, 'selection.json')
  const mapping = path.join(dir, 'map.json')
  fs.writeFileSync(mapping, JSON.stringify({ 'runtime::plugin': 'runtime.test.ts' }))
  const run = (revision: string, failure: string | null) => {
    const selection = { base: { commit: 'base', snapshot_id: 'snap_base' }, head: { commit: revision, snapshot_id: 'snap_head' }, tests: [
      { path: 'direct.test.ts', changed: [{ path: 'money.ts', line: 2, change: 'modified', evidence: 'executes' }] },
    ], incomplete: revision === 'two' ? ['unresolved calls'] : [] }
    fs.writeFileSync(selected, JSON.stringify(selection))
    const cases = ['direct', 'plugin', 'unmapped'].map((n) => `<testcase name="${n}" classname="runtime" ${n === 'direct' ? 'file="direct.test.ts"' : ''} ${n === 'plugin' ? 'time="0.5"' : ''}>${n === failure ? '<failure/>' : ''}</testcase>`)
    fs.writeFileSync(xml, `<testsuite tests="3" failures="${failure ? 1 : 0}">${cases.join('')}</testsuite>`)
    const replay = () => spawnSync('python3', [path.join(ROOT, 'docs/proofmesh/ci/audit-tests.py'), selected, xml, '--mapping', mapping, '--head', revision, '--suite-exit', failure ? '1' : '0','--repo-url','https://github.com/example/ledger'], { encoding: 'utf8' })
    const result = replay()
    expect(result.status, result.stderr).toBe(0)
    return { report: JSON.parse(result.stdout), replay }
  }
  expect(run('one', 'direct').report).toMatchObject({ failure_recall: 1, selected_tests: 1, total_tests: 3, mapped: 2, omitted_test_seconds: 0.5 })
  expect(run('two', 'plugin').report).toMatchObject({ failure_recall: 0, omitted_failures: [{ id: 'runtime::plugin', path: 'runtime.test.ts' }], selection: { incomplete: ['unresolved calls'] }, evidence_links: [{ url: 'https://github.com/example/ledger/blob/two/money.ts#L2' }] })
  expect(run('unknown', 'unmapped').report).toMatchObject({ failure_recall: 'unknown', unmapped_failures: 1 })
  const { report, replay } = run('three', null)
  expect(report.failure_recall).toBe('uninformative')
  for (const truncated of ['<testsuite', '<testsuite tests="2"><testcase name="only-one"/></testsuite>']) {
    fs.writeFileSync(xml, truncated)
    expect(replay()).toMatchObject({ status: 2, stdout: '' })
  }
})
