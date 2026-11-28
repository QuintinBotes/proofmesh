import fs from 'node:fs'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { pngText } from '../apps/observatory/src/exporting'
import { answered, serveView, startView } from './view'

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

test('FR1580 the Terrain image is the map at its snapshot positions, and two fresh browser contexts export the same bytes', async ({ browser }, testInfo) => {
  const exported: Array<{ png: Buffer; html: string; positions: Uint16Array }> = []
  for (const run of [1, 2]) {
    // A launch link works once, so each fresh context opens its own view of the same data.
    const v = await serveView(view.dataDir), context = await browser.newContext(), page = await context.newPage()
    try {
      // The payload is read from its snapshot's address (FR1453).
      const response = page.waitForResponse((r) => /\/api\/v1\/galaxy\/v\d+\/[\w-]+$/.test(new URL(r.url()).pathname))
      await page.goto(v.launchUrl)
      const body = await (await response).body(), raw = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body) : body
      const n = raw.readUInt32LE(0), h = JSON.parse(raw.subarray(4, 4 + n).toString('utf8')), base = 4 + n + ((4 - ((4 + n) % 4)) % 4)
      const positions = new Uint16Array(raw.buffer.slice(raw.byteOffset + base + h.offsets.positions, raw.byteOffset + base + h.offsets.positions + h.nodes * 4))
      await page.locator('.terrain[data-ready]').waitFor({ timeout: 60000 })
      const save = async (name: string) => {
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('group', { name: 'Export this view' }).getByRole('button', { name }).click()])
        const file = testInfo.outputPath(`terrain-${run}-${download.suggestedFilename()}`)
        await download.saveAs(file)
        return fs.readFileSync(file)
      }
      exported.push({ png: await save('Export image'), html: (await save('Export page')).toString('utf8'), positions })
      if (run === 2) {
        // Each drawn point's pixel in the image is the symbol colour, at the place the SVG gives it.
        const points = [...exported[0]!.html.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" fill="#aab4c8"\/>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
        const pixels = await page.evaluate(async ({ png, points }) => {
          const img = new Image()
          img.src = `data:image/png;base64,${png}`
          await img.decode()
          const c = document.createElement('canvas')
          c.width = img.naturalWidth; c.height = img.naturalHeight
          const g = c.getContext('2d')!
          g.drawImage(img, 0, 0)
          return points.map((p) => `#${[...g.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data.slice(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`)
        }, { png: exported[0]!.png.toString('base64'), points })
        expect(pixels).toEqual(points.map(() => '#aab4c8'))
      }
    } finally { await context.close(); v.stop() }
  }
  const [a, b] = exported as [typeof exported[0], typeof exported[0]]
  expect(b.png.equals(a.png)).toBe(true)
  expect(b.positions).toEqual(a.positions)
  // One point per symbol, at the payload's place: one scale for both axes (the layout's square frame), y downward as on screen.
  const points = [...a.html.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" fill="#aab4c8"\/>/g)].map((m) => [Number(m[1]), Number(m[2])] as const)
  expect(points).toHaveLength(a.positions.length / 2)
  const px = (i: number) => a.positions[i * 2]!, py = (i: number) => a.positions[i * 2 + 1]!
  const lo = points.reduce((m, _, i) => (px(i) < px(m) ? i : m), 0), hi = points.reduce((m, _, i) => (px(i) > px(m) ? i : m), 0)
  const scale = (points[hi]![0] - points[lo]![0]) / (px(hi) - px(lo))
  expect(scale).toBeGreaterThan(0)
  for (let i = 0; i < points.length; i++) {
    expect(Math.abs(points[i]![0] - points[lo]![0] - (px(i) - px(lo)) * scale)).toBeLessThan(0.2)
    expect(Math.abs(points[i]![1] - points[lo]![1] - (py(i) - py(lo)) * scale)).toBeLessThan(0.2)
  }
  // The caveats and the accessible title stay.
  const caveats = pngText(new Uint8Array(a.png))['proofmesh:caveats']!
  expect(caveats).toContain('scope: the whole snapshot')
  expect(caveats).toContain('Position shows containment: directory, then file, then name.')
  expect(a.html).toMatch(/role="img" aria-label="Terrain: 5 areas"/)
})
