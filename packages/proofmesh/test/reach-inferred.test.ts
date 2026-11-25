import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { indexRepository } from '../src/indexer/coordinator.js'
import { Registry } from '../src/indexer/languages.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { runTool } from '../src/query/tools.js'
import { cli, fixtureRepo, indexedDataDir, indexedRepo, symbolId, tmpDir, tool } from './helpers.js'

// Issue 21: impact, test reach and paths follow candidate edges where no precise tier analysed the subject, every row reached through one inferred.
type Dep = { name: string; qualified_name: string; depth: number; basis: string }
type Impact = { dependents: Dep[]; totals: { dependents: number; by_basis: { observed: number; inferred: number } } }
const impact = (d: string, id: string | string[], input: Record<string, unknown> = {}) => tool(d, 'analyze_impact', { subject_ids: Array.isArray(id) ? id : [id], ...input })
const names = (env: { data: unknown }) => (env.data as Impact).dependents.map((x) => [x.qualified_name, x.depth, x.basis])
// Ids are hashes that depend on where the repository sits, so the digest leaves them out.
const sha = (e: { data: unknown; limitations: unknown }) => createHash('sha256').update(JSON.stringify({ d: e.data, l: e.limitations }).replace(/\b[a-z]+_[0-9a-f]{16,}\b/g, '<id>')).digest('hex').slice(0, 16)
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()

let constrained: string
let polyglot: string
beforeAll(async () => {
  ;({ dataDir: constrained } = await indexedDataDir(fixtureRepo('constrained')))
  ;({ dataDir: polyglot } = await indexedDataDir(fixtureRepo('tests-polyglot')))
}, 240000)

describe('FR201 FR202 FR203 FR209 issue 21 scenarios 1 and 2: analyze_impact in a language with no index', () => {
  it('FR203 scenario 1: the callers of lib/lib.go Format are run at depth 1, inferred, counted, and the answer says why candidate edges were followed', () => {
    const env = impact(constrained, symbolId(constrained, 'lib/lib:Format'))
    expect(names(env)).toEqual([['svc/main:run', 1, 'inferred']])
    expect((env.data as Impact).totals.by_basis).toEqual({ observed: 0, inferred: 1 })
    expect(env.limitations).toContain("Candidate edges were followed because the subject's file has no precise tier: every row reached through one is inferred.")
  })

  it('FR201 FR203 scenario 2: include_inferred false has no dependents and counts the candidate callers it did not follow', () => {
    const env = impact(constrained, symbolId(constrained, 'lib/lib:Format'), { include_inferred: false })
    expect((env.data as Impact).dependents).toEqual([])
    expect(env.limitations).toContain('1 candidate call site naming code on these paths was not followed; pass include_inferred true to follow it.')
    expect(env.limitations.some((l) => /^Candidate edges were followed/.test(l))).toBe(false)
  })

  it('FR201 include_inferred true asks for it, and the answer says the person did', () => {
    const env = impact(constrained, symbolId(constrained, 'lib/lib:Format'), { include_inferred: true })
    expect(names(env)).toEqual([['svc/main:run', 1, 'inferred']])
    expect(env.limitations).toContain('Candidate edges were followed because include_inferred was true: every row reached through one is inferred.')
  })

  it('FR201 any other value of include_inferred is refused', () => {
    expect(() => impact(constrained, symbolId(constrained, 'lib/lib:Format'), { include_inferred: 'sometimes' })).toThrow()
  })
})

