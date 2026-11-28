// NFR005, #41: the Observatory benchmark. One command measures what a reader waits for, on a pinned fixture, in a pinned browser
// and viewport, over several cold runs, and checks the medians against the published budgets (budgets.json). README.md says how.
//
// Usage: node bench/observatory/frames.mjs --fixture typeorm|synthetic [--nodes N] [--seed S] [--runs N] [--out out/obs.json]
//          [--budgets file] [--check] [--query text] [--palette-query text] [--inject-task-ms N] [--headed]
//        node bench/observatory/frames.mjs --data-dir <dir> [--workspace W --repository R] ...   (an indexed data directory as it is)
// Writes <out>.json and <out>.md, and prints the Markdown. --check exits 1 when a median misses its budget.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { chromium } from '@playwright/test'
import { generateGalaxy } from './gen-galaxy.mjs'
import { checkBudgets, isSoftwareRenderer, mainThread, markdown, pct, summarize, summarizeRuns } from './lib.mjs'
import { displacement } from './stability.mjs'
import { SNAPSHOT_B, writeSnapshotB } from './snapshot-b.mjs'

const HERE = import.meta.dirname, ROOT = path.resolve(HERE, '../..')
const CLI = path.join(ROOT, 'packages', 'proofmesh', 'bin', 'proofmesh.mjs')
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1] }
const fixtureName = flag('--fixture'), dataDirArg = flag('--data-dir')
const RUNS = Number(flag('--runs', 3)), SEED = Number(flag('--seed', 1)), NODES = Number(flag('--nodes', 50000)), INJECT = Number(flag('--inject-task-ms', 0))
const PALETTE_QUERIES = ['init', 'order', 'payment', 'load', 'render', 'conn', 'query', 'build', 'parse', 'format']
const query = flag('--query', 'order'), paletteQuery = flag('--palette-query', 'initialize'), workspace = flag('--workspace'), repository = flag('--repository'), headless = !args.includes('--headed')
const out = path.resolve(flag('--out', path.join(HERE, 'out', `${fixtureName === 'synthetic' ? `synthetic-${NODES}` : fixtureName ?? 'data-dir'}.json`)))
const budgetsFile = flag('--budgets', path.join(HERE, 'budgets.json'))
// --fixture with --data-dir is refused: a synthetic galaxy would overwrite the galaxy cache of a person's own data directory.
if (!(fixtureName === 'typeorm' || fixtureName === 'synthetic' || dataDirArg) || (fixtureName && dataDirArg) || !(RUNS >= 1)) {
  console.error('usage: node bench/observatory/frames.mjs --fixture typeorm|synthetic [--nodes N] [--seed S] [--runs N] [--out file.json] [--budgets file] [--check] [--inject-task-ms N] [--headed]\n       node bench/observatory/frames.mjs --data-dir <dir> [--workspace W --repository R] [...]')
  process.exit(2)
}
const VIEWPORT = { width: 1400, height: 900 }
const GPU_ARGS = ['--ignore-gpu-blocklist', '--enable-gpu']
const log = (s) => console.error(`observatory-bench: ${s}`)
const fail = (s) => { console.error(`observatory-bench: ${s}`); process.exit(1) }

// ---------- the browser: Playwright's pinned build, or PW_EXECUTABLE_PATH, recorded either way ----------
const pwVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@playwright/test/package.json'), 'utf8')).version
const exe = process.env.PW_EXECUTABLE_PATH
if (exe && !fs.existsSync(exe)) fail(`PW_EXECUTABLE_PATH ${exe} does not exist`)
const pinnedPath = chromium.executablePath()
if (!exe && !fs.existsSync(pinnedPath)) fail(`Playwright ${pwVersion}'s pinned Chromium is not installed (${pinnedPath}). Install it with: pnpm exec playwright install chromium   (or set PW_EXECUTABLE_PATH to a Chromium to run instead)`)
const browserBuild = exe ? `PW_EXECUTABLE_PATH ${exe}` : `Playwright ${pwVersion} pinned build ${/chromium[-_a-z]*-(\d+)/.exec(pinnedPath)?.[1] ?? pinnedPath}${headless ? ' (headless shell)' : ''}`

