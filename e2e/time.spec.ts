import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { SNAPSHOT_B, writeSnapshotB } from '../bench/observatory/snapshot-b.mjs'
import { displacement } from '../bench/observatory/stability.mjs'
import { CLI, ROOT, startView } from './view'

// #48 on the Observatory benchmark's snapshots A and B of the TypeORM sample: A is TypeORM's src/ at a pinned commit (built once by
// bench/parity/fixture.sh), B is A plus the commit bench/observatory/snapshot-b.mjs writes, both indexed here from a copy of their own.
test.describe.configure({ mode: 'serial' })
let view: Awaited<ReturnType<typeof startView>>
let context: BrowserContext
let page: Page
let A = '', B = ''
type Compared = { symbols: { counts: { added: number; removed: number; changed: number }; changed: Array<{ qualified_name: string; what: string[] }> } }
let compared: Compared
test.beforeAll(async ({ browser }) => {
  test.setTimeout(900000)
  const src = execFileSync('sh', [path.join(ROOT, 'bench', 'parity', 'fixture.sh')], { encoding: 'utf8' }).trim()
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-time-'))
  fs.cpSync(src, copy, { recursive: true, filter: (f) => !/(^|\/)(graphify-out|\.serena)$/.test(f) })
  view = await startView(copy)
  writeSnapshotB(copy)
  const git = (...a: string[]) => execFileSync('git', ['-C', copy, '-c', 'user.name=observatory-e2e', '-c', 'user.email=e2e@localhost', '-c', 'core.hooksPath=/dev/null', ...a])
  git('add', '-A')
  git('commit', '-qm', 'observatory benchmark: snapshot B')
  const r = spawnSync(process.execPath, [CLI, '--data-dir', view.dataDir, 'index', copy], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  page = await context.newPage()
  await page.goto(view.launchUrl)
  await page.locator('.terrain[data-ready]').waitFor({ timeout: 120000 })
  ;[B, A] = (await api('snapshots', {})).snapshots.map((s: { id: string }) => s.id)
  compared = (await api('tools/compare_snapshots', { base_snapshot_id: A, snapshot_id: B, limits: { max_rows: 1000, max_bytes: 1048576 } })).data
})
test.afterAll(async () => { await context?.close(); view?.stop() })

const api = async (route: string, data: Record<string, unknown>) => (await page.request.post(`${view.origin}/api/v1/${route}`, { headers: { Origin: view.origin }, data })).json()
/** A snapshot's layout as the Terrain receives it: positions and names from the Galaxy payload (#44). */
async function layout(snapshotId: string) {
  const res = await page.request.post(`${view.origin}/api/v1/galaxy`, { headers: { Origin: view.origin }, data: { snapshot_id: snapshotId } })
  const body = await res.body()
  // The browser undoes the gzip transfer encoding; Playwright's request may hand it back still encoded.
  const buf = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body) : body
  const hl = buf.readUInt32LE(0), h = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8')), base = 4 + hl + ((4 - ((4 + hl) % 4)) % 4)
  const positions: number[] = []
  for (let i = 0; i < h.nodes * 2; i++) positions.push(buf.readUInt16LE(base + h.offsets.positions + 2 * i))
  return { positions, names: buf.subarray(base + h.offsets.names, base + h.offsets.names + h.names_bytes).toString('utf8').split('\n') }
}
const shown = (id: string) => page.locator(`.terrain[data-ready][data-snapshot="${id}"]`)
const marked = (change: string) => page.locator(`.terrain .time-mark[data-change="${change}"]`).evaluateAll((ms) => ms.map((m) => m.getAttribute('data-name')).sort())
const declared = (s: { what: string[] }) => s.what.some((w) => w === 'body' || w === 'signature')

test('#48 S1 FR1761 FR1762 FR1763 FR2620 from A to B: no shared symbol moves more than 2% of the width, the added symbols and file appear, titleCase is a cross where it was, and the counts are compare_snapshots\'', async () => {
  // The strip lists every snapshot newest first, each with its symbols and unresolved share from list_snapshots (FR1760).
  const listed = (await api('snapshots', {})).snapshots as Array<{ id: string; symbols: number; relationships: number; unresolved: number }>
  const strip = page.getByRole('list', { name: 'Snapshots, newest first' }).getByRole('button')
  await expect(strip).toHaveCount(2)
  for (const [k, s] of listed.entries()) {
    await expect(strip.nth(k)).toHaveAttribute('data-snapshot', s.id)
    await expect(strip.nth(k)).toContainText(`${s.symbols.toLocaleString('en')} symbols · ${(s.unresolved / s.relationships * 100).toLocaleString('en', { maximumFractionDigits: 1 })}% unresolved`)
  }
  await expect(strip.first()).toContainText('(current)')

  await page.keyboard.press('[')
  await shown(A).waitFor()
  await expect(page.locator('.terrain .time-mark')).toHaveCount(0)
  await page.keyboard.press(']')
  await shown(B).waitFor()
  await expect(page.getByTestId('time-counts')).toBeVisible()

  // Scenario 1: no symbol present in both moves more than 2% of the map's width (FR2620, #275), so SC-001's at most 1% holds too.
  const moved = displacement(await layout(A), await layout(B))
  console.log(`A to B: ${JSON.stringify(moved)}`)
  expect(moved.shared).toBeGreaterThan(6000)
  expect(moved.max).toBeLessThanOrEqual(0.02)
  expect(moved.moved_2pct).toBeLessThanOrEqual(0.01)

  // The new file is its module symbol, added beside its three functions; QueryBuilder gains a method; titleCase is gone.
  expect(await marked('added')).toEqual([...SNAPSHOT_B.added, SNAPSHOT_B.file.replace(/\.ts$/, '')].sort())
  expect(await marked('removed')).toEqual(SNAPSHOT_B.removed)
  const { counts } = compared.symbols
  expect([counts.added, counts.removed]).toEqual([5, 1])
  const lines = compared.symbols.changed.filter((s) => !declared(s)).length
  await expect(page.getByTestId('time-counts')).toHaveText(`Since ${A.slice(0, 13)}: ${counts.added} added, ${counts.removed} removed, 1 changed, 0 moved, ${counts.changed - lines - 1} changed through members, ${lines} moved lines.`)
})

