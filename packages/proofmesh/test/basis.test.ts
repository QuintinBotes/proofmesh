import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { indexRepository } from '../src/indexer/coordinator.js'
import { Registry } from '../src/indexer/languages.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { runTool } from '../src/query/tools.js'
import { cli, fixtureRepo, indexedDataDir, ROOT, symbolId, tmpDir, tool, withSnapshot } from './helpers.js'

// Issue 10: every relationship row says whether a compiler or index proves it (observed) or a convention or name match suggests it (inferred).
const GUESS = new Registry([{ id: 'guesslang', languages: new Set(['guesslang']), extensions: { '.guess': 'guesslang' }, isConfig: () => false, entry: () => path.join(import.meta.dirname, 'fake-adapters', 'guesslang.mjs'), unavailable: () => 'adapter_unavailable:guesslang' }])

/**
 * `core` is reached by `direct` (proved), `mid` and `both` (guessed), and by `both` also through the proved chain chain2, chain1, direct.
 * Tests: t_obs reaches core through direct, t_inf only through mid's guess, t_both through both.
 */
const FILES: Record<string, string> = {
  'src/core.guess': 'def core\n',
  'src/direct.guess': 'def direct\n  call core\n',
  'src/mid.guess': 'def mid\n  guess core\n',
  'src/chain.guess': 'def chain1\n  call direct\ndef chain2\n  call chain1\n',
  'src/both.guess': 'def both\n  guess core\n  call chain2\n  call nowhere\n',
  'src/viamid.guess': 'def viaMid\n  call mid\n',
  'test/t.guess': 'def t_obs\n  call direct\ndef t_inf\n  call mid\ndef t_both\n  call mid\n  call chain2\n',
}
const write = (repo: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text) }
}
async function guessIndex(files = FILES): Promise<{ d: string; repo: string }> {
  const repo = tmpDir('pm-basis-')
  write(repo, files)
  const d = tmpDir()
  initDataDir(d)
  const c = Catalog.open(d)
  c.addRepository(repo)
  c.close()
  await indexRepository(d, repo, undefined, GUESS)
  return { d, repo }
}

type Rel = { resolution: string; basis?: string; detail: Record<string, string> | null; other: { name?: string; path?: string }; direction: string }
const relationships = (d: string, input: Record<string, unknown>) => tool(d, 'get_relationships', input).data as unknown as { relationships: Rel[]; totals: Record<string, any> }
const lean = (d: string, name: string, input: Record<string, unknown>) => runTool(d, name, { ...input, envelope: 'lean' }).text!.split('\n').filter((l) => !l.startsWith('#'))

describe('FR181 FR189 basis is derived from resolution, origin and detail when the answer is built', () => {
  it('FR181 a candidate or ambiguous row, a contract_match, documentation or model_hypothesis origin, or a detail.inferred makes a row inferred; anything else resolved is observed', async () => {
    const { basisOf } = await import('../src/query/basis.js')
    const row = (resolution: string, origin = 'semantic_resolver', detail: Record<string, string> | null = null) => basisOf({ resolution, origin, detail })
    expect(row('resolved')).toBe('observed')
    expect(row('resolved', 'syntax')).toBe('observed')
    expect(row('candidate')).toBe('inferred')
    expect(row('ambiguous')).toBe('inferred')
    for (const origin of ['contract_match', 'documentation', 'model_hypothesis']) expect(row('resolved', origin)).toBe('inferred')
    expect(row('resolved', 'framework_adapter', { rule: 'x', inferred: 'a convention' })).toBe('inferred')
    expect(row('resolved', 'framework_adapter', { rule: 'x' })).toBe('observed')
  })

  it('FR189 a resolved_external row is observed, an unresolved boundary has no basis, and a stored detail string parses as the detail does', async () => {
    const { basisOf } = await import('../src/query/basis.js')
    expect(basisOf({ resolution: 'resolved_external', origin: 'semantic_resolver', detail: null })).toBe('observed')
    expect(basisOf({ resolution: 'unresolved', origin: 'syntax', detail: null })).toBeUndefined()
    expect(basisOf({ resolution: 'resolved', origin: 'framework_adapter', detail: '{"inferred":"x"}' })).toBe('inferred')
    expect(basisOf({ resolution: 'resolved', origin: 'framework_adapter', detail: '{"rule":"x"}' })).toBe('observed')
  })

  it('FR189 an unresolved row in get_relationships carries no basis and is not counted in by_basis', async () => {
    const { d } = await guessIndex()
    const out = relationships(d, { subject_id: symbolId(d, 'src/both:both'), direction: 'out' })
    const unresolved = out.relationships.filter((r) => r.resolution === 'unresolved')
    expect(unresolved).toHaveLength(1)
    expect('basis' in unresolved[0]!).toBe(false)
    expect(out.relationships.filter((r) => r.resolution !== 'unresolved').map((r) => r.basis).sort()).toEqual(['inferred', 'observed'])
    expect(out.totals.by_basis).toEqual({ observed: 1, inferred: 1 })
    expect(out.totals.out).toBe(3)
  }, 120000)
})

