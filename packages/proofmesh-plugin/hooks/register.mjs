// The plugin's hooks module (#113, FR480 to FR487), loaded by Claude Code 2.1.287 and later: the snapshot's state for the session's
// repository as a status line under the prompt, and /pm-status, which answers at once with no model turn. It only watches: fresh.mjs
// still records edits and runs the debounced index, and this module sees that index through the job row and the snapshot it publishes.
// The session trail (#114, FR610 to FR615): where a person ran `proofmesh trail on`, it records the paths and symbol ids the session's
// tools searched, opened, changed and claimed, never their text, hands them to `proofmesh trail record` at each turn's end, and /pm-trail shows them.
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
  const body = r.structuredContent ?? JSON.parse(r.content.find((c) => c.type === 'text')?.text ?? '{}')
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

async function noteEdit($, e) {
  const target = e.file_path ?? e.notebook_path
  if (!repo || typeof target !== 'string') return
  const path = await inRepository($, target)
  if (path === null || path === '.') return
  edited.add(path)
  edits++
  await show($, kind === 'current' || !kind ? 'behind' : kind, text)
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
  trail.push({
    session_id: await $.session.id(), repository_id: repo.id, ...(e.agentId ? { agent_id: e.agentId } : {}), at: new Date(await $.clock.now()).toISOString(),
    kind: step, tool: e.tool, ...subject, outcome: result.deny === undefined && result.isError !== true ? 'ok' : 'failed',
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

export function register(on) {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    draws = e.surface !== null
    // Not awaited, so the session starts at once; a session with nothing to draw on looks only when /pm-status asks.
    if (draws) $.clock.after(0, () => start($))
    try {
      await $.command.register({ name: 'pm-status', description: "Show the Proofmesh snapshot's state for this repository, at once and without a model turn", immediate: true })
      await $.command.register({ name: 'pm-trail', description: 'Show what this session searched, opened, changed and claimed, and the dependents of its changes it never opened', immediate: true })
    } catch {}
    return next(e)
  })

  // Passes the call on first, so no ProofMesh call delays it; an edit only marks the line behind, and the next poll reads the rest.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    idle = 0
    try {
      if (EDITS.has(e.tool) && result.deny === undefined && result.isError !== true) await noteEdit($, e)
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
}