test('#48 S2 S3 FR1762 exactly one symbol is ringed as changed, DataSource.initialize; those whose lines only shifted are not ringed, and the list and legend say moved lines', async () => {
  expect(await marked('changed')).toEqual([SNAPSHOT_B.changed])
  // Its classes changed only through it and clearParameters, so they are said, not ringed.
  expect(await page.locator('.terrain .time-mark[data-change="members"], .terrain .time-mark[data-change="lines"]').count()).toBe(0)
  const shifted = compared.symbols.changed.filter((s) => !declared(s)).map((s) => s.qualified_name).sort()
  expect(shifted.length).toBeGreaterThan(50)
  const list = page.getByRole('table', { name: 'Changes in this step' })
  await page.getByText('List the changes').click()
  await expect(list.locator('tr[data-change="lines"]')).toHaveCount(shifted.length)
  await expect(list.locator('tr[data-change="lines"] td').first()).toHaveText('moved lines')
  await expect(list.locator('tr[data-change="lines"] td[title]').first()).toHaveAttribute('title', /: moved lines, its declaration unchanged$/)
  await expect(list.locator('tr[data-change="members"] td[title]')).toHaveText(['src/data-source/DataSource:DataSource', 'src/query-builder/QueryBuilder:QueryBuilder'])
  await expect(page.getByRole('region', { name: 'Time' })).toContainText('moved lines: not ringed: only its line range changed, so its declaration did not')
  // The strip, the counts, the legend and the list open: axe finds no serious violation.
  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)
  expect(serious).toEqual([])
  await page.getByText('List the changes').click()
})

test('#48 S5 FR1763 FR010 at A, ] shows B within 300 ms with no request, and every view is pinned to the snapshot shown', async () => {
  await page.keyboard.press('[')
  await shown(A).waitFor()
  await expect(page.getByTestId('replay-banner')).toContainText(`Replaying snapshot ${A.slice(0, 13)}`)
  // Diff, another view, compares against the snapshot Time shows.
  await page.getByRole('tab', { name: 'Diff' }).click()
  await expect(page.getByRole('group', { name: 'Compare' })).toContainText(`Head: ${A.slice(0, 13)} (replayed)`)
  await page.getByRole('tab', { name: 'Terrain' }).click()
  await shown(A).waitFor()
  const requests: string[] = []
  page.on('request', (r) => { if (r.url().includes('/api/')) requests.push(r.url()) })
  // Timed in the page, from the key to B's Terrain drawn with its marks and a frame painted (SC-002).
  const ms = await page.evaluate((id) => new Promise<number>((resolve) => {
    const t0 = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }))
    const poll = () => (document.querySelector(`.terrain[data-ready][data-snapshot="${id}"] .time-mark`) ? requestAnimationFrame(() => resolve(performance.now() - t0)) : requestAnimationFrame(poll))
    poll()
  }), B)
  console.log(`] from A to B: ${Math.round(ms)} ms`)
  expect(ms).toBeLessThanOrEqual(300)
  expect(requests).toEqual([])
  await expect(page.getByTestId('replay-banner')).toHaveCount(0)
  await expect(page.locator('.crumbs .snap')).toHaveAttribute('title', B)
})

test('#48 S4 FR1764 with reduced motion the marks switch state without animation, and the counts are the same', async ({ browser }) => {
  const counts = await page.getByTestId('time-counts').textContent()
  // The same session, its cookie carried over, in a browser that asks for reduced motion.
  const still = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce', storageState: await context.storageState() })
  try {
    const p = await still.newPage()
    await p.goto(`${view.origin}/`)
    await p.locator('.terrain[data-ready]').waitFor({ timeout: 120000 })
    await p.keyboard.press('[')
    await p.locator(`.terrain[data-ready][data-snapshot="${A}"]`).waitFor()
    await p.keyboard.press(']')
    await expect(p.getByTestId('time-counts')).toHaveText(counts!)
    const animated = await p.locator('.terrain .time-mark').evaluateAll((ms) => ms.map((m) => getComputedStyle(m).animationName).filter((n) => n !== 'none'))
    expect(animated).toEqual([])
    expect(await p.locator('.terrain .time-mark').count()).toBeGreaterThan(0)
  } finally { await still.close() }
})

test('#48 FR1765 a link to a snapshot opens it pinned; a link to one no longer published says so and offers the nearest', async () => {
  await page.goto(`${view.origin}/?snapshot=${A}`)
  await expect(page.getByTestId('replay-banner')).toContainText(`Replaying snapshot ${A.slice(0, 13)}`)
  await page.goto(`${view.origin}/?snapshot=snap_000000000000000000000000`)
  const gone = page.getByTestId('snapshot-gone')
  await expect(gone).toContainText('Snapshot snap_00000000 is no longer published')
  await gone.getByRole('button', { name: `Open the nearest, ${A.slice(0, 13)}` }).click()
  await expect(page.getByTestId('replay-banner')).toContainText(`Replaying snapshot ${A.slice(0, 13)}`)
})
