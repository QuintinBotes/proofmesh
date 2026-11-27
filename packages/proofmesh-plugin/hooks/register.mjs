// The plugin's hooks module (#113, FR480 to FR487), loaded by Claude Code 2.1.287 and later: the snapshot's state for the session's
// repository as a status line under the prompt, and /pm-status, which answers at once with no model turn. It only watches: fresh.mjs
// still records edits and runs the debounced index, and this module sees that index through the job row and the snapshot it publishes.
// The session trail (#114, FR610 to FR615): where a person ran `proofmesh trail on`, it records the paths and symbol ids the session's
// tools searched, opened, changed and claimed, never their text, hands them to `proofmesh trail record` at each turn's end, and /pm-trail shows them.
// The impact pane (#115, FR700 to FR706): the symbols the session's edits changed, their dependents and the tests that reach them, asked
// once per published snapshot and drawn in a pane /pm-impact toggles, or printed by it where nothing draws.
import { deepestRoot } from './repos.mjs'

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TRAIL = { Read: 'opened', Grep: 'searched', Glob: 'searched', Edit: 'changed', Write: 'changed', MultiEdit: 'changed', NotebookEdit: 'changed' }
// The plugin's own server is mcp__plugin_proofmesh_proofmesh__; one a person registered as proofmesh is mcp__proofmesh__.
const PROOFMESH_TOOL = /^mcp__(?:plugin_proofmesh_)?proofmesh__(\w+)$/
const POLL_MS = 5000
const IDLE_POLLS = (10 * 60_000) / POLL_MS
// While current, the tree is checked once a minute: a branch switch or an edit made outside Claude moves it too.
const CURRENT_POLLS = 60_000 / POLL_MS

