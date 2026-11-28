// query_graph (#36, FR960 to FR965): one bounded, read-only openCypher query over the snapshot, as an escape hatch beside the typed tools.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ProofmeshError } from '../src/core/errors.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { Registry } from '../src/indexer/languages.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { runTool } from '../src/query/tools.js'
import { indexedDataDir, ROOT, tmpDir, tool, withSnapshot } from './helpers.js'

/** One question of each of the twelve classes has a target here; the test file imports src/ but is outside it. */
const FILES: Record<string, string> = {
  'src/store.ts': 'export interface Store {\n  save(key: string): void\n}\nexport function audit(name: string): string {\n  return name\n}\n',
  'src/memory.ts': "import { Store, audit } from './store'\nexport class MemoryStore implements Store {\n  save(key: string): void {\n    audit(key)\n  }\n}\n",
  'src/disk.ts': "import { Store, audit } from './store'\nimport { helper } from './util'\nexport class DiskStore implements Store {\n  save(key: string): void {\n    audit(helper(key))\n  }\n}\n",
  'src/util.ts': "import { loop } from './cycle'\nexport function helper(s: string): string {\n  return loop(s)\n}\nexport function unused(): number {\n  return 1\n}\n",
  'src/cycle.ts': "import { helper } from './util'\nexport function loop(s: string): string {\n  return s.length > 3 ? s : helper(s + '!')\n}\n",
  'src/ledger.ts': "import { audit } from './store'\nexport class Ledger {\n  record(key: string): string {\n    return audit(key)\n  }\n}\nexport function report(key: string): string {\n  return new Ledger().record(key)\n}\n",
  'src/api/handler.ts': "import { Store } from '../store'\nimport { MemoryStore } from '../memory'\nimport { DiskStore } from '../disk'\nimport { report } from '../ledger'\nexport function handle(store: Store, key: string): void {\n  store.save(key)\n}\nexport function main(): void {\n  handle(new MemoryStore(), 'a')\n  handle(new DiskStore(), 'b')\n  report('c')\n}\n",
  'test/handler.test.ts': "import { handle } from '../src/api/handler'\nimport { MemoryStore } from '../src/memory'\nexport function testHandle(): void {\n  handle(new MemoryStore(), 't')\n}\n",
  'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"es2020","module":"commonjs"},"include":["src","test"]}\n',
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()

/** A repository of these files in one commit. */
const makeRepo = (prefix: string, files: Record<string, string>) => {
  const repo = tmpDir(prefix)
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text) }
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'fixture')
  return repo
}

let d: string, commit: string
beforeAll(async () => {
  const repo = makeRepo('pm-graph-query-', FILES)
  commit = git(repo, 'rev-parse', 'HEAD')
  ;({ dataDir: d } = await indexedDataDir(repo))
}, 120000)

const lean = (name: string, input: Record<string, unknown>) => runTool(d, name, { ...input, envelope: 'lean' }).text!
const rows = (text: string) => text.split('\n').filter((l) => !l.startsWith('# '))
/** A lean row's `name path:line` (a file row is its `path:line` alone), without the tags each tool adds after it. */
const site = (row: string) => { const t = row.split(' '); return t.slice(0, t.findIndex((x) => /:\d+$/.test(x)) + 1).join(' ') }
const sites = (text: string) => rows(text).map(site).sort()
/** A row's item: its name and path, as the benchmark scores dependents and transitive callers (the typed rows sit at the reaching site). */
const item = (row: string) => { const s = site(row).split(' '); return s.length === 1 ? s[0]!.replace(/:\d+$/, '') : `${s[0]} ${s[1]!.replace(/:\d+$/, '')}` }
const items = (text: string) => [...new Set(rows(text).map(item))].sort()
const query = (q: string, extra: Record<string, unknown> = {}) => lean('query_graph', { query: q, ...extra })
const refusal = (input: Record<string, unknown>) => { try { runTool(d, 'query_graph', input); return null } catch (e) { return e as ProofmeshError } }
const records = () => { const c = Catalog.open(d); try { return c.queryRecords({ tool: 'query_graph', limit: 1000 }).length } finally { c.close() } }

