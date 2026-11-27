// NFR005: measures the Observatory's frame times and interaction latencies against the published budgets, on an indexed data directory.
// Usage: node bench/observatory/frames.mjs --data-dir <dir> [--workspace W --repository R] [--query <text>] [--palette-query <text>] [--headed] [--out <file.json>]
// With several repositories registered, --workspace and --repository open the Galaxy of one of them through a deep link.
// It starts `proofmesh view` on the data directory, opens the Galaxy in Chromium, and records: time to the first drawn galaxy and to its
// final positions, frame times at rest and while panning and zooming, search latency, and the time to switch to the Map, one second
// after the search is cleared. Then, over the Map, the command palette (#43): from a query set in its field to the count of matches
// painted, twenty times, and the main-thread long tasks (over 50 ms) while a ten-character query is typed a key at a time. The browser's
// WebGL renderer is recorded, because a software renderer (SwiftShader) measures the CPU, not the GPU a person's browser would use.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { chromium } from '@playwright/test'

export const BUDGETS = { first_draw_ms: 10000, frame_p95_idle_ms: 17, frame_p95_pan_zoom_ms: 33, search_ms: 200, map_switch_ms: 2000, palette_p95_ms: 50, palette_long_task_ms: 50 }
const PALETTE_QUERIES = ['init', 'order', 'payment', 'load', 'render', 'conn', 'query', 'build', 'parse', 'format']

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1] }
const dataDir = flag('--data-dir'), query = flag('--query') ?? 'order', paletteQuery = flag('--palette-query') ?? 'initialize', out = flag('--out'), workspace = flag('--workspace'), repository = flag('--repository')
if (!dataDir) { console.error('usage: node bench/observatory/frames.mjs --data-dir <dir> [--query <text>] [--headed] [--out <file.json>]'); process.exit(2) }
const CLI = path.join(import.meta.dirname, '..', '..', 'packages', 'proofmesh', 'bin', 'proofmesh.mjs')

