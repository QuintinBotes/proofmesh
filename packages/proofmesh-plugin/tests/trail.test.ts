// The session trail (#114): the hooks module records which files and symbols a session searched, opened, changed and claimed,
// only where a person turned recording on, and /pm-trail shows it. Run with `claude plugin test packages/proofmesh-plugin`.
import { expect, mock, test } from 'claude-code/testing'

const LIST = 'repo_app  app  /work/app\n'
const NOW = Date.parse('2026-11-27T10:00:00.000Z')
const SESSION = '2f6c1d9e-session-one'
const FIND = 'mcp__plugin_proofmesh_proofmesh__find_symbols'
const VERIFY = 'mcp__plugin_proofmesh_proofmesh__verify_claim'

type Run = { exitCode: number; stdout: string; stderr: string }
type On = Parameters<Parameters<typeof test>[1]>[1]
type Dollar = Parameters<Parameters<typeof test>[1]>[0]

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })

/**
 * Stubs what Claude Code and ProofMesh answer for a session in /work/app/src, with trail recording on or off for the repository; `shell`
 * is the directory a Bash `cd` left the session in.
 */
function world(on: On, w: { recording?: boolean; list?: Run | string; trail?: object; tool?: (e: { tool: string }) => object; shell?: string; missing?: string[] } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const runs: Array<{ argv: string[]; stdin?: string }> = [], mcp: Array<{ tool: string; args: Record<string, unknown> }> = []
  on('session.start', () => ({ cwd: '/work/app/src' }))
  on('session.cwd', () => ({ value: w.shell ?? '/work/app/src' }))
  on('session.end', () => ({ sessionId: SESSION }))
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: SESSION }))
  on('command.register', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.stat', ($, e) => (w.missing?.includes(e.path) ? { deny: 'ENOENT: no such file or directory' } : { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', ($, e) => {
    runs.push({ argv: [...e.argv], ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}) })
    const [, cmd, , flag] = e.argv
    if (cmd === 'repo') return typeof w.list === 'string' ? { deny: w.list } : { value: w.list ?? ok(LIST) }
    if (cmd === 'trail') return { value: ok('recorded\n') }
    if (flag === '--fresh') return { value: ok(JSON.stringify({ repository_id: 'repo_app', name: 'app', snapshot_id: 'snap_1', current: true, changed_count: 0, changed: [], trail_recording: w.recording ?? false })) }
    return { value: ok('') }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:proofmesh:proofmesh' } }))
  on('mcp.call', ($, e) => {
    mcp.push({ tool: e.tool, args: e.args })
    const envelope = e.tool === 'get_session_trail' ? w.trail : { snapshot: { id: 'snap_1', analysis_mode: 'no_execution', published_at: new Date(NOW).toISOString(), commit: 'abc123' }, data: { jobs: [] } }
    return { value: { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: false, structuredContent: envelope } }
  })
  on('tool.call', (_$, e) => w.tool?.(e) ?? { result: 'ok' })
  const recorded = () => runs.filter((r) => r.argv[1] === 'trail')
  const entries = () => recorded().flatMap((r) => r.stdin!.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>))
  return { clock, runs, mcp, recorded, entries }
}

async function start($: Dollar, w: { clock: { settle: () => Promise<void> } }) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app/src' })
  await w.clock.settle()
}

async function endTurn($: Dollar, w: { clock: { settle: () => Promise<void> } }) {
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1, isAborted: false, usage: null })
  await w.clock.settle()
}

