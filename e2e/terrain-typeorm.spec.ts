import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { answered, ROOT, startView } from './view'

// #46 story 1 on the TypeORM sample: TypeORM's src/ at a pinned commit, built once by bench/parity/fixture.sh (the parity and
// Observatory benchmarks' fixture; cloned on first use) and indexed here from a copy of its own.
test.describe.configure({ mode: 'serial' })
let view: Awaited<ReturnType<typeof startView>>
let context: BrowserContext
let page: Page
const errors: string[] = []
test.beforeAll(async ({ browser }) => {
  test.setTimeout(600000)
  const src = execFileSync('sh', [path.join(ROOT, 'bench', 'parity', 'fixture.sh')], { encoding: 'utf8' }).trim()
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-terrain-'))
  fs.cpSync(src, copy, { recursive: true, filter: (f) => !/(^|\/)(graphify-out|\.serena)$/.test(f) })
  view = await startView(copy)
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(view.launchUrl)
  await page.locator('.terrain[data-ready]').waitFor({ timeout: 120000 })
})
test.afterAll(async () => { await context?.close(); view?.stop() })

const strokes = async () => ((await page.getByTestId('terrain-strokes').textContent()) ?? '').split(' ').filter(Boolean)
const table = async () => {
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const areas = await page.getByRole('table', { name: 'Areas', exact: true }).locator('tbody tr').evaluateAll((rows) => rows.map((r) => [...r.children].map((c) => c.textContent ?? '')))
  const bundles = await page.getByRole('table', { name: 'Bundles between areas' }).locator('tbody tr').evaluateAll((rows) => rows.map((r) => [...r.children].map((c) => c.textContent ?? '')))
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  // The Terrain is drawn again from the snapshot's layout: the same areas in the same places.
  await page.locator('.terrain[data-ready] .terrain-label.area').first().waitFor()
  return { areas, bundles }
}

test('#46 S1 FR1402 FR1407 at fit: areas with their names and counts, no symbol drawn, at most 12 bundles plus every inferred one, and the total in the status line', async () => {
  const { areas, bundles } = await table()
  const labels = await page.locator('.terrain-label').allTextContents()
  expect(labels).toContain('driver 3,941')
  expect(labels).toContain('query-builder 518')
  // Every area is listed in the table; the ones drawn large enough are named in the Terrain, the rest in their tooltip and the table.
  const named = new Set(await page.locator('.terrain-label.area').evaluateAll((ls) => ls.map((l) => l.getAttribute('title'))))
  expect(named.size).toBeGreaterThanOrEqual(8)
  for (const name of named) expect(areas.map((r) => r[0])).toContain(name)
  // No symbol is drawn or named at the overview, so no line can join two symbols.
  await expect(page.locator('.terrain-label.symbol')).toHaveCount(0)
  const drawn = await strokes()
  expect(drawn.filter((s) => s.startsWith('observed:')).length).toBeLessThanOrEqual(12)
  expect(drawn.filter((s) => s.startsWith('inferred:')).length).toBe(bundles.filter((b) => Number(b[3]) > 0).length)
  await expect(page.getByTestId('conclusion')).toContainText(`of ${bundles.length.toLocaleString('en')} bundles between areas drawn`)
})

test('#46 S2 FR1402 the pointer resting on an area draws every bundle into or out of it, each direction named in words', async () => {
  const { bundles } = await table()
  const driver = page.locator('.terrain-label.area', { hasText: 'driver 3,941' })
  const box = (await driver.boundingBox())!
  await page.mouse.move(box.x + 40, box.y + 120)
  await expect(page.getByRole('region', { name: 'Bundles' })).toContainText('with every bundle of src/driver')
  const touching = bundles.filter((b) => b[0] === 'src/driver' || b[1] === 'src/driver')
  expect(touching.length).toBeGreaterThan(12)
  const drawn = await strokes()
  expect(drawn.length).toBeGreaterThanOrEqual(touching.length)
  // Each drawn bundle's direction is in words, not colour alone (FR057): its button and title name from → to.
  const buttons = page.getByRole('region', { name: 'Bundles' }).getByRole('button')
  expect(await buttons.count()).toBeGreaterThanOrEqual(touching.length)
  await expect(buttons.first()).toHaveAttribute('title', /^src\/\S+ → src\/\S+: [\d,]+ observed/)
  await page.mouse.move(5, 5)
})

