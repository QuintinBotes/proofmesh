// The impact pane (#115): after Claude edits a file of the session's repository, a pane lists the symbols the session changed, their
// dependents and the tests that reach them, from answers recorded on fixtures/ts-invoicing. Run with `claude plugin test packages/proofmesh-plugin`.
import { expect, mock, test } from 'claude-code/testing'
import { RECORDED } from './ts-invoicing.recorded'

const ROOT = '/work/app'
const REPO = RECORDED.symbolsAt.snapshot.repository_id
const LIST = `${REPO}  app  ${ROOT}\n`
const BASE = RECORDED.baseSymbol.snapshot.id
const HEAD = RECORDED.symbolsAt.snapshot.id
const NEXT = 'snap_0000000000000000000000002'
const NOW = Date.parse('2026-11-27T10:00:00.000Z')
const CURRENCY = 'packages/format/src/currency.ts'
const PANE = {
  plugin: 'proofmesh',
  component: 'Pane',
  requestId: 'pm-impact',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Impact', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const

type On = Parameters<Parameters<typeof test>[1]>[1]
type Dollar = Parameters<Parameters<typeof test>[1]>[0]
type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] } | string | null | undefined
type Envelope = { snapshot: object; data: object; completion?: object; limitations?: string[] }

const answer = (body: Envelope | string) =>
  typeof body === 'string' ? { value: { content: [{ type: 'text', text: body }], isError: false } } : { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false, structuredContent: body } }
const at = (snapshot: string, body: Envelope) => ({ ...body, snapshot: { ...body.snapshot, id: snapshot } })

