#!/usr/bin/env node
// A13: keeps the Proofmesh snapshot fresh while an agent edits. `edited` (after Edit or Write) and `session` (at start, when the
// working tree differs from the snapshot) record the change and make sure one background runner per repository will index it
// once the edits go quiet. The runner holds a lock file, so concurrent hooks never start two indexes of one repository.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deepestRoot } from './repos.mjs'

const QUIET_MS = Number(process.env.PROOFMESH_HOOK_QUIET_MS ?? 4000)
const STATE = process.env.PROOFMESH_HOOK_STATE ?? path.join(os.tmpdir(), `proofmesh-hooks-${os.userInfo().uid}`)
const INSTALL = 'git clone https://github.com/QuintinBotes/proofmesh && cd proofmesh && pnpm install --frozen-lockfile && pnpm build && cd packages/proofmesh && npm link'
let installed = true
const proofmesh = (args) => { const r = spawnSync('proofmesh', args, { encoding: 'utf8' }); if (r.error?.code === 'ENOENT') installed = false; return r }
const file = (id, kind) => path.join(STATE, `${id}.${kind}`)
// `toPerson` also shows the line to the person (systemMessage); additionalContext alone reaches only Claude.
const say = (event, text, toPerson) => process.stdout.write(JSON.stringify({ ...(toPerson && { systemMessage: text }), hookSpecificOutput: { hookEventName: event, additionalContext: text } }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The registered repository whose root holds `target`, the deepest when roots nest; null when Proofmesh is absent or none does. */
function repositoryOf(target) {
  const r = proofmesh(['repo', 'list'])
  if (r.error || r.status !== 0) return null
  let real = target
  try { real = fs.realpathSync(target) } catch { try { real = path.join(fs.realpathSync(path.dirname(target)), path.basename(target)) } catch {} }
  return deepestRoot(r.stdout, real, path.sep)
}

function alive(id) {
  try { process.kill(Number(fs.readFileSync(file(id, 'lock'), 'utf8')), 0); return true } catch { return false }
}

/** Records an edit now and starts a runner unless one is alive; true when this call started it. */
function touch(id, at = Date.now()) {
  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(file(id, 'edited'), String(at))
  if (alive(id)) return false
  spawn(process.execPath, [new URL(import.meta.url).pathname, 'run', id], { detached: true, stdio: 'ignore', env: process.env }).unref()
  return true
}

function lock(id) {
  try { fs.writeFileSync(file(id, 'lock'), String(process.pid), { flag: 'wx' }); return true } catch {}
  if (alive(id)) return false
  fs.rmSync(file(id, 'lock'), { force: true })
  try { fs.writeFileSync(file(id, 'lock'), String(process.pid), { flag: 'wx' }); return true } catch { return false }
}

async function run(id) {
  const edited = () => Number(fs.readFileSync(file(id, 'edited'), 'utf8'))
  while (lock(id)) {
    let started
    try {
      for (let wait = edited() + QUIET_MS - Date.now(); wait > 0; wait = edited() + QUIET_MS - Date.now()) await sleep(wait)
      started = Date.now()
      const r = proofmesh(['index', id])
      fs.appendFileSync(file(id, 'log'), `${new Date().toISOString()} index exit ${r.status}\n${r.stdout}${r.stderr}`)
    } finally {
      fs.rmSync(file(id, 'lock'), { force: true })
    }
    // An edit that landed while indexing, or between the last check and releasing the lock, needs one more pass.
    if (edited() < started) return
  }
}

const mode = process.argv[2]
if (mode === 'run') await run(process.argv[3])
else {
  let input = {}
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch {}
  if (mode === 'edited') {
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path
    const repo = target && repositoryOf(path.resolve(input.cwd ?? process.cwd(), target))
    if (repo && touch(repo.id)) say('PostToolUse', `Proofmesh is re-indexing ${repo.name} in the background after this edit. Until the new snapshot is published, answers are as of the previous one; ask with freshness "strict" when an answer must match the working tree.`)
  } else if (mode === 'session') {
    const repo = repositoryOf(input.cwd ?? process.cwd())
    const r = repo && proofmesh(['status', repo.id, '--fresh', '--json'])
    // The last index job when it failed, in the words `proofmesh status` uses (FR873), so Claude does not index as if nothing was tried.
    const failed = (j) => (j?.state ? `last index job ${j.id} ${j.state}${j.finished_at ? ` at ${j.finished_at}` : ''}${j.error ? `: ${j.error}` : ''}` : '')
    if (!installed) say('SessionStart', `proofmesh: not installed. The Proofmesh plugin's MCP server and hooks need the proofmesh CLI on PATH; install it: ${INSTALL}`, true)
    else if (repo && r.status !== 0) {
      let d
      try { d = JSON.parse(r.stdout).error.details } catch {}
      const why = failed(d && { id: d.job_id, state: d.job_state, finished_at: d.job_finished_at, error: d.job_error })
      say('SessionStart', `Proofmesh has ${repo.name} registered but no published snapshot of it${why ? `; ${why}` : ''}; run /proofmesh:index before asking it anything.`)
    }
    else if (repo) {
      const f = JSON.parse(r.stdout)
      const why = failed(f.failed_job) ? ` Its ${failed(f.failed_job)}.` : ''
      if (f.current) say('SessionStart', `Proofmesh's snapshot ${f.snapshot_id} of ${repo.name} matches the working tree.${why}`)
      else {
        touch(repo.id, Date.now() - QUIET_MS)
        say('SessionStart', `Proofmesh's snapshot ${f.snapshot_id} of ${repo.name} is behind the working tree: ${f.changed_count} files changed. A background index has started; until it publishes, answers are as of that snapshot.${why}`)
      }
    }
  }
}