// ---------- the fixture and its data directory, in a work directory of this run's own ----------
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obs-run-')))
const children = new Set()
process.on('exit', () => { for (const c of children) c.kill(); fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 3 }) })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(128 + os.constants.signals[sig]))
const pm = (dataDir, ...a) => { const r = spawnSync(process.execPath, [CLI, '--data-dir', dataDir, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }); if (r.status !== 0) fail(`proofmesh ${a.join(' ')} exited ${r.status}: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`); return r.stdout }
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=observatory-bench', '-c', 'user.email=bench@localhost', '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8' })

let dataDir = dataDirArg, fix = null
const fixture = { name: fixtureName ?? 'data-dir' }
if (!dataDirArg) {
  // The TypeORM sample is built by bench/parity/fixture.sh (cloned once, never committed here) and read from its copy here only.
  const src = execFileSync('sh', [path.join(ROOT, 'bench/parity/fixture.sh')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
  const prov = fs.readFileSync(path.join(src, 'PROVENANCE'), 'utf8')
  Object.assign(fixture, { source: /^Source: (.*)$/m.exec(prov)?.[1], commit: /^Commit: (\S+)/m.exec(prov)?.[1], licence: /^Licence: (\S+)/m.exec(prov)?.[1] })
  fix = path.join(WORK, 'fixture')
  fs.cpSync(src, fix, { recursive: true, filter: (f) => !/(^|\/)(graphify-out|\.serena|\.aider\.tags\.cache\.v4)$/.test(f) })
  dataDir = path.join(WORK, 'data')
  log(`indexing ${src} into ${dataDir}`)
  pm(dataDir, 'init'); pm(dataDir, 'repo', 'add', fix); pm(dataDir, 'index', fix)
}

// ---------- proofmesh view: a fresh server per cold run, so each starts with nothing in memory ----------
async function startView() {
  const view = spawn(process.execPath, [CLI, '--data-dir', dataDir, 'view', '--port', '0', '--no-open'], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.add(view)
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('proofmesh view printed no URL')), 60000)
    readline.createInterface({ input: view.stdout }).on('line', (l) => { const m = /^Observatory: (http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64})$/.exec(l); if (m) { clearTimeout(t); resolve(m[1]) } })
    view.on('exit', (code) => reject(new Error(`proofmesh view exited ${code}`)))
  })
  const u = new URL(url)
  return { url: workspace && repository ? `${u.origin}/?workspace=${encodeURIComponent(workspace)}&repository=${encodeURIComponent(repository)}${u.hash}` : url, origin: u.origin, token: u.hash.slice(3), stop: () => { view.kill(); children.delete(view) } }
}