let cwd = '', draws = false, ready, repo = null
let kind = '', text = '', snapshot = null, published = 0, changed = 0
const edited = new Set()
let edits = 0, idle = 0, ticks = 0, busy = false, queue = Promise.resolve(), shown
// Off until `proofmesh status --fresh` says a person turned the trail on for this repository.
let recording = false, trail = []
const PANE = 'pm-impact'
const SHOWN = 20
// Per repository-relative path, the line ranges the session's edits touched, kept in the file's lines as they now are, and the snapshot
// before its first edit, whose body hashes tell a changed symbol from one an edit left as it was or put back.
const touched = new Map()
// Edit targets outside the repository; edits seen before the repository is known, replayed once it is; what the trail saw opened.
const outside = new Set(), early = [], opened = new Set()
let answer = null, analysing = null

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const age = (ms) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`)
// The engine prefixes a refused call's message with where it failed; the last part says why.
const why = (err) => String(err?.message ?? err).split(': ').pop()
const lastLine = (s) => s.trim().split('\n').pop() || 'no output'

/** Runs `proofmesh <args>`, with `stdin` written to it when given, one at a time for the whole module. */
function proofmesh($, args, stdin) {
  const run = queue.then(() => $.process.run(['proofmesh', ...args], stdin === undefined ? undefined : { stdin }))
  queue = run.catch(() => {})
  return run
}

/** Calls `tool` on the plugin's own proofmesh MCP server and returns its envelope; throws with the server's message when it fails. */
export async function callTool($, tool, args) {
  const server = await $.mcp.connect('proofmesh')
  if (!server.isConnected) throw new Error(server.message)
  const r = await $.mcp.call(server.server, tool, args)
  const text = r.content.find((c) => c.type === 'text')?.text
  // A lean answer is its text alone; an error is JSON in every envelope.
  if (args.envelope === 'lean' && !r.isError) return text ?? ''
  const body = r.structuredContent ?? JSON.parse(text ?? '{}')
  if (r.isError) throw new Error(body.message ?? body.code ?? 'the tool failed')
  return body
}

async function line($) {
  if (kind === 'current') return `current ${snapshot} (${age((await $.clock.now()) - published)})`
  if (kind === 'behind') return edited.size ? `behind (${plural(edited.size, 'file')} edited)` : `behind (${plural(changed, 'file')} changed)`
  return text
}

async function show($, next, detail = '') {
  kind = next
  text = detail || next
  if (!draws) return
  // The pane marks its answer behind, or asks again, from this state.
  $.ui.invalidate('ui.render')
  const now = await line($)
  if (now !== shown) $.ui.status((shown = now))
}

/** Reads the snapshot's state: whether it matches the working tree, and any index job running. */
async function refresh($) {
  if (!repo || busy) return
  busy = true
  const seen = edits
  try {
    const f = await proofmesh($, ['status', repo.id, '--fresh', '--json'])
    if (f.exitCode !== 0) return await (f.stderr.includes('SNAPSHOT_UNAVAILABLE') ? show($, 'missing') : show($, 'unknown', `unknown (${lastLine(f.stderr)})`))
    const fresh = JSON.parse(f.stdout)
    recording = fresh.trail_recording === true
    const status = await callTool($, 'workspace_status', { repository_id: repo.id, envelope: 'compact' })
    snapshot = status.snapshot.id
    published = Date.parse(status.snapshot.published_at)
    changed = fresh.changed_count
    const job = (status.data.jobs ?? []).find((j) => j.state === 'running' || j.state === 'queued')
    if (job) return await show($, 'indexing', `indexing${job.phase ? ` ${job.phase}` : ''}${job.total ? ` ${job.done}/${job.total}` : ''}`)
    // An edit that landed while this ran is not in what it read.
    if (fresh.current && seen === edits) edited.clear()
    await show($, fresh.current && !edited.size ? 'current' : 'behind')
  } catch (err) {
    await show($, 'unknown', `unknown (${why(err)})`)
  } finally {
    busy = false
  }
}

/** Finds the repository and its state; the timer then keeps the line current. */
async function init($) {
  try {
    const listed = await proofmesh($, ['repo', 'list'])
    if (listed.exitCode !== 0) return await show($, 'unknown', `unknown (${lastLine(listed.stderr)})`)
    const real = (await $.fs.stat(cwd, { resolve: true }).catch(() => undefined))?.realPath ?? cwd
    repo = deepestRoot(listed.stdout, real, cwd.includes('\\') ? '\\' : '/')
  } catch (err) {
    return await (/failed to start/.test(String(err?.message)) ? show($, 'not installed') : show($, 'unknown', `unknown (${why(err)})`))
  }
  if (!repo) return await show($, 'not registered here')
  for (const [e, result] of early.splice(0)) await noteEdit($, e, result)
  await refresh($)
}

async function tick($) {
  const awake = idle++ < IDLE_POLLS
  if (awake && !repo && kind === 'unknown') await look($)
  else if (awake && repo && (kind !== 'current' || ++ticks % CURRENT_POLLS === 0)) await refresh($)
  else if (kind === 'current') await show($, 'current')
}

// A lookup that ended unknown is tried again by the next poll or /pm-status; not registered here and not installed stay.
const look = ($) => (ready ??= init($).then(() => { if (!repo && kind === 'unknown') ready = undefined }))

async function start($) {
  await look($)
  if (repo || kind === 'unknown') $.clock.every(POLL_MS, () => tick($))
}

/** `target` (absolute, or relative to the session's directory) relative to the repository root, `.` for the root; null outside it. */
async function inRepository($, target) {
  const sep = repo.root.includes('\\') ? '\\' : '/'
  // `.` and `..` are folded here, since a path that does not exist (a failed Read, a denied Write) comes back from stat as written.
  const parts = []
  for (const s of (/^([/\\]|[A-Za-z]:)/.test(target) ? target : `${cwd}/${target}`).split(/[/\\]/)) {
    if (s === '..') { if (parts.length > 1) parts.pop() } else if (s !== '.' && (s !== '' || !parts.length)) parts.push(s)
  }
  const absolute = parts.join(sep)
  const real = (await $.fs.stat(absolute, { resolve: true }).catch(() => undefined))?.realPath ?? absolute
  if (real === repo.root) return '.'
  return real.startsWith(repo.root) && /^[/\\]/.test(real.slice(repo.root.length)) ? real.slice(repo.root.length + 1) : null
}

async function noteEdit($, e, result) {
  const target = e.file_path ?? e.notebook_path
  if (typeof target !== 'string') return
  // shortcut: at most 1,000 edits wait for the repository lookup, which a session with no surface makes only when a command asks.
  if (!repo) return void (!kind && early.length < 1000 && early.push([{ tool: e.tool, file_path: target }, { result: hunksOf(result.result) }]))
  const path = await inRepository($, target)
  // Listed as it is, with no ProofMesh call, so it moves no answer out of date.
  if (path === null) return void (outside.add(target), draws && $.ui.invalidate('ui.render'))
  if (path === '.') return
  edited.add(path)
  edits++
  touch(path, result.result)
  await show($, kind === 'current' || !kind ? 'behind' : kind, text)
}

/**
 * The hunks an edit tool's result names, as line numbers alone: the patch Edit and Write give, a new file's whole content, or else the
 * first line (shortcut: a NotebookEdit or MultiEdit result carries no patch, so only the symbol at line 1 is looked up).
 */
function hunksOf(r) {
  if (Array.isArray(r)) return r
  if (r?.staged === true) return []
  if (Array.isArray(r?.structuredPatch) && r.structuredPatch.length) return r.structuredPatch.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines }))
  const lines = typeof r?.content === 'string' ? r.content.split('\n').length : 1
  return [{ oldStart: 1, oldLines: r?.originalFile ? r.originalFile.split('\n').length : 0, newStart: 1, newLines: lines }]
}

/** Moves the path's earlier ranges past the edit's hunks, last hunk first so each hunk's old lines still hold, then adds the hunks' new lines. */
function touch(path, r) {
  const t = touched.get(path) ?? { base: snapshot, ranges: [] }
  touched.set(path, t)
  const hunks = hunksOf(r)
  for (const h of [...hunks].reverse()) {
    const end = h.oldStart + h.oldLines, delta = h.newLines - h.oldLines
    t.ranges = t.ranges.map(([a, b]) => (b < h.oldStart ? [a, b] : a >= end ? [a + delta, b + delta] : [Math.min(a, h.oldStart), Math.max(b + delta, h.oldStart + h.newLines - 1)]))
  }
  t.ranges.push(...hunks.map((h) => [h.newStart, h.newStart + Math.max(h.newLines, 1) - 1]))
}

/** What a ProofMesh tool call names: a symbol id, or a repository-relative path; `.` when it names neither, so searched the whole repository. */
function subjectOf(tool, e) {
  // A `kind:qualified name` with a space is not kept: trail record takes symbol ids without spaces, and refuses the whole batch otherwise.
  const symbol = (id) => typeof id === 'string' && !/\s/.test(id)
  if (tool === 'verify_claim') {
    const source = e.claim?.proposition?.source
    return symbol(source) ? { symbol_id: source } : typeof source?.path === 'string' ? { path: source.path } : {}
  }
  const id = e.symbol_id ?? e.subject_id ?? e.subject_ids?.[0] ?? e.source_id
  if (symbol(id)) return { symbol_id: id }
  if (typeof id === 'string') return {}
  // A symbol named by { name, path }, or by a stable key (`<path>#<module>:<name>#<kind>`), is recorded as its file.
  const path = id?.path ?? (typeof e.key === 'string' ? e.key.split('#')[0] : undefined) ?? e.path ?? e.paths?.[0] ?? e.source_path ?? e.path_prefix
  return { path: typeof path === 'string' ? path.replace(/\/+$/, '') || '.' : '.' }
}

