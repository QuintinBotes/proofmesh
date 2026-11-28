// FR1187: measures symbol to evidence in Observatory, from the click on a search result to the declaration's source text shown, and
// counts the requests made between, against SC-001's bar: p95 <= 150 ms warm, <= 400 ms on the first open of a page.
// Usage: node bench/observatory/evidence.mjs --data-dir <dir> --symbol <qualified name> [--runs N] [--out <file.json>] [--screenshot <file.png>] [--check]
// Each run opens a fresh page of one browser on `proofmesh view`, searches the Galaxy for the symbol's name, and in its table clicks
// Explore on the symbol: that open is the run's first open. A second fresh page opens another match of the same search, then the
// symbol: that is the run's warm open, and as the page holds no card for the symbol, the request it needs is made and timed. Times are
// taken inside the page, from the click to the first frame showing the evidence panel naming the symbol with its text. The machine's
// load is recorded beside them.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { chromium } from '@playwright/test'

export const BUDGETS = { warm_p95_ms: 150, first_open_p95_ms: 400, requests_per_open: 1 }

const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1] }
const dataDir = flag('--data-dir'), symbol = flag('--symbol'), runs = Number(flag('--runs') ?? 10), out = flag('--out'), shot = flag('--screenshot')
if (!dataDir || !symbol || !(runs > 0)) { console.error('usage: node bench/observatory/evidence.mjs --data-dir <dir> --symbol <qualified name> [--runs N] [--out <file.json>] [--screenshot <file.png>] [--check]'); process.exit(2) }
const CLI = path.join(import.meta.dirname, '..', '..', 'packages', 'proofmesh', 'bin', 'proofmesh.mjs')
const short = symbol.split(':').pop().split('.').pop()

