// Structural search against ast-grep (#37). Each pattern of patterns.json, in its language, is asked of search_structure over MCP
// (extra profile) and of the pinned ast-grep CLI, on the same files: the parity fixture (TypeScript) and the TypeScript, Python
// and Go files of fixtures/. SC-001: the sets of matched `path:start-end` line ranges are equal for every pattern. SC-002: the
// scoped pattern returns exactly the matches whose enclosing symbol trace_paths reaches. SC-003 (as FR1880 restates it): the p95
// CPU time per TypeScript pattern on the parity fixture, over STRUCTURE_RUNS runs (3), is at most patterns.json's
// p95_cpu_budget_ms. Each run is one MCP session, started, asked once and ended under /usr/bin/time, so its user and system time
// is the server's and the matcher's it reaps, startup included; a busy machine stretches wall-clock time, not that work.
// Wall-clock time and ast-grep's CPU and wall-clock time are printed beside it. Exits 1 when any of them fails.
//
// Usage: node bench/structure/run.mjs [--record]. PARITY_FIXTURE is the parity fixture (default $TMPDIR/parity-typeorm; build it
// with `sh bench/parity/run.sh --fixture-only`); ast-grep is found after $PARITY_TOOLS/npm/node_modules/.bin (install.sh).
// --record rewrites fixtures-answers.json, ast-grep's answers on fixtures/, which the unit test replays without the CLI.
// Results: out/structure.md and out/results.json (STRUCTURE_OUT moves them).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { McpClient } from '../graph-bench/mcp-client.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '../..')
const SUITE = JSON.parse(fs.readFileSync(path.join(HERE, 'patterns.json'), 'utf8'))
const RUNS = Number(process.env.STRUCTURE_RUNS ?? 3)
const OUT = path.resolve(process.env.STRUCTURE_OUT ?? path.join(HERE, 'out'))
const FIX = path.resolve(process.env.PARITY_FIXTURE ?? path.join(process.env.TMPDIR ?? '/tmp', 'parity-typeorm'))
const TOOLS = process.env.PARITY_TOOLS ?? path.join(os.homedir(), '.local/share/proofmesh-parity')
const PM_BIN = path.join(ROOT, 'packages/proofmesh/bin/proofmesh.mjs')
// ast-grep's extensions per language, as search_structure chooses files (PATTERN_LANGUAGES in structure-search.ts).
const EXTS = { typescript: ['ts', 'cts', 'mts'], python: ['py', 'py3', 'pyi', 'bzl', 'bazel'], go: ['go'] }
const log = (s) => console.error(`structure: ${s}`)
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts })
const ofLanguage = (files, lang) => files.filter((f) => EXTS[lang].includes(f.slice(f.lastIndexOf('.') + 1)))
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.ceil(s.length * 0.95) - 1] }
const TIME = '/usr/bin/time'
/** User plus system milliseconds from `time -p`'s report, the process and every child it waited for. */
const cpuOf = (stderr) => ['user', 'sys'].reduce((t, k) => t + Number(new RegExp(`^${k}\\s+([\\d.]+)`, 'm').exec(stderr)?.[1] ?? NaN) * 1000, 0)

const AG = [path.join(TOOLS, 'npm/node_modules/.bin/ast-grep'), 'ast-grep'].find((c) => run(c, ['--version']).status === 0)
const agVersion = AG && /\d+\.\d+\.\d+/.exec(run(AG, ['--version']).stdout)?.[0]
if (agVersion !== SUITE.ast_grep) { log(`ast-grep ${SUITE.ast_grep} is needed (found ${agVersion ?? 'none'}): sh bench/parity/install.sh`); process.exit(2) }
if (run(TIME, ['-p', 'true']).status !== 0) { log(`${TIME} is needed to time CPU`); process.exit(2) }
if (!fs.existsSync(path.join(FIX, 'PROVENANCE'))) { log(`no parity fixture at ${FIX}: sh bench/parity/run.sh --fixture-only`); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })

// ---------- the two repositories, each indexed in its own data directory ----------
const git = (dir, ...a) => run('git', ['-C', dir, ...a])
function fixturesRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-fixtures-'))
  const files = git(ROOT, 'ls-files', 'fixtures').stdout.split('\n').filter((f) => f && Object.keys(EXTS).some((l) => ofLanguage([f], l).length))
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)) }
  git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-q', '-m', 'fixtures')
  return { name: 'fixtures', dir, files }
}
const repos = [{ name: 'parity', dir: FIX, files: git(FIX, 'ls-files').stdout.split('\n').filter(Boolean) }, fixturesRepo()]
for (const r of repos) {
  r.data = fs.mkdtempSync(path.join(os.tmpdir(), `structure-pm-${r.name}-`))
  const pm = (...a) => { const x = run(process.execPath, [PM_BIN, '--data-dir', r.data, ...a]); if (x.status !== 0) throw new Error(`proofmesh ${a[0]}: ${x.stderr}`) }
  log(`indexing ${r.name} (${r.dir})`)
  pm('init'); pm('repo', 'add', r.dir); pm('index', r.dir)
  r.mcp = new McpClient(process.execPath, [PM_BIN, '--data-dir', r.data, 'mcp', '--tools', 'core,extra'], { cwd: r.dir })
  await r.mcp.init()
}

