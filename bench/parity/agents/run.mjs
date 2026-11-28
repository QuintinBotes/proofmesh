// Run from any directory after pnpm install. PARITY_AGENT_OUT holds the full replies, expected sets and report.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { encode } from 'gpt-tokenizer/encoding/o200k_base'
import { makeTruth } from '../../graph-bench/lib.mjs'
import { McpClient } from '../../graph-bench/mcp-client.mjs'
import { directCallers, payload, pins } from './callers.mjs'
import { relatedItems } from './relations.mjs'

const here = import.meta.dirname
const source = execFileSync('sh', [path.resolve(here, '../fixture.sh')], { encoding: 'utf8' }).trim()
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-agent-parity-'))
const fixture = path.join(work, 'pristine')
const output = path.resolve(process.env.PARITY_AGENT_OUT ?? path.resolve(here, '../out/agents'))
const runs = Number(process.env.PARITY_RUNS ?? 5)
if (!Number.isSafeInteger(runs) || runs < 2) throw new Error('PARITY_RUNS must be an integer of at least 2')
fs.mkdirSync(output, { recursive: true })
const out = fs.mkdtempSync(path.join(output, 'run-'))
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const save = (file, obj) => fs.writeFileSync(path.join(out, file), JSON.stringify(obj, null, 2) + '\n')
const questions = json(path.resolve(here, '../questions.json')).questions
const reviewed = json(path.join(here, 'reviewed.json'))
const suite = questions.filter(q => Object.hasOwn(reviewed.questions, q.id))
const sorted = items => [...new Set(items)].sort()
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1]
const cost = result => {
  const full = JSON.stringify(result)
  return { bytes: Buffer.byteLength(full), tokens: encode(full).length }
}
function diff(expected, actual) {
  const truth = new Set(expected), got = new Set(actual)
  const missing = sorted(expected.filter(s => !got.has(s))), extra = sorted(actual.filter(s => !truth.has(s)))
  return { correct: truth.size - missing.length, expected: truth.size, returned: got.size, missing, extra }
}
function sourceLine(root, site) {
  const [file, line] = site.split(':')
  return fs.readFileSync(path.join(root, file), 'utf8').split('\n')[Number(line) - 1]?.trim()
}
function oracle() {
  execFileSync('git', ['clone', '-q', '--no-local', source, fixture])
  const identities = execFileSync('git', ['-C', fixture, 'rev-parse', 'HEAD:src', 'HEAD:tsconfig.json'], { encoding: 'utf8' }).trim().split('\n')
  if (identities[0] !== reviewed.src_tree || identities[1] !== reviewed.tsconfig_blob) throw new Error('Fixture source tree or compiler configuration differs from the reviewed fixture')
  const upstream = /^Commit: (\S+)/m.exec(fs.readFileSync(path.join(fixture, 'PROVENANCE'), 'utf8'))?.[1]
  if (upstream !== reviewed.upstream_commit) throw new Error('Fixture provenance differs from the reviewed commit')
  const truthFile = path.join(work, 'compiler.json')
  execFileSync(process.execPath, [path.resolve(here, '../../graph-bench/truth.mjs'), fixture, truthFile])
  const compiler = makeTruth(json(truthFile))
  const expected = {}
  for (const q of suite) {
    const t = compiler.truthFor(q), audit = reviewed.questions[q.id]
    if (sourceLine(fixture, audit.site) !== audit.source) throw new Error('Reviewed source changed: ' + q.id)
    if (audit.return_site && sourceLine(fixture, audit.return_site) !== audit.return_source) throw new Error('Reviewed return import changed: ' + q.id)
    if (q.kind !== 'callers') {
      if (!t.items.has(audit.item)) throw new Error('Reviewed relationship disagrees with fixture: ' + q.id)
      expected[q.id] = { items: sorted(t.items) }
      continue
    }
    if (!t.pairs.has(audit.caller + ' ' + audit.site)) throw new Error('Reviewed positive disagrees with fixture: ' + q.id)
    if (audit.excluded_site && (t.sites.has(audit.excluded_site) || sourceLine(fixture, audit.excluded_site) !== audit.excluded_source)) throw new Error('Reviewed negative disagrees with fixture: ' + q.id)
    expected[q.id] = { callers: sorted(t.items), sites: sorted(t.sites), pairs: sorted(t.pairs) }
  }
  save('expected.json', expected)
  return expected
}
function binary(name) {
  const key = 'PARITY_' + name.replaceAll('-', '_').toUpperCase()
  const candidates = process.env[key] ? [process.env[key]] : process.env.PATH.split(path.delimiter).map(d => path.join(d, name))
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file) } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`${name} is unavailable; set ${key} to the pinned executable`)
}
function processTable() {
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 32 << 20 })
  return table.split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)/.exec(l)).filter(Boolean)
}
const ownsCommand = (cmd, exe) => cmd === exe || cmd.startsWith(exe + ' ')
async function waitForPrivateWorkers(exe) {
  // This copy belongs to one trial. The final daemon cache flush can outlive its stdio parent.
  const deadline = Date.now() + 30_000
  while (processTable().some(([, , , , cmd]) => ownsCommand(cmd, exe))) {
    if (Date.now() >= deadline) throw new Error('Private index worker did not exit after MCP shutdown')
    await sleep(100)
  }
}
function monitor(roots, privateExe) {
  let peak = null
  function sample() {
    const rows = processTable()
    const pids = new Set(roots)
    // Codebase-Memory may detach an index worker; its executable is a private copy unique to this trial.
    if (privateExe) for (const [, pid, , , cmd] of rows) if (ownsCommand(cmd, privateExe)) pids.add(+pid)
    let count
    do {
      count = pids.size
      for (const [, pid, ppid] of rows) if (pids.has(+ppid)) pids.add(+pid)
    } while (pids.size > count)
    const rss = rows.reduce((sum, [, pid, , kb]) => sum + (pids.has(+pid) ? +kb : 0), 0)
    if (rss) peak = Math.max(peak ?? 0, rss)
  }
  const timer = setInterval(sample, 50)
  return () => { clearInterval(timer); return peak }
}

