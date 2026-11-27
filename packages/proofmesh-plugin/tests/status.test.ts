// The plugin's hooks module (#113): the snapshot state under the prompt and /pm-status. Run with `claude plugin test packages/proofmesh-plugin`.
import { expect, mock, test } from 'claude-code/testing'

const LIST = 'repo_outer  work  /work\nrepo_app  app  /work/app\n'
const PUBLISHED = Date.parse('2026-11-27T10:00:00.000Z')
const NOW = PUBLISHED + 5 * 60_000
const STATUS = [
  'adapters available: typescript, build; unavailable: csharp (not built: looked in /opt/csharp)',
  'snapshot snap_1 (no_execution) of commit abc123 (main), published 2026-11-27T10:00:00.000Z',
  'files 10: indexed 7, excluded 1, unsupported 2, failed 0, pending 0',
].join('\n')

type Run = { exitCode: number; stdout: string; stderr: string }
type World = { list?: Run | string | ((n: number) => Run | string); fresh?: (n: number) => Run | string; jobs?: () => unknown[]; snapshot?: () => { id: string; published: number }; slow?: number; surface?: 'terminal' | null; cwd?: string }

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })
const fresh = (current: boolean, snapshot = 'snap_1', changed = 0) => ok(JSON.stringify({ repository_id: 'repo_app', name: 'app', snapshot_id: snapshot, current, changed_count: changed, changed: [] }))

/** Stubs every mods API call the module makes, as a session in /work/app/src would answer them. A string answer makes the call reject with it. */
function world(on: Parameters<Parameters<typeof test>[1]>[1], w: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  const lines: Array<string | undefined> = [], runs: string[][] = [], mcp: unknown[] = [], registered: unknown[] = [], log: string[] = []
  let running = 0, most = 0, freshCalls = 0, listCalls = 0
  on('session.start', () => ({ cwd: w.cwd ?? '/work/app/src' }))
  on('command.register', ($, e) => { registered.push(e); return { value: undefined } })
  on('ui.status', ($, e) => { lines.push(e.text); return { value: undefined } })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', async ($, e) => {
    runs.push([...e.argv]); log.push(`process ${e.argv.slice(1, 3).join(' ')}`)
    most = Math.max(most, ++running)
    try {
      if (w.slow) await clock.sleep(w.slow)
      const [, cmd, , flag] = e.argv
      const r = cmd === 'repo' ? (typeof w.list === 'function' ? w.list(listCalls++) : w.list ?? ok(LIST)) : flag === '--fresh' ? (w.fresh ?? (() => fresh(true)))(freshCalls++) : ok(STATUS)
      return typeof r === 'string' ? { deny: r } : { value: r }
    } finally { running-- }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:proofmesh:proofmesh' } }))
  on('mcp.call', ($, e) => {
    mcp.push(e)
    const s = w.snapshot?.() ?? { id: 'snap_1', published: PUBLISHED }
    const envelope = { snapshot: { id: s.id, analysis_mode: 'no_execution', published_at: new Date(s.published).toISOString(), commit: 'abc123' }, data: { jobs: w.jobs?.() ?? [] } }
    return { value: { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: false, structuredContent: envelope } }
  })
  on('tool.call', () => { log.push('tool ran'); return { result: 'ok' } })
  return { clock, lines, runs, mcp, registered, log, most: () => most, line: () => lines.at(-1) }
}

const start = async ($: Parameters<Parameters<typeof test>[1]>[0], w: { clock: { settle: () => Promise<void> } }, surface: 'terminal' | null = 'terminal') => {
  await $.session.start({ surface, isInteractive: surface !== null, cwd: '/work/app/src' })
  await w.clock.settle()
}

test('FR481 scenario 1: at session start in a registered repository with a current snapshot, the line reads current <snapshot id> (<age>), from the deepest root', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.line()).toBe('current snap_1 (5m)')
  expect(w.runs).toEqual([['proofmesh', 'repo', 'list'], ['proofmesh', 'status', 'repo_app', '--fresh', '--json']])
  // A compact envelope, so the module's call does not use up the full envelope the agent's first answer from this snapshot gets over the same connection.
  expect(w.mcp).toEqual([{ server: 'plugin:proofmesh:proofmesh', tool: 'workspace_status', args: { repository_id: 'repo_app', envelope: 'compact' } }])
  // While current, the age keeps up, and the tree is checked once a minute only.
  await w.clock.advance(55_000)
  expect(w.line()).toBe('current snap_1 (5m)')
  expect(w.runs).toHaveLength(2)
  await w.clock.advance(5000)
  expect(w.line()).toBe('current snap_1 (6m)')
  expect(w.runs.slice(2)).toEqual([['proofmesh', 'status', 'repo_app', '--fresh', '--json']])
})