/** Every match of search_structure, paged, as `path:start-end`, with the time of the first page. */
async function ours(r, args) {
  const sites = [], rows = []
  let cursor, ms = null, total = null
  do {
    const a = await r.mcp.call('search_structure', { ...args, envelope: 'compact', limits: { max_rows: 1000, timeout_ms: 30000 }, ...(cursor ? { cursor } : {}) })
    if (a.isError || !a.json) throw new Error(`search_structure ${JSON.stringify(args)}: ${a.text}`)
    ms ??= a.ms
    total ??= a.json.completion.total
    if (a.json.completion.stop_reasons.includes('timeout')) throw new Error(`search_structure ${args.pattern} timed out`)
    for (const m of a.json.data.matches) { sites.push(`${m.path}:${m.line}-${m.end_line}`); rows.push(m) }
    cursor = a.json.completion.next_cursor
  } while (cursor)
  if (sites.length !== total) throw new Error(`search_structure ${args.pattern}: ${sites.length} rows for a total of ${total}`)
  return { sites, rows, ms }
}
/** One search in a session of its own, under time: its wall time and the session's CPU time. */
async function timed(r, args) {
  const c = new McpClient(TIME, ['-p', process.execPath, PM_BIN, '--data-dir', r.data, 'mcp', '--tools', 'core,extra'], { cwd: r.dir })
  await c.init()
  const a = await c.call('search_structure', { ...args, envelope: 'compact', limits: { max_rows: 1000, timeout_ms: 30000 } })
  if (a.isError) throw new Error(`search_structure ${args.pattern}: ${a.text}`)
  c.proc.stdin.end()
  await once(c.proc, 'exit')
  const cpu = cpuOf(c.stderr)
  if (!Number.isFinite(cpu)) throw new Error(`no CPU time for ${args.pattern}: ${c.stderr}`)
  return { ms: a.ms, cpu }
}
/** ast-grep's matches on the same files, as `path:start-end`, with its wall and CPU time. */
function theirs(r, lang, pattern) {
  const files = ofLanguage(r.files, lang)
  const t0 = performance.now()
  const x = run(TIME, ['-p', AG, 'run', '-p', pattern, '-l', lang, '--json=stream', ...files], { cwd: r.dir })
  const ms = performance.now() - t0
  if (x.status !== 0 && x.status !== 1) throw new Error(`ast-grep ${pattern}: ${x.stderr}`)
  return { sites: x.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((m) => `${m.file}:${m.range.start.line + 1}-${m.range.end.line + 1}`), ms, cpu: cpuOf(x.stderr) }
}

// ---------- SC-001 and SC-003 ----------
const results = []
for (const { language, pattern } of SUITE.patterns) {
  for (const r of repos) {
    if (!ofLanguage(r.files, language).length) continue
    const o = await ours(r, { pattern, language }), t = theirs(r, language, pattern)
    const a = new Set(o.sites), b = new Set(t.sites)
    const extra = [...a].filter((x) => !b.has(x)), missing = [...b].filter((x) => !a.has(x))
    const row = { repo: r.name, language, pattern, matches: o.sites.length, ast_grep: t.sites.length, extra, missing, same: !extra.length && !missing.length && o.sites.length === t.sites.length, ast_grep_sites: t.sites }
    if (r.name === 'parity' && language === 'typescript') {
      const mine = [], ag = [t]
      for (let i = 0; i < RUNS; i++) { mine.push(await timed(r, { pattern, language })); if (i) ag.push(theirs(r, language, pattern)) }
      const of = (xs, k) => xs.map((x) => x[k])
      Object.assign(row, { ms: of(mine, 'ms'), cpu_ms: of(mine, 'cpu'), ast_grep_ms: of(ag, 'ms'), ast_grep_cpu_ms: of(ag, 'cpu'), p95: p95(of(mine, 'ms')), cpu_p95: p95(of(mine, 'cpu')), ast_grep_p95: p95(of(ag, 'ms')), ast_grep_cpu_p95: p95(of(ag, 'cpu')) })
    }
    log(`${row.same ? 'same' : 'DIFFERENT'} ${r.name} ${language} ${pattern}: ${row.matches} / ast-grep ${row.ast_grep}${row.p95 ? ` (p95 CPU ${Math.round(row.cpu_p95)} ms / ${Math.round(row.ast_grep_cpu_p95)} ms, wall ${Math.round(row.p95)} ms / ${Math.round(row.ast_grep_p95)} ms)` : ''}`)
    results.push(row)
  }
}