/** The Edit result Claude Code gives for `toFixed(2)` -> `toFixed(3)` in currency.ts: one hunk over its three lines. */
const EDIT = {
  filePath: `${ROOT}/${CURRENCY}`, oldString: 'toFixed(2)', newString: 'toFixed(3)', originalFile: null, userModified: false, replaceAll: false,
  structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+b', ' c'] }],
}
const editCurrency = ($: Dollar) => $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${CURRENCY}`, old_string: 'toFixed(2)', new_string: 'toFixed(3)' })

/**
 * Stubs Claude Code and ProofMesh for a session in /work/app: `w.snapshot` is the current snapshot and `w.current` whether it matches the tree;
 * the MCP tools answer as recorded on fixtures/ts-invoicing, the symbol at a currency.ts line being formatAmount and any other file not indexed.
 */
function world(on: On, o: { recording?: boolean; symbolsAt?: (locations: string[]) => unknown[]; fail?: string; headHash?: string; writeLines?: number } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const w = { snapshot: BASE as string, current: true, clock, mcp: [] as Array<{ tool: string; args: Record<string, unknown> }>, log: [] as string[], copied: [] as Array<{ text: string; surface?: string }>, opened: [] as string[], closed: [] as string[], panes: [] as string[], tools: 0, turns: 0 }
  on('session.start', () => ({ cwd: ROOT }))
  on('session.end', () => ({ sessionId: 's1' }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', ($, e) => { w.turns++; return { turnId: e.turnId } })
  on('session.id', () => ({ value: 's1' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => { w.tools++; return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', ($, e) => { w.opened.push(e.id); w.panes = [e.id]; return { value: { isPlaced: true } } })
  on('ui.close', ($, e) => { w.closed.push(e.id); w.panes = []; return { value: undefined } })
  on('ui.panes', () => ({ value: w.panes.map((id) => ({ id, title: 'Impact', isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.copy', ($, e) => { w.copied.push({ text: e.text, surface: e.surface }); return { value: { isCopied: true } } })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', ($, e) => {
    w.log.push('proofmesh')
    const [, cmd, , flag] = e.argv
    if (cmd === 'repo') return { value: { exitCode: 0, stdout: LIST, stderr: '' } }
    if (cmd === 'trail') return { value: { exitCode: 0, stdout: 'recorded\n', stderr: '' } }
    if (flag === '--fresh') return { value: { exitCode: 0, stdout: JSON.stringify({ repository_id: REPO, name: 'app', snapshot_id: w.snapshot, current: w.current, changed_count: w.current ? 0 : 1, changed: [], trail_recording: o.recording ?? false }), stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:proofmesh:proofmesh' } }))
  on('mcp.call', ($, e) => {
    w.log.push('proofmesh')
    const args = e.args as Record<string, unknown>
    w.mcp.push({ tool: e.tool, args })
    const snap = (args.snapshot_id as string | undefined) ?? w.snapshot
    if (o.fail && e.tool === o.fail) return { value: { content: [{ type: 'text', text: '{"code":"TIMEOUT","message":"analyze_impact: the query timed out after 10000 ms"}' }], isError: true, structuredContent: { code: 'TIMEOUT', message: 'analyze_impact: the query timed out after 10000 ms' } } }
    if (e.tool === 'workspace_status') return answer({ snapshot: { id: w.snapshot, analysis_mode: 'no_execution', published_at: new Date(NOW).toISOString(), commit: null }, data: { jobs: [] } })
    if (e.tool === 'get_symbols_at') {
      const locations = args.locations as string[]
      const results = o.symbolsAt?.(locations) ?? locations.map((location) => (location.startsWith(`${CURRENCY}:`) ? { location, symbol: RECORDED.symbolsAt.data.results[0]!.symbol } : { location, symbol: null, disposition: 'unsupported', reason: 'not_indexed' }))
      return answer(at(snap, { ...RECORDED.symbolsAt, data: { results } }))
    }
    if (e.tool === 'get_symbol') {
      const recorded = snap === BASE ? RECORDED.baseSymbol : RECORDED.headSymbol
      const key = args.key as string
      return answer(at(snap, { ...recorded, data: { symbol: { ...recorded.data.symbol, stable_key: key, ...(snap !== BASE && o.headHash ? { body_hash: o.headHash } : {}) } } }))
    }
    if (e.tool === 'analyze_impact') return answer(RECORDED.impactLean.replace(HEAD, snap))
    if (e.tool === 'find_tests') return answer(at(snap, RECORDED.tests))
    return answer({ snapshot: {}, data: {} })
  })
  on('tool.call', (_$, e) => {
    w.log.push('tool')
    // An edit moves the working tree off the snapshot until the next index publishes one.
    if (e.tool === 'Edit' || e.tool === 'Write') w.current = false
    return e.tool === 'Edit' ? { result: EDIT } : e.tool === 'Write' ? { result: { type: 'update', filePath: e.file_path, content: 'x', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: o.writeLines ?? 1, lines: [] }], originalFile: 'y' } } : { result: 'ok' }
  })
  const calls = (tool: string) => w.mcp.filter((c) => c.tool === tool)
  return Object.assign(w, { calls })
}

type World = ReturnType<typeof world>

async function start($: Dollar, w: World, surface: 'terminal' | 'desktop' | null = 'terminal') {
  await $.session.start({ surface, isInteractive: surface !== null, cwd: ROOT })
  await w.clock.settle()
}

/** Publishes `snapshot` as current, and lets one poll see it. */
async function publish(w: World, snapshot: string) {
  w.snapshot = snapshot
  w.current = true
  await w.clock.advance(5000)
  await w.clock.settle()
}

/** The drawing as lines: a row Box is one line of its parts, a Button or Link its label. */
function lines(n: Node): string[] {
  if (typeof n === 'string') return [n]
  if (!n || typeof n !== 'object') return []
  const kids = (n.children ?? (n.props?.children as unknown[] | undefined) ?? []).flatMap((c) => lines(c as Node))
  if (n.type === 'Text') return [kids.join('')]
  if (n.type === 'Button' || n.type === 'Link') return [String(n.props?.label ?? kids.join(''))]
  if (n.type === 'Box' && n.props?.flexDirection === 'row') return [kids.join(' ')]
  return kids
}

/** Draws the pane on `surface`, lets the analysis its drawing starts finish, and returns the lines it draws then. */
async function pane($: Dollar, w: World, surface: 'terminal' | 'desktop') {
  let ui = await $.ui.mount({ ...PANE, surface })
  await w.clock.settle()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface })
  return { ui, lines: lines((await ui.drawn()) as Node).map((l) => l.trim()) }
}

const FORMAT_AMOUNT = [
  CURRENCY,
  'changed formatAmount line 1',
  'calls invoiceTotal packages/billing/src/invoice.ts:9 resolved depth=1 open',
  'calls handleInvoice packages/api/src/handler.ts:5 resolved depth=2 open',
  '# 1 unresolved call site in this snapshot has an unknown target and could also reach these symbols.',
  'no test reaches it',
]

test('FR700 FR701 scenario 1 SC-001: after Claude edits formatAmount, the pane lists it under changed with its dependents (relationship, file:line, evidence class) and tests, as analyze_impact and find_tests answer on the same snapshot', async ($, on) => {
  const w = world(on)
  await start($, w)
  await editCurrency($)
  await publish(w, HEAD)
  for (const surface of SURFACES) {
    const { ui, lines } = await pane($, w, surface)
    expect(lines).toEqual([`impact as of ${HEAD} (current)`, ...FORMAT_AMOUNT])
    await ui.unmount()
  }
  // get_symbols_at for the edited lines, then the body hash of each symbol before the edit and now, all on the pinned snapshot.
  expect(w.calls('get_symbols_at').map((c) => c.args)).toEqual([{ repository_id: REPO, snapshot_id: HEAD, locations: [`${CURRENCY}:1`, `${CURRENCY}:2`, `${CURRENCY}:3`], envelope: 'compact' }])
  const key = RECORDED.symbolsAt.data.results[0]!.symbol.stable_key
  expect(w.calls('analyze_impact').map((c) => c.args)).toEqual([{ repository_id: REPO, snapshot_id: HEAD, key, envelope: 'lean' }])
  expect(w.calls('find_tests').map((c) => c.args)).toEqual([{ repository_id: REPO, snapshot_id: HEAD, key, envelope: 'compact' }])
})

test('FR701 SC-002: ten edits in a row before one snapshot is published make one analyze_impact and one find_tests call for the changed symbol', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (let i = 0; i < 10; i++) {
    await editCurrency($)
    await w.clock.advance(5000)
  }
  await publish(w, HEAD)
  await ui.unmount()
  for (let i = 0; i < 3; i++) await pane($, w, 'terminal').then(({ ui }) => ui.unmount())
  expect(w.calls('get_symbols_at')).toHaveLength(1)
  expect(w.calls('analyze_impact')).toHaveLength(1)
  expect(w.calls('find_tests')).toHaveLength(1)
})

test('FR701 SC-003: the tool.call hook passes an edit on before any ProofMesh call', async ($, on) => {
  const w = world(on)
  await start($, w)
  w.log.length = 0
  await editCurrency($)
  expect(w.log[0]).toBe('tool')
  // What the edit sets off waits for the next poll and the pane, never for the tool call.
  expect(w.log).toEqual(['tool'])
})

test('FR702 scenario 2: while the snapshot is behind the edit, the pane shows the last answer marked behind, and redraws when the next snapshot is published', async ($, on) => {
  const w = world(on)
  await start($, w)
  await editCurrency($)
  await publish(w, HEAD)
  await pane($, w, 'terminal').then(({ ui }) => ui.unmount())
  await editCurrency($)
  w.current = false
  await w.clock.advance(5000)
  for (const surface of SURFACES) {
    const { ui, lines } = await pane($, w, surface)
    expect(lines).toEqual([`impact as of ${HEAD} (behind)`, ...FORMAT_AMOUNT])
    await ui.unmount()
  }
  // Behind, nothing is asked again: the answer would be about the tree before the edit.
  expect(w.calls('analyze_impact')).toHaveLength(1)
  await publish(w, NEXT)
  const { lines } = await pane($, w, 'terminal')
  expect(lines[0]).toBe(`impact as of ${NEXT} (current)`)
  expect(w.calls('analyze_impact').map((c) => c.args.snapshot_id)).toEqual([HEAD, NEXT])
})

test('FR703 scenario 3: with the session trail recording, each dependent the session never opened is marked not opened, under a count heading the list', async ($, on) => {
  const w = world(on, { recording: true })
  await start($, w)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/packages/billing/src/invoice.ts` })
  await editCurrency($)
  await publish(w, HEAD)
  for (const surface of SURFACES) {
    const { ui, lines } = await pane($, w, surface)
    expect(lines.slice(0, 5)).toEqual([
      `impact as of ${HEAD} (current)`,
      '1 dependent not opened',
      CURRENCY,
      'changed formatAmount line 1',
      'calls invoiceTotal packages/billing/src/invoice.ts:9 resolved depth=1 open',
    ])
    expect(lines[5]).toBe('calls handleInvoice packages/api/src/handler.ts:5 resolved depth=2 not opened open')
    await ui.unmount()
  }
})