/** Buffers one trail entry for a finished call: the kind, the tool and what it named, never its arguments' text or its result. */
async function noteTrail($, e, result) {
  const mcp = PROOFMESH_TOOL.exec(e.tool)?.[1]
  const step = mcp ? (mcp === 'verify_claim' ? 'claimed' : mcp === 'get_symbol' ? 'opened' : 'searched') : TRAIL[e.tool]
  if (!step || !repo) return
  let subject
  if (mcp) {
    subject = subjectOf(mcp, e)
    // ProofMesh's paths are repository-relative already; one that leaves the repository is not recorded.
    if (subject.path !== undefined && (/^([/\\]|[A-Za-z]:)/.test(subject.path) || subject.path.split(/[/\\]/).includes('..'))) return
  } else {
    // A search with no path ran in the session's directory.
    const target = e.file_path ?? e.notebook_path ?? (step === 'searched' ? e.path ?? cwd : undefined)
    const path = typeof target === 'string' ? await inRepository($, target) : null
    if (path === null) return
    subject = { path }
  }
  const ok = result.deny === undefined && result.isError !== true
  if (step === 'opened' && ok) {
    opened.add(subject.path ?? subject.symbol_id)
    if (draws) $.ui.invalidate('ui.render')
  }
  trail.push({
    session_id: await $.session.id(), repository_id: repo.id, ...(e.agentId ? { agent_id: e.agentId } : {}), at: new Date(await $.clock.now()).toISOString(),
    kind: step, tool: e.tool, ...subject, outcome: ok ? 'ok' : 'failed',
  })
}