describe('FR204 FR201 issue 21 scenario 3: an answer for a subject a precise tier analysed is unchanged', () => {
  // The hashes are of the data and limitations as the code before this slice answered them.
  it('FR204 scenario 3: analyze_impact, find_tests and trace_paths on the TypeScript fixtures are byte-identical to before, and to include_inferred false', async () => {
    const { dataDir: a } = await indexedDataDir(fixtureRepo('ts-invoicing'))
    const f = symbolId(a, 'packages/format/src/currency:formatAmount'), h = symbolId(a, 'packages/api/src/handler:handleInvoice')
    for (const [name, input, pinned] of [
      ['analyze_impact', { subject_ids: [f] }, 'c8a1ecabfbad4f62'],
      ['find_tests', { subject_ids: [f] }, '14229cabf3e620c9'],
      ['trace_paths', { source_id: h, target_id: f }, 'b5f3834127f771d9'],
    ] as const) {
      expect(sha(tool(a, name, input))).toBe(pinned)
      expect(sha(tool(a, name, { ...input, include_inferred: false }))).toBe(pinned)
    }
    const { dataDir: m } = await indexedDataDir(fixtureRepo('ts-module'))
    expect(sha(tool(m, 'analyze_impact', { subject_ids: [symbolId(m, 'src/app:greet')] }))).toBe('401d5ce28ffbfa2a')
  }, 240000)

  it('FR201 auto follows candidate edges only where every subject\'s file was analysed by the syntax tier alone', async () => {
    const { resolveFollow } = await import('../src/query/inferred.js')
    const db = new Database(':memory:')
    db.exec(`create table file (id text, path text, capabilities text); create table symbol (id text, file_id text);
      insert into file values ('file_go', 'a.go', '{"tier":"syntax"}'), ('file_ts', 'a.ts', '{"tier":"precise:typescript"}'), ('file_scip', 'b.go', '{"tier":"scip:idx"}'), ('file_old', 'c.go', '{}');
      insert into symbol values ('sym_go', 'file_go'), ('sym_ts', 'file_ts'), ('sym_scip', 'file_scip'), ('sym_old', 'file_old')`)
    const on = (input: unknown, ...subjects: string[]) => resolveFollow(db, input, subjects).on
    expect(on('auto', 'sym_go')).toBe(true)
    expect(on(undefined, 'sym_go', 'file_go')).toBe(true)
    expect(on('auto', 'sym_ts')).toBe(false)
    expect(on('auto', 'sym_scip')).toBe(false)
    expect(on('auto', 'sym_old')).toBe(false)
    expect(on('auto', 'sym_go', 'sym_ts')).toBe(false)
    expect(on('auto', 'ext_x')).toBe(false)
    expect(on('auto')).toBe(false)
    expect(on(true, 'sym_ts')).toBe(true)
    expect(on(false, 'sym_go')).toBe(false)
  })
})

describe('FR205 issue 21 scenario 4: find_tests reaches a Go test through a candidate call', () => {
  const find = (input: Record<string, unknown> = {}) => tool(polyglot, 'find_tests', { subject_ids: [symbolId(polyglot, 'calc/calc:Add')], ...input })
  type Tests = { tests: Array<{ name: string; path: string; line: number; evidence: string; depth: number; basis: string }>; totals: { executing: number; by_basis: { inferred: number; observed: number } } }

  it('FR205 scenario 4: TestAdd is a call at depth 1, inferred, and counted as executing', () => {
    const data = find().data as unknown as Tests
    expect(data.tests.map((t) => [t.name, t.path, t.evidence, t.depth, t.basis])).toContainEqual(['TestAdd', 'calc/calc_test.go', 'call', 1, 'inferred'])
    expect(data.tests.every((t) => t.basis === 'inferred')).toBe(true)
    expect(data.totals.executing).toBe(data.tests.length)
    expect(data.totals.by_basis.inferred).toBe(data.tests.length)
    const lean = runTool(polyglot, 'find_tests', { subject_ids: [symbolId(polyglot, 'calc/calc:Add')], envelope: 'lean' }).text!
    expect(lean).toMatch(/TestAdd calc\/calc_test\.go:\d+ depth=1 inferred/)
  })

  it('FR205 FR209 the answer says candidate edges were followed, and no longer says Go calls are unresolved', () => {
    const env = find()
    expect(env.limitations).toContain("Candidate edges were followed because the subject's file has no precise tier: every row reached through one is inferred.")
    expect(env.limitations.some((l) => /^Calls in Go are not resolved yet/.test(l))).toBe(false)
  })

  it('FR205 FR201 include_inferred false is the answer before this slice: no test executes Add, and the note says Go calls are not resolved', () => {
    const env = find({ include_inferred: false })
    expect((env.data as unknown as Tests).totals.executing).toBe(0)
    expect(env.limitations.some((l) => /^Calls in Go are not resolved yet/.test(l))).toBe(true)
  })
})