/** The twelve classes of bench/parity as queries, with the typed tool's (or, for Q10 to Q12, the stored data's) answer to the same question. */
const SUBJECT = (name: string, file: string) => ({ name, path: file })
const QUESTIONS: Array<{ id: string; query: string; params?: Record<string, unknown>; typed: () => string[]; answer: (text: string) => string[] }> = [
  { id: 'Q1 callers', query: 'MATCH (c)-[r:calls]->(t:function {name: $name, path: $path}) RETURN r', params: { name: 'audit', path: 'src/store.ts' }, typed: () => sites(lean('get_relationships', { subject_id: SUBJECT('audit', 'src/store.ts'), direction: 'in', types: ['calls'] })), answer: sites },
  { id: 'Q2 callers of a method called through an instance', query: "MATCH ()-[r:calls]->(m:method {name: 'record', path: 'src/ledger.ts'}) RETURN r", typed: () => sites(lean('get_relationships', { subject_id: SUBJECT('Ledger.record', 'src/ledger.ts'), direction: 'in', types: ['calls'] })), answer: sites },
  { id: 'Q3 callers of an interface method', query: "MATCH ()-[r:calls]->(:method {qualified_name: 'src/store:Store.save'}) RETURN r", typed: () => sites(lean('get_relationships', { subject_id: SUBJECT('Store.save', 'src/store.ts'), direction: 'in', types: ['calls'] })), answer: sites },
  { id: 'Q4 implementations', query: "MATCH ()-[r:implements]->(:interface {name: 'Store'}) RETURN r", typed: () => sites(lean('get_relationships', { subject_id: SUBJECT('Store', 'src/store.ts'), direction: 'in', types: ['implements'] })), answer: sites },
  { id: 'Q5 importers', query: "MATCH (:file)-[r:imports]->(:file {path: 'src/store.ts'}) RETURN r", typed: () => sites(lean('get_relationships', { path: 'src/store.ts', direction: 'in', types: ['imports'] })), answer: sites },
  { id: 'Q6 dependents', query: "MATCH (d:file)-[:imports*1..6]->(:file {path: 'src/util.ts'}) RETURN DISTINCT d", typed: () => items(lean('analyze_impact', { paths: ['src/util.ts'], types: ['imports'], limits: { max_depth: 6 } })).filter((x) => x !== 'src/util.ts'), answer: (t) => items(t).filter((x) => x !== 'src/util.ts') },
  { id: 'Q7 transitive callers', query: "MATCH (c)-[:calls*1..3]->(:method {name: 'record'}) RETURN DISTINCT c", typed: () => items(lean('analyze_impact', { subject_ids: [SUBJECT('Ledger.record', 'src/ledger.ts')], types: ['calls'], limits: { max_depth: 3 } })), answer: items },
  { id: 'Q8 call path', query: "MATCH p = (:function {name: 'main'})-[:calls*1..6]->(:function {name: 'audit'}) RETURN p", typed: () => rows(lean('trace_paths', { source_id: SUBJECT('main', 'src/api/handler.ts'), target_id: SUBJECT('audit', 'src/store.ts'), types: ['calls'] })).map(item), answer: (t) => rows(t).map(item) },
  { id: 'Q9 type users', query: "MATCH ()-[r:references]->(:interface {name: 'Store'}) RETURN r", typed: () => sites(lean('get_relationships', { subject_id: SUBJECT('Store', 'src/store.ts'), direction: 'in', types: ['references'] })), answer: sites },
  {
    id: 'Q10 dead code', query: "MATCH (f:function) WHERE f.path STARTS WITH 'src/' AND f.qualified_name ENDS WITH ':' + f.name AND NOT EXISTS { (x)-->(f) WHERE x <> f } RETURN f",
    typed: () => withSnapshot(d, (db) => (db.prepare("select s.name || ' ' || f.path as k from symbol s join file f on f.id = s.file_id where s.kind = 'function' and f.path like 'src/%' and not exists (select 1 from edge e where e.dst = s.id and e.src <> s.id)").all() as Array<{ k: string }>).map((r) => r.k).sort()),
    answer: items,
  },
  {
    id: 'Q11 import cycles', query: "MATCH (a:file)-[:imports*1..6]->(a) WHERE a.path STARTS WITH 'src/' RETURN a",
    typed: () => withSnapshot(d, (db) => {
      const imports = db.prepare("select fa.path a, fb.path b from assertion x join file fa on fa.id = x.source_id join file fb on fb.id = x.target_id where x.type = 'imports' and x.resolution = 'resolved'").all() as Array<{ a: string; b: string }>
      const adj = new Map<string, Set<string>>()
      for (const { a, b } of imports) adj.set(a, (adj.get(a) ?? new Set()).add(b))
      // A file is in a cycle when its imports, followed without a bound, lead back to it.
      const cyclic = (start: string) => { const seen = new Set<string>(), todo = [...(adj.get(start) ?? [])]; for (let f; (f = todo.pop()) !== undefined;) { if (f === start) return true; if (!seen.has(f)) { seen.add(f); todo.push(...(adj.get(f) ?? [])) } } return false }
      return (db.prepare("select path from file where path like 'src/%'").all() as Array<{ path: string }>).map((f) => f.path).filter(cyclic).sort()
    }),
    answer: items,
  },
  {
    id: 'Q12 roots', query: "MATCH (f:file) WHERE f.path STARTS WITH 'src/' AND f.disposition = 'indexed' AND NOT EXISTS { (g:file)-[:imports]->(f) WHERE g.path STARTS WITH 'src/' } RETURN f",
    typed: () => withSnapshot(d, (db) => (db.prepare("select f.path from file f where f.path like 'src/%' and f.disposition = 'indexed' and not exists (select 1 from assertion x join file g on g.id = x.source_id where x.type = 'imports' and x.resolution = 'resolved' and x.target_id = f.id and g.path like 'src/%')").all() as Array<{ path: string }>).map((r) => r.path).sort()),
    answer: items,
  },
]