async function measure(tool, expected) {
  const dir = path.join(work, tool), repo = path.join(dir, 'repo'), commands = []
  const row = { version: pins[tool], commands, questions: {} }
  fs.mkdirSync(dir)
  execFileSync('git', ['clone', '-q', '--no-local', fixture, repo])
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/API_KEY$/.test(key)) delete env[key]
  let cmd = binary(tool), prefix = [], args, privateExe
  if (tool === 'gitnexus' && cmd.endsWith('.js')) { prefix = [cmd]; cmd = process.execPath }
  const v = execFileSync(cmd, [...prefix, tool === 'gortex' ? 'version' : '--version'], { env, cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 20000 })
  if (!new RegExp('(?:^|\\s)v?' + pins[tool].replaceAll('.', '\\.') + '(?:[+\\s]|$)').test(v)) throw new Error('Version mismatch: ' + v.trim())
  row.reported_version = v.trim()
  if (tool === 'gortex') {
    Object.assign(env, { GORTEX_AUTOSTART: '0', GORTEX_DAEMON_SOCKET: path.join(dir, 'sock'), XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_CACHE_HOME: path.join(dir, 'cache'), TMPDIR: path.join(dir, 'tmp') })
    fs.mkdirSync(env.TMPDIR)
    fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'gortex'), { recursive: true })
    fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'gortex/config.yaml'), 'mcp:\n  allow_embedded: true\n')
    args = ['mcp', '--index', repo, '--no-semantic', '--cache-dir', env.XDG_CACHE_HOME]
    row.profile = 'embedded MCP, default facade; semantic enrichment and embeddings off'
  } else if (tool === 'gitnexus') {
    env.GITNEXUS_HOME = path.join(dir, 'registry')
    args = ['mcp']
    row.profile = 'local syntax graph; no FTS or embeddings'
  } else {
    privateExe = path.join(dir, 'codebase-memory-mcp')
    fs.copyFileSync(cmd, privateExe, fs.constants.COPYFILE_FICLONE)
    fs.chmodSync(privateExe, 0o700)
    privateExe = fs.realpathSync(privateExe)
    cmd = privateExe
    Object.assign(env, { CBM_CACHE_DIR: path.join(dir, 'cache'), CBM_ALLOWED_ROOT: repo, CBM_DISABLE_LSP_CROSS: '1' })
    args = []
    row.profile = 'default MCP; local indexing, cross-language LSP disabled'
  }
  const roots = [], stop = monitor(roots, privateExe)
  let client, stopped = false
  try {
    const start = performance.now()
    if (tool === 'gitnexus') {
      const index = [...prefix, 'analyze', '--name', 'parity', '--skip-agents-md', '--skip-skills', '--skip-fts']
      commands.push([cmd, ...index])
      const fd = fs.openSync(path.join(out, tool + '-index.log'), 'w')
      try {
        const p = spawn(cmd, index, { cwd: repo, env, stdio: ['ignore', fd, fd], timeout: 300000 })
        roots.push(p.pid)
        await new Promise((resolve, reject) => { p.once('error', reject); p.once('exit', (code, sig) => code === 0 ? resolve() : reject(new Error('Index ended with ' + (sig ?? code) + '; see index log'))) })
      } finally { fs.closeSync(fd) }
    }
    commands.push([cmd, ...prefix, ...args])
    client = new McpClient(cmd, [...prefix, ...args], { cwd: repo, env })
    roots.push(client.proc.pid)
    const initialized = await client.init()
    if (!initialized.result) throw new Error('MCP initialization failed')
    if (tool === 'gortex') {
      const deadline = Date.now() + 180000
      while (!/\[gortex\] indexed [1-9]\d* files/.test(client.stderr)) {
        if (Date.now() > deadline || client.proc.exitCode !== null) throw new Error('Gortex did not report a complete local index')
        await sleep(75)
      }
    } else if (tool === 'codebase-memory-mcp') {
      const input = { repo_path: repo }
      commands.push(['tools/call', 'index_repository', input])
      const index = payload(await client.request('tools/call', { name: 'index_repository', arguments: input }))
      if (!(index.nodes > 0) || !(index.edges > 0)) throw new Error('Index did not supply a nonempty graph: ' + JSON.stringify(index).slice(0, 250))
    }
    row.cold_ms = Math.round(performance.now() - start)
    row.peak_rss_kib = stop(); stopped = true
    const discovery = await client.request('tools/list', {})
    row.discovery = { tools: discovery.result.tools.length, ...cost(discovery.result) }
    save(tool + '-discovery.json', discovery.result)
    async function run(q) {
      const messages = []
      const before = performance.now()
      const retrieve = q.kind === 'callers' ? directCallers : relatedItems
      const answer = await retrieve(tool, q, async (name, args) => {
        const input = { name, arguments: args }
        const r = await client.request('tools/call', input)
        messages.push({ input, reply: r })
        if (name === 'edit' && args.operation === 'export_graph' && !r.error && !r.result?.isError) {
          const text = r.result?.content?.find(c => c.type === 'text')?.text
          if (!text) throw new Error('Missing inline GraphML export')
          return text
        }
        return payload(r)
      }, repo)
      const ms = performance.now() - before
      if (q.kind !== 'callers') return { ...answer, items: sorted(answer.items ?? []), messages, ms }
      const facts = answer.facts ?? []
      return { ...answer, facts: undefined, callers: sorted(facts.map(f => f.file + '::' + f.caller)), sites: sorted(facts.map(f => f.site).filter(Boolean)),
        pairs: sorted(facts.filter(f => f.site).map(f => f.file + '::' + f.caller + ' ' + f.site)), messages, ms }
    }
    for (const q of suite) {
      const trials = []
      try {
        const warmup = await run(q)
        for (let i = 0; i < runs; i++) trials.push(await run(q))
        const first = trials[0]
        const semantic = t => JSON.stringify([t.status, t.truncated, t.callers, t.pairs, t.sites, t.items])
        if ([warmup, ...trials].some(t => semantic(t) !== semantic(first))) throw new Error('Repeated retrieval changed the semantic result')
        const costs = first.messages.map(m => cost(m.reply.result))
        const audit = reviewed.questions[q.id]
        const score = {
          status: first.status, method: first.method, reason: first.reason ?? first.site_limitation, truncated: first.truncated ?? false,
          warm_ms: trials.map(t => Math.round(t.ms * 10) / 10), bytes: costs.reduce((s, c) => s + c.bytes, 0), tokens: costs.reduce((s, c) => s + c.tokens, 0),
        }
        // Each class has its own answer contract: comparing costs requires every expected fact with no extras.
        const fields = q.kind === 'callers' ? ['callers', 'sites', 'pairs'] : ['items']
        const raw = { calls: first.messages }
        for (const field of fields) {
          score[field] = diff(expected[q.id][field], first[field])
          raw[field] = first[field]
        }
        score.exact_answer = first.status === 'answered' && !score.truncated && fields.every(field => !score[field].missing.length && !score[field].extra.length)
        if (q.kind === 'callers') {
          score.exact_site_answer = score.exact_answer
          score.audit = { caller_found: first.callers.includes(audit.caller), site_found: first.pairs.includes(audit.caller + ' ' + audit.site), source: audit.source }
        } else {
          score.audit = { site: audit.site, source: audit.source, item: audit.item, item_found: first.items.includes(audit.item) }
        }
        score.p50_ms = quantile(score.warm_ms, .5); score.p95_ms = quantile(score.warm_ms, .95)
        row.questions[q.id] = score
        save(tool + '-' + q.id + '.json', raw)
      } catch (e) { row.questions[q.id] = { status: 'retrieval_failed', reason: e.message } }
    }
    const audit = reviewed.questions.Q1
    const [file, line] = audit.site.split(':'), source = path.join(repo, file)
    const lines = fs.readFileSync(source, 'utf8').split('\n')
    lines.splice(Number(line) - 1, 0, '// parity fixture: call moved down one line')
    fs.writeFileSync(source, lines.join('\n'))
    const stale = await run(suite.find(q => q.id === 'Q1'))
    row.stale = { old_site: audit.site, moved_site: file + ':' + (Number(line) + 1), old_line_now: sourceLine(repo, audit.site), moved_source: sourceLine(repo, file + ':' + (Number(line) + 1)), old_site_returned: stale.sites.includes(audit.site), moved_site_returned: stale.sites.includes(file + ':' + (Number(line) + 1)), status: stale.status, site_limitation: stale.site_limitation }
    save(tool + '-stale.json', stale.messages)
    return row
  } finally {
    if (!stopped) stop()
    if (client) {
      await client.close()
      if (privateExe) await waitForPrivateWorkers(privateExe)
      fs.writeFileSync(path.join(out, tool + '-stderr.log'), client.stderr)
    }
  }
}