const view = spawn(process.execPath, [CLI, '--data-dir', dataDir, 'view', '--port', '0', '--no-open'], { stdio: ['ignore', 'pipe', 'inherit'] })
const launch = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('proofmesh view printed no URL')), 30000)
  readline.createInterface({ input: view.stdout }).on('line', (l) => { const m = /^Observatory: (http:\/\/(?:localhost|127\.0\.0\.1):\d+\/#t=[0-9a-f]{64})$/.exec(l); if (m) { clearTimeout(t); resolve(m[1]) } })
})
const load = { before: os.loadavg(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model ?? 'unknown', memory_gb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`, node: process.version }
const browser = await chromium.launch({ headless: !args.includes('--headed') })
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] * 10) / 10 : null }
const stats = (xs) => ({ runs: xs.length, median: pct(xs, 0.5), p95: pct(xs, 0.95), max: pct(xs, 1), all: xs.map((x) => Math.round(x * 10) / 10) })
const first = [], warm = [], requests = [], rows = []
try {
  // A launch link works once: the first page takes the session, and every later page of the context shares its cookie.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  let session = false
  // A fresh page on the Galaxy, with the API requests it makes and a timed open of a search result.
  const fresh = async () => {
    const page = await context.newPage()
    page.on('pageerror', (e) => { console.error(`page error: ${e.message}`); process.exitCode = 1 })
    const asked = []
    page.on('request', (q) => { if (/\/api\/v1\/(tools\/[a-z_]+|galaxy\/symbol)$/.test(q.url())) asked.push(new URL(q.url()).pathname) })
    await page.goto(session ? new URL(launch).origin + '/' : launch)
    session = true
    await page.getByTestId('conclusion').filter({ hasText: /symbols in \d/ }).waitFor({ timeout: 300000 })
    // Clicks a search result's Explore and returns the time, taken in the page, from the click to the first frame in which the evidence
    // panel names the symbol with its text, and the requests made between.
    const timed = async (name) => {
      if ((await page.getByRole('tab', { name: 'Galaxy' }).getAttribute('aria-selected')) !== 'true') await page.getByRole('tab', { name: 'Galaxy' }).click()
      await page.getByRole('button', { name: 'Table', exact: true }).click()
      await page.getByLabel('Search').fill(short)
      const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
      const button = page.getByRole('table').locator('tbody tr').filter({ has: page.locator('td:nth-child(3)', { hasText: exact }) }).first().getByRole('button', { name: 'Explore' })
      await button.waitFor()
      await page.evaluate(() => { window.__t0 = 0; window.addEventListener('click', () => { window.__t0 = performance.now() }, { capture: true, once: true }) })
      const before = asked.length
      const shown = page.waitForFunction((title) => {
        const t = document.querySelector('.ev-title'), text = document.querySelector('[data-testid="evidence-text"]')
        return window.__t0 && t?.textContent === title && text?.textContent ? performance.now() - window.__t0 : false
      }, name, { polling: 'raf', timeout: 60000 })
      await button.click()
      const ms = await (await shown).jsonValue()
      await page.locator('[data-testid="conclusion"][aria-busy="false"]').waitFor()
      return { ms, requests: asked.slice(before) }
    }
    return { page, timed }
  }
  for (let r = 0; r < runs; r++) {
    // First open: the symbol is the first thing this page opens.
    const a = await fresh()
    await a.page.getByRole('button', { name: 'Table', exact: true }).click()
    await a.page.getByLabel('Search').fill(short)
    // Another match of the same search, opened first on the warm page, so the symbol's warm open still needs its own request.
    const other = (await a.page.getByRole('table').locator('tbody tr td:nth-child(3)').allTextContents()).find((n) => n !== symbol)
    if (!other) throw new Error(`no other symbol matches “${short}” to warm a page with`)
    const f = await a.timed(symbol)
    first.push(f.ms); requests.push(f.requests.length)
    if (r === 0) {
      const lens = a.page.getByRole('region', { name: 'Proof lens' })
      rows.push({ callers: await a.page.getByTestId('incoming-count').textContent(), callees: await a.page.getByTestId('outgoing-count').textContent(), integrity: await a.page.locator('.right .integrity').textContent(), requests: f.requests, callerSites: await lens.getByRole('listbox', { name: 'Callers' }).locator('.site').allTextContents() })
      if (shot) await a.page.screenshot({ path: shot })
    }
    await a.page.close()
    // Warm open: a page that has opened another symbol, so the lens has drawn once.
    const b = await fresh()
    const o = await b.timed(other)
    requests.push(o.requests.length)
    const w = await b.timed(symbol)
    if (w.requests.length === 0) throw new Error('the warm open made no request: the page already held the card, so this run measures nothing')
    warm.push(w.ms); requests.push(w.requests.length)
    await b.page.close()
  }
} finally {
  await browser.close()
  view.kill()
}
const result = {
  symbol, budgets: BUDGETS, first_open_ms: stats(first), warm_ms: stats(warm), requests_per_open: { max: Math.max(...requests), all: requests },
  card: rows[0] ?? null, machine: { ...load, after: os.loadavg(), chromium: browser.version() }, measured_at: new Date().toISOString(),
}
const over = [
  ...(result.warm_ms.p95 > BUDGETS.warm_p95_ms ? [`warm p95 ${result.warm_ms.p95} ms > ${BUDGETS.warm_p95_ms} ms`] : []),
  ...(result.first_open_ms.p95 > BUDGETS.first_open_p95_ms ? [`first open p95 ${result.first_open_ms.p95} ms > ${BUDGETS.first_open_p95_ms} ms`] : []),
  ...(result.requests_per_open.max > BUDGETS.requests_per_open ? [`${result.requests_per_open.max} requests on one open > ${BUDGETS.requests_per_open}`] : []),
]
result.over_budget = over
const text = JSON.stringify(result, null, 2)
if (out) fs.writeFileSync(out, text + '\n')
console.log(text)
if (args.includes('--check') && over.length) { console.error(`over budget: ${over.join('; ')}`); process.exit(1) }