describe('FR960 SC-001 scenario 1: each of the twelve question classes is one query, and its rows equal the typed answer', () => {
  for (const q of QUESTIONS) {
    it(q.id, () => {
      const typed = q.typed(), answer = q.answer(query(q.query, q.params ? { params: q.params } : {}))
      expect(typed.length, `${q.id} has a non-empty typed answer`).toBeGreaterThan(0)
      expect(answer).toEqual(typed)
    })
  }

  it('the composed question the typed tools need several calls for: callers of audit, reached from main, that are not tests', () => {
    const text = query("MATCH (:function {name: 'main'})-[:calls*1..6]->(c)-[r:calls]->(:function {name: 'audit'}) WHERE NOT c.test RETURN r")
    expect(sites(text)).toEqual(['Ledger.record src/ledger.ts:4'])
  })
})

describe('FR960 SC-002 scenario 2: the twelve queries run three times each with p95 at most 500 ms', () => {
  it('p95 over 36 runs', () => {
    const ms: number[] = []
    for (let i = 0; i < 3; i++) for (const q of QUESTIONS) { const t0 = performance.now(); query(q.query, q.params ? { params: q.params } : {}); ms.push(performance.now() - t0) }
    ms.sort((a, b) => a - b)
    expect(ms[Math.ceil(ms.length * 0.95) - 1]).toBeLessThanOrEqual(500)
  })
})