/** Hands the buffered entries to ProofMesh in one process. */
async function flush($) {
  if (!trail.length) return
  const lines = trail.splice(0).map((t) => JSON.stringify(t)).join('\n') + '\n'
  try { await proofmesh($, ['trail', 'record'], lines) } catch {}
}

/** /pm-trail's text from get_session_trail's envelope. */
function trailText(t) {
  const d = t.data, n = d.entries.length
  return [
    `session trail ${d.session_id} in ${repo.name}, as of snapshot ${t.snapshot.id}: ${n} entr${n === 1 ? 'y' : 'ies'}${d.cut ? ' (cut at 10,000)' : ''}`,
    ...d.entries.map((e) => `  ${[e.seq, e.kind, e.tool.replace(PROOFMESH_TOOL, '$1'), e.path ?? e.symbol_id ?? '-', ...(e.outcome === 'failed' ? ['failed'] : []), ...(e.agent_id ? [`agent=${e.agent_id}`] : [])].join(' ')}`),
    ...d.changed.flatMap((c) => [
      `changed ${c.name} ${c.path}:${c.line}: ${plural(c.never_seen.length + c.searched_only.length, 'dependent')} not opened`,
      ...c.never_seen.map((x) => `  never seen: ${x.name} ${x.path}:${x.line}`),
      ...c.searched_only.map((x) => `  searched only: ${x.name} ${x.path}:${x.line}`),
    ]),
    ...t.limitations.map((l) => `# ${l}`),
  ].join('\n')
}

/** What the pane's answer is as of: the snapshot, and the edits it covers. */
const asOf = () => `${snapshot}|${edits}`
/** The pane asks again only for a current snapshot it has no answer for, and never with no change in the session. */
const stale = () => repo && kind === 'current' && touched.size > 0 && answer?.of !== asOf()

/** One lean row of analyze_impact, `<name> <path>:<line> <tags>`, a token with a space quoted as JSON. */
function dependentOf(row) {
  const tokens = (row.match(/(?:"(?:[^"\\]|\\.)*"|[^\s"])+/g) ?? []).map((t) => t.replace(/^("(?:[^"\\]|\\.)*")/, (q) => JSON.parse(q)))
  const site = /^(.*):(\d+)$/
  const i = tokens.length > 1 && site.test(tokens[1]) ? 1 : 0
  const [, path, line] = site.exec(tokens[i]) ?? [null, null, null]
  const tags = tokens.slice(i + 1)
  return {
    name: i ? tokens[0] : path ?? tokens[0], path, line: Number(line),
    relationship: tags.find((t) => !/^(depth=\d+|inferred|generated|external)$/.test(t)) ?? '-',
    // A lean row says inferred when a hop of its chain is; every other row was reached along resolved relationships.
    evidence: tags.includes('inferred') ? 'inferred' : 'resolved',
    depth: tags.find((t) => t.startsWith('depth=')) ?? '',
  }
}

