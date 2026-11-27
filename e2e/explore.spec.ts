import { expect, test } from '@playwright/test'
import { answered, startView } from './view'

// Each test opens its own view: a launch link works once.
let view: Awaited<ReturnType<typeof startView>>
test.beforeEach(async () => { view = await startView() })
test.afterEach(() => view?.stop())

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

test('FR640 the conclusion stays busy until every query in flight has answered, so a click during the first load is not reported done early', async ({ page }) => {
  // Hold the first load's get_overview and the clicked starting point's card, then let the first load finish alone.
  let releaseOverview!: () => void, releaseFocus!: () => void, focusAsked!: () => void
  const overviewHeld = new Promise<void>((r) => { releaseOverview = r }), focusHeld = new Promise<void>((r) => { releaseFocus = r }), asked = new Promise<void>((r) => { focusAsked = r })
  await page.route('**/api/v1/tools/get_overview', async (route) => { await overviewHeld; await route.continue() })
  await page.route('**/api/v1/tools/get_symbol_card', async (route) => { focusAsked(); await focusHeld; await route.continue() })
  await page.goto(view.launchUrl)
  await page.getByRole('tab', { name: 'Explore' }).click()
  await page.getByRole('region', { name: 'Start exploring' }).getByRole('button').filter({ hasText: 'packages/billing/src/invoice:invoiceTotal' }).click()
  await asked
  const conclusion = page.getByTestId('conclusion')
  const before = await conclusion.getAttribute('data-answered')
  releaseOverview()
  await expect(conclusion).not.toHaveAttribute('data-answered', before ?? '0')
  await expect(conclusion).toHaveAttribute('aria-busy', 'true')
  await expect(conclusion).toHaveText('Loading…')
  await answered(page, async () => releaseFocus())
  await expect(page).toHaveURL(/\?focus=sym_[0-9a-z]+$/)
  await expect(conclusion).toHaveText('invoiceTotal: 1 incoming, 2 outgoing. Click a node to explore from it.')
})