describe('FR961 SC-003 scenario 3: a write, a procedure or file access is refused by name before anything runs', () => {
  const WRITES: Array<[string, string]> = [
    ['CREATE', "CREATE (n:function {name: 'x'}) RETURN n"],
    ['MERGE', "MERGE (n:function {name: 'x'}) RETURN n"],
    ['SET', "MATCH (n:function) SET n.name = 'x' RETURN n"],
    ['DELETE', 'MATCH (n:function) DELETE n'],
    ['REMOVE', 'MATCH (n:function) REMOVE n.name RETURN n'],
    ['CALL', 'CALL db.labels()'],
    ['LOAD', "LOAD CSV FROM 'file:///etc/passwd' AS line RETURN line"],
    ['DETACH', 'MATCH (n) DETACH DELETE n'],
    ['DELETE', "MATCH (n:function) WHERE n.name = 'audit' WITH n RETURN n UNION MATCH (m) delete m"],
  ]
  for (const [clause, text] of WRITES) {
    it(`${clause}: ${text}`, () => {
      const before = records()
      const e = refusal({ query: text })
      expect(e?.code).toBe('INVALID_ARGUMENT')
      expect(e?.message).toContain(`query_graph is read-only: ${clause} is refused`)
      expect(records()).toBe(before)
    })
  }

  it('a clause name inside a string or as a property is data, not a clause', () => {
    expect(rows(query("MATCH (f:function) WHERE f.name <> 'CREATE (x)' AND f.set IS NULL RETURN f.name AS n ORDER BY n LIMIT 1"))).toEqual(['n=audit'])
  })

  it('$parameters are values passed apart from the text: a parameter holding a clause is compared, never run', () => {
    expect(rows(query('MATCH (f:function {name: $n}) RETURN f', { params: { n: "x'}) DETACH DELETE f //" } }))).toEqual([])
    expect(refusal({ query: 'MATCH (f:function {name: $n}) RETURN f' })?.message).toBe('parameter $n is not given in params')
  })

  it('a quoted name cannot reach the interpreter\'s own names, which start with a space', () => {
    expect(refusal({ query: "MATCH (` inferred`:function {name: 'audit'}) RETURN ` inferred`" })?.message).toContain('starts with a space')
  })

  it('regular expressions, unknown functions and unknown clauses are refused rather than guessed at', () => {
    expect(refusal({ query: "MATCH (f) WHERE f.name =~ '(a+)+$' RETURN f" })?.message).toContain('=~ (regular expressions) is not supported')
    expect(refusal({ query: "MATCH (f) RETURN readFile('/etc/passwd')" })?.message).toContain('unknown function readFile')
    expect(refusal({ query: 'UNWIND [1] AS x RETURN x' })?.message).toContain('UNWIND is not supported')
  })
})

