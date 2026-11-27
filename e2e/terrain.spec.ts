import crypto from 'node:crypto'
import path from 'node:path'
import zlib from 'node:zlib'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { ROOT, serveView, startView } from './view'

// A launch link works once, so the tests share one page.
test.describe.configure({ mode: 'serial' })
let view: Awaited<ReturnType<typeof startView>>
let context: BrowserContext
let page: Page
const errors: string[] = []
test.beforeAll(async ({ browser }) => {
  view = await startView()
  context = await browser.newContext()
  page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(view.launchUrl)
})
test.afterAll(async () => { await context?.close(); view?.stop() })

test('A11 FR1400 the Terrain opens first with every area, and search shows only the matches and lists them', async () => {
  await expect(page.getByRole('tab', { name: 'Terrain' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab')).toHaveText(['Terrain', 'Explore', 'Claims', 'Diff', 'Ecosystem'])
  await expect(page.getByTestId('conclusion')).toHaveText('8 symbols in 4 areas; 2 of 2 bundles between areas drawn; 1 more area holds files the graph cannot see. Search, zoom into an area, or open a bundle.', { timeout: 60000 })
  await expect(page.getByRole('region', { name: 'Areas' })).toContainText('packages/api')
  await page.getByLabel('Search').fill('format')
  await expect(page.getByTestId('conclusion')).toHaveText('“format”: showing the 2 matching symbols; click one to explore it.')
  await expect(page.getByRole('status').filter({ hasText: 'of 8 symbols' })).toContainText('“format”: 2 of 8 symbols')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Symbols matching “format”' }).locator('tbody tr td:nth-child(3)')).toHaveText(['packages/format/src/currency:formatAmount', 'packages/legacy/src/format:formatAmount'])
})

test('FR059 FR1405 FR1407 SC011 files the graph cannot see are drawn as ghost cells, distinct from empty space, and the table says why', async () => {
  await page.getByLabel('Search').fill('')
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(page.getByTestId('conclusion')).toContainText('1 more area holds files the graph cannot see', { timeout: 60000 })
  // An area with no symbols has no cell in the layout: it is a ghost cell in the row below, never blank space.
  const ghosts = page.locator('.terrain-fog.empty')
  await expect(ghosts).toHaveCount(1)
  await expect(ghosts).toHaveAttribute('title', '(root): 1 file not analysed (no_adapter:.md 1)')
  // An area with symbols and a file it could not analyse carries a ghost inside its cell, its tooltip saying how many and why.
  await expect(page.locator('.terrain-fog[data-area="packages/api"] .terrain-ghost')).toHaveAttribute('title', 'packages/api: 1 file not analysed (no_adapter:.avsc 1)')
  // Excluded files are not a gap in what could be analysed, so they draw no ghost.
  await expect(page.locator('.terrain-fog[data-area="packages/billing"]')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Areas' }).getByRole('button')).toHaveCount(4)
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const rows = page.getByRole('table', { name: 'Areas', exact: true }).locator('tbody tr')
  await expect(rows).toHaveCount(5)
  await expect(rows.filter({ hasText: 'packages/api' }).locator('td:nth-child(6)')).toHaveText('1 of 2')
  await expect(rows.filter({ hasText: 'packages/api' }).locator('td:nth-child(8)')).toHaveText('ghost: files not analysed')
  await expect(rows.filter({ hasText: 'packages/billing' }).locator('td')).toHaveText(['packages/billing', '3', '2', '0', '1', '0 of 2', '**/dist/** 1', 'complete', 'Show'])
  const bundles = page.getByRole('table', { name: 'Bundles between areas' }).locator('tbody tr')
  await expect(bundles.locator('td:nth-child(-n+5)')).toHaveText(['packages/billing', 'packages/format', '1', '0', 'calls 1', 'packages/api', 'packages/billing', '1', '0', 'calls 1'])
})

test('FR1223 the map paints at its final positions: no simulation, no layout control and no layout cache in the browser', async ({ browser }) => {
  // A fresh context on a second view of the same data, so the first paint is a cold one.
  const second = await serveView(view.dataDir)
  const fresh = await browser.newContext()
  const cold = await fresh.newPage()
  cold.on('pageerror', (e) => errors.push(e.message))
  await cold.goto(second.launchUrl)
  const labels = cold.locator('.terrain-label.area')
  await expect(labels).toHaveCount(4, { timeout: 60000 })
  const first = await labels.evaluateAll((ls) => ls.map((l) => l.getBoundingClientRect()).map((r) => `${Math.round(r.x)},${Math.round(r.y)}`))
  await expect(cold.getByRole('toolbar', { name: 'Terrain controls' }).getByRole('button')).toHaveText(['+', '−', '⤢'])
  await expect(cold.getByRole('button', { name: /layout/i })).toHaveCount(0)
  // Long enough for any simulation to have moved a point, and for a settled layout to have been stored.
  await cold.waitForTimeout(3000)
  expect(await labels.evaluateAll((ls) => ls.map((l) => l.getBoundingClientRect()).map((r) => `${Math.round(r.x)},${Math.round(r.y)}`))).toEqual(first)
  expect((await cold.evaluate(() => indexedDB.databases())).map((db) => db.name)).not.toContain('proofmesh-galaxy')
  await fresh.close()
  second.stop()
})

test('A11 B5 B20 a one-character search says why nothing shows, and every area is named', async () => {
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await page.getByLabel('Search').fill('f')
  await expect(page.getByTestId('conclusion')).toHaveText('Type at least two characters to search.')
  await page.getByLabel('Search').fill('')
  // Every area is named with its count, largest first (FR1404).
  await expect(page.locator('.terrain-label.area')).toHaveText(['billing 3', 'api 3', 'format 1', 'legacy 1'])
})

test.describe('FR1220 the TypeORM sample draws the same map everywhere', () => {
  const sample = path.join(ROOT, 'fixtures', 'ts-typeorm', 'repo')
  /** The payload as the browser received it, and the bytes of its positions section. */
  const read = (body: Buffer) => {
    const raw = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body) : body
    const n = raw.readUInt32LE(0), h = JSON.parse(raw.subarray(4, 4 + n).toString('utf8'))
    const base = 4 + n + ((4 - ((4 + n) % 4)) % 4)
    return { raw, nodes: h.nodes as number, positions: raw.subarray(base + h.offsets.positions, base + h.offsets.positions + h.nodes * 4) }
  }

  test('two fresh browser contexts receive byte-identical positions, and a second index in another data directory sends the same payload', async ({ browser }) => {
    const one = await startView(sample), two = await serveView(one.dataDir), again = await startView(sample)
    try {
      const received: Array<ReturnType<typeof read>> = []
      for (const v of [one, two, again]) {
        const context = await browser.newContext()
        const page = await context.newPage()
        page.on('pageerror', (e) => errors.push(e.message))
        const response = page.waitForResponse((r) => r.url().endsWith('/api/v1/galaxy'))
        await page.goto(v.launchUrl)
        received.push(read(await (await response).body()))
        await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
        await context.close()
      }
      const [a, b, c] = received as [ReturnType<typeof read>, ReturnType<typeof read>, ReturnType<typeof read>]
      expect(a.nodes).toBeGreaterThan(20)
      expect(a.positions.length).toBe(a.nodes * 4)
      expect(b.positions.equals(a.positions)).toBe(true)
      const sha = (x: Buffer) => crypto.createHash('sha256').update(x).digest('hex')
      expect(sha(c.raw)).toBe(sha(a.raw))
    } finally {
      one.stop(); two.stop(); again.stop()
    }
  })
})

test('FR1210 a search with one match and an area of one symbol are said in the singular', async () => {
  await page.getByLabel('Search').fill('dispatch')
  await expect(page.getByTestId('conclusion')).toHaveText('“dispatch”: showing the 1 matching symbol; click one to explore it.')
  await page.getByLabel('Search').fill('')
  await page.getByRole('region', { name: 'Areas' }).getByRole('button', { name: /legacy/ }).click()
  await expect(page.getByTestId('conclusion')).toHaveText('packages/legacy: 1 symbol. Click a point to explore it.')
  await page.getByRole('region', { name: 'Areas' }).getByRole('button', { name: /legacy/ }).click()
})

test('A11 B10 no view raised a page error while these tests ran', async () => {
  expect(errors).toEqual([])
})