// A synthetic galaxy replaces the indexed fixture's in the server's cache; its points map to the fixture's real symbol ids.
// The cache's file names (galaxy-v5-<snapshot>) follow packages/proofmesh/src/query/galaxy.ts, whose format retires older payloads.
let evidenceNames = null
if (fixtureName === 'synthetic') {
  const v = await startView()
  const session = await fetch(`${v.origin}/session`, { method: 'POST', headers: { Origin: v.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: v.token }) })
  const cookie = /pm_session=[0-9a-f]+/.exec(session.headers.get('set-cookie') ?? '')?.[0]
  const g = cookie && await fetch(`${v.origin}/api/v1/galaxy`, { method: 'POST', headers: { Origin: v.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })
  v.stop()
  if (!g?.ok) fail(`could not build the fixture's galaxy (${g?.status ?? session.status})`)
  const cache = path.join(dataDir, 'cache'), idsFile = fs.readdirSync(cache).find((f) => /^galaxy-v5-.*\.ids\.json$/.test(f))
  const snapshotId = /^galaxy-v5-(.*)\.ids\.json$/.exec(idsFile)[1]
  // Evidence opens the synthetic point that maps to the fixture's best method, so its Explore view has edges.
  const real = evidencePoints(cachedGalaxy())
  const t0 = performance.now()
  const syn = generateGalaxy({ nodes: NODES, seed: SEED, snapshotId, ids: JSON.parse(fs.readFileSync(path.join(cache, idsFile), 'utf8')) })
  fs.writeFileSync(path.join(cache, idsFile), JSON.stringify(syn.ids))
  fs.writeFileSync(path.join(cache, `galaxy-v5-${snapshotId}.bin.gz`), syn.gz)
  Object.assign(fixture, { nodes: NODES, seed: SEED, links: syn.links, galaxy_sha256: crypto.createHash('sha256').update(syn.gz).digest('hex'), generated_ms: Math.round(performance.now() - t0) })
  const names = cachedGalaxy().names
  const mapped = real.filter((i) => i < NODES && alone(names, i))
  if (mapped.length === 2) evidenceNames = mapped.map((i) => names[i])
  log(`synthetic galaxy: ${NODES} symbols, ${syn.links} links, seed ${SEED}`)
}

// ---------- one page load, timed inside the page ----------
// Long tasks and the moments the map is drawn and settles are recorded from the first script on, by observers in the page.
const INIT = `(() => {
  const o = window.__obs = { longTasks: [], marks: {} }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) o.longTasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask', buffered: true }) } catch {}
  const check = () => {
    const c = document.querySelector('[data-testid=conclusion]')
    if (!o.marks.first_draw && c && /symbols in \\d/.test(c.textContent)) {
      o.marks.first_draw = performance.now()
      // --inject-task-ms: a main-thread task of that length right after the first draw, standing in for a slowed build.
      if (${INJECT}) setTimeout(() => { const end = performance.now() + ${INJECT}; while (performance.now() < end) {} }, 0)
    }
    // Positions come with the snapshot (#44): they are final once the Terrain has drawn them and marks itself ready (#46).
    if (o.marks.first_draw && !o.marks.settled && document.querySelector('.terrain[data-ready]')) o.marks.settled = performance.now()
  }
  new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
})()`

/** The process tree's resident memory, in MB, from the browser process down. */
function treeRss(rootPid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
  const kids = new Map()
  for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid])
  const rss = new Map(rows.map(([pid, , r]) => [pid, r])), seen = new Set([rootPid]), todo = [rootPid]
  while (todo.length) for (const k of kids.get(todo.pop()) ?? []) if (!seen.has(k)) { seen.add(k); todo.push(k) }
  return Math.round([...seen].reduce((s, p) => s + (rss.get(p) ?? 0), 0) / 1024)
}

