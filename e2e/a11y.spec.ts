import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { startView, traceIt } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('AC31 same-origin requests only, no serious accessibility violations', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (r) => requests.push(r.url()))
  await page.goto(view.launchUrl)
  await traceIt(page, ['handleInvoice', 'handleInvoice'], ['formatAmount', 'packages/format/src/currency'])
  const serious = async () => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`)
  expect(await serious()).toEqual([])
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  expect(await serious()).toEqual([])
  expect(requests.length).toBeGreaterThan(3)
  for (const url of requests) expect(url.startsWith(view.origin)).toBe(true)
})

test('AC31 reduced motion is honoured', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto(view.launchUrl)
  await expect(page.locator('body')).toHaveAttribute('data-motion', 'reduced')
  await context.close()
})
