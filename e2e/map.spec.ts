import { expect, test } from '@playwright/test'
import { answered, startView } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('FR056 the map shows the areas, a search shows its results in the graph and the table, and an area opens', async ({ page }) => {
  await page.goto(view.launchUrl)
  await page.getByRole('tab', { name: 'Map' }).click()
  await expect(page.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('conclusion')).toHaveText('packages: 4 areas, 2 links between them. Click one to open it.', { timeout: 60000 })

  await answered(page, () => page.getByLabel('Search').fill('format'))
  await expect(page.getByTestId('conclusion')).toHaveText('“format”: 2 matching symbols in 2 areas of packages. Click one to narrow down.')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const symbols = page.getByRole('table', { name: 'Matching symbols' })
  await expect(symbols.locator('tbody tr td:nth-child(3)')).toHaveText(['packages/format/src/currency:formatAmount', 'packages/legacy/src/format:formatAmount'])

  await answered(page, () => page.getByRole('table', { name: 'Areas holding “format”' }).getByRole('row').filter({ hasText: 'format/src' }).getByRole('button', { name: 'Open' }).click())
  await expect(page.getByRole('navigation', { name: 'Location' })).toContainText('format')
  await expect(page).toHaveURL(/\?map=packages%2Fformat%2Fsrc&q=format$/)
})