const view = spawn(process.execPath, [CLI, '--data-dir', dataDir, 'view', '--port', '0', '--no-open'], { stdio: ['ignore', 'pipe', 'inherit'] })
const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('proofmesh view printed no URL')), 30000)
  readline.createInterface({ input: view.stdout }).on('line', (l) => { const m = /^Observatory: (http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64})$/.exec(l); if (m) { clearTimeout(t); resolve(m[1]) } })
})
const browser = await chromium.launch({ headless: !args.includes('--headed'), args: ['--ignore-gpu-blocklist', '--enable-gpu'] })
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null }
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  // A page error means the view is broken; stop at once rather than wait out a timeout.
  const pageErrors = []
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.error(`page error: ${e.message}`); process.exitCode = 1; browser.close().finally(() => { view.kill(); process.exit(1) }) })
  const conclusion = page.getByTestId('conclusion')
  const t0 = Date.now()
  const u = new URL(url)
  await page.goto(workspace && repository ? `${u.origin}/?workspace=${encodeURIComponent(workspace)}&repository=${encodeURIComponent(repository)}${u.hash}` : url)
  await conclusion.filter({ hasText: /symbols in \d/ }).waitFor({ timeout: 300000 })
  const firstDraw = Date.now() - t0
  const summary = (await conclusion.textContent()).trim()
  // Positions come with the snapshot (FR1223): the layout is final once the area labels are placed on the first drawn frame.
  await page.locator('.galaxy-label').first().waitFor({ timeout: 600000 })
  const settled = Date.now() - t0
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : 'no WebGL'
  })
  // Frame times: every requestAnimationFrame interval for a while, at rest and then while the mouse pans and zooms the canvas.
  const frames = (ms) => page.evaluate((ms) => new Promise((resolve) => {
    const ts = []; const end = performance.now() + ms
    const tick = (t) => { ts.push(t); if (t < end) requestAnimationFrame(tick); else resolve(ts.slice(1).map((x, i) => x - ts[i])) }
    requestAnimationFrame(tick)
  }), ms)
  const idle = await frames(3000)
  const canvas = await page.locator('canvas').first().boundingBox()
  const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2
  const moving = frames(5000)
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, i % 2 ? 300 : -300)
    await page.mouse.down()
    await page.mouse.move(cx + 120, cy + 60, { steps: 8 })
    await page.mouse.up()
  }
  const panZoom = await moving
  // Search: from typing the query to the status line naming the matches, five times.
  const search = []
  for (let i = 0; i < 5; i++) {
    await page.getByLabel('Search').fill('')
    const s = Date.now()
    await page.getByLabel('Search').fill(query)
    await page.getByRole('status').filter({ hasText: new RegExp(`“${query}”: [\\d,]+ of`) }).first().waitFor({ timeout: 60000 })
    search.push(Date.now() - s)
  }
  await page.getByLabel('Search').fill('')
  // A person pauses between actions; without it the Map switch would also time the full galaxy's return after the search clears.
  await page.waitForTimeout(1000)
  // The Map's data loads with the page, so switching asks the server nothing. Timed inside the page, from the tab's click to the Map's
  // graph mounted and two frames painted: once cold (the first WebGL programs of its context compile then) and once warm.
  const switchTo = (name, ready) => page.evaluate(({ name, ready }) => new Promise((resolve) => {
    const tab = [...document.querySelectorAll('[role=tab]')].find((e) => e.textContent === name)
    const t0 = performance.now(); tab.click()
    const poll = () => (document.querySelector(ready) ? requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - t0)))) : requestAnimationFrame(poll))
    poll()
  }), { name, ready })
  const mapCold = await switchTo('Map', '[aria-label="Graph controls"]')
  await switchTo('Galaxy', '[aria-label="Galaxy controls"]')
  const mapSwitch = await switchTo('Map', '[aria-label="Graph controls"]')
  await page.keyboard.press('Control+K')
  const paletteStatus = page.getByRole('dialog', { name: 'Command palette' }).getByRole('status')
  await page.getByRole('combobox', { name: 'Find a symbol, file or command' }).fill(paletteQuery.slice(0, 2))
  await paletteStatus.filter({ hasText: /match/ }).waitFor({ timeout: 120000 })
  // Timed inside the page: the field is set as typing sets it, and the clock stops at the frame after the count changes.
  const paletteMs = []
  for (let i = 0; i < 20; i++) {
    paletteMs.push(await page.evaluate((q) => new Promise((resolve) => {
      const input = document.querySelector('[role=dialog] input'), status = document.querySelector('[role=dialog] [role=status]')
      const set = (v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v); input.dispatchEvent(new Event('input', { bubbles: true })) }
      set('')
      requestAnimationFrame(() => {
        const t0 = performance.now()
        const seen = new MutationObserver(() => { if (/match/.test(status.textContent)) { seen.disconnect(); requestAnimationFrame(() => resolve(performance.now() - t0)) } })
        seen.observe(status, { childList: true, characterData: true, subtree: true })
        set(q)
      })
    }), PALETTE_QUERIES[i % PALETTE_QUERIES.length]))
  }
  await page.evaluate(() => { window.longTasks = []; new PerformanceObserver((l) => window.longTasks.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask' }) })
  await page.getByRole('combobox', { name: 'Find a symbol, file or command' }).fill('')
  await page.keyboard.type(paletteQuery, { delay: 100 })
  await paletteStatus.filter({ hasText: /match/ }).waitFor({ timeout: 60000 })
  await page.waitForTimeout(500)
  const longTasks = await page.evaluate(() => window.longTasks)
  const result = {
    measured_at: new Date().toISOString(), hardware: `${os.cpus()[0].model}, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.type()} ${os.release()}`, browser: `Chromium ${browser.version()}`, webgl_renderer: renderer,
    headless: !args.includes('--headed'), galaxy: summary, query,
    first_draw_ms: firstDraw, settled_ms: settled,
    frame_ms_idle: { p50: pct(idle, 0.5), p95: pct(idle, 0.95), max: pct(idle, 1), frames: idle.length },
    frame_ms_pan_zoom: { p50: pct(panZoom, 0.5), p95: pct(panZoom, 0.95), max: pct(panZoom, 1), frames: panZoom.length },
    search_ms: { median: pct(search, 0.5), max: Math.max(...search) }, map_switch_ms: mapSwitch, map_switch_cold_ms: mapCold,
    palette_ms: { p50: pct(paletteMs, 0.5), p95: pct(paletteMs, 0.95), max: pct(paletteMs, 1), runs: paletteMs.map((x) => Math.round(x)) },
    palette_typing: { query: paletteQuery, long_tasks: longTasks.length, longest_ms: longTasks.length ? Math.round(Math.max(...longTasks)) : 0 }, budgets: BUDGETS,
  }
  result.within_budget = {
    first_draw: result.first_draw_ms <= BUDGETS.first_draw_ms, frame_idle: result.frame_ms_idle.p95 <= BUDGETS.frame_p95_idle_ms,
    frame_pan_zoom: result.frame_ms_pan_zoom.p95 <= BUDGETS.frame_p95_pan_zoom_ms, search: result.search_ms.median <= BUDGETS.search_ms, map_switch: mapSwitch <= BUDGETS.map_switch_ms,
    palette: result.palette_ms.p95 <= BUDGETS.palette_p95_ms, palette_typing: result.palette_typing.longest_ms <= BUDGETS.palette_long_task_ms,
  }
  console.log(JSON.stringify(result, null, 2))
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n') }
} finally {
  await browser.close()
  view.kill()
}