describe('FR181 FR185 issue 10 scenario 1: callers on fixtures/ts-module are observed', () => {
  it('FR181 FR185 scenario 1: every row of the callers of greet has basis observed, and by_basis counts them', async () => {
    const { dataDir: d } = await indexedDataDir(fixtureRepo('ts-module'))
    const out = relationships(d, { subject_id: symbolId(d, 'src/app:greet'), direction: 'in' })
    expect(out.relationships.length).toBeGreaterThan(0)
    expect(out.relationships.map((r) => r.basis)).toEqual(out.relationships.map(() => 'observed'))
    expect(out.totals.by_basis).toEqual({ observed: out.relationships.length, inferred: 0 })
  }, 240000)
})

describe('FR181 FR182 issue 10 scenario 2: Django model tables on fixtures/py-django', () => {
  it('FR181 scenario 2: a model whose table comes from the convention is inferred, and one with Meta.db_table is observed', async () => {
    const { dataDir: d } = await indexedDataDir(fixtureRepo('py-django'))
    const maps = (qn: string) => relationships(d, { subject_id: symbolId(d, qn), direction: 'out', types: ['maps_to'] }).relationships
    const conv = maps('shop/models:Customer'), table = maps('shop/models:Order')
    expect(conv).toHaveLength(1)
    expect(conv[0]).toMatchObject({ basis: 'inferred', detail: { rule: 'django_convention' } })
    expect(conv[0]!.detail!.inferred).toBeTruthy()
    expect(table).toHaveLength(1)
    expect(table[0]).toMatchObject({ basis: 'observed', detail: { rule: 'db_table' } })
    expect(table[0]!.detail!.inferred).toBeUndefined()
  }, 240000)
})

describe('FR181 FR185 issue 10 scenario 3: candidates that reference a SQL table on fixtures/syntax-tier are inferred', () => {
  it('FR181 scenario 3: the inbound references of the table customers are candidates, each inferred', async () => {
    const { dataDir: d } = await indexedDataDir(fixtureRepo('syntax-tier'))
    const out = relationships(d, { subject_id: symbolId(d, 'customers'), direction: 'in', types: ['references'] })
    expect(out.relationships.length).toBeGreaterThan(0)
    expect(out.relationships.map((r) => r.resolution)).toContain('candidate')
    expect(out.relationships.map((r) => r.basis)).toEqual(out.relationships.map(() => 'inferred'))
    expect(out.totals.by_basis).toEqual({ observed: 0, inferred: out.relationships.length })
  }, 240000)
})

