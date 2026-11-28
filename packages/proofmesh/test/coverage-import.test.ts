import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { matchPaths, readCoverage } from '../src/coverage/read.js'
import { ROOT, cli, fixtureRepo, symbolId, tmpDir, tool } from './helpers.js'

// #241: coverage reports a test run wrote, imported beside static test reach. Proofmesh runs no test.
type Coverage = { executed: boolean | null; lines_covered: number; lines_total: number; source: string; format: string; window: { from: string; to: string }; stale: boolean; at: { path: string; line: number } | null }
type TestRow = { name: string; evidence: string; depth: number; basis: string; chain: unknown[] }
const REPORTS = path.join(ROOT, 'fixtures', 'coverage')
const report = (name: string) => path.join(REPORTS, name)
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim()

let d: string, repo: string, before: { tests: string; relationships: string; status: string; symbol: string }
const imports: Record<string, string> = {}
const run = (...args: string[]) => { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0); return r }
const at = (p: string, name: string) => ({ subject_ids: [{ path: p, name }] })
const tests = (p: string, name: string, envelope = 'full') => tool(d, 'find_tests', { ...at(p, name), envelope })
const coverage = (p: string, name: string) => tests(p, name).data.coverage as Coverage | undefined
const leanOf = (e: unknown) => (e as { text: string }).text
const stripTiming = (e: unknown) => JSON.stringify({ ...(e as Record<string, unknown>), timing: undefined, meta: undefined })

beforeAll(() => {
  repo = fs.realpathSync(tmpDir('pm-coverage-'))
  fs.cpSync(fixtureRepo('coverage'), repo, { recursive: true })
  d = tmpDir()
  run('init'); run('repo', 'add', repo); run('index', repo)
    before = {
    tests: stripTiming(tool(d, 'find_tests', { ...at('src/calc.ts', 'viaRegistry'), envelope: 'full' }).data),
    relationships: relationships(),
    status: stripTiming(tool(d, 'workspace_status', {}).data),
    symbol: stripTiming(tool(d, 'get_symbol', { path: 'src/calc.ts', envelope: 'full' }).data),
  }
  imports.lcov = run('observe', 'import', repo, report('lcov.info'), '--format', 'lcov').stdout
  imports.cobertura = run('observe', 'import', repo, report('cobertura.xml'), '--format', 'cobertura', '--test', 'test_total').stdout
  imports.jacoco = run('observe', 'import', repo, report('jacoco.xml'), '--format', 'jacoco').stdout
  imports.go = run('observe', 'import', repo, report('cover.out'), '--format', 'go-cover').stdout
})

/** get_relationships of viaRegistry, both directions. */
const relationships = () => stripTiming(tool(d, 'get_relationships', { subject_id: symbolId(d, 'src/calc:viaRegistry'), direction: 'both', envelope: 'full' }).data)