/** Scenario 2's session: Grep for formatAmount, Read currency.ts, find_symbols, Edit currency.ts, verify_claim. */
async function scenario($: Dollar) {
  await $.tool.call({ tool: 'Grep', pattern: 'formatAmount', path: '/work/app/packages/billing' })
  await $.tool.call({ tool: 'Read', file_path: '/work/app/packages/format/src/currency.ts' })
  await $.tool.call({ tool: FIND, text: 'formatAmount' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/packages/format/src/currency.ts', old_string: 'toFixed(2)', new_string: 'toFixed(3)' })
  await $.tool.call({ tool: VERIFY, claim: { statement: 'formatAmount is only called by invoiceTotal', proposition: { type: 'relationship', source: 'sym_invoice', relationship: 'calls', target: 'sym_format' } } })
}

test('FR611 scenario 1 SC-001: with recording off, the default, 100 tool calls record nothing, start no process for the trail, and /pm-trail says how to turn it on', async ($, on) => {
  const w = world(on)
  let turns = 0
  on('turn.start', ($, e) => { turns++; return { turnId: e.turnId } })
  await start($, w)
  for (let i = 0; i < 20; i++) await scenario($)
  await endTurn($, w)
  await $.session.end({ reason: 'other' })
  expect(w.recorded()).toEqual([])
  const answer = await $.command.run({ command: 'pm-trail', args: '' })
  expect(answer).toEqual({ text: 'session trail: recording is off for app (repo_app); turn it on with: proofmesh trail on repo_app', isTextDisplayOnly: true })
  expect(w.recorded()).toEqual([])
  expect(w.mcp.map((c) => c.tool)).not.toContain('get_session_trail')
  expect(turns).toBe(0)
})

test('FR610 scenario 2: with recording on, Grep, Read, find_symbols, Edit and verify_claim make five entries in order, sent at turn end in one process, holding no source text', async ($, on) => {
  const w = world(on, { recording: true })
  await start($, w)
  await scenario($)
  expect(w.recorded()).toEqual([])
  await endTurn($, w)
  expect(w.recorded().map((r) => r.argv)).toEqual([['proofmesh', 'trail', 'record']])
  const at = new Date(NOW).toISOString()
  const base = { session_id: SESSION, repository_id: 'repo_app', at, outcome: 'ok' }
  expect(w.entries()).toEqual([
    { ...base, kind: 'searched', tool: 'Grep', path: 'packages/billing' },
    { ...base, kind: 'opened', tool: 'Read', path: 'packages/format/src/currency.ts' },
    { ...base, kind: 'searched', tool: FIND, path: '.' },
    { ...base, kind: 'changed', tool: 'Edit', path: 'packages/format/src/currency.ts' },
    { ...base, kind: 'claimed', tool: VERIFY, symbol_id: 'sym_invoice' },
  ])
  const sent = w.recorded()[0]!.stdin!
  for (const text of ['formatAmount', 'toFixed', 'only called by']) expect(sent).not.toContain(text)
})

test('FR614 scenario 3: /pm-trail prints the trail and each changed symbol\'s dependents no entry opened, with file:line, at once and with no turn', async ($, on) => {
  const trail = {
    snapshot: { id: 'snap_2', analysis_mode: 'no_execution', published_at: new Date(NOW).toISOString(), commit: 'abc123' },
    data: {
      session_id: SESSION, recording: true, cut: false,
      entries: [
        { seq: 1, at: '2026-11-27T10:00:00.000Z', kind: 'searched', tool: 'Grep', path: 'packages/billing', outcome: 'ok' },
        { seq: 2, at: '2026-11-27T10:00:01.000Z', kind: 'opened', tool: 'Read', path: 'packages/format/src/currency.ts', outcome: 'ok' },
        { seq: 3, at: '2026-11-27T10:00:02.000Z', kind: 'opened', tool: 'Read', path: 'packages/api/src/handler.ts', outcome: 'failed', agent_id: 'a1b2c3' },
        { seq: 4, at: '2026-11-27T10:00:03.000Z', kind: 'changed', tool: 'Edit', path: 'packages/format/src/currency.ts', outcome: 'ok' },
        { seq: 5, at: '2026-11-27T10:00:04.000Z', kind: 'claimed', tool: VERIFY, symbol_id: 'sym_invoice', outcome: 'ok' },
      ],
      changed: [{
        id: 'sym_format', name: 'formatAmount', qualified_name: 'packages/format/src/currency:formatAmount', path: 'packages/format/src/currency.ts', line: 1,
        never_seen: [{ id: 'sym_handle', name: 'handleInvoice', qualified_name: 'packages/api/src/handler:handleInvoice', path: 'packages/api/src/handler.ts', line: 5, depth: 2 }],
        searched_only: [{ id: 'sym_invoice', name: 'invoiceTotal', qualified_name: 'packages/billing/src/invoice:invoiceTotal', path: 'packages/billing/src/invoice.ts', line: 9, depth: 1 }],
      }],
    },
    limitations: ['A search covers the files under the path it searched.'],
  }
  const w = world(on, { recording: true, trail })
  let turns = 0
  on('turn.start', ($, e) => { turns++; return { turnId: e.turnId } })
  await start($, w)
  await $.tool.call({ tool: 'Read', file_path: '/work/app/README.md' })
  const answer = await $.command.run({ command: 'pm-trail', args: '' })
  // What the module still held is sent first, so the answer covers it.
  expect(w.recorded()).toHaveLength(1)
  expect(w.mcp.at(-1)).toEqual({ tool: 'get_session_trail', args: { repository_id: 'repo_app', session_id: SESSION, envelope: 'compact' } })
  expect(answer.isTextDisplayOnly).toBe(true)
  expect(answer.text).toBe([
    `session trail ${SESSION} in app, as of snapshot snap_2: 5 entries`,
    '  1 searched Grep packages/billing',
    '  2 opened Read packages/format/src/currency.ts',
    '  3 opened Read packages/api/src/handler.ts failed agent=a1b2c3',
    '  4 changed Edit packages/format/src/currency.ts',
    '  5 claimed verify_claim sym_invoice',
    'changed formatAmount packages/format/src/currency.ts:1: 2 dependents not opened',
    '  never seen: handleInvoice packages/api/src/handler.ts:5',
    '  searched only: invoiceTotal packages/billing/src/invoice.ts:9',
    '# A search covers the files under the path it searched.',
  ].join('\n'))
  expect(turns).toBe(0)
})

test('FR615: a path outside the repository is not recorded, a subagent\'s call keeps its agent id, and a failed or denied call is recorded as failed', async ($, on) => {
  const w = world(on, { recording: true, tool: (e) => (e.tool === 'Write' ? { deny: 'not allowed' } : e.tool === 'Edit' ? { result: 'no match', isError: true } : { result: 'ok' }) })
  await start($, w)
  await $.tool.call({ tool: 'Read', file_path: '/elsewhere/notes.md' })
  await $.tool.call({ tool: 'Read', file_path: '/work/application/a.ts' })
  await $.tool.call({ tool: FIND, text: 'x', path_prefix: '../outside' })
  await $.tool.call({ tool: 'Read', file_path: 'lib.ts', agentId: 'a1b2c3' })
  await $.tool.call({ tool: 'Write', file_path: '/work/app/src/new.ts', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'cat /work/app/src/a.ts' })
  // A claim about `endpoint:GET /a` is kept without its subject, since trail record refuses a symbol id with a space.
  await $.tool.call({ tool: VERIFY, claim: { statement: 'x', proposition: { type: 'relationship', source: 'endpoint:GET /a', relationship: 'calls', target: 'sym_b' } } })
  // A path stat cannot resolve (the stub answers it as written) is folded before the check: one `..` leaves the repository, one stays in it.
  await $.tool.call({ tool: 'Read', file_path: '/work/app/../other/x.ts' })
  await $.tool.call({ tool: 'Read', file_path: '/work/app/src/../x.ts' })
  // get_symbol by { name, path } or by stable key opened that file.
  await $.tool.call({ tool: 'mcp__plugin_proofmesh_proofmesh__get_symbol', symbol_id: { name: 'invoiceTotal', path: 'packages/billing/src/invoice.ts' } })
  await $.tool.call({ tool: 'mcp__plugin_proofmesh_proofmesh__get_symbol', key: 'packages/api/src/handler.ts#packages/api/src/handler:handleInvoice#function' })
  await endTurn($, w)
  expect(w.entries().map((e) => [e.tool, e.path ?? e.symbol_id ?? null, e.agent_id ?? null, e.outcome])).toEqual([
    ['Read', 'src/lib.ts', 'a1b2c3', 'ok'],
    ['Write', 'src/new.ts', null, 'failed'],
    ['Edit', 'src/a.ts', null, 'failed'],
    // A file read through Bash is recorded since #149 (FR800).
    ['Bash', 'src/a.ts', null, 'ok'],
    [VERIFY, null, null, 'ok'],
    ['Read', 'x.ts', null, 'ok'],
    ['mcp__plugin_proofmesh_proofmesh__get_symbol', 'packages/billing/src/invoice.ts', null, 'ok'],
    ['mcp__plugin_proofmesh_proofmesh__get_symbol', 'packages/api/src/handler.ts', null, 'ok'],
  ])
})

// A mod's own tool call, as /pm-trail's MCP calls reach tool.call in a real session, is not a step Claude took.
const prober = {
  name: 'prober',
  register(on: On) {
    on('command.run', { command: 'probe' }, async ($: Dollar) => {
      await $.tool.call({ tool: 'Read', file_path: '/work/app/src/probed.ts' })
      return { text: 'probed' }
    })
  },
}

test('FR610: only calls Claude made are recorded, not a mod\'s own tool calls', { plugins: [prober] }, async ($, on) => {
  const w = world(on, { recording: true })
  await start($, w)
  await $.command.run({ command: 'probe', args: '' })
  await $.tool.call({ tool: 'Read', file_path: '/work/app/src/a.ts' })
  await endTurn($, w)
  expect(w.entries().map((e) => e.path)).toEqual(['src/a.ts'])
})

test('FR615: entries are sent at turn end and at session end, one process a flush, and nothing is sent when nothing was recorded', async ($, on) => {
  const w = world(on, { recording: true })
  await start($, w)
  await $.tool.call({ tool: 'Read', file_path: '/work/app/src/a.ts' })
  await $.tool.call({ tool: 'Glob', pattern: '**/*.ts' })
  await endTurn($, w)
  await endTurn($, w)
  expect(w.recorded()).toHaveLength(1)
  expect(w.entries().map((e) => [e.kind, e.tool, e.path])).toEqual([['opened', 'Read', 'src/a.ts'], ['searched', 'Glob', 'src']])
  await $.tool.call({ tool: 'MultiEdit', file_path: '/work/app/src/a.ts', edits: [] })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/app/notes.ipynb', new_source: 'x' })
  await $.session.end({ reason: 'prompt_input_exit' })
  expect(w.recorded()).toHaveLength(2)
  expect(w.entries().slice(2).map((e) => [e.kind, e.tool, e.path])).toEqual([['changed', 'MultiEdit', 'src/a.ts'], ['changed', 'NotebookEdit', 'notes.ipynb']])
})

test('FR615: without ProofMesh installed, or outside every registered repository, recording stays off and /pm-trail says why', async ($, on) => {
  const w = world(on, { list: 'proofmesh: $.process.run(proofmesh) failed to start: ENOENT: Executable not found in $PATH: "proofmesh"' })
  await start($, w)
  await scenario($)
  await endTurn($, w)
  expect(w.recorded()).toEqual([])
  expect((await $.command.run({ command: 'pm-trail', args: '' })).text).toBe('session trail: off (not installed)')
})

test('FR615: a repository not registered reads off (not registered here)', async ($, on) => {
  const w = world(on, { list: ok('repo_other  other  /other\n') })
  await start($, w)
  await scenario($)
  await endTurn($, w)
  expect(w.recorded()).toEqual([])
  expect((await $.command.run({ command: 'pm-trail', args: '' })).text).toBe('session trail: off (not registered here)')
})

// Reads and searches made through Bash (#149): Claude Code has no Grep or Glob tool in some configurations, so a session reads with cat and searches with rg.
const OUTPUT = 'export function formatAmount(cents: number) { return (cents / 100).toFixed(2) }'

test('FR800 FR801: Bash cat, sed -n, head, rg, grep -rn and find record opened for the files read and searched for the paths searched, repository-relative, never the command, its pattern or its output', async ($, on) => {
  const w = world(on, { recording: true, tool: () => ({ result: OUTPUT }) })
  await start($, w)
  await $.tool.call({ tool: 'Bash', command: 'cat /work/app/packages/format/src/currency.ts' })
  await $.tool.call({ tool: 'Bash', command: "sed -n '1,20p' ../packages/billing/src/invoice.ts" })
  await $.tool.call({ tool: 'Bash', command: 'head -n 40 lib.ts' })
  await $.tool.call({ tool: 'Bash', command: 'rg -n -d 2 formatAmount /work/app/packages' })
  await $.tool.call({ tool: 'Bash', command: 'grep -rn "formatAmount|invoiceTotal" ../packages/billing | head -20' })
  await $.tool.call({ tool: 'Bash', command: "find /work/app/packages -name '*.test.ts'" })
  await endTurn($, w)
  expect(w.entries().map((e) => [e.kind, e.tool, e.path, e.outcome])).toEqual([
    ['opened', 'Bash', 'packages/format/src/currency.ts', 'ok'],
    ['opened', 'Bash', 'packages/billing/src/invoice.ts', 'ok'],
    ['opened', 'Bash', 'src/lib.ts', 'ok'],
    ['searched', 'Bash', 'packages', 'ok'],
    ['searched', 'Bash', 'packages/billing', 'ok'],
    ['searched', 'Bash', 'packages', 'ok'],
  ])
  const sent = w.recorded()[0]!.stdin!
  for (const text of ['formatAmount', 'invoiceTotal', '1,20p', 'sed', 'grep', 'test.ts', 'toFixed', 'head']) expect(sent).not.toContain(text)
})

test('FR802: a Bash command the trail cannot read with confidence records nothing, nor one that reads outside the repository or a path where nothing is', async ($, on) => {
  // A word taken for a path by mistake, a search pattern say, names nothing on disk, so it is never stored.
  const w = world(on, { recording: true, missing: ['/work/app/src/sk_live_pattern'] })
  await start($, w)
  for (const command of [
    'cat src/*.ts', 'cat $HOME/notes.md', 'cat a.ts; rm b.ts', 'cat a.ts && cat b.ts', 'cat a.ts > b.ts', 'cat a.ts\ncat b.ts', 'grep -rn x src 2>/dev/null',
    // sed -n -i edits in place; find -exec with a quoted '{}' passes the word check and is refused for its action alone.
    'grep -rn x src | sh', "sed -n -i 's/a/b/p' a.ts", 'sed s/a/b/ a.ts', 'find . -name x -delete', "find . -exec grep -l x '{}' +", 'rg x', 'grep -rn x', 'rg --unknown x src',
    // A short option it does not know may take a value, which would read as the pattern and push the pattern into the paths.
    'rg -Q 2 x src', 'tail -W 3 a.ts', 'cat sk_live_pattern',
    // rg -h prints its help and searches nothing; a file named -n after -- is not sed's -n.
    'rg -h x src', 'sed p -- -n a.ts',
    'FOO=1 cat a.ts', 'ls src', 'echo cat a.ts', 'cat "a.ts', 'cat ""', 'grep -rn x ""', 'cat /elsewhere/notes.md', 'grep -rn x ../../outside',
  ]) await $.tool.call({ tool: 'Bash', command })
  await endTurn($, w)
  expect(w.entries()).toEqual([])
})

test('FR803: a Bash path is resolved against the directory the shell is in after a cd, not the one the session started in, and one with a `..` after a name is not guessed', async ($, on) => {
  const w = world(on, { recording: true, shell: '/work/app/packages' })
  await start($, w)
  await $.tool.call({ tool: 'Bash', command: 'cat format/src/currency.ts' })
  // If vendor is a link out of the repository, cat reads that file's neighbour, not packages/notes.md, and $.fs.stat folds `..` first.
  await $.tool.call({ tool: 'Bash', command: 'cat vendor/../notes.md' })
  await $.tool.call({ tool: 'Bash', command: 'head ../README.md' })
  await endTurn($, w)
  expect(w.entries().map((e) => e.path)).toEqual(['packages/format/src/currency.ts', 'README.md'])
})