describe('FR206 issue 21 scenario 5: trace_paths follows a candidate call', () => {
  type Trace = { conclusion: string; paths: Array<{ nodes: string[]; assertions: string[]; basis: string }>; relationships: Record<string, { basis: string; type: string }>; boundaries: Array<{ reason: string; path: string }> }
  const trace = (input: Record<string, unknown> = {}) => tool(constrained, 'trace_paths', { source_id: symbolId(constrained, 'svc/main:run'), target_id: symbolId(constrained, 'lib/lib:Format'), ...input })

  it('FR206 scenario 5: run reaches Format, each hop with its basis, the path and the conclusion inferred', () => {
    const data = trace().data as unknown as Trace
    expect(data.conclusion).toBe('path_found')
    expect(data.paths).toHaveLength(1)
    expect(data.paths[0]!.basis).toBe('inferred')
    expect(data.paths[0]!.assertions.map((a) => [data.relationships[a]!.type, data.relationships[a]!.basis])).toEqual([['calls', 'inferred']])
  })

  it('FR206 FR201 scenario 5: include_inferred false is no_resolved_path, naming the candidate site that could lead on', () => {
    const env = trace({ include_inferred: false })
    const data = env.data as unknown as Trace
    expect(data.conclusion).toBe('no_resolved_path')
    expect(data.boundaries.some((b) => b.reason === 'candidate' && b.path === 'svc/main.go')).toBe(true)
  })

  it('FR209 a lean path row ends with inferred, and the answer says candidate edges were followed', () => {
    const lean = runTool(constrained, 'trace_paths', { source_id: symbolId(constrained, 'svc/main:run'), target_id: symbolId(constrained, 'lib/lib:Format'), envelope: 'lean' }).text!
    expect(lean).toMatch(/run svc\/main\.go:\d+ inferred/)
    expect(trace().limitations).toContain("Candidate edges were followed because the subjects' files have no precise tier: every row reached through one is inferred.")
  })
})

describe('FR207 issue 21 scenario 6: impact_completeness through a candidate call', () => {
  it('FR207 scenario 6: the dependent of a changed Go function carries basis inferred and the summary counts it under its own figure', () => {
    const repo = tmpDir('pm-inf-')
    fs.cpSync(fixtureRepo('constrained'), repo, { recursive: true })
    git(repo, 'init', '-q')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(repo, 'lib/lib.go'), fs.readFileSync(path.join(repo, 'lib/lib.go'), 'utf8').replace('func Format(x string) string {\n\treturn x\n}', 'func Format(x string) string {\n\treturn x + "!"\n}'))
    git(repo, 'commit', '-q', '-am', 'head')
    const head = git(repo, 'rev-parse', 'HEAD')
    const d = tmpDir()
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
    expect(cli(['--data-dir', d, 'repo', 'add', repo]).status).toBe(0)
    const run = cli(['--data-dir', d, 'completeness', repo, `${base}..${head}`])
    // Exit 1 says a dependent is covered by no test, which is the case here; 2 is a failure.
    expect(run.status).toBe(1)
    const env = tool(d, 'impact_completeness', { base, head })
    const data = env.data as unknown as { changed: Array<{ name: string; dependents: Array<{ name: string; basis: string; relation: string }> }>; totals: { dependents: number; by_basis: { inferred: number; observed: number } } }
    const format = data.changed.find((c) => c.name === 'Format')!
    expect(format.dependents.map((x) => [x.name, x.relation, x.basis])).toEqual([['run', 'calls', 'inferred']])
    expect(data.totals.by_basis).toEqual({ observed: 0, inferred: 1 })
    const lean = runTool(d, 'impact_completeness', { base, head, envelope: 'lean' }).text!
    expect(lean).toMatch(/summary: 1 changed symbol; 1 dependent: 0 changed, 0 tested, 1 neither; 1 inferred/)
    expect(lean).toMatch(/calls run svc\/main\.go:\d+ neither inferred/)
    const off = tool(d, 'impact_completeness', { base, head, include_inferred: false })
    expect((off.data as unknown as typeof data).changed.find((c) => c.name === 'Format')!.dependents).toEqual([])
  }, 240000)
})

