import { expect, test } from '@playwright/test'
import { startView } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('A11 B17 FR1450 a rebuilt Observatory is never served stale: the page is revalidated and its assets carry a content hash, so they are cached for good', async ({ page }) => {
  const response = await page.goto(view.launchUrl)
  expect(response!.headers()['cache-control']).toBe('no-cache')
  const assets = await page.locator('script[src], link[rel="stylesheet"]').evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? e.getAttribute('href')))
  expect(assets.length).toBeGreaterThan(0)
  for (const a of assets) expect(a).toMatch(/^\/assets\/[\w-]+-[\w-]{8}\.(js|css)$/)
  const asset = await page.request.get(`${view.origin}${assets[0]}`)
  // A rebuild gives a changed asset a new name, so the old one may be kept for good (FR1450).
  expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
})
