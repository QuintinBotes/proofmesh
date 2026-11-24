import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { startView } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('US12 FR061 a claim shows every layer, named by its symbols, and its evidence; tampered evidence shows as an integrity failure in both', async ({ page }) => {
  await page.goto(view.launchUrl)
  await page.locator('.crumbs').waitFor()
  const call = async (tool: string, input: Record<string, unknown>) => (await page.request.post(`${view.origin}/api/v1/tools/${tool}`, { headers: { Origin: view.origin }, data: input })).json()
  const verified = await call('verify_claim', { claim: { statement: 'handleInvoice calls invoiceTotal.', proposition: { type: 'relationship', source: 'function:packages/api/src/handler:handleInvoice', relationship: 'calls', target: 'function:packages/billing/src/invoice:invoiceTotal' } } })
  expect(verified.data.verdict).toBe('supported')

  const ids = Object.fromEntries(await Promise.all(['handleInvoice', 'invoiceTotal'].map(async (name) => [name, (await call('find_symbols', { text: name })).data.symbols.find((s: { name: string }) => s.name === name).id])))
  await call('verify_claim', { claim: { statement: 'By id.', proposition: { type: 'relationship', source: ids.handleInvoice, relationship: 'calls', target: ids.invoiceTotal } } })

  await page.getByRole('tab', { name: 'Claims' }).click()
  await expect(page.getByRole('list', { name: 'Stored claims' }).locator('.claim-text')).toHaveText(['handleInvoice calls invoiceTotal', 'handleInvoice calls invoiceTotal'])
  await page.getByRole('list', { name: 'Stored claims' }).getByRole('button').last().click()
  await expect(page.getByTestId('claim-verdict')).toContainText('supported against snap_')
  const layers = page.getByRole('table', { name: 'Verification layers, in order' })
  await expect(layers.locator('tbody tr td:first-child')).toHaveText(['scope', 'resolution', 'semantic', 'integrity', 'replay', 'independent', 'execution'])
  await expect(layers.locator('tr[data-outcome] >> nth=3')).toHaveAttribute('data-outcome', 'pass')
  await expect(page.getByRole('region', { name: 'Claim evidence' })).toContainText('integrity: verified')
  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)
  expect(serious).toEqual([])

  const evidence = await call('read_evidence', { evidence_ids: verified.data.dependencies.evidence })
  const hash = evidence.data.evidence[0].object_hash as string
  const object = path.join(view.dataDir, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash)
  fs.chmodSync(object, 0o644)
  fs.appendFileSync(object, '// tampered\n')
  await page.getByRole('button', { name: 'Verify again against the current snapshot' }).click()
  await expect(page.getByTestId('claim-verdict')).toContainText('invalid against snap_')
  await expect(layers.locator('tr[data-outcome] >> nth=3')).toHaveAttribute('data-outcome', 'fail')
  await expect(page.getByRole('region', { name: 'Claim evidence' })).toContainText('integrity: failed')
  await expect(page.getByRole('region', { name: 'Claim evidence' })).toContainText('Source unavailable')
})