describe('FR208 FR202 issue 21 scenario 7: an ambiguous site is followed with all its candidates, up to five, and never past the cap', () => {
  const overloads = (n: number) => Array.from({ length: n }, (_, i) => `  static void foo(${Array.from({ length: i }, (_, j) => `int a${j}`).join(', ')}) {}\n`).join('')
  const java = (n: number) => ({ 'src/a/Many.java': `package a;\n\npublic class Many {\n${overloads(n)}  static void caller() {\n    foo(1);\n  }\n}\n` })
  const foos = (d: string) => (tool(d, 'find_symbols', { text: 'foo', kinds: ['method'] }).data.symbols as Array<{ id: string }>).map((s) => s.id)

  it('FR208 scenario 7: a site of five candidates reaches the caller from each of them, inferred, and the caller reaches each of them', async () => {
    const { dataDir: d } = await indexedRepo(java(5))
    const ids = foos(d), caller = symbolId(d, 'a.Many.caller')
    expect(ids).toHaveLength(5)
    for (const id of ids) {
      expect(names(impact(d, id))).toEqual([['a.Many.caller', 1, 'inferred']])
      const t = tool(d, 'trace_paths', { source_id: caller, target_id: id }).data as unknown as { conclusion: string; paths: Array<{ basis: string }> }
      expect(t.conclusion).toBe('path_found')
      expect(t.paths[0]!.basis).toBe('inferred')
    }
  }, 240000)

  it('FR208 FR202 a site with more than five candidates is never followed, and the answer says how many it stopped at', async () => {
    const { dataDir: d } = await indexedRepo(java(6))
    const ids = foos(d), caller = symbolId(d, 'a.Many.caller')
    expect(ids).toHaveLength(6)
    const env = impact(d, ids)
    expect((env.data as Impact).dependents).toEqual([])
    expect(env.limitations).toContain('1 call site naming code on these paths has more than 5 candidates and was not followed.')
    for (const id of ids) expect((tool(d, 'trace_paths', { source_id: caller, target_id: id }).data as unknown as { conclusion: string }).conclusion).not.toBe('path_found')
    expect(tool(d, 'find_tests', { subject_ids: ids }).limitations.some((l) => /has more than 5 candidates/.test(l))).toBe(true)
  }, 240000)
})

/** A made-up language whose adapter is precise (so auto leaves candidates alone) and sends call, cand and amb rows: `call` is proved, `cand` and `amb` are not. */
const GUESS = new Registry([{ id: 'guesslang', languages: new Set(['guesslang']), extensions: { '.guess': 'guesslang' }, isConfig: () => false, entry: () => path.join(import.meta.dirname, 'fake-adapters', 'guesslang.mjs'), unavailable: () => 'adapter_unavailable:guesslang' }])
async function guessIndex(files: Record<string, string>): Promise<string> {
  const repo = tmpDir('pm-inf-')
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text) }
  const d = tmpDir()
  initDataDir(d)
  const c = Catalog.open(d)
  c.addRepository(repo)
  c.close()
  await indexRepository(d, repo, undefined, GUESS)
  return d
}