// ---------- SC-002: the graph scope equals the reachable set ----------
const sc = SUITE.scope, pr = repos.find((r) => r.name === sc.fixture)
const scoped = await ours(pr, { pattern: sc.pattern, language: sc.language, scope: { reachable_from: [sc.reachable_from] } })
const every = await ours(pr, { pattern: sc.pattern, language: sc.language })
const start = (await pr.mcp.call('find_symbols', { text: sc.reachable_from.split('.').pop(), envelope: 'compact', limits: { max_rows: 1000 } })).json.data.symbols.filter((s) => s.qualified_name.endsWith(`:${sc.reachable_from}`))
if (start.length !== 1) throw new Error(`${sc.reachable_from} names ${start.length} symbols`)
const reached = new Map()
for (const id of new Set(every.rows.map((m) => m.symbol.id))) {
  reached.set(id, id === start[0].id || (await pr.mcp.call('trace_paths', { source_id: start[0].id, target_id: id, envelope: 'compact' })).json.data.conclusion === 'path_found')
}
const expected = every.rows.filter((m) => reached.get(m.symbol.id)).map((m) => `${m.symbol.qualified_name} ${m.path}:${m.line}`)
const got = scoped.rows.map((m) => `${m.symbol.qualified_name} ${m.path}:${m.line}`)
const sc2 = { ...sc, matches: got.length, of: every.rows.length, symbols_reached: [...reached.values()].filter(Boolean).length, same: JSON.stringify(got) === JSON.stringify(expected), got, expected }
log(`${sc2.same ? 'same' : 'DIFFERENT'} scope reachable_from ${sc.reachable_from}: ${got.length} of ${every.rows.length} matches, ${sc2.symbols_reached} enclosing symbols reached`)
for (const r of repos) r.mcp.close()

// ---------- results ----------
const sc1 = results.every((r) => r.same)
const timedRows = results.filter((r) => r.p95 != null)
const sc3 = timedRows.every((r) => r.cpu_p95 <= SUITE.p95_cpu_budget_ms)
const head = run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']).stdout.trim()
const meta = { proofmesh: head, ast_grep: agVersion, runs: RUNS, p95_cpu_budget_ms: SUITE.p95_cpu_budget_ms, when: new Date().toISOString(), machine: `${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0]?.model ?? ''} x${os.cpus().length}, load ${os.loadavg().map((l) => l.toFixed(0)).join(' ')}, Node ${process.version}`, fixture: fs.readFileSync(path.join(FIX, 'PROVENANCE'), 'utf8').split('\n')[1] }
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, sc1, sc2, sc3, patterns: results.map(({ ast_grep_sites: _s, ...r }) => r) }, null, 1))
const md = [
  `# search_structure against ast-grep ${agVersion}`, '',
  `ProofMesh ${head}, ${meta.when}, ${meta.machine}. Parity fixture: ${meta.fixture}.`, '',
  '| repo | language | pattern | search_structure | ast-grep | same | p95 CPU ms (ours / ast-grep) | p95 wall ms (ours / ast-grep) |', '|---|---|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.repo} | ${r.language} | \`${r.pattern.replaceAll('|', '\\|').replaceAll('\n', '\\n')}\` | ${r.matches} | ${r.ast_grep} | ${r.same ? 'yes' : `no (+${r.extra.length} −${r.missing.length})`} | ${r.p95 != null ? `${Math.round(r.cpu_p95)} / ${Math.round(r.ast_grep_cpu_p95)} | ${Math.round(r.p95)} / ${Math.round(r.ast_grep_p95)}` : '- | -'} |`),
  '', `Scope: \`${sc.pattern}\` reachable_from \`${sc.reachable_from}\`: ${got.length} of ${every.rows.length} matches, ${sc2.same ? 'exactly' : 'NOT'} those whose enclosing symbol trace_paths reaches (${sc2.symbols_reached} of ${reached.size} symbols).`,
  '', `- SC-001 identical match sets on every pattern: ${sc1 ? 'met' : 'NOT met'}`, `- SC-002 scoped matches equal the reachable set: ${sc2.same ? 'met' : 'NOT met'}`,
  `- SC-003 p95 CPU time per TypeScript pattern at most ${SUITE.p95_cpu_budget_ms} ms (FR1880): ${sc3 ? 'met' : `NOT met (${timedRows.filter((r) => r.cpu_p95 > SUITE.p95_cpu_budget_ms).length} of ${timedRows.length} patterns over)`}; most ${Math.round(Math.max(...timedRows.map((r) => r.cpu_p95)))} ms, ast-grep's most ${Math.round(Math.max(...timedRows.map((r) => r.ast_grep_cpu_p95)))} ms`, '',
].join('\n')
fs.writeFileSync(path.join(OUT, 'structure.md'), md)
console.log(md)
if (process.argv.includes('--record')) {
  const fixtures = repos.find((r) => r.name === 'fixtures')
  const files = Object.fromEntries(Object.keys(EXTS).map((l) => [l, ofLanguage(fixtures.files, l)]))
  const answers = results.filter((r) => r.repo === 'fixtures').map((r) => ({ language: r.language, pattern: r.pattern, sites: [...r.ast_grep_sites].sort() }))
  fs.writeFileSync(path.join(HERE, 'fixtures-answers.json'), JSON.stringify({ ast_grep: agVersion, note: 'ast-grep\'s matches on the files of fixtures/, recorded by node bench/structure/run.mjs --record', files, answers }, null, 1) + '\n')
  log('recorded fixtures-answers.json')
}
process.exit(sc1 && sc2.same && sc3 ? 0 : 1)