async function loadMetrics(page, cdp, pid) {
  await page.waitForFunction(() => window.__obs?.marks.settled, null, { timeout: 900000, polling: 100 })
  // Time to interactive needs a quiet second after the last long task.
  await page.waitForFunction(() => { const t = window.__obs.longTasks.at(-1); return performance.now() - Math.max(window.__obs.marks.first_draw, t ? t.start + t.duration : 0) > 1000 }, null, { timeout: 120000, polling: 200 })
  const o = await page.evaluate(() => ({ ...window.__obs, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null }))
  const heap = (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize').value
  return {
    fcp_ms: Math.round(o.fcp), first_draw_ms: Math.round(o.marks.first_draw), settled_ms: Math.round(o.marks.settled),
    ...mainThread({ longTasks: o.longTasks, fcp: o.fcp ?? 0, firstDraw: o.marks.first_draw }),
    js_heap_mb: Math.round(heap / 1048576), browser_rss_mb: treeRss(pid),
  }
}

/**
 * The layout the page receives: the Galaxy payload fetched again in the page, with the request body the Galaxy itself sent, so it
 * names the same repository and snapshot. Its key is the snapshot id; positions are x, y pairs and names the symbols' names (#44).
 */
async function shownLayout(page, body, notKey) {
  for (let i = 0; i < 100; i++) {
    const l = await page.evaluate(async (body) => {
      const r = await fetch('/api/v1/galaxy', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body })
      if (!r.ok) return null
      const buf = await r.arrayBuffer(), hl = new DataView(buf).getUint32(0, true), h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)))
      const base = 4 + hl + ((4 - ((4 + hl) % 4)) % 4)
      return { key: h.snapshot_id, positions: Array.from(new Uint16Array(buf, base + h.offsets.positions, h.nodes * 2)), names: new TextDecoder().decode(new Uint8Array(buf, base + h.offsets.names, h.names_bytes)).split('\n') }
    }, body)
    if (l && l.key !== notKey) return l
    await page.waitForTimeout(100)
  }
  throw new Error('the Galaxy sent no layout')
}

// Frame times: every requestAnimationFrame interval for a while.
const frames = (page, ms) => page.evaluate((ms) => new Promise((resolve) => {
  const ts = [], end = performance.now() + ms
  const tick = (t) => { ts.push(t); if (t < end) requestAnimationFrame(tick); else resolve(ts.slice(1).map((x, i) => x - ts[i])) }
  requestAnimationFrame(tick)
}), ms)

// Clicks a button found in the page and waits until ready() holds and two frames have painted; returns the time and the API requests between.
const timedClick = (page, find, ready, arg) => page.evaluate(async ({ find, ready, arg }) => {
  const el = new Function('arg', `return (${find})(arg)`)(arg), isReady = new Function('arg', `return (${ready})(arg)`)
  if (!el) return null
  const t0 = performance.now()
  el.click()
  await new Promise((resolve, reject) => { const stop = performance.now() + 60000; const poll = () => (isReady(arg) ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : performance.now() > stop ? reject(new Error(`not ready: ${ready}`)) : requestAnimationFrame(poll)); poll() })
  const t1 = performance.now()
  return { ms: Math.round(t1 - t0), requests: performance.getEntriesByType('resource').filter((e) => e.startTime >= t0 && e.startTime <= t1 && e.name.includes('/api/')).length }
}, { find: find.toString(), ready: ready.toString(), arg })
/** The galaxy of a snapshot (or the only one) in the server's cache: the name, degree and kind of each point. */
function cachedGalaxy(snapshotId) {
  const file = snapshotId ? `galaxy-v5-${snapshotId}.bin.gz` : fs.readdirSync(path.join(dataDir, 'cache')).find((f) => /^galaxy-v5-.*\.bin\.gz$/.test(f))
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(dataDir, 'cache', file)))
  const hl = buf.readUInt32LE(0), h = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8')), base = 4 + hl + ((4 - ((4 + hl) % 4)) % 4)
  return {
    names: buf.subarray(base + h.offsets.names, base + h.offsets.names + h.names_bytes).toString('utf8').split('\n'),
    degree: new Uint32Array(buf.buffer.slice(buf.byteOffset + base + h.offsets.degree, buf.byteOffset + base + h.offsets.degree + h.nodes * 4)),
    kind: buf.subarray(base + h.offsets.kind, base + h.offsets.kind + h.nodes), kinds: h.kinds,
  }
}
/** Whether no other name contains point i's name, so a search finds it alone. */
function alone(names, i, all = names.join('\n').toLowerCase()) { const q = names[i].toLowerCase(); return q.length >= 2 && all.indexOf(q) === all.lastIndexOf(q) }
/** The points opened for evidence: the two best-connected methods or functions (the lens lists their calls) a search finds alone. */
function evidencePoints(g) {
  const callable = (i) => (['method', 'function'].includes(g.kinds[g.kind[i]]) ? 1 : 0)
  const all = g.names.join('\n').toLowerCase()
  return Array.from(g.names.keys()).sort((a, b) => callable(b) - callable(a) || g.degree[b] - g.degree[a] || a - b).slice(0, 500).filter((i) => alone(g.names, i, all)).slice(0, 2)
}

