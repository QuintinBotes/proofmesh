import { expect, test } from '@playwright/test'
import { answered, startView } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('A11 switching to Claims closes the evidence panel and shows no Trace controls', async ({ page }) => {
  await page.goto(view.launchUrl)
  await page.getByRole('tab', { name: 'Explore' }).click()
  await answered(page, () => page.getByRole('region', { name: 'Start exploring' }).getByRole('button').filter({ hasText: 'packages/billing/src/invoice:invoiceTotal' }).click())
  await expect(page.getByRole('complementary', { name: 'Evidence' })).toBeVisible()
  await page.getByRole('tab', { name: 'Claims' }).click()
  await expect(page.getByRole('complementary', { name: 'Evidence' })).toHaveCount(0)
  await expect(page.locator('#picker-source')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Trace', exact: true })).toHaveCount(0)
})
