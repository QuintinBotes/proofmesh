import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ROOT, cli, fixtureRepo, symbolId, tmpDir, tool } from './helpers.js'

// #30: findings a data-flow analyser wrote as SARIF, attached to the innermost symbol at their line and shown beside impact and test reach.
type Finding = { import: string; tool: string; rule: string; level: string; path: string; line: number | null; rank: number | null; precision: string | null; symbol: { qualified_name: string } | null; stale: string | null }
const SARIF = path.join(ROOT, 'fixtures', 'sarif', 'findings.sarif')

let d: string, repo: string, added: { status: number | null; stdout: string; stderr: string }
const run = (...args: string[]) => { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0); return r }
const findings = (input: Record<string, unknown>) => tool(d, 'get_findings', input)
beforeAll(() => {
  repo = fs.realpathSync(tmpDir('pm-sarif-'))
  fs.cpSync(fixtureRepo('sarif'), repo, { recursive: true })
  d = tmpDir()
  run('init'); run('repo', 'add', repo); run('index', repo)
  added = run('sarif', 'add', repo, SARIF)
})

describe('FR1900 to FR1905 SARIF findings attached to symbols (fixtures/sarif)', () => {
  it('FR1900 FR1901 scenario 1: each finding is attached to the innermost symbol at its line, and get_findings on each subject returns exactly its findings', () => {
    expect(added.stdout).toContain('SARIF file findings imported for')
    expect(added.stdout).toContain('3 findings attached')
    const of = (name: string) => (findings({ subject_ids: [symbolId(d, name)] }).data.findings as Finding[]).map((f) => [f.tool, f.rule, f.level, `${f.path}:${f.line}`, f.symbol?.qualified_name])
    expect(of('src/db:Store.find')).toEqual([['CodeQL 2.19.0', 'js/sql-injection', 'error', 'src/db.ts:7', 'src/db:Store.find']])
    expect(of('src/api:handle')).toEqual([['Opengrep 1.6.0', 'typescript.lang.tainted-store-lookup', 'warning', 'src/api.ts:5', 'src/api:handle']])
    expect(of('test/api.test:handlesAnId')).toEqual([['Opengrep 1.6.0', 'javascript.lang.correctness.useless-eqeq', 'note', 'test/api.test.ts:4', 'test/api.test:handlesAnId']])
    expect(of('src/db:runQuery')).toEqual([])
    // Edge cases: each run's tool is recorded, a duplicate result is one finding, and precision and rank are kept.
    const all = findings({})
    expect((all.data.findings as Finding[]).length).toBe(3)
    expect(all.data.imports).toMatchObject([{ name: 'findings', tools: ['CodeQL 2.19.0', 'Opengrep 1.6.0'], findings: 3 }])
    expect((all.data.findings as Finding[]).find((f) => f.rule === 'js/sql-injection')).toMatchObject({ import: 'findings', rank: 90, precision: 'high', stale: null })
    expect((findings({ paths: ['src/api.ts'] }).data.findings as Finding[]).map((f) => f.line)).toEqual([5])
  })

  it('FR1902 scenario 2: an impact row whose dependent holds a finding carries findings=1, and so does a find_tests row', () => {
    const impact = tool(d, 'analyze_impact', { subject_ids: [symbolId(d, 'src/db:runQuery')], envelope: 'full' })
    const rows = impact.data.dependents as Array<{ qualified_name: string; findings?: number }>
    expect(rows.find((r) => r.qualified_name === 'src/db:Store.find')?.findings).toBe(1)
    expect(rows.find((r) => r.qualified_name === 'src/db:Store')?.findings).toBeUndefined()
    const lean = (tool(d, 'analyze_impact', { subject_ids: [symbolId(d, 'src/db:runQuery')], envelope: 'lean' }) as unknown as { text: string }).text
    expect(lean).toMatch(/^Store\.find src\/db\.ts:7 depth=1 calls findings=1$/m)
    const tests = tool(d, 'find_tests', { subject_ids: [symbolId(d, 'src/api:handle')], envelope: 'full' }).data.tests as Array<{ name: string; findings?: number }>
    expect(tests.find((t) => t.name === 'handlesAnId')?.findings).toBe(1)
  })

  it('FR1903 scenario 4: a result outside the repository or in a file not in the snapshot is listed in the import\'s limitations and not attached', () => {
    expect(added.stdout).toContain('2 results not attached')
    expect(added.stdout).toMatch(/\.\.\/outside\/lib\.ts:3 js\/sql-injection: outside_repository/)
    expect(added.stdout).toMatch(/src\/missing\.ts:1 typescript\.lang\.tainted-store-lookup: not_in_snapshot/)
    expect(run('sarif', 'list', repo).stdout).toMatch(/^findings .* 3 findings, 2 not attached/m)
    expect(findings({}).limitations.join('\n')).toContain('2 results of SARIF file findings were not attached: 1 outside_repository, 1 not_in_snapshot')
  })

  it('FR1904 scenario 3: a finding in a file edited after import is stale (sarif_stale:<name>) until a new SARIF file is imported', () => {
    fs.writeFileSync(path.join(repo, 'src', 'db.ts'), `// edited\n${fs.readFileSync(path.join(repo, 'src', 'db.ts'), 'utf8')}`)
    run('index', repo)
    const stale = findings({ paths: ['src/db.ts'] })
    expect((stale.data.findings as Finding[]).map((f) => f.stale)).toEqual(['sarif_stale:findings'])
    expect(stale.limitations.join('\n')).toContain('1 finding is in a file changed since its SARIF file was imported')
    expect((findings({ paths: ['src/api.ts'] }).data.findings as Finding[]).map((f) => f.stale)).toEqual([null])
    run('sarif', 'add', repo, SARIF)
    expect((findings({ paths: ['src/db.ts'] }).data.findings as Finding[]).map((f) => f.stale)).toEqual([null])
  })

  it('FR1904 a finding in a file deleted from the tree since the snapshot is imported, and stale', () => {
    fs.rmSync(path.join(repo, 'test', 'api.test.ts'))
    run('sarif', 'add', repo, SARIF, '--name', 'after-delete')
    expect((findings({ paths: ['test/api.test.ts'] }).data.findings as Finding[]).map((f) => [f.import, f.stale])).toEqual([['after-delete', 'sarif_stale:after-delete'], ['findings', null]])
  })

  it('FR1900 a file that is not SARIF 2.1.0 is refused and nothing is imported', () => {
    const bad = path.join(tmpDir('pm-sarif-bad-'), 'bad.sarif')
    fs.writeFileSync(bad, JSON.stringify({ version: '2.0.0', runs: [] }))
    const r = cli(['--data-dir', d, 'sarif', 'add', repo, bad])
    expect([r.status, r.stderr]).toEqual([1, expect.stringContaining('is not a SARIF 2.1.0 file')])
    expect(run('sarif', 'list', repo).stdout).not.toMatch(/^bad /m)
  })
})
