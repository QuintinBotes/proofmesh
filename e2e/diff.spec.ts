import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { answered, CLI, openInLens, ROOT, startView } from './view'

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
  const table = page.getByRole('table').filter({ hasText: /symbol changes?, by path/ })
  await expect(table.locator('tbody tr td:nth-child(3)')).toHaveText([
    'packages/api/src/handler:Rates', 'packages/api/src/handler:handleInvoice', 'packages/billing/src/invoice:invoiceTax', 'packages/billing/src/invoice:invoiceTotal', 'packages/format/src/currency:legacyFormat',
  ])
  await expect(table.locator('tbody tr').nth(4)).toHaveAttribute('data-change', 'removed')

  // Filters narrow the table; keyboard alone reaches them and the rows' controls.
  await page.getByRole('group', { name: 'Filters' }).getByRole('combobox').selectOption('class')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table.locator('caption')).toHaveText('1 symbol change, by path then name')
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

test('FR1301 FR1302 after exploring a symbol, Diff draws no other view over its controls, and a row opens in the lens with one request: the comparison holds each head symbol id', async ({ page }) => {
  // The invoicing fixture, indexed, then changed and indexed again, so the comparison is of two real snapshots.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-e2e-diff-'))
  fs.cpSync(path.join(ROOT, 'fixtures', 'ts-invoicing', 'repo'), repo, { recursive: true })
  const own = await startView(repo)
  try {
    const invoice = path.join(repo, 'packages', 'billing', 'src', 'invoice.ts')
    fs.writeFileSync(invoice, fs.readFileSync(invoice, 'utf8').replace('return formatAmount(cents, currency);', 'const rounded = Math.round(cents);\n  return formatAmount(rounded, currency);'))
    const r = spawnSync(process.execPath, [CLI, '--data-dir', own.dataDir, 'index', repo], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`second index failed: ${r.stderr}`)
    await page.goto(own.launchUrl)
    await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
    // A symbol explored first: its neighbourhood belongs to Explore, so Diff must not draw it, nor say its conclusion.
    await openInLens(page, 'formatAmount', 'packages/format/src/currency:formatAmount')
    await page.getByRole('tab', { name: 'Diff' }).click()
    await expect(page.locator('.graph-wrap')).toHaveCount(0)
    await expect(page.getByTestId('conclusion')).toHaveText('')
    await page.locator('#diff-base').selectOption({ index: 1 })
    await answered(page, () => page.getByRole('button', { name: 'Compare' }).click())
    const row = page.getByRole('table').filter({ hasText: /symbol changes?, by path/ }).locator('tbody tr').filter({ hasText: 'packages/billing/src/invoice:invoiceTotal' })
    await expect(row).toHaveAttribute('data-change', 'changed')
    const seen: string[] = []
    page.on('request', (q) => { const m = /\/api\/v1\/tools\/([a-z_]+)$/.exec(q.url()); if (m) seen.push(m[1]!) })
    await answered(page, () => row.getByRole('button', { name: 'Explore' }).click())
    await expect(page.getByRole('region', { name: 'Focus' })).toContainText('packages/billing/src/invoice:invoiceTotal')
    // The head snapshot's declaration, with the changed body, is what the evidence panel shows.
    await expect(page.getByTestId('evidence-text')).toContainText('const rounded = Math.round(cents);')
    expect(seen).toEqual(['get_symbol_card'])
  } finally { own.stop() }
})