/** Asks ProofMesh about the session's changes on the current snapshot, pinned so every answer is of that one snapshot. */
async function analyse($) {
  const of = asOf(), at = snapshot, pin = { repository_id: repo.id, snapshot_id: at }
  const next = { of, snapshot: at, files: new Map(), more: 0, notIndexed: [], error: null }
  try {
    const locations = [...touched].flatMap(([path, t]) => [...new Set(t.ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)))].sort((x, y) => x - y).map((l) => `${path}:${l}`))
    const found = new Map(), reasons = new Map()
    for (let i = 0; i < locations.length; i += 100) {
      const r = await callTool($, 'get_symbols_at', { ...pin, locations: locations.slice(i, i + 100), envelope: 'compact' })
      for (const x of r.data.results) {
        if (x.symbol && x.symbol.kind !== 'module') found.set(x.symbol.stable_key, x.symbol)
        else if (!x.symbol && (x.reason === 'not_indexed' || x.error)) reasons.set(x.location.replace(/:\d+$/, ''), x.disposition ?? x.error?.code ?? x.reason)
      }
    }
    for (const [path, reason] of reasons) if (![...found.values()].some((s) => s.path === path)) next.notIndexed.push([path, reason])
    const hash = (key, snapshot_id) => callTool($, 'get_symbol', { ...pin, snapshot_id, key, envelope: 'compact' }).then((r) => r.data.symbol.body_hash, () => null)
    const changed = []
    for (const s of [...found.values()].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : x.start_line - y.start_line))) {
      const base = touched.get(s.path)?.base
      // The same body as before the session's first edit of its file: an edit beside it, or one undone.
      if (base && base !== at) {
        const was = await hash(s.stable_key, base)
        if (was !== null && was === (await hash(s.stable_key, at))) continue
      }
      changed.push(s)
    }
    next.more = Math.max(0, changed.length - SHOWN)
    for (const s of changed.slice(0, SHOWN)) {
      const lean = (await callTool($, 'analyze_impact', { ...pin, key: s.stable_key, envelope: 'lean' })).split('\n').slice(1)
      const t = await callTool($, 'find_tests', { ...pin, key: s.stable_key, envelope: 'compact' })
      const row = {
        name: s.name, line: s.start_line,
        dependents: lean.filter((l) => !l.startsWith('# ')).map(dependentOf),
        notes: lean.filter((l) => l.startsWith('# ')),
        tests: t.data.tests.map((x) => `test ${x.name} ${x.path}:${x.line} ${x.evidence}${x.basis === 'inferred' ? ' inferred' : ''}`),
        cut: t.completion.truncated ? `# tests: ${t.data.tests.length} of ${t.data.totals.tests} shown (${t.completion.stop_reasons.join(', ')})` : null,
      }
      next.files.set(s.path, [...(next.files.get(s.path) ?? []), row])
    }
  } catch (err) {
    next.error = why(err)
  }
  answer = next
}

/** Asks once at a time, and redraws when the answer lands. */
function update($) {
  return (analysing ??= analyse($).finally(() => {
    analysing = null
    if (draws) $.ui.invalidate('ui.render')
  }))
}

