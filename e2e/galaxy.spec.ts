import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { startView } from './view'

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

test('A11 B12 a settled layout is cached: a reload shows it at rest instead of simulating again', async () => {
  await page.getByLabel('Search').fill('')
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume layout' })).toBeVisible({ timeout: 60000 })
  await page.reload()
  await expect(page.getByTestId('conclusion')).toContainText('8 symbols in 4 areas', { timeout: 60000 })
  // A cached layout is at rest as soon as it draws; a fresh simulation needs the better part of a minute to settle, so 5 s still tells them apart.
  await expect(page.getByRole('button', { name: 'Resume layout' })).toBeVisible({ timeout: 5000 })
})

test('A11 B5 B8 B20 a one-character search says why nothing shows, every area is named, and the layout button stays put', async () => {
  await page.getByLabel('Search').fill('f')
  await expect(page.getByTestId('conclusion')).toHaveText('Type at least two characters to search.')
  await page.getByLabel('Search').fill('')
  await expect(page.locator('.galaxy-label')).toHaveText(['billing/src', 'api/src', 'format/src', 'legacy/src'])
  const toggle = page.getByRole('toolbar', { name: 'Galaxy controls' }).getByRole('button').last()
  const before = await toggle.boundingBox()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(await toggle.boundingBox()).toEqual(before)
  await toggle.click()
})

test('A11 B10 no view raised a page error while these tests ran', async () => {
  expect(errors).toEqual([])
})