const responses = (page) => {
  const list = []
  page.on('response', async (res) => {
    const type = res.request().resourceType(), u = new URL(res.url())
    const kind = type === 'script' ? 'script' : type === 'stylesheet' ? 'stylesheet' : u.pathname.startsWith('/api/') ? 'api' : null
    if (!kind) return
    const sizes = await res.request().sizes().catch(() => null)
    const transferred = sizes && sizes.responseBodySize + sizes.responseHeadersSize
    const body = await res.body().catch(() => null)
    if (body) return list.push({ url: u.pathname, type: kind, raw: body.length, gzip: zlib.gzipSync(body).length, transferred })
    // A body larger than the browser's network buffer (the galaxy at 250,000 symbols) cannot be read back: its decoded size comes
    // from resource timing, and its gzip size is the size sent when it was sent gzipped.
    const raw = await page.evaluate((url) => performance.getEntriesByName(url).at(-1)?.decodedBodySize ?? null, res.url()).catch(() => null)
    list.push({ url: u.pathname, type: kind, raw, gzip: res.headers()['content-encoding'] === 'gzip' ? sizes?.responseBodySize ?? null : null, transferred })
  })
  return list
}

async function coldRun(i, { keepFor } = {}) {
  const v = await startView()
  const server = await chromium.launchServer({ headless, args: GPU_ARGS, ...(exe ? { executablePath: exe } : {}) })
  const browser = await chromium.connect(server.wsEndpoint())
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  await context.addInitScript(INIT)
  const page = await context.newPage()
  const galaxyRequest = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/v1/galaxy', { timeout: 900000 })
  // A page error means the view is broken; stop at once rather than wait out a timeout.
  page.on('pageerror', (e) => { console.error(`page error: ${e.message}`); server.close().finally(() => process.exit(1)) })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  const bytes = responses(page)
  log(`cold run ${i}${i === 0 ? ' (first, reported apart)' : ''}`)
  await page.goto(v.url)
  const run = await loadMetrics(page, cdp, server.process().pid)
  const loadBytes = [...bytes]
  const summary = (await page.getByTestId('conclusion').textContent()).trim()
  const galaxyBody = (await galaxyRequest).postData() ?? '{}'
  const layout = await shownLayout(page, galaxyBody)
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : 'no WebGL'
  })
  // Frames at rest, then while the mouse pans and zooms the canvas.
  const idle = await frames(page, 3000)
  const canvas = await page.locator('canvas').first().boundingBox()
  const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2
  const moving = frames(page, 5000)
  for (let k = 0; k < 10; k++) {
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, k % 2 ? 300 : -300)
    await page.mouse.down()
    await page.mouse.move(cx + 120, cy + 60, { steps: 8 })
    await page.mouse.up()
  }
  const panZoom = await moving
  // Search: from typing the query to the status line naming the matches, five times.
  const search = []
  for (let k = 0; k < 5; k++) {
    await page.getByLabel('Search').fill('')
    const s = Date.now()
    await page.getByLabel('Search').fill(query)
    await page.getByRole('status').filter({ hasText: new RegExp(`“${query}”: [\\d,]+ of`) }).first().waitFor({ timeout: 60000 })
    search.push(Date.now() - s)
  }
  await page.getByLabel('Search').fill('')
  // A person pauses between actions; without it the switch would also time the Terrain's return after the search clears.
  await page.waitForTimeout(1000)
  // The Terrain switch (#46 replaced the Map): from Diff, a table, back to the Terrain, drawn again from the payload it holds, so it
  // asks the server nothing; twice, the second warm.
  const tab = (name) => timedClick(page, (n) => [...document.querySelectorAll('[role=tab]')].find((e) => e.textContent === n), (n) => document.querySelector(n === 'Terrain' ? '.terrain[data-ready] [aria-label="Terrain controls"]' : '[aria-label="Compare"]'), name)
  await tab('Diff')
  const switchCold = await tab('Terrain')
  await tab('Diff')
  const switchWarm = await tab('Terrain')
  // The command palette (#43), over the Terrain: from a query set in its field to the frame after the count of matches changes, twenty
  // times; then the longest main-thread task while a query is typed a key at a time.
  await page.keyboard.press('Control+K')
  const palette = page.getByRole('combobox', { name: 'Find a symbol, file or command' })
  const paletteStatus = page.getByRole('dialog', { name: 'Command palette' }).getByRole('status')
  await palette.fill(paletteQuery.slice(0, 2))
  await paletteStatus.filter({ hasText: /match/ }).waitFor({ timeout: 120000 })
  const paletteMs = []
  for (let k = 0; k < 20; k++) {
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
    }), PALETTE_QUERIES[k % PALETTE_QUERIES.length]))
  }
  await palette.fill('')
  const typingFrom = await page.evaluate(() => performance.now())
  await page.keyboard.type(paletteQuery, { delay: 100 })
  await paletteStatus.filter({ hasText: /match/ }).waitFor({ timeout: 60000 })
  await page.waitForTimeout(500)
  const typingTasks = await page.evaluate((t) => window.__obs.longTasks.filter((x) => x.start >= t).map((x) => x.duration), typingFrom)
  await page.keyboard.press('Escape')
  // Symbol to evidence: the Terrain table's Explore button (the same call path as a click on the symbol's point) to the Proof lens
  // showing the symbol's source text, with the API requests between. The first open is the page's first; the warm open is of a
  // second symbol, once the lens has drawn, so it still needs its own request. Then an edge: a caller or callee row of the lens to
  // its call site shown.
  // The Terrain shown is the one of the snapshot its layout key names; a data directory's cache may hold others.
  if (!evidenceNames) { const g = cachedGalaxy(layout.key); evidenceNames = evidencePoints(g).map((i) => g.names[i]) }
  if (evidenceNames.length < 2) throw new Error('no two symbols with names no other name contains')
  const openSymbol = async (symbol) => {
    await page.getByRole('tab', { name: 'Terrain' }).click()
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    await page.getByLabel('Search').fill(symbol)
    // A synthetic point opens the fixture's real symbol it maps to, so there the panel's title is only checked to have changed.
    const before = await page.evaluate(() => document.querySelector('.ev-title')?.textContent ?? null)
    const t = await timedClick(page, (a) => [...document.querySelectorAll('[aria-label="Terrain table"] tr')].find((r) => r.children[2]?.textContent === a.symbol)?.querySelector('button'),
      (a) => { const title = document.querySelector('.ev-title')?.textContent; return title && (a.exact ? title === a.symbol : title !== a.before) && document.querySelector('[data-testid=evidence-text]')?.textContent },
      { symbol, before, exact: fixtureName !== 'synthetic' })
    if (!t) throw new Error(`the Terrain table has no row for ${symbol}`)
    return t
  }
  const evFirst = await openSymbol(evidenceNames[0])
  const ev = await openSymbol(evidenceNames[1])
  const edge = await timedClick(page, () => document.querySelector('[aria-label="Proof lens"] [role=listbox][aria-label=Callees] [role=option]') ?? document.querySelector('[aria-label="Proof lens"] [role=listbox][aria-label=Callers] [role=option]'),
    () => document.querySelector('[data-testid=cited]')?.textContent)
  await page.getByLabel('Search').fill('')
  const calls = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/')).map((e) => ({ call: new URL(e.name).pathname, ms: e.duration })))
  Object.assign(run, {
    frame_idle_p50_ms: pct(idle, 0.5), frame_idle_p95_ms: pct(idle, 0.95), frame_idle_max_ms: pct(idle, 1),
    frame_pan_zoom_p50_ms: pct(panZoom, 0.5), frame_pan_zoom_p95_ms: pct(panZoom, 0.95), frame_pan_zoom_max_ms: pct(panZoom, 1),
    search_ms: summarize(search).median, symbol_to_evidence_first_ms: evFirst?.ms, symbol_to_evidence_ms: ev?.ms, symbol_to_evidence_requests: ev?.requests,
    edge_to_evidence_ms: edge?.ms ?? null, edge_to_evidence_requests: edge?.requests ?? null, terrain_switch_ms: switchWarm.ms, terrain_switch_cold_ms: switchCold.ms,
    palette_p50_ms: pct(paletteMs, 0.5), palette_p95_ms: pct(paletteMs, 0.95), palette_max_ms: pct(paletteMs, 1),
    palette_typing_longest_task_ms: Math.max(0, ...typingTasks),
    script_gzip_kb: Math.round(loadBytes.filter((b) => b.type === 'script').reduce((s, b) => s + b.gzip, 0) / 1024),
    // Scripts and style sheets only, as #47's target counts them ("before data"); the bytes table lists the data apart.
    transferred_kb: Math.round(loadBytes.filter((b) => b.type !== 'api').reduce((s, b) => s + b.transferred, 0) / 1024),
  })
  for (const k of Object.keys(run)) if (typeof run[k] === 'number') run[k] = Math.round(run[k] * 10) / 10
  // Warm: the Terrain loaded again in the same page, its HTTP cache kept (a reload would reopen the symbol Explore shows).
  const galaxyUrl = v.origin + (workspace && repository ? new URL(v.url).search : '/')
  await page.goto(galaxyUrl)
  const warm = await loadMetrics(page, cdp, server.process().pid)
  const result = { run, warm, layout, galaxyBody, renderer, summary, bytes: loadBytes, calls, browserVersion: browser.version(), symbol: evidenceNames.join(', '), galaxyUrl }
  if (keepFor) { result.keep = { page, close: async () => { await server.close(); v.stop() } }; return result }
  await server.close()
  v.stop()
  return result
}