test('FR703: with recording off, no dependent is marked', async ($, on) => {
  const w = world(on)
  await start($, w)
  await editCurrency($)
  await publish(w, HEAD)
  const { lines } = await pane($, w, 'terminal')
  expect(lines.join('\n')).not.toContain('not opened')
})

// The Desktop app makes a Link only of an https: or http://localhost href and draws a file: one as plain text, so the file:line is drawn
// as text on every surface and copied on a press: the spec's link in the Desktop app is left for a person to decide (see the PR).
test('FR704 scenario 4: pressing a dependent row or its open button copies its file:line, in the terminal and the Desktop app', async ($, on) => {
  const w = world(on)
  await start($, w)
  await editCurrency($)
  await publish(w, HEAD)
  for (const surface of SURFACES) {
    const { ui } = await pane($, w, surface)
    await ui.press({ key: 'dep:0' })
    await ui.press({ key: 'open:1' })
    expect(await ui.find({ type: 'Text', text: 'packages/billing/src/invoice.ts:9' })).toBeDefined()
    await ui.unmount()
  }
  expect(w.copied).toEqual([
    { text: 'packages/billing/src/invoice.ts:9', surface: 'terminal' },
    { text: 'packages/api/src/handler.ts:5', surface: 'terminal' },
    { text: 'packages/billing/src/invoice.ts:9', surface: 'desktop' },
    { text: 'packages/api/src/handler.ts:5', surface: 'desktop' },
  ])
})

