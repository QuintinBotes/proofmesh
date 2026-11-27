// The plugin's hooks module (#113, FR480 to FR487), loaded by Claude Code 2.1.287 and later: the snapshot's state for the session's
// repository as a status line under the prompt, and /pm-status, which answers at once with no model turn. It only watches: fresh.mjs
// still records edits and runs the debounced index, and this module sees that index through the job row and the snapshot it publishes.
import { deepestRoot } from './repos.mjs'

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const POLL_MS = 5000
const IDLE_POLLS = (10 * 60_000) / POLL_MS

let cwd = '', draws = false, ready, repo = null
let kind = '', text = '', snapshot = null, published = 0, changed = 0
const edited = new Set()
let edits = 0, idle = 0, busy = false, queue = Promise.resolve(), shown

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const age = (ms) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`)
// The engine prefixes a refused call's message with where it failed; the last part says why.
const why = (err) => String(err?.message ?? err).split(': ').pop()
const firstLine = (s) => s.trim().split('\n')[0] || 'no output'

/** Runs `proofmesh <args>`, one at a time for the whole module. */
function proofmesh($, args) {
  const run = queue.then(() => $.process.run(['proofmesh', ...args]))
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
    if (f.exitCode !== 0) return await (f.stderr.includes('SNAPSHOT_UNAVAILABLE') ? show($, 'missing') : show($, 'unknown', `unknown (${firstLine(f.stderr)})`))
    const fresh = JSON.parse(f.stdout)
    const status = await callTool($, 'workspace_status', { repository_id: repo.id })
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

/** Finds the repository and its state once; the timer then keeps the line current. */
async function init($) {
  try {
    const listed = await proofmesh($, ['repo', 'list'])
    if (listed.exitCode !== 0) return await show($, 'unknown', `unknown (${firstLine(listed.stderr)})`)
    const real = (await $.fs.stat(cwd, { resolve: true }).catch(() => undefined))?.realPath ?? cwd
    repo = deepestRoot(listed.stdout, real, cwd.includes('\\') ? '\\' : '/')
  } catch (err) {
    return await show($, 'unknown', /failed to start/.test(String(err?.message)) ? 'not installed' : `unknown (${why(err)})`)
  }
  if (!repo) return await show($, 'not registered here')
  await refresh($)
  if (draws) $.clock.every(POLL_MS, () => tick($))
}

async function tick($) {
  if (kind !== 'current' && idle++ < IDLE_POLLS) await refresh($)
  else if (kind === 'current') await show($, 'current')
}

const look = ($) => (ready ??= init($))

async function noteEdit($, e) {
  const target = e.file_path ?? e.notebook_path
  if (!repo || typeof target !== 'string') return
  const absolute = /^([/\\]|[A-Za-z]:)/.test(target) ? target : `${cwd}/${target}`
  const real = (await $.fs.stat(absolute, { resolve: true }).catch(() => undefined))?.realPath ?? absolute
  if (!real.startsWith(repo.root) || !/^[/\\]/.test(real.slice(repo.root.length))) return
  edited.add(real.slice(repo.root.length + 1))
  edits++
  await show($, kind === 'current' || !kind ? 'behind' : kind, text)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    draws = e.surface !== null
    // Not awaited, so the session starts at once; a session with nothing to draw on looks only when /pm-status asks.
    if (draws) $.clock.after(0, () => look($))
    try {
      await $.command.register({ name: 'pm-status', description: "Show the Proofmesh snapshot's state for this repository, at once and without a model turn", immediate: true })
    } catch {}
    return next(e)
  })

  // Passes the call on first, so no ProofMesh call delays it; an edit only marks the line behind, and the next poll reads the rest.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    idle = 0
    try {
      if (EDITS.has(e.tool) && result.deny === undefined && result.isError !== true) await noteEdit($, e)
    } catch {}
    return result
  })

  on('prompt.submit', ($, e, next) => {
    idle = 0
    return next(e)
  })

  on('command.run', { command: 'pm-status' }, async ($) => {
    idle = 0
    await look($)
    if (!repo) return { text, isTextDisplayOnly: true }
    const lines = [await line($), `repository ${repo.name} (${repo.id}) at ${repo.root}${published ? `, snapshot published ${age((await $.clock.now()) - published)} ago` : ''}`, `files edited since: ${edited.size ? [...edited].join(', ') : 'none'}`]
    try {
      const r = await proofmesh($, ['status', repo.id])
      lines.push(...(r.exitCode === 0 ? r.stdout.split('\n').filter((l) => /^(index job |adapters available|snapshot )/.test(l)) : [firstLine(r.stderr)]))
    } catch (err) {
      lines.push(`proofmesh status failed: ${why(err)}`)
    }
    return { text: lines.join('\n'), isTextDisplayOnly: true }
  })
}
