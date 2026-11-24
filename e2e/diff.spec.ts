import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { ROOT, startView } from './view'

// compare_snapshots and the snapshot list are served from a recorded envelope, so the view is checked apart from the tool.
const envelope = fs.readFileSync(path.join(ROOT, 'apps', 'observatory', 'test', 'fixtures', 'compare.json'), 'utf8')
const HEAD = JSON.parse(envelope).data.head.snapshot_id as string, BASE = JSON.parse(envelope).data.base.snapshot_id as string

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('FR019 Diff compares a chosen base with the head and shows every change as tiles and an ordered, filterable table', async ({ page }) => {
  await page.route('**/api/v1/snapshots', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ snapshots: [
    { id: HEAD, published_at: '2026-11-09T10:00:00.000Z', analysis_mode: 'no_execution', current: true, git: { available: false } },
    { id: BASE, published_at: '2026-11-08T10:00:00.000Z', analysis_mode: 'no_execution', current: false, git: { available: false } },
  ] }) }))
  const asked: Record<string, unknown>[] = []
  await page.route('**/api/v1/tools/compare_snapshots', (route) => { asked.push(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ contentType: 'application/json', body: envelope }) })
  await page.goto(view.launchUrl)
  await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })

  await page.getByRole('tab', { name: 'Diff' }).click()
  await page.locator('#diff-base').selectOption(BASE)
  await page.getByRole('button', { name: 'Compare' }).click()
  expect(asked).toEqual([{ base_snapshot_id: BASE, snapshot_id: HEAD }])

  const tiles = page.getByRole('list', { name: 'Summary' }).locator('li')
  await expect(tiles).toHaveText([/Symbols added2/, /Symbols removed1/, /Symbols changed2/, /Relationships\+5 −2/, /Files1 added, 0 removed, 2 changed/, /Unresolved4 → 3/])
  const table = page.getByRole('table').filter({ hasText: 'symbol changes' })
  await expect(table.locator('tbody tr td:nth-child(3)')).toHaveText([
    'packages/api/src/handler:Rates', 'packages/api/src/handler:handleInvoice', 'packages/billing/src/invoice:invoiceTax', 'packages/billing/src/invoice:invoiceTotal', 'packages/format/src/currency:legacyFormat',
  ])
  await expect(table.locator('tbody tr').nth(4)).toHaveAttribute('data-change', 'removed')

  // Filters narrow the table; keyboard alone reaches them and the rows' controls.
  await page.getByRole('group', { name: 'Filters' }).getByRole('combobox').selectOption('class')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await page.getByRole('group', { name: 'Filters' }).getByRole('combobox').selectOption('')
  await page.getByRole('checkbox', { name: 'removed' }).focus()
  await page.keyboard.press('Space')
  await expect(table.locator('tbody tr')).toHaveCount(4)
  await page.getByRole('checkbox', { name: 'changed' }).focus()
  await page.keyboard.press('Tab')
  await expect(page.locator(':focus')).toHaveText('Explore')
  await expect(page.getByRole('table').filter({ hasText: 'disposition changed' }).locator('tbody tr')).toHaveText([/packages\/format\/src\/legacy\.jsindexedunsupported/])

  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)
  expect(serious).toEqual([])
})
