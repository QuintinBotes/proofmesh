import { expect, test } from '@playwright/test'
import { serveView, startView, traceIt } from './view'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView() })
test.afterAll(() => view?.stop())

test('AC30 repository content renders as text: no markup injection, bidi characters made visible', async ({ page }) => {
  let dialogs = 0
  page.on('dialog', async (d) => { dialogs++; await d.dismiss() })
  await page.goto(view.launchUrl)
  await traceIt(page, ['handleInvoice', 'handleInvoice'], ['formatAmount', 'packages/format/src/currency'])
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await page.getByRole('table', { name: 'Traced nodes in order' }).locator('tbody tr').first().getByRole('button', { name: 'Show evidence' }).click()
  const panel = page.getByRole('complementary', { name: 'Evidence' })
  await expect(panel.getByTestId('evidence-text')).toContainText('<img src=x onerror=alert(1)>')
  await expect(panel.locator('img')).toHaveCount(0)

  await traceIt(page, ['dispatch', 'dispatch'], ['formatAmount', 'packages/legacy/src/format'])
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await page.getByRole('table', { name: 'Traced nodes in order' }).locator('tbody tr[data-role="unreached-target"]').getByRole('button', { name: 'Show evidence' }).click()
  await expect(panel.getByTestId('evidence-text')).toContainText('⟨U+202E⟩')
  await expect(page.getByRole('list', { name: 'Unresolved boundaries' })).toContainText('dynamic_element_access')
  expect(dialogs).toBe(0)
})

test('FR1450 FR1453 a cold load gets every script compressed and immutable, the page revalidated, API answers unstored, and the Galaxy again from the HTTP cache on reload', async ({ page }) => {
  const own = await serveView(view.dataDir)
  try {
    const responses: Array<{ url: string; type: string; headers: Record<string, string> }> = []
    page.on('response', (r) => responses.push({ url: new URL(r.url()).pathname, type: r.request().resourceType(), headers: r.headers() }))
    await page.goto(own.launchUrl)
    // Drawn: every script the Galaxy loads has arrived, so the reload below finds it all in the cache.
    await page.locator('.galaxy[data-ready]').waitFor({ timeout: 60000 })
    expect(responses.find((r) => r.type === 'document')!.headers['cache-control']).toBe('no-cache')
    const assets = responses.filter((r) => r.url.startsWith('/assets/'))
    expect(assets.filter((r) => r.type === 'script').length).toBeGreaterThan(0)
    for (const a of assets) {
      expect(['br', 'gzip'], a.url).toContain(a.headers['content-encoding'])
      expect(a.headers['cache-control'], a.url).toBe('public, max-age=31536000, immutable')
    }
    const api = responses.filter((r) => r.url.startsWith('/api/') && !/^\/api\/v1\/galaxy\/v\d+\//.test(r.url))
    expect(api.length).toBeGreaterThan(0)
    for (const a of api) expect(a.headers['cache-control'], a.url).toBe('no-store')
    const galaxy = responses.find((r) => /^\/api\/v1\/galaxy\/v\d+\/snap_\w+$/.test(r.url))!
    expect(galaxy.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    // Every response keeps the strict policy (FR065).
    for (const r of responses) expect(r.headers['content-security-policy'], r.url).toMatch(/^default-src 'self'; script-src 'self';/)

    await page.reload()
    await page.locator('.galaxy[data-ready]').waitFor({ timeout: 60000 })
    const again = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/api\/v1\/galaxy\/v\d+\//.test(e.name) || /\/assets\/.*\.js$/.test(e.name)).map((e) => [new URL(e.name).pathname, (e as PerformanceResourceTiming).transferSize] as const))
    expect(again.some(([u]) => u.startsWith('/api/v1/galaxy/'))).toBe(true)
    // Served from the HTTP cache: nothing crossed the wire.
    for (const [u, bytes] of again) expect(bytes, u).toBe(0)
  } finally { own.stop() }
})