describe('FR182 FR184 FR185 issue 10 scenario 4: analyze_impact labels a dependent by its strongest chain', () => {
  let d: string
  beforeAll(async () => { ({ d } = await guessIndex()) }, 120000)
  type Dep = { name: string; depth: number; basis: string }
  const impact = (input: Record<string, unknown> = {}) => tool(d, 'analyze_impact', { subject_ids: [symbolId(d, 'src/core:core')], ...input }).data as unknown as { dependents: Dep[]; totals: { dependents: number; by_depth: Record<string, number>; by_basis: Record<string, number> } }

  it('FR182 FR184 scenario 4: a dependent reached only through a guessed hop is inferred; one reached by a proved chain as well is observed, at the depth of that chain', () => {
    const data = impact()
    const by = Object.fromEntries(data.dependents.map((x) => [x.name, [x.depth, x.basis]]))
    expect(by).toEqual({
      direct: [1, 'observed'], mid: [1, 'inferred'], chain1: [2, 'observed'], viaMid: [2, 'inferred'], t_obs: [2, 'observed'], t_inf: [2, 'inferred'],
      chain2: [3, 'observed'], both: [4, 'observed'], t_both: [4, 'observed'],
    })
  })

  it('FR185 scenario 4: the totals give by_basis, and by_depth counts the depth each dependent is reported at', () => {
    const data = impact()
    expect(data.totals.by_basis).toEqual({ observed: 6, inferred: 3 })
    expect(data.totals.by_depth).toEqual({ 1: 2, 2: 4, 3: 1, 4: 2 })
    expect(data.totals.dependents).toBe(9)
  })

  it('FR184 a chain that continues past a guessed hop stays inferred: dependents of a guessed dependent are inferred', async () => {
    const { d: other } = await guessIndex({ 'a.guess': 'def a\n  guess b\n', 'b.guess': 'def b\n  call c\n', 'c.guess': 'def c\n  call d\n', 'd.guess': 'def d\n' })
    const data = tool(other, 'analyze_impact', { subject_ids: [symbolId(other, 'b:b')] }).data as unknown as { dependents: Dep[] }
    expect(data.dependents.map((x) => [x.name, x.basis])).toEqual([['a', 'inferred']])
    const down = tool(other, 'analyze_impact', { subject_ids: [symbolId(other, 'd:d')] }).data as unknown as { dependents: Dep[] }
    expect(down.dependents.map((x) => [x.name, x.depth, x.basis])).toEqual([['c', 1, 'observed'], ['b', 2, 'observed'], ['a', 3, 'inferred']])
  }, 120000)

  it('FR182 on fixtures/ts-typeorm a table is reached through the entity that maps to it: inferred for a bare @Entity(), observed for a named one', async () => {
    const { dataDir: t } = await indexedDataDir(fixtureRepo('ts-typeorm'))
    const deps = (table: string) => (tool(t, 'analyze_impact', { subject_ids: [symbolId(t, table)] }).data as unknown as { dependents: Dep[] }).dependents.map((x) => [x.name, x.basis])
    expect(deps('payment')).toEqual([['Payment', 'inferred'], ['CardPayment', 'inferred'], ['chargeCard', 'inferred'], ['charge', 'inferred'], ['POST payments', 'inferred']])
    expect(deps('orders').length).toBeGreaterThan(0)
    expect(deps('orders').map((x) => x[1])).toEqual(deps('orders').map(() => 'observed'))
  }, 240000)

  it('FR182 get_table_reach rows carry basis: inferred when the chain to the table is, observed otherwise', async () => {
    const { dataDir: t } = await indexedDataDir(fixtureRepo('ts-typeorm'))
    const rows = (table: string) => (tool(t, 'get_table_reach', { table }).data as unknown as { tables: Array<{ reach: Array<{ qualified_name: string; basis: string }> }> }).tables.flatMap((x) => x.reach)
    expect(rows('payment').length).toBeGreaterThan(0)
    expect(rows('payment').map((r) => r.basis)).toEqual(rows('payment').map(() => 'inferred'))
    expect(rows('orders').length).toBeGreaterThan(0)
    expect(rows('orders').map((r) => r.basis)).toEqual(rows('orders').map(() => 'observed'))
  }, 240000)
})

describe('FR183 FR184 find_tests keeps the strongest evidence when only a weaker chain is observed', () => {
  it('FR183 FR184 a test that calls the subject through a guessed call and also references it is listed as a call, inferred, and stays executing', async () => {
    const { d } = await guessIndex({ 'src/core.guess': 'def core\n', 'test/t.guess': 'def t_weak\n  guess core\n  ref core\ndef t_ref\n  ref core\ndef t_call\n  call core\n' })
    const data = tool(d, 'find_tests', { subject_ids: [symbolId(d, 'src/core:core')] }).data as unknown as { tests: Array<{ name: string; evidence: string; basis: string }>; totals: { by_basis: Record<string, number>; executing: number } }
    expect(data.tests.map((t) => [t.name, t.evidence, t.basis])).toEqual([['t_weak', 'call', 'inferred'], ['t_call', 'call', 'observed'], ['t_ref', 'reference', 'observed']])
    expect(data.totals.executing).toBe(2)
    expect(data.totals.by_basis).toEqual({ observed: 2, inferred: 1 })
  }, 120000)
})

