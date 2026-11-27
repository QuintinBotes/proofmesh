import path from 'node:path'
import { expect, test } from '@playwright/test'
import { answered, ROOT, startView } from './view'

// #46 story 2 on a framework fixture analysed by the syntax tier: app/shop calls app/billing (observed) and its Django model maps to a
// table app/billing declares, by Django's naming convention (inferred).
let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView(path.join(ROOT, 'fixtures', 'terrain-basis', 'repo')) })
test.afterAll(() => view?.stop())

test('#46 story 2 FR1402 FR1403 FR1406 a bundle of observed and inferred relationships is two strokes with their own counts, and its list groups rows by basis', async ({ page }) => {
  await page.goto(view.launchUrl)
  await page.locator('.terrain[data-ready]').waitFor({ timeout: 60000 })
  await expect(page.getByTestId('conclusion')).toContainText('5 symbols in 2 areas; 1 of 1 bundle between areas drawn')
  // One pair, drawn twice: a solid stroke for the observed relationship and a dashed one for the inferred (FR1402).
  expect((await page.getByTestId('terrain-strokes').textContent())!.split(' ')).toEqual(['observed:1>0', 'inferred:1>0'])
  const bundle = page.getByRole('region', { name: 'Bundles' }).getByRole('button')
  await expect(bundle).toHaveText('shop → billing1 observed1 inferred')
  await expect(bundle.locator('.basis.observed')).toHaveCSS('border-bottom-style', 'solid')
  await expect(bundle.locator('.basis.inferred')).toHaveCSS('border-bottom-style', 'dashed')
  await expect(bundle).toHaveAttribute('title', 'app/shop → app/billing: 1 observed, 1 inferred (calls 1, maps_to 1)')
  await answered(page, () => bundle.click())
  const panel = page.getByRole('complementary', { name: 'Bundle' })
  await expect(panel.locator('tbody tr')).toHaveCount(2)
  const observed = panel.getByRole('region', { name: 'Observed relationships' })
  await expect(observed.getByRole('heading')).toHaveText('Observed (compiler or runtime), solid: 1')
  await expect(observed.locator('tbody td:nth-child(-n+5)')).toHaveText(['app/shop/models:place', 'app/billing/tables:charge', 'calls', 'app/shop/models.py:11', 'observed'])
  const inferred = panel.getByRole('region', { name: 'Inferred relationships' })
  await expect(inferred.getByRole('heading')).toHaveText('Inferred (rules, syntax tier, models), dashed: 1')
  await expect(inferred.locator('tbody td:nth-child(-n+5)')).toHaveText(['app/shop/models:Order', 'shop_order', 'maps_to', 'app/shop/models.py:6', 'inferred'])
  // The legend says which stroke is which in words.
  await expect(page.getByRole('region', { name: 'Legend' })).toContainText('solid is observed (compiler or runtime), dashed is inferred (rules, syntax tier, models)')
})