test('FR482: a change made without an edit tool (a branch switch, an IDE) moves the line off current within a minute', async ($, on) => {
  const w = world(on, { fresh: (n) => (n === 0 ? fresh(true) : fresh(false, 'snap_1', 3)) })
  await start($, w)
  expect(w.line()).toBe('current snap_1 (5m)')
  await w.clock.advance(60_000)
  expect(w.line()).toBe('behind (3 files changed)')
})

test('FR482 scenario 2: an Edit to a tracked file makes the line read behind (1 file edited), and current again within one poll once the debounced index publishes', async ($, on) => {
  let published = false
  const w = world(on, { fresh: (n) => fresh(n === 0 || published, published ? 'snap_2' : 'snap_1'), snapshot: () => (published ? { id: 'snap_2', published: NOW + 2000 } : { id: 'snap_1', published: PUBLISHED }) })
  await start($, w)
  expect(w.line()).toBe('current snap_1 (5m)')
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' })
  expect(w.line()).toBe('behind (1 file edited)')
  // A Read, or an edit outside the repository, changes nothing.
  await $.tool.call({ tool: 'Read', file_path: '/work/app/src/b.ts' })
  await $.tool.call({ tool: 'Write', file_path: '/elsewhere/c.ts', content: 'x' })
  expect(w.line()).toBe('behind (1 file edited)')
  await w.clock.advance(5000)
  expect(w.line()).toBe('behind (1 file edited)')
  published = true
  await w.clock.advance(5000)
  expect(w.line()).toBe('current snap_2 (8s)')
})

test('FR482 scenario 3: while an index runs, the line reads indexing with the stage proofmesh status reports', async ($, on) => {
  let jobs: unknown[] = [{ id: 'job_1', state: 'running', phase: 'analyse', done: 3, total: 10 }]
  const w = world(on, { fresh: () => fresh(false, 'snap_1', 2), jobs: () => jobs })
  await start($, w)
  expect(w.line()).toBe('indexing analyse 3/10')
  jobs = [{ id: 'job_1', state: 'running', phase: 'publish', done: null, total: null }]
  await w.clock.advance(5000)
  expect(w.line()).toBe('indexing publish')
  jobs = []
  await w.clock.advance(5000)
  expect(w.line()).toBe('behind (2 files changed)')
})

test('FR482: a registered repository with no published snapshot reads missing', async ($, on) => {
  const w = world(on, { fresh: () => ({ exitCode: 1, stdout: '', stderr: 'proofmesh: SNAPSHOT_UNAVAILABLE: no published snapshot for this repository; run "proofmesh index" first\n' }) })
  await start($, w)
  expect(w.line()).toBe('missing')
  expect(w.mcp).toEqual([])
})

