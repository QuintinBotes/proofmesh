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
import { cli, fixtureRepo, indexedDataDir, indexedRepo, ROOT, symbolId, tmpDir, tool, withSnapshot as withSnapshotOf } from './helpers.js'

// Issue 21: impact, test reach and paths follow candidate edges where no precise tier analysed the subject, every row reached through one inferred.
type Dep = { name: string; qualified_name: string; depth: number; basis: string }
type Impact = { dependents: Dep[]; totals: { dependents: number; by_basis: { observed: number; inferred: number } } }
const impact = (d: string, id: string | string[], input: Record<string, unknown> = {}) => tool(d, 'analyze_impact', { subject_ids: Array.isArray(id) ? id : [id], ...input })
const names = (env: { data: unknown }) => (env.data as Impact).dependents.map((x) => [x.qualified_name, x.depth, x.basis])
// Ids are hashes that depend on where the repository sits, and orders follow from them, so the digest leaves both out.
const ID = /\b[a-z]+_[0-9a-f]{16,}\b/g
/** The answer with ids left out and every order that follows from them removed: a map keyed by ids becomes a sorted list, and a list of objects is sorted. */
const canon = (x: unknown): unknown => {
  if (Array.isArray(x)) { const l = x.map(canon); return l.length && typeof l[0] === 'object' && l[0] !== null && !Array.isArray(l[0]) ? l.map((v) => JSON.stringify(v).replace(ID, '<id>')).sort() : l }
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>, keys = Object.keys(o)
    if (keys.length && keys.every((k) => /^[a-z]+_[0-9a-f]{16,}$/.test(k))) return keys.map((k) => JSON.stringify(canon(o[k])).replace(ID, '<id>')).sort()
    // FR280 and FR440 added each row's stable keys; the digest is of everything else, which those rows leave as it was.
    return Object.fromEntries(keys.filter((k) => k !== 'key' && k !== 'from_key' && k !== 'to_key').map((k) => [k, canon(o[k])]))
  }
  return x
}
const sha = (e: { data: unknown; limitations: unknown }) => createHash('sha256').update(JSON.stringify(canon({ d: e.data, l: e.limitations })).replace(ID, '<id>')).digest('hex').slice(0, 16)
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
    expect(env.limitations).toContain("Candidate edges were followed in every file the walk reached because the subject's file has no precise tier: every row reached through one is inferred.")
  })

  it('FR201 FR203 scenario 2: include_inferred false has no dependents and counts the candidate callers it did not follow', () => {
    const env = impact(constrained, symbolId(constrained, 'lib/lib:Format'), { include_inferred: false })
    expect((env.data as Impact).dependents).toEqual([])
    expect(env.limitations).toContain('1 candidate site naming code on these paths was not followed; pass include_inferred true to follow it.')
    expect(env.limitations.some((l) => /^Candidate edges were followed/.test(l))).toBe(false)
  })

  it('FR201 include_inferred true asks for it, and the answer says the person did', () => {
    const env = impact(constrained, symbolId(constrained, 'lib/lib:Format'), { include_inferred: true })
    expect(names(env)).toEqual([['svc/main:run', 1, 'inferred']])
    expect(env.limitations).toContain('Candidate edges were followed in every file the walk reached because include_inferred was true: every row reached through one is inferred.')
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
      ['analyze_impact', { subject_ids: [f] }, 'b46e40daffaa581c'],
      ['find_tests', { subject_ids: [f] }, '14229cabf3e620c9'],
      ['trace_paths', { source_id: h, target_id: f }, '8433e868d5914ce6'],
    ] as const) {
      expect(sha(tool(a, name, input))).toBe(pinned)
      expect(sha(tool(a, name, { ...input, include_inferred: false }))).toBe(pinned)
    }
    const { dataDir: m } = await indexedDataDir(fixtureRepo('ts-module'))
    expect(sha(tool(m, 'analyze_impact', { subject_ids: [symbolId(m, 'src/app:greet')] }))).toBe('538f790ce73d06e1')
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
    expect(env.limitations).toContain("Candidate edges were followed in every file the walk reached because the subject's file has no precise tier: every row reached through one is inferred.")
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
    expect(trace().limitations).toContain("Candidate edges were followed in every file the walk reached because the subjects' files have no precise tier: every row reached through one is inferred.")
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
    expect(env.limitations).toContain('1 ambiguous site naming code on these paths lists more than 5 candidates and was not followed.')
    for (const id of ids) expect((tool(d, 'trace_paths', { source_id: caller, target_id: id }).data as unknown as { conclusion: string }).conclusion).not.toBe('path_found')
    expect(tool(d, 'find_tests', { subject_ids: ids }).limitations.some((l) => /lists more than 5 candidates/.test(l))).toBe(true)
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

  it('FR204 FR209 by default a precise-tier subject follows no candidate and the answer says nothing of them; asked for with false, it counts the site it did not follow', async () => {
    const d = await guessIndex(FILES)
    const env = impact(d, symbolId(d, 's:S'))
    expect(names(env)).toEqual([['p:P1', 1, 'observed'], ['p:P2', 2, 'observed'], ['p:X', 3, 'observed']])
    expect(env.limitations.some((l) => /candidate/i.test(l))).toBe(false)
    const off = impact(d, symbolId(d, 's:S'), { include_inferred: false })
    expect(names(off)).toEqual(names(env))
    expect(off.limitations).toContain('1 candidate site naming code on these paths was not followed; pass include_inferred true to follow it.')
  }, 240000)

  it('FR204 a precise-tier subject with candidate sites answers byte-identically with the default input, data and limitations, in every tool', async () => {
    const d = await guessIndex({ ...FILES, 'test/t.guess': 'def testY\n  call Y\n' })
    const S = symbolId(d, 's:S'), X = symbolId(d, 'p:X'), Y = symbolId(d, 'y:Y')
    // The digests are of the answers the code before issue 21 gave for this repository.
    expect(sha(tool(d, 'analyze_impact', { subject_ids: [S] }))).toBe('f896ece756590e17')
    expect(sha(tool(d, 'find_tests', { subject_ids: [S] }))).toBe('bd8b98971215cf8d')
    expect(sha(tool(d, 'trace_paths', { source_id: X, target_id: S }))).toBe('a418129d2e0af03f')
    expect(sha(tool(d, 'trace_paths', { source_id: X, target_id: Y }))).toBe('ff647a1e5996434b')
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

describe('FR201 FR210 issue 21 edge case 1: auto is decided from the subjects; once on, the walk follows candidate sites in every file it reaches', () => {
  type Spec = { files: Record<string, string | null>; symbols: Array<[string, string]>; observed: Array<[string, string]>; candidates: Array<[string, string[]]> }
  let n = 0
  /** A snapshot of the real format with only what a walk reads: files with a tier (null: none recorded), symbols, observed calls and candidate sites. */
  function mini(spec: Spec) {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    db.exec(fs.readFileSync(path.join(ROOT, 'schemas', 'snapshot-format', '0.9.sql'), 'utf8'))
    for (const [id, tier] of Object.entries(spec.files)) db.prepare("insert into file (id, path, content_hash, size, language, disposition, capabilities) values (?, ?, 'h', 1, 'x', 'indexed', ?)").run(id, `${id}.x`, JSON.stringify(tier ? { tier } : {}))
    for (const [id, file] of spec.symbols) db.prepare("insert into symbol (id, file_id, kind, name, qualified_name, start_byte, end_byte, start_line, end_line, stable_key, evidence_id) values (?, ?, 'function', ?, ?, 0, 1, 1, 1, ?, 'ev')").run(`sym_${id}`, file, id, `${file}:${id}`, id)
    const assertion = db.prepare("insert into assertion (id, type, origin, resolution, source_kind, source_id, target_kind, target_id, reason, adapter, adapter_version, analysis_mode) values (?, 'calls', 'semantic_resolver', ?, 'symbol', ?, ?, ?, ?, 'x', '1', 'no_execution')")
    spec.observed.forEach(([src, dst], i) => {
      assertion.run(`a_obs${i}`, 'resolved', `sym_${src}`, 'symbol', `sym_${dst}`, null)
      db.prepare("insert into edge (src, type, dst, resolution, assertion_id) values (?, 'calls', ?, 'resolved', ?)").run(`sym_${src}`, `sym_${dst}`, `a_obs${i}`)
    })
    spec.candidates.forEach(([src, dsts], i) => {
      assertion.run(`a_cand${i}`, dsts.length > 1 ? 'ambiguous' : 'candidate', `sym_${src}`, null, null, 'name_match')
      dsts.forEach((dst, rank) => db.prepare("insert into assertion_candidate (assertion_id, symbol_id, rank, reason) values (?, ?, ?, 'r')").run(`a_cand${i}`, `sym_${dst}`, rank))
    })
    return { db, snap: `snap_mini${n++}` }
  }
  const rowsOf = (impact: { dependents: Dep[] }) => impact.dependents.map((x) => [x.name, x.depth, x.basis])

  it('FR201 FR204 a precise subject meeting a syntax-tier file through an observed edge follows no candidate under auto, and follows them when asked', async () => {
    const { resolveFollow } = await import('../src/query/inferred.js')
    const { analyzeImpact } = await import('../src/query/impact.js')
    const { db, snap } = mini({ files: { p: 'precise:x', s: 'syntax' }, symbols: [['pf', 'p'], ['s1', 's'], ['s2', 's']], observed: [['s1', 'pf']], candidates: [['s2', ['s1']]] })
    expect(resolveFollow(db, 'auto', ['sym_pf']).on).toBe(false)
    expect(rowsOf(analyzeImpact(db, snap, ['sym_pf'], ['calls'], 5, 100, undefined, resolveFollow(db, 'auto', ['sym_pf']).on))).toEqual([['s1', 1, 'observed']])
    expect(rowsOf(analyzeImpact(db, snap, ['sym_pf'], ['calls'], 5, 100, undefined, resolveFollow(db, true, ['sym_pf']).on))).toEqual([['s1', 1, 'observed'], ['s2', 2, 'inferred']])
  })

  it('FR201 FR210 a syntax-tier subject follows candidate sites in every file the walk reaches, a precise-tier file included, and every row past the first candidate is inferred', async () => {
    const { resolveFollow } = await import('../src/query/inferred.js')
    const { analyzeImpact } = await import('../src/query/impact.js')
    const { db, snap } = mini({ files: { p: 'precise:x', s: 'syntax' }, symbols: [['s0', 's'], ['p1', 'p'], ['p2', 'p'], ['p3', 'p']], observed: [['p2', 'p1']], candidates: [['p1', ['s0']], ['p3', ['p2']]] })
    expect(resolveFollow(db, 'auto', ['sym_s0']).on).toBe(true)
    expect(rowsOf(analyzeImpact(db, snap, ['sym_s0'], ['calls'], 5, 100, undefined, true))).toEqual([['p1', 1, 'inferred'], ['p2', 2, 'inferred'], ['p3', 3, 'inferred']])
  })

  it('FR210 the node budget is checked inside a level: a hub with more ambiguous callers than the budget stops at it and says so, and a budget it does not exceed changes nothing', async () => {
    const { analyzeImpact } = await import('../src/query/impact.js')
    const callers = Array.from({ length: 30 }, (_, i) => `c${i}`)
    const { db, snap } = mini({ files: { s: 'syntax' }, symbols: [['hub', 's'], ...callers.map((c) => [c, 's'] as [string, string])], observed: [], candidates: callers.map((c) => [c, ['hub', 'other']] as [string, string[]]) })
    const all = analyzeImpact(db, snap, ['sym_hub'], ['calls'], 5, 100, undefined, true)
    expect([all.dependents.length, all.stopped_by]).toEqual([30, null])
    const cut = analyzeImpact(db, snap, ['sym_hub'], ['calls'], 5, 100, undefined, true, 10)
    expect([cut.dependents.length, cut.totals.dependents, cut.stopped_by]).toEqual([10, 10, 'node_budget'])
  })

  it('FR210 test reach stops at the node budget inside a level too', async () => {
    const { testReach } = await import('../src/query/test-reach.js')
    const callers = Array.from({ length: 30 }, (_, i) => `t${i}`)
    const { db, snap } = mini({ files: { s: 'syntax', tests: 'syntax' }, symbols: [['hub', 's'], ...callers.map((c) => [c, 'tests'] as [string, string])], observed: [], candidates: callers.map((c) => [c, ['hub']] as [string, string[]]) })
    const isTest = (p: string) => p === 'tests.x'
    const all = testReach(db, snap, ['sym_hub'], [], () => undefined, 5, isTest, true)
    expect([all.rows.length, all.stopped_by]).toEqual([30, null])
    const cut = testReach(db, snap + 'b', ['sym_hub'], [], () => undefined, 5, isTest, true, 10)
    expect([cut.rows.length, cut.stopped_by]).toEqual([10, 'node_budget'])
  })

  it('FR201 a subject in a file with no recorded tier is not syntax-tier: auto follows nothing, and asked for it follows', async () => {
    const { resolveFollow } = await import('../src/query/inferred.js')
    const { analyzeImpact } = await import('../src/query/impact.js')
    // No fixture symbol lacks a tier, so the snapshot is built: a file whose capabilities record none.
    const { db, snap } = mini({ files: { u: null, s: 'syntax' }, symbols: [['u0', 'u'], ['s1', 's']], observed: [], candidates: [['s1', ['u0']]] })
    expect(resolveFollow(db, 'auto', ['sym_u0']).on).toBe(false)
    expect(analyzeImpact(db, snap, ['sym_u0'], ['calls'], 5, 100, undefined, false).dependents).toEqual([])
    expect(rowsOf(analyzeImpact(db, snap, ['sym_u0'], ['calls'], 5, 100, undefined, resolveFollow(db, true, ['sym_u0']).on))).toEqual([['s1', 1, 'inferred']])
  })
})

describe('FR199 FR205 the note that Go calls are not resolved is decided per subject: dropped only for a subject with candidate sites of its own', () => {
  it('FR205 a Go function a test calls loses the note, and one nothing calls keeps it', async () => {
    const { dataDir: d } = await indexedRepo({
      'go.mod': 'module example.com/p\n\ngo 1.21\n',
      'a.go': 'package p\n\nfunc Used() {}\n\nfunc Unused() {}\n',
      'a_test.go': 'package p\n\nimport "testing"\n\nfunc TestUsed(t *testing.T) { Used() }\n',
    })
    const note = (qn: string) => tool(d, 'find_tests', { subject_ids: [symbolId(d, qn)] }).limitations.some((l) => /^Calls in Go are not resolved yet/.test(l))
    expect(note('a:Used')).toBe(false)
    expect(note('a:Unused')).toBe(true)
  }, 240000)
})
