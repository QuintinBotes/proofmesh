import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { answered, openInLens, startView, traceTo } from './view'

// A hub with 30 callers (more than one page of 24) that calls four functions and one name nothing declares.
function hubRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-e2e-lens-'))
  const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text) }
  write('tsconfig.json', '{}\n')
  write('src/steps.ts', 'export function alpha(): number { return 1 }\nexport function beta(): number { return 2 }\nexport function gamma(): number { return 3 }\nexport function delta(): number { return 4 }\n')
  write('src/hub.ts', "import { alpha, beta, gamma, delta } from './steps'\nexport function hub(name: string): number {\n  const a = alpha()\n  const b = beta()\n  const g = gamma()\n  const d = delta()\n  return a + b + g + d + titleCase(name).length\n}\n")
  for (let i = 0; i < 30; i++) write(`src/callers/c${String(i).padStart(2, '0')}.ts`, `import { hub } from '../hub'\nexport function caller${i}(): number {\n  return hub('x')\n}\n`)
  return repo
}

/** The API requests the page makes from now on: a tool by its name, a Galaxy point's by its route. */
const toolRequests = (page: Page) => {
  const seen: string[] = []
  page.on('request', (r) => { const m = /\/api\/v1\/(?:tools\/([a-z_]+)|(galaxy\/symbol))$/.exec(r.url()); if (m) seen.push(m[1] ?? m[2]!) })
  return seen
}
const openHub = async (page: Page, name: string) => {
  await page.getByRole('tab', { name: 'Explore' }).click()
  await answered(page, () => page.getByRole('region', { name: 'Start exploring' }).getByRole('button').filter({ hasText: name }).first().click())
}