// ---------- the runs ----------
const loadStart = os.loadavg()
const runs = []
for (let i = 0; i <= RUNS; i++) runs.push(await coldRun(i, { keepFor: i === RUNS && fix && fixtureName !== 'synthetic' ? 'stability' : undefined }))
const measured = runs.slice(1)

// Stability: the same snapshot in two fresh profiles, then snapshot A followed by B (A plus the commit snapshot-b.mjs writes) in one profile.
let timeStep = null
const stability = { same_snapshot: displacement(measured.length > 1 ? measured[0].layout : runs[0].layout, measured.at(-1).layout) }
const last = runs.at(-1)
if (last.keep) {
  writeSnapshotB(fix)
  git(fix, 'add', '-A')
  git(fix, 'commit', '-q', '-m', 'observatory benchmark: snapshot B')
  const files = git(fix, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n')
  log('stability: indexing snapshot B')
  pm(dataDir, 'index', fix)
  const page = last.keep.page
  await page.goto(last.galaxyUrl)
  await page.waitForFunction(() => window.__obs?.marks.settled, null, { timeout: 900000, polling: 100 })
  const b = await shownLayout(page, last.galaxyBody, last.layout.key)
  stability.a_to_b = { ...displacement(last.layout, b), files, added: SNAPSHOT_B.added, removed: SNAPSHOT_B.removed, changed: SNAPSHOT_B.changed }
  // Time (#48 SC-002): from B, step to A and back once, so both are loaded and compared; then time ] from A to B drawn with its marks.
  const step = (key, id) => page.evaluate(({ key, id }) => new Promise((resolve) => {
    const t0 = performance.now()
    window.dispatchEvent(new KeyboardEvent('keydown', { key }))
    const done = () => document.querySelector(`.terrain[data-ready][data-snapshot="${id}"]`) && (key === '[' || document.querySelector('.terrain .time-mark'))
    const poll = () => (done() ? requestAnimationFrame(() => resolve(Math.round(performance.now() - t0))) : requestAnimationFrame(poll))
    poll()
  }), { key, id })
  await step('[', last.layout.key); await step(']', b.key); await step('[', last.layout.key)
  timeStep = await step(']', b.key)
  log(`time: ] from A to B, loaded, ${timeStep} ms`)
  await last.keep.close()
} else stability.a_to_b = { reason: fixtureName === 'synthetic' ? 'a synthetic galaxy has no commit to change' : 'needs a fixture (--fixture typeorm)' }

const proofmeshCommit = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null
const cold = summarizeRuns(measured.map((r) => r.run)), warm = summarizeRuns(measured.map((r) => r.warm))
const bytesTotal = {}
for (const b of measured[0].bytes) { const t = (bytesTotal[b.type] ??= { count: 0, raw: 0, gzip: 0, transferred: 0 }); t.count++; t.raw += b.raw; t.gzip += b.gzip; t.transferred += b.transferred }
const callTimes = new Map()
for (const r of measured) for (const c of r.calls) callTimes.set(c.call, [...(callTimes.get(c.call) ?? []), c.ms])
const outliers = Object.entries(cold).filter(([k, s]) => k.endsWith('_ms') && s && s.median > 100 && s.spread_pct > 10).map(([k]) => k)
const result = {
  measured_at: new Date().toISOString(),
  fixture: { ...fixture, symbols: Number(/^([\d,]+) symbols/.exec(runs[0].summary)?.[1].replace(/,/g, '')) || null },
  proofmesh_commit: proofmeshCommit, proofmesh_dirty: spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() !== '',
  machine: { hardware: `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.type()} ${os.release()} ${os.arch()}`, load_avg_start: loadStart, load_avg_end: os.loadavg(), free_memory_gb: Math.round(os.freemem() / 2 ** 30 * 10) / 10 },
  browser: { name: 'Chromium', version: runs[0].browserVersion, build: browserBuild, headless },
  viewport: { ...VIEWPORT, device_scale_factor: 1 }, webgl_renderer: runs[0].renderer, software_renderer: isSoftwareRenderer(runs[0].renderer),
  galaxy: runs[0].summary, query, evidence_symbol: runs[0].symbol, runs: RUNS, ...(INJECT ? { injected_task_ms: INJECT } : {}),
  cold, warm: { ...warm, ...(timeStep != null ? { time_step_ms: summarize([timeStep]) } : {}) }, first_run: { ...runs[0].run, ...Object.fromEntries(Object.entries(runs[0].warm).map(([k, v]) => [`warm_${k}`, v])) },
  bytes: measured[0].bytes, bytes_total: bytesTotal,
  calls: [...callTimes].map(([call, ms]) => ({ call, count: ms.length / measured.length, ms: summarize(ms) })).sort((a, b) => (a.call < b.call ? -1 : 1)),
  stability, agreement: measured.length > 1 ? { ok: !outliers.length, outliers } : null,
}
const budgets = JSON.parse(fs.readFileSync(budgetsFile, 'utf8')).budgets
const rows = checkBudgets(result, budgets)
result.budgets = rows
result.over_budget = rows.filter((b) => b.over).map((b) => b.key)
const md = markdown(result, rows)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
fs.writeFileSync(out.replace(/\.json$/, '') + '.md', md)
console.log(md)
log(`wrote ${out} and ${out.replace(/\.json$/, '')}.md`)
process.exit(args.includes('--check') && result.over_budget.length ? 1 : 0)