describe('FR962 SC-003 scenario 4: a variable-length path with no upper bound, or one above 6 hops, is refused with the bound before it runs', () => {
  for (const pattern of ['*', '*1..', '*2..', '*..7', '*7', '*1..7', '*0..100']) {
    it(`[:calls${pattern}]`, () => {
      const before = records()
      const e = refusal({ query: `MATCH (a)-[:calls${pattern}]->(b) RETURN b` })
      expect(e?.code).toBe('INVALID_ARGUMENT')
      expect(e?.details.detail).toBe('query_unbounded')
      expect(e?.message).toMatch(/at most 6|above 6/)
      expect(records()).toBe(before)
    })
  }

  it('a lower max_depth lowers the bound, and the refusal names it', () => {
    expect(refusal({ query: 'MATCH (a)-[:calls*1..4]->(b) RETURN b', limits: { max_depth: 3 } })?.message).toContain('upper bound 4 is above 3')
    expect(refusal({ query: 'MATCH (a)-[:calls*1..3]->(b) RETURN b', limits: { max_depth: 3 } })).toBeNull()
  })

  it('the bound holds inside a pattern predicate too', () => {
    expect(refusal({ query: 'MATCH (a:function) WHERE (a)-[:calls*]->() RETURN a' })?.details.detail).toBe('query_unbounded')
  })

  it('the labels and relationship types are those of the current snapshot format', async () => {
    const { LABELS, REL_TYPES } = await import('../src/query/graph-query.js')
    const { FORMAT_VERSION } = await import('../src/meshstore/snapshot.js')
    const sql = fs.readFileSync(path.join(ROOT, 'schemas/snapshot-format', `${FORMAT_VERSION}.sql`), 'utf8')
    const checked = (table: string, column: string) => [...new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?${column} TEXT NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)`).exec(sql)![1]!.matchAll(/'(\w+)'/g)].map((m) => m[1])
    expect(LABELS).toEqual([...checked('symbol', 'kind'), 'file', 'external'])
    expect(REL_TYPES).toEqual(checked('assertion', 'type'))
  })

  it('unknown labels and relationship types are refused with the valid ones', () => {
    expect(refusal({ query: 'MATCH (a:widget) RETURN a' })?.message).toMatch(/^unknown node label widget; the labels are function, class, method, .*file, external$/)
    expect(refusal({ query: 'MATCH (a)-[:writes]->(b) RETURN b' })?.message).toMatch(/^unknown relationship type writes; the types are calls, imports, .*mentions$/)
  })
})

describe("FR2400 a variable-length pattern follows up to the query's max_depth (at most 12), and so do all of them together", () => {
  // An import ring of eight files, c0 -> c1 -> ... -> c7 -> c0, each calling the next: every path round it is longer than 6.
  const RING = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`src/c${i}.ts`, `import { f${(i + 1) % 8} } from './c${(i + 1) % 8}'\nexport function f${i}(n: number): number {\n  return n > 0 ? f${(i + 1) % 8}(n - 1) : 0\n}\n`]))
  const ringFiles = Object.keys(RING).sort()
  let r: string
  beforeAll(async () => { ({ dataDir: r } = await indexedDataDir(makeRepo('pm-graph-query-ring-', { ...RING, 'tsconfig.json': FILES['tsconfig.json']! }))) }, 120000)
  const ask = (q: string, max_depth?: number) => runTool(r, 'query_graph', { query: q, envelope: 'lean', ...(max_depth ? { limits: { max_depth } } : {}) }).text!
  const fail = (q: string, max_depth?: number) => { try { runTool(r, 'query_graph', { query: q, ...(max_depth ? { limits: { max_depth } } : {}) }); return null } catch (e) { return e as ProofmeshError } }

  it('Q6 dependents past 6 imports: *1..12 under max_depth 12 equals analyze_impact at max_depth 12, which *1..6 does not', () => {
    const dependents = (n: number) => items(ask(`MATCH (d:file)-[:imports*1..${n}]->(:file {path: 'src/c0.ts'}) WHERE d.path <> 'src/c0.ts' RETURN DISTINCT d`, n))
    const typed = items(runTool(r, 'analyze_impact', { paths: ['src/c0.ts'], types: ['imports'], limits: { max_depth: 12 }, envelope: 'lean' }).text!).filter((x) => x !== 'src/c0.ts')
    expect(typed).toEqual(ringFiles.filter((f) => f !== 'src/c0.ts'))
    expect(dependents(12)).toEqual(typed)
    expect(dependents(6)).toHaveLength(6)
  })

  it('Q11 an import cycle of 8: *1..12 under max_depth 12 finds every file of it; *1..6 finds none', () => {
    expect(items(ask("MATCH (a:file)-[:imports*1..12]->(a) WHERE a.path STARTS WITH 'src/' RETURN a", 12))).toEqual(ringFiles)
    expect(rows(ask("MATCH (a:file)-[:imports*1..6]->(a) WHERE a.path STARTS WITH 'src/' RETURN a"))).toEqual([])
  })

  it('above max_depth is refused naming it; above 12 is refused at 12, the most max_depth applies', () => {
    expect(fail('MATCH (a)-[:calls*1..7]->(b) RETURN b')?.message).toContain('upper bound 7 is above 6')
    expect(fail('MATCH (a)-[:calls*1..12]->(b) RETURN b', 12)).toBeNull()
    const e = fail('MATCH (a)-[:calls*1..13]->(b) RETURN b', 13)
    expect([e?.code, e?.details.detail]).toEqual(['INVALID_ARGUMENT', 'query_unbounded'])
    expect(e?.message).toContain('upper bound 13 is above 12')
  })

  it('the upper bounds of all the variable-length patterns of a query, in MATCH, WHERE and EXISTS, together stay within max_depth', () => {
    expect(fail('MATCH (a)-[:calls*1..3]->(b)-[:calls*1..3]->(c) RETURN c')).toBeNull()
    for (const q of ['MATCH (a)-[:calls*1..4]->(b)-[:calls*1..3]->(c) RETURN c', 'MATCH (a)-[:calls*1..4]->(b), (b)-[:imports*3]->(c) RETURN c', 'MATCH (a)-[:calls*1..4]->(b) WHERE (b)-[:calls*1..3]->() RETURN b', 'MATCH (a)-[:calls*1..6]->(b) WHERE NOT EXISTS { (b)-[:calls*1..2]->() } RETURN b']) {
      const e = fail(q)
      expect([e?.code, e?.details.detail], q).toEqual(['INVALID_ARGUMENT', 'query_unbounded'])
      expect(e?.message, q).toMatch(/^the variable-length relationships of this query follow up to (7|8) hops together, above 6, its max_depth/)
    }
    expect(fail('MATCH (a)-[:calls*1..6]->(b)-[:calls*1..6]->(c) RETURN c', 12)).toBeNull()
    expect(fail('MATCH (a)-[:calls*1..6]->(b)-[:calls*1..7]->(c) RETURN c', 12)?.message).toContain('up to 13 hops together, above 12')
    // A single hop is no variable-length pattern and counts nothing.
    expect(fail("MATCH (:function {name: 'f0'})-[:calls*1..6]->(c)-[:calls]->(d) RETURN d")).toBeNull()
  })
})

describe('FR2401 query_graph reads only what the snapshot resolved: no dispatch, and no unresolved site makes code used', () => {
  const LITERAL = {
    'src/shape.ts': 'export interface Shape {\n  area(): number\n}\nexport class Square implements Shape {\n  area(): number {\n    return 1\n  }\n}\nexport function total(s: Shape): number {\n  return s.area()\n}\n',
    'src/loose.ts': 'export function orphan(): number {\n  return 1\n}\nexport function caller(o: any): number {\n  return o.orphan()\n}\n',
    'tsconfig.json': FILES['tsconfig.json']!,
  }
  let s: string
  beforeAll(async () => { ({ dataDir: s } = await indexedDataDir(makeRepo('pm-graph-query-literal-', LITERAL))) }, 120000)
  const ask = (q: string) => runTool(s, 'query_graph', { query: q, envelope: 'lean' }).text!

  it('Q7: the transitive callers of an implementation are its resolved callers; analyze_impact adds those of the interface method, which a pattern writes out', () => {
    const typed = items(runTool(s, 'analyze_impact', { subject_ids: [SUBJECT('Square.area', 'src/shape.ts')], types: ['calls'], limits: { max_depth: 3 }, envelope: 'lean' }).text!)
    expect(typed).toContain('total src/shape.ts')
    expect(rows(ask("MATCH (c)-[:calls*1..3]->(:method {qualified_name: 'src/shape:Square.area'}) RETURN DISTINCT c"))).toEqual([])
    expect(items(ask("MATCH (c)-[:calls]->(:method)<-[:implements|overrides]-(:method {qualified_name: 'src/shape:Square.area'}) RETURN DISTINCT c"))).toEqual(['total src/shape.ts'])
  })

  it('Q10: a function only an unresolved call could reach has no relationship, so it is unused here; find_unused calls it possibly_used', () => {
    const unused = rows(runTool(s, 'find_unused', { kinds: ['function'], path_prefix: 'src/loose', top_level_only: true, envelope: 'lean' }).text!)
    expect(unused.find((l) => l.startsWith('orphan '))).toMatch(/possibly_used/)
    expect(items(ask("MATCH (f:function) WHERE f.path STARTS WITH 'src/loose' AND NOT EXISTS { (x)-->(f) WHERE x <> f } RETURN f"))).toEqual(['caller src/loose.ts', 'orphan src/loose.ts'])
  })
})

describe('FR963 scenario 5: a query that would pass the row, time or byte limit stops there, returns the rows so far, and says which limit cut it', () => {
  it('max_rows', () => {
    const env = runTool(d, 'query_graph', { query: 'MATCH (a) RETURN a', limits: { max_rows: 3 } })
    expect((env.data.rows as unknown[]).length).toBe(3)
    expect(env.completion).toMatchObject({ truncated: true, stop_reasons: ['max_rows'] })
    expect(lean('query_graph', { query: 'MATCH (a) RETURN a', limits: { max_rows: 3 } })).toContain('# Stopped at max_rows 3; the rows are those found before it.')
  })

  it('max_rows bounds the rows count and collect read, and says so', () => {
    const env = runTool(d, 'query_graph', { query: 'MATCH (a)-->(b) RETURN count(*) AS n', limits: { max_rows: 2 } })
    expect(env.data.rows).toEqual([{ values: [2] }])
    expect(env.completion.stop_reasons).toEqual(['max_rows'])
    expect(env.limitations).toContain('count and collect covered only the first 2 rows.')
  })

  it('timeout: a cross product that cannot finish stops at timeout_ms with the rows found so far', () => {
    const t0 = Date.now()
    const env = runTool(d, 'query_graph', { query: "MATCH (a), (b), (c), (d), (e), (f) WHERE f.name = 'nothing' RETURN a.name AS n", limits: { timeout_ms: 200, max_rows: 1000 } })
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(env.completion).toMatchObject({ truncated: true, timed_out: true })
    expect(env.completion.stop_reasons).toContain('timeout')
    expect((env.data.rows as unknown[]).length).toBeLessThanOrEqual(1000)
  })

  it('max_bytes', () => {
    const text = lean('query_graph', { query: 'MATCH (a) RETURN a', limits: { max_bytes: 700 } })
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(700)
    expect(runTool(d, 'query_graph', { query: 'MATCH (a) RETURN a', envelope: 'lean', limits: { max_bytes: 700 } }).completion.stop_reasons).toEqual(['max_bytes'])
  })
})

describe('FR964 scenario 6: rows are lean with file:line, and the header names the snapshot commit and freshness', () => {
  it('a symbol row, a relationship row at its site, a path row a node per hop, and scalars as key=value', () => {
    const header = (text: string) => text.split('\n')[0]
    const text = query("MATCH (c)-[r:calls]->(:function {name: 'audit'}) RETURN r, c.name AS caller ORDER BY caller, r")
    expect(header(text)).toMatch(new RegExp(`^# query_graph · commit ${commit.slice(0, 12)} · 3 rows · snap_[0-9a-z]+ current$`))
    expect(rows(text)).toEqual(['Ledger.record src/ledger.ts:4 calls caller=record', 'DiskStore.save src/disk.ts:5 calls caller=save', 'MemoryStore.save src/memory.ts:4 calls caller=save'])
    expect(rows(query("MATCH (f:function {name: 'audit'}) RETURN f"))).toEqual(['audit src/store.ts:4 function'])
    expect(rows(query("MATCH (f:file {path: 'src/util.ts'}) RETURN f"))).toEqual(['src/util.ts:1 file'])
    expect(rows(query("MATCH p = (:function {name: 'report'})-[:calls*1..2]->(:function {name: 'audit'}) RETURN p"))).toEqual(['report src/ledger.ts:7 function', 'Ledger.record src/ledger.ts:3 method depth=1', 'audit src/store.ts:4 function depth=2'])
    expect(rows(query("MATCH (c)-[:calls]->(t:function {name: 'audit'}) RETURN t.name AS target, count(c) AS callers, collect(c.name) AS names"))).toEqual(['target=audit callers=3 names=[save,record,save]'])
    const full = runTool(d, 'query_graph', { query: "MATCH (f:function {name: 'audit'}) RETURN f", envelope: 'full' })
    expect(full.snapshot?.commit).toBe(commit)
    expect(full.freshness.status).toBe('as_of_snapshot')
    expect(full.evidence_ids.length).toBe(1)
    expect(full.data).toMatchObject({ columns: ['f'], rows: [{ values: [{ kind: 'function', name: 'audit', path: 'src/store.ts', line: 4 }] }] })
  })

  it('a row any of whose hops is inferred ends with inferred (#10), and one with only proved hops does not', async () => {
    // The line language of the basis tests: `call` is a proved call, `guess` one its resolver bound by a convention.
    const GUESS = new Registry([{ id: 'guesslang', languages: new Set(['guesslang']), extensions: { '.guess': 'guesslang' }, isConfig: () => false, entry: () => path.join(ROOT, 'packages/proofmesh/test/fake-adapters/guesslang.mjs'), unavailable: () => 'adapter_unavailable:guesslang' }])
    const repo = tmpDir('pm-graph-query-guess-')
    fs.mkdirSync(path.join(repo, 'src'))
    for (const [p, t] of Object.entries({ 'src/core.guess': 'def core\n', 'src/direct.guess': 'def direct\n  call core\n', 'src/mid.guess': 'def mid\n  guess core\n', 'src/viamid.guess': 'def viaMid\n  call mid\n' })) fs.writeFileSync(path.join(repo, p), t)
    const g = tmpDir()
    initDataDir(g)
    const c = Catalog.open(g)
    c.addRepository(repo)
    c.close()
    await indexRepository(g, repo, undefined, GUESS)
    const text = runTool(g, 'query_graph', { query: "MATCH (a)-[:calls*1..2]->(:function {name: 'core'}) RETURN a ORDER BY a.name", envelope: 'lean' }).text!
    expect(rows(text)).toEqual(['direct src/direct.guess:1 function', 'mid src/mid.guess:1 function inferred', 'viaMid src/viamid.guess:1 function inferred'])
    expect((runTool(g, 'query_graph', { query: "MATCH (a {name: 'viaMid'})-[:calls*1..2]->(:function {name: 'core'}) RETURN a" }).data.rows as Array<{ inferred?: boolean }>)[0]?.inferred).toBe(true)
  })
})

describe('FR965 query_graph is listed in the extra profile only, and reads nothing outside the snapshot', () => {
  it('extra profile, read capability, lean by default over MCP', async () => {
    const { PROFILE, CAPABILITY, LEAN } = await import('../src/query/tools.js')
    expect([PROFILE.query_graph, CAPABILITY.query_graph, LEAN.has('query_graph')]).toEqual(['extra', 'read', true])
  })

  it('the module that runs queries holds no statement that writes, and builds none from the query', () => {
    const source = fs.readFileSync(path.join(ROOT, 'packages/proofmesh/src/query/graph-query.ts'), 'utf8')
    expect(source).not.toMatch(/\b(insert|update|delete from|attach|pragma|load_extension)\b/i)
    // Every statement is prepared in the Graph constructor, from fixed text.
    expect([...source.matchAll(/\.prepare\(/g)].length).toBe(1)
  })
})
