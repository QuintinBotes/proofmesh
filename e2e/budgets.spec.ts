import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { ROOT, serveView, startView } from './view'

/** The fixture's galaxy replaced by a synthetic one of n symbols, as the Observatory benchmark does (#41); its points map to the fixture's ids. */
async function syntheticView(n: number) {
  const first = await startView()
  const session = await fetch(`${first.origin}/session`, { method: 'POST', headers: { Origin: first.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(first.launchUrl).hash.slice(3) }) })
  const cookie = /pm_session=[0-9a-f]+/.exec(session.headers.get('set-cookie') ?? '')![0]
  await fetch(`${first.origin}/api/v1/galaxy`, { method: 'POST', headers: { Origin: first.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })
  first.stop()
  const cache = path.join(first.dataDir, 'cache'), idsFile = fs.readdirSync(cache).find((f) => /^galaxy-v\d+-.*\.ids\.json$/.test(f))!
  const [, version, snapshotId] = /^galaxy-(v\d+)-(.*)\.ids\.json$/.exec(idsFile)!
  const { generateGalaxy } = await import(path.join(ROOT, 'bench/observatory/gen-galaxy.mjs'))
  const syn = generateGalaxy({ nodes: n, seed: 1, snapshotId, ids: JSON.parse(fs.readFileSync(path.join(cache, idsFile), 'utf8')) })
  fs.writeFileSync(path.join(cache, idsFile), JSON.stringify(syn.ids))
  fs.writeFileSync(path.join(cache, `galaxy-${version}-${snapshotId}.bin.gz`), syn.gz)
  return serveView(first.dataDir)
}

test.describe('FR1452 the Galaxy payload is parsed off the page', () => {
  let small: Awaited<ReturnType<typeof startView>>
  test.beforeAll(async () => { small = await startView() })
  test.afterAll(() => small?.stop())

  test('FR1452 in a worker, which hands the page its typed arrays', async ({ page }) => {
    const workers: string[] = []
    page.on('worker', (w) => workers.push(w.url()))
    await page.goto(small.launchUrl)
    await expect(page.getByTestId('conclusion')).toContainText('8 symbols in 4 areas', { timeout: 60000 })
    expect(workers.filter((u) => /\/assets\/galaxyWorker-[\w-]+\.js$/.test(u))).toHaveLength(1)
  })

  test('FR1451 the first screen fetches the Galaxy view\'s code and no other view\'s; the Map\'s arrives when the Map is first shown', async ({ page }) => {
    const again = await serveView(small.dataDir)
    try {
      const scripts: string[] = []
      page.on('request', (r) => { if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname) })
      await page.goto(again.launchUrl)
      await page.locator('.galaxy[data-ready]').waitFor({ timeout: 60000 })
      expect(scripts.filter((u) => /^\/assets\/Galaxy-/.test(u))).toHaveLength(1)
      expect(scripts.filter((u) => /^\/assets\/GraphView-/.test(u))).toEqual([])
      await page.getByRole('tab', { name: 'Map' }).click()
      await expect.poll(() => scripts.filter((u) => /^\/assets\/GraphView-/.test(u)).length).toBe(1)
    } finally { again.stop() }
  })

  test('FR1452 a browser without Web Workers parses it on the page, in slices, and search still works', async ({ page }) => {
    const again = await serveView(small.dataDir)
    try {
      await page.addInitScript(() => { delete (window as { Worker?: unknown }).Worker })
      await page.goto(again.launchUrl)
      const conclusion = page.getByTestId('conclusion')
      await expect(conclusion).toContainText('8 symbols in 4 areas', { timeout: 60000 })
      await page.getByLabel('Search').fill('format')
      await expect(conclusion).toHaveText('“format”: showing the 2 matching symbols; click one to explore it.')
    } finally { again.stop() }
  })
})

test.describe('FR1454 virtual tables', () => {
let view: Awaited<ReturnType<typeof serveView>>
test.beforeAll(async () => { view = await syntheticView(61000) })
test.afterAll(() => view?.stop())

test('FR1454 a table of over 50,000 symbols scrolls end to end with every row reachable, a few hundred in the page and no frame dropped', async ({ page }) => {
  test.setTimeout(180000)
  await page.goto(view.launchUrl)
  await expect(page.getByTestId('conclusion')).toContainText('61,000 symbols in', { timeout: 120000 })
  await page.getByLabel('Search').fill('er')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const table = page.getByRole('table', { name: /symbols matching “er”/i })
  // The count stays visible (FR058), and nothing says the list was cut.
  const count = Number((await table.locator('caption').textContent())!.replace(/[^\d]/g, ''))
  expect(count).toBeGreaterThanOrEqual(50000)
  await expect(page.getByText(/first 200/)).toHaveCount(0)
  const nodes = () => page.evaluate(() => document.querySelectorAll('*').length)
  expect(await nodes()).toBeLessThanOrEqual(3000)

  // Scrolling the whole table, a wheel turn a frame: every frame interval is timed while it moves.
  const box = (await table.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 40)
  const frames = page.evaluate(() => new Promise<number[]>((resolve) => {
    const ts: number[] = [], end = performance.now() + 3000
    const tick = (t: number) => { ts.push(t); if (t < end) requestAnimationFrame(tick); else resolve(ts.slice(1).map((x, i) => x - ts[i]!)) }
    requestAnimationFrame(tick)
  }))
  for (let k = 0; k < 60; k++) await page.mouse.wheel(0, 2000)
  const intervals = (await frames).sort((a, b) => a - b)
  const p95 = intervals[Math.floor(intervals.length * 0.95)]!
  console.log(`table scroll: ${intervals.length} frames, p95 ${p95.toFixed(1)} ms, max ${intervals.at(-1)!.toFixed(1)} ms`)
  // At 60 Hz a frame is 16.7 ms, and vsync jitters it by a few tenths; a dropped frame is 33 ms.
  expect(p95).toBeLessThan(16.7 * 1.5)
  expect(await nodes()).toBeLessThanOrEqual(3000)

  // The last row is reachable: scrolled to the end, the table shows the last match.
  await table.evaluate((t) => { const s = t.closest('.virtual')!; s.scrollTop = s.scrollHeight })
  await expect(table.locator('tbody tr:not(.spacer)').last()).toHaveAttribute('aria-rowindex', String(count + 1))
  expect(await nodes()).toBeLessThanOrEqual(3000)
})
})