test('#46 S3 FR1403 a bundle chosen from the keyboard lists the relationships it stands for, one row each with source, target, type, file:line and basis', async () => {
  const { bundles } = await table()
  // A bundle of a few relationships, so every row can be checked.
  const small = bundles.find((b) => Number(b[2]) + Number(b[3]) >= 3 && Number(b[2]) + Number(b[3]) <= 40)!
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const row = page.getByRole('table', { name: 'Bundles between areas' }).locator('tbody tr').filter({ has: page.locator('td:nth-child(1)', { hasText: new RegExp(`^${small[0]}$`) }) }).filter({ has: page.locator('td:nth-child(2)', { hasText: new RegExp(`^${small[1]}$`) }) })
  await row.getByRole('button', { name: 'Open' }).focus()
  await answered(page, () => page.keyboard.press('Enter'))
  const panel = page.getByRole('complementary', { name: 'Bundle' })
  await expect(panel.getByRole('heading').first()).toHaveText(`${small[0]} → ${small[1]}`)
  const rows = panel.locator('tbody tr')
  await expect(rows).toHaveCount(Number(small[2]) + Number(small[3]))
  for (const r of await rows.evaluateAll((trs) => trs.map((t) => [...t.children].map((c) => c.textContent ?? '')))) {
    expect(r[0]!.startsWith(`${small[0]}/`), r[0]).toBe(true)
    expect(r[1]!.startsWith(`${small[1]}/`), r[1]).toBe(true)
    expect(r[2]).toMatch(/^[a-z_]+$/)
    expect(r[3]).toMatch(/^src\/\S+:\d+$/)
    expect(r[4]).toMatch(/^(observed|inferred)$/)
  }
  await panel.getByRole('button', { name: 'Close bundle' }).click()
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  // A drawn bundle opens from its button in the Bundles list too, by keyboard alone.
  const first = page.getByRole('region', { name: 'Bundles' }).getByRole('button').first()
  await first.focus()
  await answered(page, () => page.keyboard.press('Enter'))
  await expect(page.getByRole('complementary', { name: 'Bundle' }).locator('tbody tr').first()).toBeVisible()
  await page.getByRole('button', { name: 'Close bundle' }).click()
})

test('#46 S4 FR056 FR1404 zooming into src/data-source names its files, then its symbols, and no symbol moves at any zoom', async () => {
  await page.getByRole('region', { name: 'Areas' }).getByRole('button', { name: /^src\/data-source/ }).click()
  await expect(page.locator('.terrain-label.file', { hasText: 'DataSource.ts' })).toBeVisible()
  const zoomIn = page.getByRole('toolbar', { name: 'Terrain controls' }).getByRole('button', { name: 'Zoom in' })
  const symbols = page.locator('.terrain-label.symbol')
  for (let i = 0; i < 8 && !(await symbols.count()); i++) { await zoomIn.click(); await page.waitForTimeout(450) }
  await expect(symbols.first()).toBeVisible()
  // Zoom in about the view's centre: every named symbol's point scales away from it by the zoom factor, so none moved.
  const canvas = (await page.locator('.terrain-canvas').boundingBox())!
  const cx = canvas.width / 2, cy = canvas.height / 2
  // A symbol's name is centred under its point: its left, before the centring transform, is the point's x. A qualified name some
  // other symbol shares (an overload, a merged declaration) is left out, so each name stands for one point.
  const at = async () => {
    const all = await symbols.evaluateAll((ls) => ls.map((l) => [l.getAttribute('title')!, { x: l.offsetLeft, y: l.offsetTop }] as const))
    return new Map(all.filter(([k]) => all.filter(([j]) => j === k).length === 1))
  }
  // The camera has finished moving before the first reading.
  await page.waitForTimeout(600)
  const before = await at()
  await zoomIn.click()
  await page.waitForTimeout(600)
  const after = await at()
  const shared = [...before.keys()].filter((k) => after.has(k))
  expect(shared.length).toBeGreaterThan(0)
  for (const k of shared) {
    const b = before.get(k)!, a = after.get(k)!
    expect(Math.abs(a.x - (cx + (b.x - cx) * 1.6)), k).toBeLessThan(1.5)
    // The name hangs under the point by an eighth of the symbol's cell and 3 px; the cell scales with the zoom, the 3 px do not.
    expect(Math.abs(a.y - (cy + (b.y - cy) * 1.6)), k).toBeLessThan(3)
  }
  await page.getByRole('toolbar', { name: 'Terrain controls' }).getByRole('button', { name: 'Fit everything' }).click()
  await page.waitForTimeout(500)
})

test('#46 S5 FR1405 an area with more than 4% of its calls unresolved is hatched, files the graph cannot analyse are ghost cells, and each tooltip says how many and why', async () => {
  const { areas } = await table()
  const hatched = page.locator('.terrain-fog.hatched')
  expect(await hatched.count()).toBe(areas.filter((r) => r[7]!.includes('hatched')).length)
  expect(await hatched.count()).toBeGreaterThan(0)
  await expect(page.locator('.terrain-fog.hatched[data-area="src/driver"]')).toHaveAttribute('title', /^src\/driver: \d+% of [\d,]+ calls unresolved/)
  // Areas with no symbols: ghost cells below the layout, never blank, each titled with its files and why.
  const ghosts = page.locator('.terrain-fog.empty')
  expect(await ghosts.count()).toBe(areas.filter((r) => r[1] === '0').length)
  for (const t of await ghosts.evaluateAll((g) => g.map((x) => x.getAttribute('title') ?? ''))) expect(t).toMatch(/: [\d,]+ files? not analysed|excluded/)
})

test('#46 no page error while these tests ran', async () => {
  expect(errors).toEqual([])
})
