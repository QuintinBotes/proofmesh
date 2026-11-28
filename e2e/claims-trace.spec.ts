import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { mcpSession } from './mcp-session'
import { CLI, ROOT, serveView, startView } from './view'

// #50 Claims & trace on the TypeORM sample (bench/parity/fixture.sh, as the Terrain's own test uses it). Snapshot A is the sample;
// snapshot B changes DataSource.initialize, deletes titleCase and adds QueryBuilder.clearParameters. A scripted MCP session with
// recording on searches, opens, diffs, asks for impact and records the four claims, then Observatory opens Claims & trace.
test.describe.configure({ mode: 'serial' })
let view: Awaited<ReturnType<typeof serveView>>
let context: BrowserContext
let page: Page
let snapA = '', snapB = '', repoId = ''
const claimIds: Record<string, string> = {}
const pm = (dataDir: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, '--data-dir', dataDir, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`proofmesh ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}
const edit = (root: string, file: string, from: string | RegExp, to: string) => {
  const p = path.join(root, file), text = fs.readFileSync(p, 'utf8'), next = text.replace(from, to)
  if (next === text) throw new Error(`${file}: nothing to change`)
  fs.writeFileSync(p, next)
}
const CLAIMS = [
  ['src/query-builder/QueryBuilder:QueryBuilder.setParameters', 'src/query-builder/QueryBuilder:QueryBuilder.setParameter'],
  ['src/data-source/DataSource:DataSource.initialize', 'src/data-source/DataSource:DataSource.buildMetadatas'],
  ['src/query-builder/QueryBuilder:QueryBuilder.createParameter', 'src/query-builder/QueryBuilder:QueryBuilder.hasParameter'],
  ['src/query-builder/QueryBuilder:QueryBuilder.clearParameters', 'src/query-builder/QueryBuilder:QueryBuilder.setParameters'],
] as const

test.beforeAll(async ({ browser }) => {
  test.setTimeout(1800000)
  const src = execFileSync('sh', [path.join(ROOT, 'bench', 'parity', 'fixture.sh')], { encoding: 'utf8' }).trim()
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-claims-'))
  fs.cpSync(src, repo, { recursive: true, filter: (f) => !/(^|\/)(graphify-out|\.serena)$/.test(f) })
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-claims-data-'))
  pm(dataDir, 'init')
  repoId = /repo_\w+/.exec(pm(dataDir, 'repo', 'add', repo))![0]
  snapA = /snapshot (snap_\w+) published/.exec(pm(dataDir, 'index', repo))![1]!
  edit(repo, 'src/data-source/DataSource.ts', '        await this.driver.connect()\n', '        await this.driver.connect()\n        this.logger.log("info", "connected")\n')
  edit(repo, 'src/util/StringUtils.ts', /\/\*\*\n \* Converts string into Title Case\.[\s\S]*?\nexport function titleCase[\s\S]*?\n}\n/, '')
  edit(repo, 'src/query-builder/QueryBuilder.ts', '    protected createParameter(value: any): string {', '    clearParameters(): this {\n        this.expressionMap.parameters = {}\n        return this\n    }\n\n    protected createParameter(value: any): string {')
  snapB = /snapshot (snap_\w+) published/.exec(pm(dataDir, 'index', repo))![1]!
  pm(dataDir, 'trail', 'on', repoId)

  // The scripted session: search, open, search, open, diff, impact, then the four claims.
  const s = await mcpSession(dataDir)
  try {
    const init = (await s.call('find_symbols', { text: 'DataSource.initialize' })).data.symbols.find((x: { qualified_name: string }) => x.qualified_name === CLAIMS[1][0]).id
    await s.call('get_symbol', { symbol_id: init })
    await s.call('find_symbols', { text: 'createConnection', path_prefix: 'src/globals' })
    await s.call('get_symbol', { symbol_id: { name: 'connect', path: 'src/data-source/DataSource.ts' } })
    await s.call('compare_snapshots', { base_snapshot_id: snapA })
    await s.call('analyze_impact', { subject_ids: [init] })
    for (const [source, target] of CLAIMS) {
      const v = await s.call('verify_claim', { claim: { statement: `${source} calls ${target}.`, proposition: { type: 'relationship', source: `method:${source}`, relationship: 'calls', target: `method:${target}` } } })
      claimIds[source] = v.data.claim_id
    }
  } finally {
    s.close()
  }
  view = await serveView(dataDir)
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  page = await context.newPage()
  await page.goto(view.launchUrl)
  await page.locator('.terrain[data-ready]').waitFor({ timeout: 120000 })
  await page.getByRole('tab', { name: 'Claims', exact: true }).click()
  await page.locator('.claims-trace .terrain[data-ready]').waitFor({ timeout: 120000 })
})
test.afterAll(async () => { await context?.close(); view?.stop() })

const pins = () => page.locator('.claim-pin')
const call = async (tool: string, input: Record<string, unknown>) => (await page.request.post(`${view.origin}/api/v1/tools/${tool}`, { headers: { Origin: view.origin }, data: input })).json()

test('#50 S1.1 FR1950 FR1951 four claims on snapshot B are pinned at their source symbols, three marked ✓ and one ✗, and the summary says 1 of 4 claims refuted', async () => {
  await expect(pins()).toHaveCount(4)
  expect((await pins().evaluateAll((ps) => ps.map((p) => p.getAttribute('data-symbol')))).sort()).toEqual(CLAIMS.map(([s]) => s).sort())
  expect((await pins().evaluateAll((ps) => ps.map((p) => `${p.getAttribute('data-verdict')} ${p.textContent}`))).sort()).toEqual(['refuted ✗', 'supported ✓', 'supported ✓', 'supported ✓'])
  // The mark is a shape and a word, not colour alone (FR057).
  for (const p of await pins().all()) await expect(p).toHaveAttribute('aria-label', /^(supported|refuted): .+ calls .+, checked at snap_/)
  await expect(page.getByTestId('claims-summary')).toHaveText('1 of 4 claims refuted')
  // Each pin sits on its symbol's point: inside the Terrain, and inside the cell of the file that declares it.
  const area = (await page.locator('.claims-trace .terrain').boundingBox())!
  for (const p of await pins().all()) {
    const b = (await p.boundingBox())!
    expect(b.x >= area.x && b.x <= area.x + area.width && b.y >= area.y && b.y <= area.y + area.height).toBe(true)
  }
})

test('#50 S1.2 FR1952 the refuted claim shows its seven layers as equal cells in pipeline order, semantic: fail the most prominent, not run and unsupported hatched', async () => {
  await page.locator('.claim-pin[data-verdict="refuted"]').click()
  const cells = page.getByRole('list', { name: 'Layers in pipeline order' }).getByRole('listitem')
  await expect(cells).toHaveText(['scope: pass', 'resolution: pass', 'semantic: fail', 'integrity: not run', 'replay: unsupported', 'independent: not run', 'execution: not run'])
  const boxes = await cells.evaluateAll((ls) => ls.map((l) => { const r = l.getBoundingClientRect(), s = getComputedStyle(l); return { w: r.width, h: r.height, border: parseFloat(s.borderTopWidth), weight: Number(s.fontWeight), hatch: s.backgroundImage, outcome: l.getAttribute('data-outcome') } }))
  for (const b of boxes) { expect(Math.abs(b.w - boxes[0]!.w)).toBeLessThan(1); expect(Math.abs(b.h - boxes[0]!.h)).toBeLessThan(1) }
  const fail = boxes[2]!
  for (const b of boxes.filter((_, i) => i !== 2)) { expect(fail.border).toBeGreaterThan(b.border); expect(fail.weight).toBeGreaterThanOrEqual(b.weight) }
  for (const b of boxes.filter((x) => x.outcome === 'not_run' || x.outcome === 'unsupported')) expect(b.hatch).toContain('repeating-linear-gradient')
  for (const b of boxes.filter((x) => x.outcome === 'pass' || x.outcome === 'fail')) expect(b.hatch).toBe('none')
})

test('#50 S1.3 FR1953 a claim last checked against an older snapshot says checked at it, never shows the old verdict as current, and verifies again', async () => {
  const source = CLAIMS[0][0]
  await call('verify_claim', { claim_id: claimIds[source], snapshot_id: snapA })
  // The view reads claims each time it opens.
  await page.getByRole('tab', { name: 'Terrain' }).click()
  await page.getByRole('tab', { name: 'Claims', exact: true }).click()
  const pin = page.locator(`.claim-pin[data-symbol="${source}"]`)
  await expect(pin).toHaveAttribute('data-verdict', 'stale')
  await expect(pin).toContainText(`checked at ${snapA.slice(0, 13)}`)
  await expect(pin).not.toContainText('✓')
  await expect(page.getByTestId('claims-summary')).toHaveText('1 of 3 claims refuted at the current snapshot; 1 checked at an older snapshot')
  await pin.click()
  await expect(page.getByTestId('claim-verdict')).toHaveText(`checked at ${snapA}, not the current snapshot ${snapB}: verify again for a current verdict`)
  await page.getByRole('button', { name: 'Verify again against the current snapshot' }).click()
  await expect(pin).toHaveAttribute('data-verdict', 'supported')
  await expect(page.getByTestId('claims-summary')).toHaveText('1 of 4 claims refuted')
})

test('#50 S2.1 FR1954 FR1955 the trail numbers each step in order at its subject, a subject visited again carries +n, and every step lists its tool and subjects', async () => {
  const steps = page.getByRole('list', { name: 'Steps in order' }).locator(':scope > li.step')
  await expect(steps).toHaveCount(10)
  const text = await steps.allTextContents()
  expect(text.map((t) => /^\d+ (\w+) (\w+)/.exec(t)!.slice(1).join(' '))).toEqual([
    'searched find_symbols', 'opened get_symbol', 'searched find_symbols', 'opened get_symbol', 'changed compare_snapshots', 'opened analyze_impact',
    'claimed verify_claim', 'claimed verify_claim', 'claimed verify_claim', 'claimed verify_claim',
  ])
  expect(text.map((t) => Number(/^\d+/.exec(t)![0]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(text[2]).toContain('createConnection')
  expect(text[4]).toContain('titleCase')
  // The diff read snapshot A; the trail says so where the snapshot changed, and back.
  await expect(page.getByRole('list', { name: 'Steps in order' }).locator('li.snapshot-change')).toHaveText([`snapshot changed to ${snapA.slice(0, 13)}`, `snapshot changed to ${snapB.slice(0, 13)}`])
  // DataSource.initialize: found at step 1, then opened, diffed, asked about and claimed.
  const visits = text.filter((t) => t.includes('DataSource.initialize')).length
  expect(visits).toBeGreaterThan(1)
  const marker = page.locator('.trail-mark[data-symbol="src/data-source/DataSource:DataSource.initialize"]')
  await expect(marker).toHaveText(`1+${visits - 1}`)
  await expect(page.locator('.trail-mark')).not.toHaveCount(0)
})

test('#50 S2.2 FR1956 against the blast radius of the change, the view lists every dependent the session never searched for nor opened: 20 of 24', async () => {
  const missed = page.getByRole('region', { name: 'Dependents never looked at' })
  await expect(missed.getByRole('heading')).toHaveText('20 of 24 dependents of the session\'s change never looked at')
  const rows = await missed.getByRole('listitem').allTextContents()
  expect(rows).toHaveLength(20)
  expect(rows.some((r) => r.includes('ColumnMetadata.build '))).toBe(true)
  for (const c of ['CacheClear', 'MigrationGenerate', 'MigrationRevert', 'MigrationRun', 'MigrationShow', 'Query', 'SchemaDrop', 'SchemaLog', 'SchemaSync']) expect(rows.some((r) => r.includes(`${c}Command.handler `)), c).toBe(true)
})

test('#50 S2.3 FR1957 with recording off the trail is absent and says how to turn it on, and the claims half works unchanged', async ({ browser }) => {
  const small = await startView()
  const ctx = await browser.newContext()
  try {
    const p = await ctx.newPage()
    await p.goto(small.launchUrl)
    await p.locator('.crumbs').waitFor()
    await p.request.post(`${small.origin}/api/v1/tools/verify_claim`, { headers: { Origin: small.origin }, data: { claim: { statement: 'handleInvoice calls invoiceTotal.', proposition: { type: 'relationship', source: 'function:packages/api/src/handler:handleInvoice', relationship: 'calls', target: 'function:packages/billing/src/invoice:invoiceTotal' } } } })
    await p.getByRole('tab', { name: 'Claims', exact: true }).click()
    const trail = p.getByRole('region', { name: 'Session trail' })
    await expect(trail).toContainText('Recording is off for this repository, so no session trail is kept.')
    await expect(trail).toContainText(/proofmesh trail on repo_\w+/)
    await expect(trail.getByRole('list', { name: 'Steps in order' })).toHaveCount(0)
    await expect(p.getByTestId('claims-summary')).toHaveText('0 of 1 claim refuted')
    await expect(p.locator('.claim-pin')).toHaveCount(1)
  } finally {
    await ctx.close()
    small.stop()
  }
})