test('FR705 scenario 5: /pm-impact opens the pane, or closes it if open, with no model turn and no tool for Claude', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.opened).toEqual([])
  await $.command.run({ command: 'pm-impact', args: '' })
  expect(w.opened).toEqual(['pm-impact'])
  await $.command.run({ command: 'pm-impact', args: '' })
  expect(w.closed).toEqual(['pm-impact'])
  expect(w.turns).toBe(0)
  expect(w.tools).toBe(0)
})

test('FR705 scenario 5: with no surface that draws (claude -p, the Agent SDK), /pm-impact prints the same list as text', async ($, on) => {
  const w = world(on)
  await start($, w, null)
  await editCurrency($)
  w.snapshot = HEAD
  w.current = true
  const answer = await $.command.run({ command: 'pm-impact', args: '' })
  expect(answer).toEqual({ text: [`impact as of ${HEAD} (current)`, CURRENCY, '  changed formatAmount line 1', ...FORMAT_AMOUNT.slice(2).map((l) => `    ${l.replace(/ open$/, '')}`)].join('\n'), isTextDisplayOnly: true })
  expect(w.opened).toEqual([])
  expect(w.turns).toBe(0)
})

test('FR706 edge case: no edits yet, the pane says so and makes no ProofMesh call for it', async ($, on) => {
  const w = world(on)
  await start($, w)
  for (const surface of SURFACES) {
    const { ui, lines } = await pane($, w, surface)
    expect(lines).toEqual(['no changes in this session'])
    await ui.unmount()
  }
  expect(w.mcp.map((c) => c.tool).filter((t) => t !== 'workspace_status')).toEqual([])
})

test('FR706 edge case: an edit to a file no adapter reads, or outside the repository, is listed as not indexed with the reason', async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/README.md`, content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/elsewhere/notes.ts', content: 'x' })
  await publish(w, HEAD)
  const { lines } = await pane($, w, 'terminal')
  expect(lines).toEqual([`impact as of ${HEAD} (current)`, 'README.md: not indexed (unsupported)', '/elsewhere/notes.ts: not indexed (outside the repository)'])
  expect(w.calls('analyze_impact')).toEqual([])
})

test('FR706 edge case: many changed symbols are grouped by file, at most 20 shown, then a count', async ($, on) => {
  const sym = RECORDED.symbolsAt.data.results[0]!.symbol
  // Each Write's hunk covers 12 lines, and each line holds its own symbol: 24 changed symbols in two files.
  const w = world(on, {
    writeLines: 12,
    symbolsAt: (locations) => locations.map((location) => {
      const path = location.replace(/:\d+$/, ''), line = Number(location.split(':').pop())
      return { location, symbol: { ...sym, id: `sym_${path[0]}${line}`, name: `f${line}`, qualified_name: `${path}:f${line}`, stable_key: `${path}#f${line}#function`, path, start_line: line, end_line: line } }
    }),
  })
  await start($, w)
  for (const file of ['a.ts', 'b.ts']) await $.tool.call({ tool: 'Write', file_path: `${ROOT}/${file}`, content: 'x' })
  await publish(w, HEAD)
  const { lines } = await pane($, w, 'terminal')
  const shown = lines.filter((l) => /^(a|b)\.ts$|^changed |more changed/.test(l))
  expect(shown).toEqual(['a.ts', ...Array.from({ length: 12 }, (_, i) => `changed f${i + 1} line ${i + 1}`), 'b.ts', ...Array.from({ length: 8 }, (_, i) => `changed f${i + 1} line ${i + 1}`), '4 more changed symbols not shown'])
  expect(w.calls('analyze_impact')).toHaveLength(20)
  expect(w.calls('find_tests')).toHaveLength(20)
})

test('FR706 edge case: a ProofMesh call that fails is one row, and the edit and the session go on', async ($, on) => {
  const w = world(on, { fail: 'analyze_impact' })
  await start($, w)
  const edited = await editCurrency($)
  expect(edited).toEqual({ result: EDIT })
  await publish(w, HEAD)
  const { lines } = await pane($, w, 'terminal')
  expect(lines).toEqual([`impact as of ${HEAD} (current)`, 'impact: unknown (the query timed out after 10000 ms)'])
})

test('FR706 edge case: a symbol whose edit was undone, its body hash the snapshot\'s before the edit again, leaves the changed list', async ($, on) => {
  const w = world(on, { headHash: RECORDED.baseSymbol.data.symbol.body_hash })
  await start($, w)
  await editCurrency($)
  await publish(w, HEAD)
  const { lines } = await pane($, w, 'terminal')
  expect(lines).toEqual([`impact as of ${HEAD} (current)`, 'no changed symbols'])
  expect(w.calls('analyze_impact')).toEqual([])
})
