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

test('A11 the Galaxy opens first with every symbol, and search shows only the matches and lists them', async () => {
  await expect(page.getByRole('tab', { name: 'Galaxy' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('conclusion')).toHaveText('8 symbols in 4 areas, 5 links; 3 more areas hold files the graph cannot see. Search, pick an area, or click a point.', { timeout: 60000 })
  await expect(page.getByRole('region', { name: 'Areas' })).toContainText('packages/api/src')
  await page.getByLabel('Search').fill('format')
  await expect(page.getByTestId('conclusion')).toHaveText('“format”: showing the 2 matching symbols; click one to explore it.')
  await expect(page.getByRole('status').filter({ hasText: 'of 8 symbols' })).toContainText('“format”: 2 of 8 symbols')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Symbols matching “format”' }).locator('tbody tr td:nth-child(3)')).toHaveText(['packages/format/src/currency:formatAmount', 'packages/legacy/src/format:formatAmount'])
})

test('FR059 SC011 areas the graph cannot see are drawn as fog, and the table says why', async () => {
  await page.getByLabel('Search').fill('')
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(page.getByTestId('conclusion')).toContainText('3 more areas hold files the graph cannot see', { timeout: 60000 })
  const ghosts = page.locator('.galaxy-fog.empty')
  // Fog is placed once the simulation has positions, which a busy machine can delay past the default budget.
  await expect(ghosts).toHaveCount(3, { timeout: 30000 })
  await expect(ghosts.locator('.fog-label')).toHaveText([
    '(root): 1 file not analysed', 'packages/api: 1 file not analysed', 'packages/billing/dist: 1 excluded',
  ])
  await expect(page.getByRole('region', { name: 'Areas' }).getByRole('button')).toHaveCount(4)
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const rows = page.getByRole('table', { name: 'Areas' }).locator('tbody tr')
  await expect(rows).toHaveCount(7)
  await expect(rows.filter({ hasText: 'packages/api/src' }).locator('td:nth-child(6)')).toHaveText('1 of 2')
  await expect(rows.filter({ hasText: 'packages/billing/dist' }).locator('td')).toHaveText(['packages/billing/dist', '0', '0', '0', '1', 'no call sites', '**/dist/** 1', ''])
})

test('FR1560 every ghost and its label lie inside the Galaxy and clear of its controls, after the first paint and after Fit everything', async () => {
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(page.locator('.galaxy-fog.empty .fog-label')).toHaveCount(3, { timeout: 30000 })
  // Each shown ghost's and label's box against the canvas, the zoom toolbar and the Graph/Table switch: an empty list means all are clear.
  const misplaced = () => page.evaluate(() => {
    const g = document.querySelector('.galaxy')!.getBoundingClientRect()
    const over = ['[aria-label="Galaxy controls"]', '[role="group"][aria-label="View"]'].map((s) => document.querySelector(s)!.getBoundingClientRect())
    return [...document.querySelectorAll('.galaxy-fog.empty, .galaxy-fog.empty .fog-label')].flatMap((e) => {
      const b = e.getBoundingClientRect(), name = e.getAttribute('data-area') ?? e.textContent
      const outside = b.left < g.left || b.right > g.right || b.top < g.top || b.bottom > g.bottom
      const under = over.some((c) => b.left < c.right && b.right > c.left && b.top < c.bottom && b.bottom > c.top)
      return outside || under ? [`${name}${outside ? ' outside' : ''}${under ? ' under a control' : ''}`] : []
    })
  })
  await expect.poll(misplaced).toEqual([])
  await page.getByRole('button', { name: 'Fit everything' }).click()
  // Fitting animates for half a second; the labels must stay put once it has settled.
  await page.waitForTimeout(800)
  await expect.poll(misplaced).toEqual([])
})

test('FR1223 the map paints at its final positions: no simulation, no layout control and no layout cache in the browser', async ({ browser }) => {
  // A fresh context on a second view of the same data, so the first paint is a cold one.
  const second = await serveView(view.dataDir)
  const fresh = await browser.newContext()
  const cold = await fresh.newPage()
  cold.on('pageerror', (e) => errors.push(e.message))
  await cold.goto(second.launchUrl)
  const labels = cold.locator('.galaxy-label')
  await expect(labels).toHaveCount(4, { timeout: 60000 })
  const first = await labels.evaluateAll((ls) => ls.map((l) => l.getBoundingClientRect()).map((r) => `${Math.round(r.x)},${Math.round(r.y)}`))
  await expect(cold.getByRole('toolbar', { name: 'Galaxy controls' }).getByRole('button')).toHaveText(['+', '−', '⤢'])
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
  await expect(page.locator('.galaxy-label')).toHaveText(['billing/src', 'api/src', 'format/src', 'legacy/src'])
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
  await page.getByRole('region', { name: 'Areas' }).getByRole('button', { name: /legacy\/src/ }).click()
  await expect(page.getByTestId('conclusion')).toHaveText('packages/legacy/src: 1 symbol. Click a point to explore it.')
  await page.getByRole('region', { name: 'Areas' }).getByRole('button', { name: /legacy\/src/ }).click()
})

test('A11 B10 no view raised a page error while these tests ran', async () => {
  expect(errors).toEqual([])
})
