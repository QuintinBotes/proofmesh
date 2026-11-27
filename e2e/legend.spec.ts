import { expect, test } from '@playwright/test'
import { startView } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('FR068 FR057 every graph view says position carries no meaning, and shows the analysis mode in words', async ({ page }) => {
  await page.goto(view.launchUrl)
  await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  const legend = page.getByRole('region', { name: 'Legend' })
  // A path is traced inside Explore's lens (FR1300); trace.spec.ts checks the legend beside it.
  for (const tab of ['Galaxy', 'Map', 'Explore', 'Ecosystem']) {
    await page.getByRole('tab', { name: tab }).click()
    await expect(legend, tab).toContainText('Position carries no meaning; only drawn lines are relationships.')
    await expect(page.locator('.crumbs'), tab).toContainText('no execution')
  }
  // Claims and Diff are tables, not drawings: there is no position to disclaim.
  for (const tab of ['Claims', 'Diff']) {
    await page.getByRole('tab', { name: tab }).click()
    await expect(legend, tab).not.toContainText('Position carries no meaning')
  }
})
