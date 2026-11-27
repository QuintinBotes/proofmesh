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

for (const colorScheme of ['dark', 'light'] as const) {
  test(`FR1146 SC003 the command palette, open with results, is a labelled dialog that passes axe with no serious violation, ${colorScheme}`, async ({ browser }) => {
    const own = await startView()
    const context = await browser.newContext({ colorScheme })
    try {
      const page = await context.newPage()
      await page.goto(own.launchUrl)
      await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
      await page.keyboard.press('Control+K')
      const palette = page.getByRole('dialog', { name: 'Command palette' })
      const input = palette.getByRole('combobox', { name: 'Find a symbol, file or command' })
      await expect(input).toBeFocused()
      await page.keyboard.type('format')
      const options = palette.getByRole('listbox', { name: 'Results' }).getByRole('option')
      await expect(options.filter({ hasText: 'function · packages/format/src/currency:formatAmount' })).toHaveCount(1)
      await expect(options.filter({ hasText: 'function · packages/legacy/src/format:formatAmount' })).toHaveCount(1)
      // The highlighted option is the combobox's active descendant, so a screen reader announces it as it moves.
      await page.keyboard.press('ArrowDown')
      await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
      await expect(input).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id'))!)
      const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
      expect(serious).toEqual([])
    } finally { await context.close(); own.stop() }
  })
}
