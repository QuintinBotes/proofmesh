import { expect, test } from '@playwright/test'
import { answered, startView } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('Explore opens on starting points, re-centres on a neighbour, and Back returns', async ({ page }) => {
  await page.goto(view.launchUrl)
  await page.getByRole('tab', { name: 'Explore' }).click()
  const start = page.getByRole('region', { name: 'Start exploring' })
  await answered(page, () => start.getByRole('button').filter({ hasText: 'packages/billing/src/invoice:invoiceTotal' }).click())
  await expect(page).toHaveURL(/\?focus=sym_[0-9a-z]+$/)
  await expect(page.getByRole('region', { name: 'Focus' })).toContainText('packages/billing/src/invoice:invoiceTotal')
  await expect(page.getByTestId('conclusion')).toHaveText('invoiceTotal: 1 incoming, 2 outgoing. Click a node to explore from it.')
  await expect(page.getByTestId('evidence-text')).toContainText('export function invoiceTotal')

  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await answered(page, () => page.getByRole('table', { name: 'Symbol and its neighbours' }).getByRole('row').filter({ hasText: 'packages/api/src/handler:handleInvoice' }).getByRole('button', { name: 'Explore' }).click())
  await expect(page.getByRole('region', { name: 'Focus' })).toContainText('packages/api/src/handler:handleInvoice')
  await expect(page.getByTestId('conclusion')).toContainText('handleInvoice:')

  await answered(page, () => page.goBack())
  await expect(page.getByRole('region', { name: 'Focus' })).toContainText('packages/billing/src/invoice:invoiceTotal')
})