describe('FR183 FR184 FR185 issue 10 scenario 5: find_tests and trace_paths carry basis', () => {
  it('FR183 scenario 5: on fixtures/tests-reach every test row is observed and by_basis counts them', async () => {
    const { dataDir: d } = await indexedDataDir(fixtureRepo('tests-reach'))
    const data = tool(d, 'find_tests', { paths: ['src/core.ts'] }).data as unknown as { tests: Array<{ evidence: string; basis: string }>; totals: { tests: number; by_basis: Record<string, number> } }
    expect(data.tests.length).toBeGreaterThan(0)
    expect(data.tests.map((t) => t.basis)).toEqual(data.tests.map(() => 'observed'))
    expect(data.totals.by_basis).toEqual({ observed: data.totals.tests, inferred: 0 })
  }, 240000)

  it('FR183 scenario 5: on fixtures/tests-reach every hop of trace_paths is observed and so is the path', async () => {
    const { dataDir: d } = await indexedDataDir(fixtureRepo('tests-reach'))
    const t = tool(d, 'trace_paths', { source_id: symbolId(d, 'test/service.test:serviceAddsOne'), target_id: symbolId(d, 'src/core:core') }).data as unknown as { paths: Array<{ assertions: string[]; basis: string }>; relationships: Record<string, { basis: string }> }
    expect(t.paths).toHaveLength(1)
    expect(t.paths[0]!.assertions.length).toBe(2)
    expect(t.paths[0]!.basis).toBe('observed')
    expect(t.paths[0]!.assertions.map((a) => t.relationships[a]!.basis)).toEqual(['observed', 'observed'])
  }, 240000)

  describe('through a guessed hop', () => {
    let d: string
    beforeAll(async () => { ({ d } = await guessIndex()) }, 120000)
    type Test = { name: string; depth: number; evidence: string; basis: string }

    it('FR183 FR184 a test reached only through a guessed hop is inferred; one with a proved chain as well is observed, with that chain', () => {
      const data = tool(d, 'find_tests', { subject_ids: [symbolId(d, 'src/core:core')] }).data as unknown as { tests: Test[]; totals: { by_basis: Record<string, number> } }
      expect(data.tests.map((t) => [t.name, t.depth, t.evidence, t.basis])).toEqual([
        ['t_obs', 2, 'transitive_call', 'observed'], ['t_inf', 2, 'transitive_call', 'inferred'], ['t_both', 4, 'transitive_call', 'observed'],
      ])
      expect(data.totals.by_basis).toEqual({ observed: 2, inferred: 1 })
    })

    it('FR183 a path is inferred when any hop is, and each hop says its own basis', () => {
      const trace = (from: string) => tool(d, 'trace_paths', { source_id: symbolId(d, from), target_id: symbolId(d, 'src/core:core') }).data as unknown as { paths: Array<{ assertions: string[]; basis: string }>; relationships: Record<string, { basis: string }> }
      const inf = trace('test/t:t_inf'), obs = trace('test/t:t_obs')
      expect(inf.paths).toHaveLength(1)
      expect(inf.paths[0]!.assertions.map((a) => inf.relationships[a]!.basis)).toEqual(['observed', 'inferred'])
      expect(inf.paths[0]!.basis).toBe('inferred')
      expect(obs.paths[0]!.assertions.map((a) => obs.relationships[a]!.basis)).toEqual(['observed', 'observed'])
      expect(obs.paths[0]!.basis).toBe('observed')
    })

    it('FR183 FR185 get_relationships on the callers of core: each row its own basis, and by_basis counts every matching row', () => {
      const out = relationships(d, { subject_id: symbolId(d, 'src/core:core'), direction: 'in' })
      expect(out.relationships.map((r) => [r.other.name, r.basis]).sort()).toEqual([['both', 'inferred'], ['direct', 'observed'], ['mid', 'inferred']])
      expect(out.totals.by_basis).toEqual({ observed: 1, inferred: 2 })
      expect(out.totals.in).toBe(3)
    })
  })
})