test.describe('the Proof lens on the invoicing fixture', () => {
  let view: Awaited<ReturnType<typeof startView>>
  test.beforeEach(async () => { view = await startView() })
  test.afterEach(() => view?.stop())

  test('FR1180 SC-002 opening a symbol makes exactly one request and shows its callers, callees and verified declaration', async ({ page }) => {
    await page.goto(view.launchUrl)
    await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
    await page.getByRole('tab', { name: 'Explore' }).click()
    const hubButton = page.getByRole('region', { name: 'Start exploring' }).getByRole('button').filter({ hasText: 'packages/billing/src/invoice:invoiceTotal' })
    await hubButton.waitFor()
    const seen = toolRequests(page)
    await answered(page, () => hubButton.click())
    await expect(page.getByTestId('evidence-text')).toContainText('export function invoiceTotal')
    expect(seen).toEqual(['get_symbol_card'])
    const lens = page.getByRole('region', { name: 'Proof lens' })
    const callers = lens.getByRole('listbox', { name: 'Callers' }).getByRole('option')
    await expect(callers).toHaveCount(1)
    await expect(callers.first()).toContainText('handleInvoice')
    await expect(callers.first()).toContainText('packages/api/src/handler.ts:5')
    await expect(callers.first()).toContainText('observed')
    await expect(page.getByTestId('outgoing-count')).toHaveText('2 of 2')
    // An external target is a row marked external, at its call site in the repository.
    await expect(lens.getByRole('listbox', { name: 'Callees' }).getByRole('option').filter({ hasText: 'Array.reduce' })).toContainText(/packages\/billing\/src\/invoice\.ts:8.*observed · external/)
    await expect(page.getByRole('complementary', { name: 'Evidence' })).toContainText('integrity: ✓ verified')

    // Opening a row inside the lens asks the server nothing: the card holds its evidence.
    await callers.first().click()
    await expect(page.getByTestId('cited')).toHaveText('invoiceTotal(request.lines, "EUR")')
    await expect(page.getByTestId('evidence-text')).toHaveText('  return invoiceTotal(request.lines, "EUR");')
    expect(seen).toEqual(['get_symbol_card'])
  })

  test('FR1180 a Galaxy search result opens with one request: its point brings its card', async ({ page }) => {
    await page.goto(view.launchUrl)
    await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    await page.getByLabel('Search').fill('invoiceTotal')
    const row = page.getByRole('table').locator('tbody tr').filter({ hasText: 'packages/billing/src/invoice:invoiceTotal' }).first()
    await row.waitFor()
    const seen = toolRequests(page)
    await answered(page, () => row.getByRole('button', { name: 'Explore' }).click())
    await expect(page.getByTestId('evidence-text')).toContainText('export function invoiceTotal')
    await expect(page.getByTestId('incoming-count')).toHaveText('1 of 1')
    expect(seen).toEqual(['galaxy/symbol'])
  })

  test('FR1186 a row the pointer rests on is prefetched once, and the click that follows asks nothing more', async ({ page }) => {
    await page.goto(view.launchUrl)
    await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
    await page.getByRole('tab', { name: 'Explore' }).click()
    const hubButton = page.getByRole('region', { name: 'Start exploring' }).getByRole('button').filter({ hasText: 'packages/billing/src/invoice:invoiceTotal' })
    await hubButton.waitFor()
    const seen = toolRequests(page)
    await hubButton.hover()
    await expect.poll(() => seen.length).toBe(1)
    // Leaving and resting again on a card already held asks nothing.
    await page.mouse.move(0, 0)
    await hubButton.hover()
    await page.waitForTimeout(300)
    await answered(page, () => hubButton.click())
    await expect(page.getByTestId('evidence-text')).toContainText('export function invoiceTotal')
    expect(seen).toEqual(['get_symbol_card'])
  })

  test('FR1182 evidence that fails its integrity check keeps its row, and the code panel says why the source is unavailable', async ({ page }) => {
    await page.goto(view.launchUrl)
    await openHub(page, 'packages/billing/src/invoice:invoiceTotal')
    const focusUrl = page.url()
    const call = async (tool: string, input: Record<string, unknown>) => (await page.request.post(`${view.origin}/api/v1/tools/${tool}`, { headers: { Origin: view.origin }, data: input })).json()
    const id = new URL(focusUrl).searchParams.get('focus')!
    const row = (await call('get_symbol_card', { symbol_id: id })).data.incoming.rows[0]
    const hash = (await call('read_evidence', { evidence_ids: row.evidence_ids })).data.evidence[0].object_hash as string
    const object = path.join(view.dataDir, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash)
    fs.chmodSync(object, 0o644)
    fs.appendFileSync(object, '// tampered\n')
    await answered(page, () => page.reload())
    const caller = page.getByRole('region', { name: 'Proof lens' }).getByRole('listbox', { name: 'Callers' }).getByRole('option')
    await expect(caller).toHaveCount(1)
    await caller.click()
    await expect(page.getByRole('complementary', { name: 'Evidence' })).toContainText('integrity: failed')
    await expect(page.getByTestId('evidence-text')).toHaveText('Source unavailable: the evidence object failed its integrity check or is missing.')
  })

  test('FR1185 a path from the focus reads as a chain of hops, each with its call site, labelled by its weakest hop', async ({ page }) => {
    await page.goto(view.launchUrl)
    await page.locator('.crumbs').waitFor()
    // handleInvoice is no starting point, so it opens by its link.
    const id = (await (await page.request.post(`${view.origin}/api/v1/tools/find_symbols`, { headers: { Origin: view.origin }, data: { text: 'handleInvoice' } })).json()).data.symbols.find((s: { name: string }) => s.name === 'handleInvoice').id as string
    await answered(page, () => page.goto(`${view.origin}/?focus=${id}`))
    await expect(page.getByRole('region', { name: 'Focus' })).toContainText('packages/api/src/handler:handleInvoice')
    await page.fill('#picker-path-to', 'formatAmount')
    await answered(page, () => page.getByRole('listbox', { name: 'Path to candidates' }).getByRole('button').filter({ hasText: 'packages/format/src/currency' }).first().click())
    const hops = page.getByRole('region', { name: 'Path' }).getByRole('listitem')
    await expect(hops).toHaveCount(3)
    await expect(hops.nth(0)).toContainText('handleInvoice')
    await expect(hops.nth(0)).toContainText('calls the next at packages/api/src/handler.ts:5')
    await expect(hops.nth(1)).toContainText('calls the next at packages/billing/src/invoice.ts:9')
    await expect(hops.nth(2)).toContainText('formatAmount')
    await expect(page.getByTestId('path-basis')).toHaveText('observed')
  })

  test('FR1300 the lens replaces the Trace a path tab: it traces from the focus at a chosen depth, says where the search stopped, keeps the table, and clears back to the neighbourhood', async ({ page }) => {
    await page.goto(view.launchUrl)
    await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
    await expect(page.getByRole('tab', { name: 'Trace a path' })).toHaveCount(0)
    await openInLens(page, 'handleInvoice', 'packages/api/src/handler:handleInvoice')
    // Depth 1 stops one hop short: the lens says no path was found and names the horizon, in words.
    await traceTo(page, ['formatAmount', 'packages/format/src/currency'], 1)
    const path = page.getByRole('region', { name: 'Path' })
    await expect(page.getByTestId('path-basis')).toHaveText('no path')
    await expect(path.getByRole('list', { name: 'Horizon' })).toContainText('packages/billing/src/invoice:invoiceTotal: +1 unexplored · stopped by max_depth')
    await expect(page.getByTestId('conclusion')).toContainText('this is not evidence that no path exists')
    // A deeper search of the same pair, from the lens, finds the path; its table equivalent lists the hops in order.
    await page.focus('#depth')
    await page.keyboard.press('End')
    await answered(page, () => page.getByRole('button', { name: 'Trace again' }).click())
    await expect(page.getByTestId('path-basis')).toHaveText('observed')
    await expect(path.getByRole('listitem')).toHaveCount(3)
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    await expect(page.getByRole('table', { name: 'Traced nodes in order' }).locator('tbody tr td:nth-child(3)')).toHaveText([
      'packages/api/src/handler:handleInvoice', 'packages/billing/src/invoice:invoiceTotal', 'packages/format/src/currency:formatAmount',
    ])
    // Clearing the path returns the lens, and its table, to the focus's neighbourhood.
    await page.getByRole('button', { name: 'Graph', exact: true }).click()
    await path.getByRole('button', { name: 'Clear path' }).click()
    await expect(page.getByRole('region', { name: 'Path' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    await expect(page.getByRole('table', { name: 'Symbol and its neighbours' })).toBeVisible()
  })
})

test.describe('the Proof lens on a hub', () => {
  let view: Awaited<ReturnType<typeof startView>>
  test.beforeEach(async () => { view = await startView(hubRepo()) })
  test.afterEach(() => view?.stop())

  test('FR1184 SC-003 keyboard only: open a symbol, walk to the third callee and show its call site, with no pointer event and no request', async ({ page }) => {
    await page.goto(view.launchUrl)
    await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
    // Counts every pointer event from here on; a key that activates a button fires no pointer event.
    await page.evaluate(() => { const w = window as unknown as { pointerEvents: number }; w.pointerEvents = 0; for (const t of ['pointerdown', 'pointermove', 'mousedown']) window.addEventListener(t, () => { w.pointerEvents++ }, true) })
    // Tab to the Explore tab and open it, then Tab to the first starting point, the hub, and open it.
    await page.locator('body').focus()
    for (let i = 0; i < 40 && !(await page.evaluate(() => document.activeElement?.textContent === 'Explore')); i++) await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    for (let i = 0; i < 40 && !(await page.evaluate(() => /src\/hub:hub/.test(document.activeElement?.textContent ?? ''))); i++) await page.keyboard.press('Tab')
    await answered(page, () => page.keyboard.press('Enter'))
    await expect(page.getByTestId('evidence-text')).toContainText('export function hub')
    const seen = toolRequests(page)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('cited')).toHaveText('gamma()')
    await expect(page.getByRole('complementary', { name: 'Evidence' })).toContainText('src/hub.ts:5')
    await expect(page.getByRole('listbox', { name: 'Callees' }).getByRole('option', { selected: true })).toContainText('gamma')
    expect(seen).toEqual([])
    expect(await page.evaluate(() => (window as unknown as { pointerEvents: number }).pointerEvents)).toBe(0)
    // f makes the selected row the focus.
    await answered(page, () => page.keyboard.press('f'))
    await expect(page).toHaveURL(/\?focus=sym_/)
    await expect(page.getByRole('region', { name: 'Focus' })).toContainText('src/steps:gamma')
  })

  test('FR1183 an unresolved call is a row with its reason and a dotted marker, never omitted', async ({ page }) => {
    await page.goto(view.launchUrl)
    await openHub(page, 'src/hub:hub')
    const row = page.getByRole('listbox', { name: 'Callees' }).getByRole('option').filter({ hasText: 'titleCase(name)' })
    await expect(row).toContainText('src/hub.ts:7')
    await expect(row).toContainText('unresolved · unknown_name')
    await expect(row).toHaveAttribute('data-mark', 'unresolved')
    await expect(row).toHaveCSS('border-left-style', 'dotted')
    const observed = page.getByRole('listbox', { name: 'Callees' }).getByRole('option').filter({ hasText: 'alpha' })
    await expect(observed).toHaveCSS('border-left-style', 'solid')
  })

  test('FR058 FR1181 a hub lists 24 callers of 30, the count always shown, and the rest page in as the list scrolls', async ({ page }) => {
    await page.goto(view.launchUrl)
    await openHub(page, 'src/hub:hub')
    await expect(page.getByTestId('incoming-count')).toHaveText('24 of 30')
    const seen = toolRequests(page)
    const callers = page.getByRole('listbox', { name: 'Callers' })
    await callers.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(page.getByTestId('incoming-count')).toHaveText('30 of 30')
    await expect(callers.getByRole('option')).toHaveCount(30)
    expect(seen).toEqual(['get_symbol_card'])
  })
})
