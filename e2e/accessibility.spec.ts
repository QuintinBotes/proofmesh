import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import path from 'node:path'
import { answered, ROOT, startView, traceIt } from './view'

// Each test opens its own view: a launch link works once.
async function open(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}, fixture?: string) {
  const view = await startView(fixture)
  const context = await browser.newContext(options)
  const page = await context.newPage()
  await page.goto(view.launchUrl)
  await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  return { page, close: async () => { await context.close(); view.stop() } }
}
const serious = async (page: Page, where: string) =>
  (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)

for (const colorScheme of ['dark', 'light'] as const) {
  test(`NFR012 SC013 every view and its table pass axe with no serious violation, ${colorScheme}`, async ({ browser }) => {
    // Six views and a traced path, each checked as graph and as table: well over the default budget on a laptop.
    test.setTimeout(180000)
    const { page, close } = await open(browser, { colorScheme })
    try {
      const found: string[] = []
      const both = async (where: string) => {
        found.push(...await serious(page, `${where} graph`))
        await page.getByRole('button', { name: 'Table', exact: true }).click()
        await expect(page.locator('.table-view table').first()).toBeVisible()
        found.push(...await serious(page, `${where} table`))
        await page.getByRole('button', { name: 'Graph', exact: true }).click()
      }
      await both('Galaxy')
      await page.getByRole('tab', { name: 'Map' }).click()
      await expect(page.getByRole('navigation', { name: 'Location' })).toBeVisible()
      await both('Map')
      await page.getByRole('tab', { name: 'Explore' }).click()
      await answered(page, () => page.getByRole('region', { name: 'Start exploring' }).getByRole('button').filter({ hasText: 'packages/billing/src/invoice:invoiceTotal' }).click())
      await both('Explore')
      await traceIt(page, ['handleInvoice', 'handleInvoice'], ['formatAmount', 'packages/format/src/currency'])
      await both('Trace')
      await page.getByRole('tab', { name: 'Claims' }).click()
      await expect(page.getByRole('heading', { name: 'No claims yet' })).toBeVisible()
      found.push(...await serious(page, 'Claims'))
      expect(found).toEqual([])
    } finally { await close() }
  })
}

test('FR067 a request for more contrast is honoured: secondary text and lines take full contrast', async ({ browser }) => {
  const { page, close } = await open(browser, { contrast: 'more' })
  try {
    const colour = (selector: string, property: string) => page.locator(selector).first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), property)
    expect(await colour('[data-testid=conclusion] ~ * .dim, .dim', 'color')).toBe(await colour('body', 'color'))
    expect(await colour('.top', 'border-bottom-color')).toBe(await colour('body', 'color'))
    expect(await serious(page, 'Galaxy, more contrast')).toEqual([])
  } finally { await close() }
})

test('NFR012 everything can be done with the keyboard alone: search, explore, trace, read the evidence, open Claims', async ({ browser }) => {
  const { page, close } = await open(browser)
  // Moves focus with Tab only, until the focused control has the given accessible name.
  const tabTo = async (name: string | RegExp) => {
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press('Tab')
      const label = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null
        const own = a instanceof HTMLInputElement ? a.labels?.[0]?.textContent ?? a.getAttribute('aria-label') : a?.getAttribute('aria-label') ?? a?.textContent
        return (own ?? '').trim()
      })
      if (typeof name === 'string' ? label === name : name.test(label)) return
    }
    throw new Error(`Tab never reached ${name}`)
  }
  try {
    // `/` opens the command palette (FR1140), so the search box is reached with Tab like any other control.
    await tabTo('Search')
    await page.keyboard.type('invoiceTotal')
    await expect(page.getByTestId('conclusion')).toContainText('“invoiceTotal”: showing the 1 matching symbol;')
    await tabTo('Table')
    await page.keyboard.press('Enter')
    await tabTo('Explore')
    await answered(page, () => page.keyboard.press('Enter'))
    await expect(page.getByRole('region', { name: 'Focus' })).toContainText('packages/billing/src/invoice:invoiceTotal')
    // The lens traces from its focus (FR1300): picking the target with Enter traces the path.
    await tabTo('Path to')
    await page.keyboard.type('formatAmount')
    await expect(page.getByRole('listbox', { name: 'Path to candidates' })).toBeVisible()
    await tabTo(/^formatAmount function · packages\/format\/src\/currency:formatAmount/)
    await answered(page, () => page.keyboard.press('Enter'))
    await expect(page.getByTestId('conclusion')).toContainText('Path found')
    await expect(page.getByRole('region', { name: 'Path' }).getByRole('listitem').first()).toContainText('invoiceTotal')
    await tabTo('Table')
    await page.keyboard.press('Enter')
    await tabTo('Show evidence')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('evidence-text')).toContainText('export function invoiceTotal')
    await tabTo('Claims')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'No claims yet' })).toBeVisible()
  } finally { await close() }
})

test('NFR012 FR1140 FR1145 on the TypeORM sample, Control+K, a name and Enter select the symbol, show its evidence and put focus in it, with the keyboard alone', async ({ browser }) => {
  const { page, close } = await open(browser, {}, path.join(ROOT, 'fixtures', 'ts-typeorm', 'repo'))
  try {
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await page.keyboard.press('Control+K')
    await expect(palette).toBeVisible()
    await page.keyboard.type('initialize')
    await answered(page, () => page.keyboard.press('Enter'))
    await expect(palette).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Explore' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('region', { name: 'Focus' })).toContainText('src/data-source:DataSource.initialize')
    const evidence = page.getByRole('complementary', { name: 'Evidence' })
    await expect(evidence.getByRole('heading')).toHaveText('src/data-source:DataSource.initialize')
    await expect(evidence.getByTestId('evidence-text')).toContainText('async initialize(): Promise<this>')
    await expect(evidence).toBeFocused()
  } finally { await close() }
})