/** The pane's rows, which /pm-impact prints as text: `{ depth, text, dim }`, or a dependent's `{ depth, dep: { head, loc, tail } }`. */
function impactRows() {
  if (!repo) return [{ depth: 0, text: `impact: off (${text || 'looking for the repository'})` }]
  if (!touched.size && !outside.size) return [{ depth: 0, text: 'no changes in this session' }]
  const away = [...outside].map((p) => ({ depth: 0, text: `${p}: not indexed (outside the repository)` }))
  if (!touched.size) return away
  if (!answer) return [{ depth: 0, text: `impact: waiting for a snapshot with the session's edits (${kind || 'unknown'})` }, ...away]
  const out = [{ depth: 0, text: `impact as of ${answer.snapshot} (${answer.of === asOf() && kind === 'current' ? 'current' : 'behind'})` }]
  if (answer.error) return [...out, { depth: 0, text: `impact: unknown (${answer.error})` }]
  // shortcut: an opened symbol id never matches, since a lean impact row names no id; a Read of the file, or get_symbol by name and path, does.
  const unopened = (d) => recording && d.path !== null && ![...opened].some((p) => d.path === p || d.path.startsWith(`${p}/`))
  const notOpened = [...answer.files.values()].flat().flatMap((s) => s.dependents).filter(unopened).length
  if (recording) out.push({ depth: 0, text: `${plural(notOpened, 'dependent')} not opened` })
  for (const [path, symbols] of answer.files) {
    out.push({ depth: 0, text: path })
    for (const s of symbols) {
      out.push({ depth: 1, text: `changed ${s.name} line ${s.line}` })
      for (const d of s.dependents) out.push({ depth: 2, dep: { head: `${d.relationship} ${d.name}`, loc: d.path === null ? null : `${d.path}:${d.line}`, tail: [d.evidence, d.depth, ...(unopened(d) ? ['not opened'] : [])].filter(Boolean).join(' ') } })
      out.push(...s.notes.map((n) => ({ depth: 2, text: n, dim: true })))
      out.push(...(s.tests.length ? s.tests : ['no test reaches it']).map((t) => ({ depth: 2, text: t })))
      if (s.cut) out.push({ depth: 2, text: s.cut, dim: true })
    }
  }
  if (answer.more) out.push({ depth: 0, text: `${answer.more} more changed symbol${answer.more === 1 ? '' : 's'} not shown` })
  out.push(...answer.notIndexed.map(([path, reason]) => ({ depth: 0, text: `${path}: not indexed (${reason})` })))
  if (out.length === 1) out.push({ depth: 0, text: 'no changed symbols' })
  return [...out, ...away]
}

const rowText = (r) => '  '.repeat(r.depth) + (r.dep ? [r.dep.head, r.dep.loc ?? 'external', r.dep.tail].join(' ') : r.text)

/**
 * Draws the rows: a dependent is a Button that copies its file:line, beside an open button that does too. The file:line is not a Link:
 * the desktop app links only an https: or http://localhost href, and draws a file: one as plain text.
 */
