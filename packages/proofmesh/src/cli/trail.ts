// proofmesh trail (#114): the session trail the Claude Code plugin records. Off for every repository until a person turns it on, and
// what is stored is checked here, at the boundary: ids and repository-relative paths only, never source text or a search pattern.
import { ProofmeshError } from '../core/errors.js'
import { Catalog, TRAIL_CAP, type TrailInput } from '../meshstore/catalog.js'

const KINDS = new Set(['searched', 'opened', 'changed', 'claimed'])
const FIELDS = new Set(['session_id', 'repository_id', 'agent_id', 'at', 'kind', 'tool', 'path', 'symbol_id', 'outcome'])
const ID = /^[\w.:@+-]{1,200}$/

/** One stdin line as an entry, or why it is refused: a field that is not a short id, a path or a time is never stored. */
function entry(line: string, n: number): TrailInput {
  const bad = (why: string) => new ProofmeshError('INVALID_ARGUMENT', `trail record line ${n}: ${why}; nothing was recorded`)
  let e: Record<string, unknown>
  try { e = JSON.parse(line) } catch { throw bad('not JSON') }
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw bad('not an object')
  const extra = Object.keys(e).filter((k) => !FIELDS.has(k))
  if (extra.length) throw bad(`unknown field ${extra.join(', ')}`)
  for (const k of ['session_id', 'repository_id', 'tool'] as const) if (typeof e[k] !== 'string' || !ID.test(e[k] as string)) throw bad(`${k} must be an id`)
  if (e.agent_id !== undefined && (typeof e.agent_id !== 'string' || !ID.test(e.agent_id))) throw bad('agent_id must be an id')
  if (typeof e.at !== 'string' || e.at.length > 40 || Number.isNaN(Date.parse(e.at))) throw bad('at must be a time')
  if (!KINDS.has(e.kind as string)) throw bad('kind must be searched, opened, changed or claimed')
  if (e.outcome !== 'ok' && e.outcome !== 'failed') throw bad('outcome must be ok or failed')
  if (e.symbol_id !== undefined && (typeof e.symbol_id !== 'string' || e.symbol_id.length > 500 || /[\s\0-\x1f]/.test(e.symbol_id))) throw bad('symbol_id must be a symbol id')
  if (e.path !== undefined) {
    const p = e.path
    if (typeof p !== 'string' || p === '' || p.length > 1024 || /[\0-\x1f]/.test(p) || /^([/\\]|[A-Za-z]:)/.test(p) || p.split(/[/\\]/).includes('..')) throw bad('path must be relative to the repository root, inside it')
  }
  if (e.path !== undefined && e.symbol_id !== undefined) throw bad('an entry names a path or a symbol id, not both')
  return e as TrailInput
}

export async function runTrail(dataDir: string, rest: string[], take: (args: string[], flag: string) => string | undefined): Promise<number> {
  const opts = [...rest], sub = opts.shift()
  const catalog = Catalog.open(dataDir)
  try {
    if ((sub === 'on' || sub === 'off') && opts[0]) {
      const repo = catalog.repository(opts[0])
      catalog.setTrailRecording(repo.id, sub === 'on')
      console.log(sub === 'on'
        ? `session trail on for ${repo.name} (${repo.id}): the Claude Code plugin records the repository-relative paths and symbol ids its sessions search, open, change and claim, never source text; proofmesh trail off ${repo.id} stops it, proofmesh trail purge deletes what was recorded`
        : `session trail off for ${repo.name} (${repo.id}); what was recorded stays until proofmesh trail purge or gc`)
      return 0
    }
    if (sub === 'record') {
      // Streamed: a synchronous read of a large piped stdin fails with EAGAIN.
      let text = ''
      process.stdin.setEncoding('utf8')
      for await (const chunk of process.stdin) text += chunk
      const lines = text.split('\n').filter((l) => l.trim())
      const r = catalog.recordTrail(lines.map((l, i) => entry(l, i + 1)))
      const refused = [...new Set(r.refused)]
      console.log(`recorded ${r.recorded} entries${r.dropped ? `; dropped ${r.dropped} past the cap of ${TRAIL_CAP} a session` : ''}${refused.length ? `; refused ${r.refused.length}: recording is off for ${refused.join(', ')}` : ''}`)
      return 0
    }
    if (sub === 'purge') {
      const session = take(opts, '--session')
      if (opts.length || (rest.includes('--session') && !session)) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh trail purge [--session <id>]')
      console.log(`deleted ${catalog.purgeTrail(session)} trail entries`)
      return 0
    }
    throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh trail on <repo> | trail off <repo> | trail record (JSON lines on stdin) | trail purge [--session <id>]')
  } finally {
    catalog.close()
  }
}