describe('FR182 FR185 impact_completeness gives each dependent its basis', () => {
  it('FR182 FR185 the callers of a changed symbol are inferred through a guessed hop and observed through a proved chain, with by_basis in the totals', async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
    const repo = tmpDir('pm-basis-git-')
    write(repo, FILES)
    git(repo, 'init', '-q')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    const d = tmpDir()
    initDataDir(d)
    const c = Catalog.open(d)
    const id = c.addRepository(repo).id
    c.close()
    // The CLI records each index as a job whose result names the commit; the fake adapter is not reachable from the CLI, so the test records it.
    const indexCommit = async (rev: string) => {
      const r = await indexRepository(d, id, undefined, GUESS, rev, true)
      const cat = Catalog.open(d)
      const job = cat.createJob(id, 'test')
      cat.updateJob(job, { state: 'succeeded', finished_at: new Date().toISOString(), result: JSON.stringify({ snapshot_id: r.snapshotId, commit: r.commit }) })
      cat.close()
    }
    await indexRepository(d, id, undefined, GUESS)
    await indexCommit(base)
    write(repo, { 'src/core.guess': 'def core now changes\n' })
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'head')
    const head = git(repo, 'rev-parse', 'HEAD')
    await indexCommit(head)
    const data = tool(d, 'impact_completeness', { repository_id: id, base, head, depth: 4 }).data as unknown as { changed: Array<{ name: string; dependents: Array<{ name: string; relation: string; basis: string }> }>; totals: { dependents: number; by_basis: Record<string, number> } }
    expect(data.changed.map((x) => x.name)).toEqual(['core'])
    expect(Object.fromEntries(data.changed[0]!.dependents.map((x) => [x.name, x.basis]))).toEqual({ direct: 'observed', mid: 'inferred', both: 'observed', chain1: 'observed', chain2: 'observed', viaMid: 'inferred' })
    expect(data.totals.by_basis).toEqual({ observed: 4, inferred: 2 })
    const text = runTool(d, 'impact_completeness', { repository_id: id, base, head, depth: 4, envelope: 'lean' }).text!.split('\n').filter((l) => l.startsWith('  calls '))
    expect(text.filter((l) => l.endsWith(' inferred')).map((l) => l.split(' ')[3])).toEqual(['mid', 'viaMid'].sort())
    expect(text).toHaveLength(6)
  }, 240000)
})

describe('FR186 lean rows end with inferred, and only inferred rows do', () => {
  let d: string
  beforeAll(async () => { ({ d } = await guessIndex()) }, 120000)

  it('FR186 scenario 6: get_relationships rows: an inferred row ends with the token inferred, an observed row is as it was', () => {
    expect(lean(d, 'get_relationships', { subject_id: symbolId(d, 'src/core:core'), direction: 'in' }).sort()).toEqual([
      'both src/both.guess:2 inferred', 'direct src/direct.guess:2', 'mid src/mid.guess:2 inferred',
    ])
  })

  it('FR186 scenario 6: analyze_impact rows', () => {
    expect(lean(d, 'analyze_impact', { subject_ids: [symbolId(d, 'src/core:core')] })).toEqual([
      'direct src/direct.guess:2 depth=1 calls', 'mid src/mid.guess:2 depth=1 calls inferred',
      'chain1 src/chain.guess:2 depth=2 calls', 'viaMid src/viamid.guess:2 depth=2 calls inferred', 't_inf test/t.guess:4 depth=2 calls inferred', 't_obs test/t.guess:2 depth=2 calls',
      'chain2 src/chain.guess:4 depth=3 calls',
      'both src/both.guess:3 depth=4 calls', 't_both test/t.guess:7 depth=4 calls',
    ])
  })

  it('FR186 scenario 6: find_tests rows', () => {
    expect(lean(d, 'find_tests', { subject_ids: [symbolId(d, 'src/core:core')] })).toEqual(['t_obs test/t.guess:2 depth=2', 't_inf test/t.guess:4 depth=2 inferred', 't_both test/t.guess:7 depth=4'])
  })

  it('FR186 scenario 6: trace_paths rows mark the inferred hop and no other', () => {
    expect(lean(d, 'trace_paths', { source_id: symbolId(d, 'test/t:t_inf'), target_id: symbolId(d, 'src/core:core') })).toEqual(['t_inf test/t.guess:4', 'mid src/mid.guess:2 inferred', 'core src/core.guess:1'])
    expect(lean(d, 'trace_paths', { source_id: symbolId(d, 'test/t:t_obs'), target_id: symbolId(d, 'src/core:core') })).toEqual(['t_obs test/t.guess:2', 'direct src/direct.guess:2', 'core src/core.guess:1'])
  })
})