describe('FR2060 to FR2067 coverage reports beside static test reach (fixtures/coverage)', () => {
  it('FR2060 FR2061 FR2066 SC-001 scenario 1: each format imports with its files matched, files not in the snapshot and lines covered', () => {
    expect(imports.lcov).toMatch(/2 files matched, 1 not in the snapshot, 1 ambiguous; 4 of 8 lines covered/)
    expect(imports.lcov).toMatch(/^ {2}\/ci\/build\/src\/generated\.ts: not_in_snapshot$/m)
    expect(imports.lcov).toMatch(/^ {2}util\.ts: ambiguous \(src\/a\/util\.ts, src\/b\/util\.ts\)$/m)
    expect(imports.cobertura).toMatch(/2 files matched, 0 not in the snapshot, 0 ambiguous; 6 of 7 lines covered/)
    expect(imports.jacoco).toMatch(/1 file matched, 0 not in the snapshot, 0 ambiguous; 2 of 3 lines covered/)
    expect(imports.go).toMatch(/1 file matched, 0 not in the snapshot, 0 ambiguous; 3 of 6 lines covered/)
    expect(run('observe', 'validate', report('jacoco.xml'), '--format', 'jacoco').stdout).toMatch(/is a valid jacoco coverage report: 1 file, 2 of 3 lines covered/)
    expect(run('observe', 'list', repo).stdout).toMatch(/^lcov {2}lcov .* 2 files matched/m)
    // The content hash stored for each file is the snapshot's.
    const ws = tool(d, 'workspace_status', {}).data.coverage as Array<{ source: string; format: string; files_matched: number; stale_files: number }>
    expect(ws.map((c) => [c.source, c.format, c.files_matched, c.stale_files])).toEqual([['cobertura', 'cobertura', 2, 0], ['cover', 'go-cover', 1, 0], ['jacoco', 'jacoco', 1, 0], ['lcov', 'lcov', 2, 0]])
  })

  it('FR2062 FR2063 scenario 2: a function no test reaches statically but the report covers is executed by coverage', () => {
    const env = tests('src/calc.ts', 'viaRegistry')
    expect((env.data.tests as TestRow[]).filter((t) => t.evidence !== 'coverage')).toEqual([])
    expect(env.data.coverage).toMatchObject({ executed: true, lines_covered: 1, lines_total: 1, source: 'lcov', format: 'lcov', stale: false, at: { path: 'src/calc.ts', line: 15 } })
    expect((env.data.coverage as Coverage).window.from).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(leanOf(tests('src/calc.ts', 'viaRegistry', 'lean')).split('\n')[0]).toMatch(/^# find_tests · executed by coverage lcov · /)
    // Each format: the innermost symbol holding a hit line is executed.
    expect([coverage('py/shop.py', 'total'), coverage('java/src/com/acme/Cart.java', 'count'), coverage('go/calc/calc.go', 'Add')].map((c) => [c?.source, c?.executed])).toEqual([['cobertura', true], ['jacoco', true], ['cover', true]])
    expect([coverage('java/src/com/acme/Cart.java', 'empty'), coverage('go/calc/calc.go', 'Sub'), coverage('src/calc.ts', 'untouched')].map((c) => [c?.executed, c?.lines_covered, c?.lines_total])).toEqual([[false, 0, 1], [false, 0, 3], [false, 0, 1]])
    // A Python def line runs at import: discount is executed by that line alone, and lines_covered says so.
    expect(coverage('py/shop.py', 'discount')).toMatchObject({ executed: true, lines_covered: 1, lines_total: 2 })
    // get_symbol answers coverage in the full envelope.
    expect(tool(d, 'get_symbol', { path: 'src/helper.ts', envelope: 'full' }).data.coverage).toMatchObject({ executed: true, source: 'lcov' })
    expect(tool(d, 'get_symbol', { path: 'src/helper.ts', envelope: 'compact' }).data.coverage).toBeUndefined()
  })

  it('FR2063 scenario 3: a function with static test reach that the report shows not executed keeps its tests', () => {
    const env = tests('src/calc.ts', 'rarely')
    expect((env.data.tests as TestRow[]).map((t) => [t.name, t.evidence])).toEqual([['rarelyWhenSkipped', 'call']])
    expect(env.data.coverage).toMatchObject({ executed: false, lines_covered: 0, lines_total: 3, at: null })
    expect(leanOf(tests('src/calc.ts', 'rarely', 'lean')).split('\n')[0]).toMatch(/^# find_tests · not executed by coverage lcov · 1 row · /)
  })

  it('FR2063 scenario 5: each test a report names as executing the symbol is listed with evidence coverage', () => {
    const via = tests('src/calc.ts', 'viaRegistry').data.tests as TestRow[]
    expect(via.map((t) => [t.name, t.evidence, t.depth, t.chain])).toEqual([['runsTheRegistry', 'coverage', 1, []]])
    expect(tests('src/calc.ts', 'viaRegistry').data.totals).toMatchObject({ tests: 1, executing: 1 })
    expect(leanOf(tests('src/calc.ts', 'viaRegistry', 'lean'))).toMatch(/^runsTheRegistry test\/calc\.test\.ts:7 coverage$/m)
    // A test a static chain already reaches is listed once, by its chain.
    expect((tests('src/calc.ts', 'add').data.tests as TestRow[]).map((t) => [t.name, t.evidence])).toEqual([['addsTwoNumbers', 'call']])
    // One report per test, named by --test.
    expect((tests('py/shop.py', 'total').data.tests as TestRow[]).map((t) => [t.name, t.evidence])).toEqual([['test_total', 'coverage']])
  })

  it('FR2065 FR2066 SC-003 coverage adds no relationship and changes no basis; answers with no report covering them are as before', () => {
    expect(relationships()).toBe(before.relationships)
    expect(JSON.parse(before.tests)).not.toHaveProperty('coverage')
    expect(JSON.parse(before.tests).observed).toEqual({ available: false, reason: 'No coverage data has been imported for this snapshot.' })
    expect(JSON.parse(before.status)).not.toHaveProperty('coverage')
    expect(JSON.parse(before.symbol)).not.toHaveProperty('coverage')
    expect(tests('src/calc.ts', 'viaRegistry').data.observed).toMatchObject({ available: true })
  })

  it('FR2060 paths: --strip-prefix makes a report path exact; a suffix two files share is ambiguous', () => {
    expect(matchPaths(['/ci/build/src/calc.ts', 'util.ts', 'calc.ts', 'x/missing.ts'], ['src/calc.ts', 'src/a/util.ts', 'src/b/util.ts', 'lib/src/calc.ts'], '/ci/build/')).toEqual({
      matched: new Map([['/ci/build/src/calc.ts', 'src/calc.ts']]),
      unmatched: [{ path: 'util.ts', reason: 'ambiguous', candidates: ['src/a/util.ts', 'src/b/util.ts'] }, { path: 'calc.ts', reason: 'ambiguous', candidates: ['lib/src/calc.ts', 'src/calc.ts'] }, { path: 'x/missing.ts', reason: 'not_in_snapshot', candidates: [] }],
    })
    // Without the prefix, the longer shared suffix wins.
    expect(matchPaths(['/ci/build/src/calc.ts'], ['src/calc.ts', 'calc.ts']).matched.get('/ci/build/src/calc.ts')).toBe('src/calc.ts')
  })

  it('FR2060 SC-004 a report is read in pieces, and a character split between two pieces is read whole', () => {
    const f = path.join(tmpDir('pm-coverage-read-'), 'big.info'), pad = `TN:${'x'.repeat((1 << 20) - 'TN:'.length - 1)}\n`
    // The é of the path straddles the first 1 MB read.
    fs.writeFileSync(f, `${pad.slice(0, -5)}\nSF:é/a.ts\nDA:1,1\nend_of_record\n`)
    const r = readCoverage(f, 'lcov')
    expect([...r.keys()]).toEqual(['é/a.ts'])
    expect([...r.get('é/a.ts')!.tests.values()]).toEqual([[1]])
  })

  it('FR2061 scenario 6: coverage of a file edited after the report is stale and answers no status; the newest fresh import answers', () => {
    fs.writeFileSync(path.join(repo, 'src', 'calc.ts'), `// edited\n${fs.readFileSync(path.join(repo, 'src', 'calc.ts'), 'utf8')}`)
    run('index', repo)
    expect(coverage('src/calc.ts', 'viaRegistry')).toMatchObject({ executed: null, stale: true, source: 'lcov' })
    expect((tests('src/calc.ts', 'viaRegistry').data.tests as TestRow[])).toEqual([])
    expect((tool(d, 'workspace_status', {}).data.coverage as Array<{ source: string; stale_files: number }>).find((c) => c.source === 'lcov')?.stale_files).toBe(1)
    run('observe', 'import', repo, report('lcov.info'), '--format', 'lcov', '--source', 'lcov-after-edit')
    expect(coverage('src/calc.ts', 'viaRegistry')).toMatchObject({ stale: false, source: 'lcov-after-edit' })
  })

  it('FR2060 a file that is not a report of its format is refused and nothing is imported', () => {
    const r = cli(['--data-dir', d, 'observe', 'import', repo, report('cover.out'), '--format', 'jacoco'])
    expect([r.status, r.stderr]).toEqual([1, expect.stringContaining('is not a jacoco coverage report')])
    expect(cli(['--data-dir', d, 'observe', 'import', repo, report('cover.out'), '--format', 'clover']).stderr).toContain('--format takes lcov, cobertura, jacoco or go-cover')
  })
})

describe('FR2064 impact_completeness: covered, beside changed, tested and neither', () => {
  let r: string, dd: string
  beforeAll(() => {
    r = fs.realpathSync(tmpDir('pm-coverage-diff-'))
    fs.cpSync(fixtureRepo('coverage'), r, { recursive: true })
    git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'base')
    dd = tmpDir()
    for (const args of [['init'], ['repo', 'add', r], ['index', r], ['observe', 'import', r, report('lcov.info'), '--format', 'lcov']]) expect(cli(['--data-dir', dd, ...args]).status).toBe(0)
    fs.writeFileSync(path.join(r, 'src', 'helper.ts'), 'export function double(n: number): number {\n  return n + n\n}\n')
    expect(cli(['--data-dir', dd, 'index', r]).status).toBe(0)
  })

  it('scenario 4: a dependent with no static test whose lines are covered is covered, counted apart; the CLI exits 0 unless --static-only', () => {
    // The CLI first: it indexes the base commit, which has no snapshot yet.
    const text = cli(['--data-dir', dd, 'completeness', r, 'HEAD'])
    expect(text.status, text.stdout + text.stderr).toBe(0)
    expect(text.stdout).toMatch(/^ {2}calls viaRegistry src\/calc\.ts:15 covered coverage=lcov$/m)
    expect(text.stdout).toContain('1 dependent: 0 changed, 0 tested, 1 covered, 0 neither')
    const env = tool(dd, 'impact_completeness', { base: 'HEAD', envelope: 'full' })
    const deps = (env.data.changed as Array<{ name: string; dependents: Array<{ name: string; status: string; coverage?: { source: string } }> }>).flatMap((c) => c.dependents)
    expect(deps.map((x) => [x.name, x.status, x.coverage?.source])).toEqual([['viaRegistry', 'covered', 'lcov']])
    expect(env.data.totals).toMatchObject({ dependents: 1, tested: 0, covered: 1, neither: 0 })
    expect(cli(['--data-dir', dd, 'completeness', r, 'HEAD', '--static-only']).status).toBe(1)
  })
})