function drawPane($, e) {
  const { Box, Text, Button } = $.ui.resolve(e)
  let n = 0
  const children = impactRows().map((r) => {
    if (!r.dep) return Box({ flexDirection: 'column', paddingLeft: r.depth * 2, children: [Text({ dimColor: r.dim === true, children: [r.text] })] })
    const i = n++, { head, loc, tail } = r.dep
    const copy = (press) => (loc ? $.ui.copy({ text: loc, surface: press.surface }) : undefined)
    return Box({
      flexDirection: 'row', columnGap: 1, paddingLeft: r.depth * 2,
      children: [
        Button({ key: `dep:${i}`, label: head, plain: true, onPress: copy }),
        Text({ children: [loc ?? 'external'] }),
        Text({ dimColor: true, children: [tail] }),
        Button({ key: `open:${i}`, label: 'open', onPress: copy }),
      ],
    })
  })
  return Box({ flexDirection: 'column', children })
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    draws = e.surface !== null
    // Not awaited, so the session starts at once; a session with nothing to draw on looks only when /pm-status asks.
    if (draws) $.clock.after(0, () => start($))
    try {
      await $.command.register({ name: 'pm-status', description: "Show the Proofmesh snapshot's state for this repository, at once and without a model turn", immediate: true })
      await $.command.register({ name: 'pm-trail', description: 'Show what this session searched, opened, changed and claimed, and the dependents of its changes it never opened', immediate: true })
      await $.command.register({ name: 'pm-impact', description: "Open or close a pane with the symbols this session changed, their dependents and the tests that reach them", immediate: true })
    } catch {}
    return next(e)
  })

  // Passes the call on first, so no ProofMesh call delays it; an edit only marks the line behind, and the next poll reads the rest.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    idle = 0
    try {
      if (EDITS.has(e.tool) && result.deny === undefined && result.isError !== true) await noteEdit($, e, result)
      // Only Claude's calls: this module's own MCP calls (/pm-trail's, /pm-status's) reach this hook too, from the plugin.
      if (recording && next.origin.plugin === 'engine') await noteTrail($, e, result)
    } catch {}
    return result
  })

  // One process a flush, after the turn and not during it.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (trail.length) $.clock.after(0, () => flush($))
    return result
  })

  on('session.end', async ($, e, next) => {
    await flush($)
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    idle = 0
    return next(e)
  })

  on('command.run', { command: 'pm-status' }, async ($) => {
    idle = 0
    const first = ready === undefined
    await look($)
    if (!repo) return { text, isTextDisplayOnly: true }
    // The state may be older than the last poll, or there is no poll at all without a surface.
    if (!first) await refresh($)
    const lines = [await line($), `repository ${repo.name} (${repo.id}) at ${repo.root}${published ? `, snapshot published ${age((await $.clock.now()) - published)} ago` : ''}`, `files edited since: ${edited.size ? [...edited].join(', ') : 'none'}`]
    try {
      const r = await proofmesh($, ['status', repo.id])
      lines.push(...(r.exitCode === 0 ? r.stdout.split('\n').filter((l) => /^(index job |adapters available|snapshot )/.test(l)) : [lastLine(r.stderr)]))
    } catch (err) {
      lines.push(`proofmesh status failed: ${why(err)}`)
    }
    return { text: lines.join('\n'), isTextDisplayOnly: true }
  })

  on('command.run', { command: 'pm-trail' }, async ($) => {
    idle = 0
    const first = ready === undefined
    await look($)
    const say = (answer) => ({ text: answer, isTextDisplayOnly: true })
    if (!repo) return say(`session trail: off (${text})`)
    // Whether recording is on is read again, as /pm-status reads the state, so turning it on shows here at once.
    if (!first) await refresh($)
    if (!recording) return say(`session trail: recording is off for ${repo.name} (${repo.id}); turn it on with: proofmesh trail on ${repo.id}`)
    // What the module still holds goes first, so the answer covers it.
    await flush($)
    try {
      return say(trailText(await callTool($, 'get_session_trail', { repository_id: repo.id, session_id: await $.session.id(), envelope: 'compact' })))
    } catch (err) {
      return say(`session trail: unknown (${why(err)})`)
    }
  })

  on('command.run', { command: 'pm-impact' }, async ($) => {
    idle = 0
    try {
      if (draws) {
        const open = (await $.ui.panes()).some((p) => p.id === PANE)
        await (open ? $.ui.close({ id: PANE }) : $.ui.open({ id: PANE, title: 'Impact' }))
        return {}
      }
      // No surface draws the pane: the same rows as text, read now, as /pm-status reads the state.
      const first = ready === undefined
      await look($)
      if (repo && touched.size) {
        if (!first) await refresh($)
        if (stale()) await update($)
      }
    } catch {}
    return { text: impactRows().map(rowText).join('\n'), isTextDisplayOnly: true }
  })

  // Drawn only while the pane is open; a drawing that finds the answer out of date asks again after it, never holding the draw.
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    // Asked again when the timer runs: a second drawing before it may have set one off already.
    if (stale() && !analysing) $.clock.after(0, () => stale() && update($))
    return drawPane($, e)
  })
}