describe('FR187 FR188 the name matching of issue 16 stays inferred without its stand-in', () => {
  let d: string
  beforeAll(() => {
    d = tmpDir()
    for (const args of [['init'], ['repo', 'add', fixtureRepo('constrained')], ['index', fixtureRepo('constrained')]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  }, 240000)

  it('FR187 FR023 no row a name match bound is resolved: each is a candidate or ambiguous, so none is an edge', () => {
    withSnapshot(d, (db) => {
      const bound = db.prepare("select resolution from assertion where origin = 'syntax' and json_extract(detail, '$.rule') glob '[gj][oa]*_*' and json_extract(detail, '$.rule') in ('go_package_member', 'go_same_package', 'go_import_path', 'java_same_file', 'java_import', 'java_static_import', 'java_same_package')").all() as Array<{ resolution: string }>
      expect(bound.length).toBeGreaterThan(5)
      expect(new Set(bound.map((r) => r.resolution)).size).toBeLessThanOrEqual(2)
      for (const r of bound) expect(['candidate', 'ambiguous']).toContain(r.resolution)
    })
  })

  it('FR188 issue 10 replaces issue 16\'s detail.inferred stand-in: a bound row carries its rule and no inferred detail, and reads as inferred through its resolution', () => {
    withSnapshot(d, (db) => {
      const open = db.prepare("select detail from assertion where origin = 'syntax' and type in ('calls', 'inherits', 'implements', 'imports') and resolution in ('candidate', 'ambiguous')").all() as Array<{ detail: string }>
      expect(open.length).toBeGreaterThan(10)
      for (const r of open) { const detail = JSON.parse(r.detail); expect(detail.rule).toMatch(/^(go|java)_/); expect(detail.inferred).toBeUndefined() }
    })
    const rows = relationships(d, { subject_id: symbolId(d, 'lib/lib:Format'), direction: 'in', types: ['calls'] }).relationships
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ resolution: 'candidate', basis: 'inferred' })
  }, 240000)
})

describe('FR190 basis is derived at answer time: no snapshot column, no adapter protocol field, and the tool schemas declare it', () => {
  const schema = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'tools', `${name}.data.schema.json`), 'utf8'))
  it('FR190 the tool data schemas name basis and by_basis', () => {
    expect(schema('get_relationships').properties.relationships.items.properties.basis.enum).toEqual(['observed', 'inferred'])
    expect(schema('analyze_impact').properties.dependents.items.properties.basis.enum).toEqual(['observed', 'inferred'])
    expect(schema('find_tests').properties.tests.items.properties.basis.enum).toEqual(['observed', 'inferred'])
    expect(schema('impact_completeness').properties.changed.items.properties.dependents.items.properties.basis.enum).toEqual(['observed', 'inferred'])
    expect(schema('trace_paths').properties.paths.items.properties.basis.enum).toEqual(['observed', 'inferred'])
    for (const t of ['get_relationships', 'analyze_impact', 'find_tests', 'impact_completeness']) expect(JSON.stringify(schema(t))).toContain('by_basis')
  })

  it('FR190 neither the snapshot format nor the adapter protocol has a basis field', async () => {
    const { dataDir: d } = await indexedDataDir(fixtureRepo('ts-module'))
    withSnapshot(d, (db) => expect((db.prepare("select count(*) as n from pragma_table_info('assertion') where name like '%basis%'").get() as { n: number }).n).toBe(0))
    expect(fs.readFileSync(path.join(ROOT, 'schemas', 'adapter-protocol', 'analyze.response.schema.json'), 'utf8')).not.toContain('basis')
    // Positive control: the same query finds a column that is there.
    withSnapshot(d, (db) => expect((db.prepare("select count(*) as n from pragma_table_info('assertion') where name = 'resolution'").get() as { n: number }).n).toBe(1))
  }, 240000)
})