test('FR483 scenario 4: outside every registered repository the line reads not registered here, and no other hook calls ProofMesh', async ($, on) => {
  const w = world(on, { cwd: '/elsewhere' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/elsewhere' })
  await w.clock.settle()
  expect(w.line()).toBe('not registered here')
  await $.tool.call({ tool: 'Edit', file_path: '/elsewhere/a.ts', old_string: 'a', new_string: 'b' })
  await w.clock.advance(60_000)
  expect((await $.command.run({ command: 'pm-status', args: '' })).text).toBe('not registered here')
  expect(w.runs).toEqual([['proofmesh', 'repo', 'list']])
  expect(w.mcp).toEqual([])
})

test('FR483 scenario 4: without proofmesh on PATH the line reads not installed, and no other hook calls ProofMesh', async ($, on) => {
  const w = world(on, { list: 'proofmesh: $.process.run(proofmesh) failed to start: ENOENT: Executable not found in $PATH: "proofmesh"' })
  await start($, w)
  expect(w.line()).toBe('not installed')
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' })
  await w.clock.advance(60_000)
  expect((await $.command.run({ command: 'pm-status', args: '' })).text).toBe('not installed')
  expect(w.runs).toEqual([['proofmesh', 'repo', 'list']])
  expect(w.mcp).toEqual([])
})

test('FR484 scenario 5 and SC-002: /pm-status answers at once with no turn, for the person only, naming the repository, snapshot, commit, mode, age, files edited and unavailable adapters', async ($, on) => {
  const w = world(on, { fresh: (n) => fresh(n === 0) })
  let turns = 0
  on('turn.start', ($, e) => { turns++; return { turnId: e.turnId } })
  await start($, w)
  expect(w.registered).toEqual([{ name: 'pm-status', description: expect.any(String), immediate: true }, { name: 'pm-trail', description: expect.any(String), immediate: true }])
  await $.tool.call({ tool: 'MultiEdit', file_path: '/work/app/src/a.ts', edits: [] })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/app/notes.ipynb', new_source: 'x' })
  const answer = await $.command.run({ command: 'pm-status', args: '' })
  expect(answer.isTextDisplayOnly).toBe(true)
  expect(answer.text).toBe([
    'behind (2 files edited)',
    'repository app (repo_app) at /work/app, snapshot published 5m ago',
    'files edited since: src/a.ts, notes.ipynb',
    'adapters available: typescript, build; unavailable: csharp (not built: looked in /opt/csharp)',
    'snapshot snap_1 (no_execution) of commit abc123 (main), published 2026-11-27T10:00:00.000Z',
  ].join('\n'))
  expect(w.runs.at(-1)).toEqual(['proofmesh', 'status', 'repo_app'])
  expect(turns).toBe(0)
})

test('FR485: a proofmesh call that fails or times out reads unknown (<reason>), and the tool call it observed goes on unchanged', async ($, on) => {
  const w = world(on, { fresh: (n) => (n === 0 ? fresh(true) : 'proofmesh: $.process.run(proofmesh) aborted: still running after 30000ms') })
  await start($, w)
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' })
  expect(edit).toEqual({ result: 'ok' })
  await w.clock.advance(5000)
  expect(w.line()).toBe('unknown (still running after 30000ms)')
})

test('FR485: a failed call reads the error proofmesh printed last, not a warning before it', async ($, on) => {
  const w = world(on, { fresh: () => ({ exitCode: 2, stdout: '', stderr: 'warning: repo_app root /work/app is under a temporary directory and may disappear\nproofmesh: NOT_FOUND: repository repo_app is not registered\n' }) })
  await start($, w)
  expect(w.line()).toBe('unknown (proofmesh: NOT_FOUND: repository repo_app is not registered)')
})

test('FR485: a repo list that fails at session start is asked again by the next poll', async ($, on) => {
  const w = world(on, { list: (n) => (n === 0 ? 'proofmesh: $.process.run(proofmesh) aborted: still running after 30000ms' : ok(LIST)) })
  await start($, w)
  expect(w.line()).toBe('unknown (still running after 30000ms)')
  await w.clock.advance(5000)
  expect(w.line()).toBe('current snap_1 (5m)')
})

test('FR485 SC-003: the tool.call hook passes the call on before it starts any process', async ($, on) => {
  const w = world(on, { fresh: (n) => fresh(n === 0) })
  await start($, w)
  w.log.length = 0
  await $.tool.call({ tool: 'Write', file_path: '/work/app/src/new.ts', content: 'x' })
  expect(w.log).toEqual(['tool ran'])
  await w.clock.advance(5000)
  expect(w.log).toEqual(['tool ran', 'process status repo_app'])
})

test('FR487: at most one proofmesh process at a time, none while the session is idle over 10 minutes, and nothing drawn without a surface', async ($, on) => {
  const w = world(on, { fresh: () => fresh(false, 'snap_1', 1), slow: 3000 })
  await start($, w)
  await w.clock.advance(3000)
  const asked = $.command.run({ command: 'pm-status', args: '' })
  await w.clock.advance(20_000)
  expect((await asked).text).toMatch(/^behind \(1 file changed\)\n/)
  expect(w.most()).toBe(1)
  // Ten idle minutes later the polls stop, and the next tool call starts them again.
  await w.clock.advance(10 * 60_000)
  const idle = w.runs.length
  await w.clock.advance(5 * 60_000)
  expect(w.runs.length).toBe(idle)
  await $.tool.call({ tool: 'Read', file_path: '/work/app/src/a.ts' })
  await w.clock.advance(10_000)
  expect(w.runs.length).toBeGreaterThan(idle)
})

test('FR487: a session with no surface draws nothing and runs nothing until /pm-status is asked', async ($, on) => {
  const w = world(on)
  await start($, w, null)
  await w.clock.advance(60_000)
  expect(w.runs).toEqual([])
  expect((await $.command.run({ command: 'pm-status', args: '' })).text).toMatch(/^current snap_1 \(6m\)\nrepository app \(repo_app\)/)
  expect(w.lines).toEqual([])
})

test('FR484: in a session with no surface, each /pm-status reads the state again, so an index published since the last one shows', async ($, on) => {
  let tree: 'current' | 'edited' | 'published' = 'current'
  const w = world(on, { fresh: () => fresh(tree !== 'edited', tree === 'published' ? 'snap_2' : 'snap_1'), snapshot: () => (tree === 'published' ? { id: 'snap_2', published: NOW } : { id: 'snap_1', published: PUBLISHED }) })
  const status = async () => (await $.command.run({ command: 'pm-status', args: '' })).text
  await start($, w, null)
  expect(await status()).toMatch(/^current snap_1 \(5m\)\n/)
  tree = 'edited'
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' })
  expect(await status()).toMatch(/^behind \(1 file edited\)\n/)
  tree = 'published'
  expect(await status()).toMatch(/^current snap_2 \(0s\)\n.*\nfiles edited since: none\n/)
})
