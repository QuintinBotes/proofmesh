import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { pngText } from '../apps/observatory/src/exporting'
import { answered, startView } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('FR064 FR052 an export carries its caveats, loads nothing, and includes source only with consent', async ({ page, browser }, testInfo) => {
  await page.goto(view.launchUrl)
  await page.getByRole('tab', { name: 'Explore' }).click()
  await answered(page, () => page.getByRole('region', { name: 'Start exploring' }).getByRole('button').filter({ hasText: 'packages/billing/src/invoice:invoiceTotal' }).click())
  await expect(page.getByTestId('evidence-text')).toContainText('export function invoiceTotal')
  const exports = page.getByRole('group', { name: 'Export this view' })
  const save = async (name: string) => {
    const [download] = await Promise.all([page.waitForEvent('download'), exports.getByRole('button', { name }).click()])
    const file = testInfo.outputPath(`${name.replace(' ', '-')}-${Date.now()}-${download.suggestedFilename()}`)
    await download.saveAs(file)
    return file
  }

  const withoutConsent = fs.readFileSync(await save('Export page'), 'utf8')
  expect(withoutConsent).toContain('Proofmesh Explore · repository ')
  expect(withoutConsent).toMatch(/snapshot snap_[0-9a-f]{24} · analysis mode no execution/)
  expect(withoutConsent).toContain('scope: relationships of packages/billing/src/invoice:invoiceTotal')
  expect(withoutConsent).toContain('unresolved: the target is unknown')
  expect(withoutConsent).toContain('no source code included')
  expect(withoutConsent).not.toContain('export function invoiceTotal')

  await exports.getByRole('checkbox', { name: 'include the source shown in the evidence panel' }).check()
  const file = await save('Export page')
  const withConsent = fs.readFileSync(file, 'utf8')
  expect(withConsent).toContain('source included with consent: packages/billing/src/invoice.ts from line')
  expect(withConsent).toContain('export function invoiceTotal')

  // Opened on its own, the page asks for nothing beyond itself.
  const offline = await browser.newPage()
  const url = pathToFileURL(file).href
  const requests: string[] = []
  offline.on('request', (r) => { if (r.url() !== url) requests.push(r.url()) })
  await offline.goto(url)
  await expect(offline.getByRole('heading', { name: 'Proofmesh Explore' })).toBeVisible()
  expect(requests).toEqual([])
  await offline.close()

  const png = fs.readFileSync(await save('Export image'))
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const caveats = pngText(new Uint8Array(png))['proofmesh:caveats']!
  expect(caveats).toContain('scope: relationships of packages/billing/src/invoice:invoiceTotal')
  expect(caveats).toContain('source included with consent: packages/billing/src/invoice.ts')
})