try {
  const commit = reviewed.upstream_commit, expected = oracle()
  const results = { commit, src_tree: reviewed.src_tree, tsconfig_blob: reviewed.tsconfig_blob, runs, host: os.platform() + '/' + os.arch(), node: process.version, tokenizer: 'o200k_base (gpt-tokenizer 4.1.2)', tools: {}, pending: questions.filter(q => !suite.includes(q)).map(q => q.id) }
  for (const tool of Object.keys(pins)) {
    try { results.tools[tool] = await measure(tool, expected) }
    catch (e) { results.tools[tool] = { status: 'not_run', version: pins[tool], reason: e.message } }
    console.log(tool, results.tools[tool].reason ?? 'finished')
  }
  save('results.json', results)
  const lines = ['# Graph queries on TypeORM', '', `Fixture ${commit}. ${runs} warm queries per target. Complete MCP reply costs use o200k_base.`, '',
    '| Tool | Question | Correct / returned / expected callers | Correct / returned / expected sites | p50 / p95 ms | Bytes | Tokens |', '|---|---|---|---|---|---|---|']
  const ratio = x => `${x.correct}/${x.returned}/${x.expected}`
  for (const [tool, data] of Object.entries(results.tools)) for (const q of suite.filter(q => q.kind === 'callers')) {
    const a = data.questions?.[q.id]
    lines.push(a?.callers ? `| ${tool} | ${q.id} (${a.status}) | ${ratio(a.callers)} | ${ratio(a.sites)} | ${a.p50_ms} / ${a.p95_ms} | ${a.bytes} | ${a.tokens} |` : `| ${tool} | ${q.id} | ${a?.reason ?? data.reason} | — | — | — | — |`)
  }
  lines.push('', '## Relationship queries', '', '| Tool | Question | Correct / returned / expected items | Exact | p50 / p95 ms | Bytes | Tokens |', '|---|---|---|---|---|---|---|')
  for (const [tool, data] of Object.entries(results.tools)) for (const q of suite.filter(q => q.kind !== 'callers')) {
    const a = data.questions?.[q.id]
    lines.push(a?.items ? `| ${tool} | ${q.id} ${q.kind} (${a.status}) | ${ratio(a.items)} | ${a.exact_answer} | ${a.p50_ms} / ${a.p95_ms} | ${a.bytes} | ${a.tokens} |` : `| ${tool} | ${q.id} | ${a?.reason ?? data.reason} | — | — | — | — |`)
  }
  lines.push('', '## Index and discovery costs', '', '| Tool | Index to ready (ms) | Sampled peak RSS (MiB) | Listed tools | Schema bytes | Schema tokens |', '|---|---:|---:|---:|---:|---:|')
  for (const [tool, r] of Object.entries(results.tools)) if (r.discovery) lines.push(`| ${tool} | ${r.cold_ms} | ${r.peak_rss_kib ? (r.peak_rss_kib / 1024).toFixed(1) : 'unavailable'} | ${r.discovery.tools} | ${r.discovery.bytes} | ${r.discovery.tokens} |`)
  lines.push('', '## Source audit', '', 'A saved edit moved the Q1 call in Entity.ts from line 34 to 35 immediately before the stale-source query.', '', '| Tool | Q1 caller matched | Q1 caller and site matched | Old line returned after edit | New line returned after edit |', '|---|---|---|---|---|')
  for (const [tool, r] of Object.entries(results.tools)) if (r.stale) lines.push(`| ${tool} | ${r.questions.Q1?.audit?.caller_found ?? 'unknown'} | ${r.questions.Q1?.audit?.site_found ?? 'unknown'} | ${r.stale.old_site_returned} | ${r.stale.moved_site_returned} |`)
  lines.push('', 'Only exact, untruncated answers qualify for comparing costs within a question. Direct-caller questions also require exact caller/site pairs. The JSON files contain the raw replies, commands, audits and every missing or extra fact.', '', `Question classes pending adapter coverage: ${results.pending.join(', ')}.`)
  fs.writeFileSync(path.join(out, 'report.md'), lines.join('\n') + '\n')
  console.log(path.join(out, 'report.md'))
} finally { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
