import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { startView, traceIt } from './view'

test.describe.configure({ mode: 'serial' })
let view: Awaited<ReturnType<typeof startView>>
let context: BrowserContext
let page: Page

test.beforeAll(async ({ browser }) => {
  view = await startView()
  context = await browser.newContext()
  page = await context.newPage()
  await page.goto(view.launchUrl)
  await page.locator('.crumbs').waitFor()
})
test.afterAll(async () => { await context?.close(); view?.stop() })

test('AC28 the launch URL opens a session, drops its token, and traces the path', async ({}, testInfo) => {
  expect(page.url()).not.toContain('#t=')
  await traceIt(page, ['handleInvoice', 'handleInvoice'], ['formatAmount', 'packages/format/src/currency'])
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const rows = page.getByRole('table', { name: 'Traced nodes in order' }).locator('tbody tr')
  await expect(rows.locator('td:nth-child(3)')).toHaveText([
    'packages/api/src/handler:handleInvoice', 'packages/billing/src/invoice:invoiceTotal', 'packages/format/src/currency:formatAmount',
  ])
  await expect(page.getByTestId('conclusion')).toContainText('Path found')
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await traceIt(page, ['handleInvoice', 'handleInvoice'], ['formatAmount', 'packages/format/src/currency'])
    await page.waitForTimeout(800)
    await page.screenshot({ path: testInfo.outputPath(`trace-${scheme}.png`) })
  }
})

test('AC29 FR058 depth 1 shows the horizon badge, the honest conclusion, and the legend', async () => {
  await traceIt(page, ['handleInvoice', 'handleInvoice'], ['formatAmount', 'packages/format/src/currency'], 1)
  await expect(page.getByText('+1 unexplored · stopped by max_depth').first()).toBeVisible()
  await expect(page.getByTestId('conclusion')).toContainText('this is not evidence that no path exists')
  await expect(page.getByRole('region', { name: 'Legend' })).toContainText('Position carries no meaning; only drawn lines are relationships.')
})
