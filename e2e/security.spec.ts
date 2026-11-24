import { expect, test } from '@playwright/test'
import { startView, traceIt } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('AC30 repository content renders as text: no markup injection, bidi characters made visible', async ({ page }) => {
  let dialogs = 0
  page.on('dialog', async (d) => { dialogs++; await d.dismiss() })
  await page.goto(view.launchUrl)
  await traceIt(page, ['handleInvoice', 'handleInvoice'], ['formatAmount', 'packages/format/src/currency'])
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await page.getByRole('table', { name: 'Traced nodes in order' }).locator('tbody tr').first().getByRole('button', { name: 'Show evidence' }).click()
  const panel = page.getByRole('complementary', { name: 'Evidence' })
  await expect(panel.getByTestId('evidence-text')).toContainText('<img src=x onerror=alert(1)>')
  await expect(panel.locator('img')).toHaveCount(0)

  await traceIt(page, ['dispatch', 'dispatch'], ['formatAmount', 'packages/legacy/src/format'])
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await page.getByRole('table', { name: 'Traced nodes in order' }).locator('tbody tr[data-role="unreached-target"]').getByRole('button', { name: 'Show evidence' }).click()
  await expect(panel.getByTestId('evidence-text')).toContainText('⟨U+202E⟩')
  await expect(page.getByRole('list', { name: 'Unresolved boundaries' })).toContainText('dynamic_element_access')
  expect(dialogs).toBe(0)
})