describe('FR210 FR201 FR204 issue 21 edge cases: an observed chain wins, an inferred one never makes an observed answer, and a precise-tier subject does not follow candidates unless asked', () => {
  // S is called by P1 (proved), P1 by P2, P2 by X; and Y guesses S (candidate), X guesses Y (candidate).
  const FILES = {
    's.guess': 'def S\n',
    'p.guess': 'def P1\n  call S\ndef P2\n  call P1\ndef X\n  call P2\n  cand Y\n',
    'y.guess': 'def Y\n  cand S\n',
  }
  const LAST = { ...FILES, 'p.guess': 'def P1\n  call S\ndef P2\n  call P1\ndef X\n  cand Y\ndef P0\n  call X\n' }

  it('FR210 asked for, X is reached by the observed chain P1, P2 at depth 3 and by the inferred chain Y at depth 2: it is observed, at depth 3, and Y alone is inferred', async () => {
    const d = await guessIndex(FILES)
    const env = impact(d, symbolId(d, 's:S'), { include_inferred: true })
    expect(names(env)).toEqual([['p:P1', 1, 'observed'], ['y:Y', 1, 'inferred'], ['p:P2', 2, 'observed'], ['p:X', 3, 'observed']])
    expect((env.data as Impact).totals.by_basis).toEqual({ observed: 3, inferred: 1 })
  }, 240000)

  it('FR204 FR209 by default a precise-tier subject follows no candidate: the observed rows only, and the answer counts the candidate site it did not follow', async () => {
    const d = await guessIndex(FILES)
    const env = impact(d, symbolId(d, 's:S'))
    expect(names(env)).toEqual([['p:P1', 1, 'observed'], ['p:P2', 2, 'observed'], ['p:X', 3, 'observed']])
    expect(env.limitations).toContain('1 candidate call site naming code on these paths was not followed; pass include_inferred true to follow it.')
    expect(env.limitations.some((l) => /^Candidate edges were followed/.test(l))).toBe(false)
    expect(names(impact(d, symbolId(d, 's:S'), { include_inferred: false }))).toEqual(names(env))
  }, 240000)

  it('FR210 a chain with one inferred hop makes the row inferred: P0 calls X, which is reached only through Y', async () => {
    const d = await guessIndex(LAST)
    expect(names(impact(d, symbolId(d, 's:S'), { include_inferred: true }))).toEqual([['p:P1', 1, 'observed'], ['y:Y', 1, 'inferred'], ['p:P2', 2, 'observed'], ['p:X', 2, 'inferred'], ['p:P0', 3, 'inferred']])
  }, 240000)

  it('FR210 FR206 trace_paths and find_tests follow a candidate only when asked, and a path through one is inferred', async () => {
    const d = await guessIndex({ ...FILES, 'test/t.guess': 'def testY\n  call Y\n' })
    const trace = (include_inferred?: boolean) => tool(d, 'trace_paths', { source_id: symbolId(d, 'p:X'), target_id: symbolId(d, 's:S'), ...(include_inferred === undefined ? {} : { include_inferred }) }).data as unknown as { conclusion: string; paths: Array<{ nodes: string[]; basis: string }> }
    expect(trace().conclusion).toBe('path_found')
    expect(trace().paths.map((p) => [p.nodes.length, p.basis])).toEqual([[4, 'observed']])
    const asked = trace(true)
    // The shortest path is the answer, as ever: the two-hop path through two candidates beats the three-hop observed one.
    expect(asked.paths.map((p) => [p.nodes.length, p.basis])).toEqual([[3, 'inferred']])
    const onlyY = tool(d, 'trace_paths', { source_id: symbolId(d, 'p:X'), target_id: symbolId(d, 'y:Y') })
    expect((onlyY.data as { conclusion: string }).conclusion).toBe('no_resolved_path')
    const viaY = tool(d, 'trace_paths', { source_id: symbolId(d, 'p:X'), target_id: symbolId(d, 'y:Y'), include_inferred: true }).data as unknown as { conclusion: string; paths: Array<{ basis: string }> }
    expect([viaY.conclusion, viaY.paths[0]!.basis]).toEqual(['path_found', 'inferred'])
    // testY calls Y observed, and Y reaches S only through a candidate: a test of S is found only when asked.
    const tests = (include_inferred?: boolean) => (tool(d, 'find_tests', { subject_ids: [symbolId(d, 's:S')], ...(include_inferred === undefined ? {} : { include_inferred }) }).data as unknown as { tests: Array<{ name: string; basis: string }> }).tests.map((t) => [t.name, t.basis])
    expect(tests()).toEqual([])
    expect(tests(true)).toEqual([['testY', 'inferred']])
  }, 240000)
})
