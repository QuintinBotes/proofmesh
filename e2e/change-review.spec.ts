import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { ROOT, startView } from './view'

// fixtures/change-reach as a git repository: base committed, then head (and head-delete when asked) committed on top (#49).
// A test file in base imports auditorScore and calls nothing, so a test reaches it only by import (the edge case).
function reachRepo(withDelete = false): { repo: string; base: string; head: string } {
  const fixture = path.join(ROOT, 'fixtures', 'change-reach')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-e2e-change-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' }).trim()
  fs.cpSync(path.join(fixture, 'base'), repo, { recursive: true })
  fs.copyFileSync(path.join(fixture, 'tsconfig.json'), path.join(repo, 'tsconfig.json'))
  fs.writeFileSync(path.join(repo, 'test', 'auditor.test.ts'), "import { auditorScore } from '../src/roles/auditor'\nexport function auditorPending(): void {\n  return\n}\n")
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  fs.cpSync(path.join(fixture, 'head'), repo, { recursive: true })
  if (withDelete) fs.cpSync(path.join(fixture, 'head-delete'), repo, { recursive: true })
  git('add', '-A'); git('commit', '-q', '-m', 'head')
  return { repo, base, head: git('rev-parse', 'HEAD') }
}

/** Opens a review from a link (FR1812): the launch token's fragment after `?change=`, so the session starts on that view. */
async function openReview(page: Page, view: { launchUrl: string }, change: string) {
  const u = new URL(view.launchUrl)
  await page.goto(`${u.origin}/?change=${change}${u.hash}`)
  await expect(page.getByTestId('change-summary')).toBeVisible({ timeout: 120000 })
}
const rows = (page: Page) => page.getByRole('region', { name: 'Changes and dependents' }).getByRole('listitem')
const row = (page: Page, text: string) => page.getByRole('region', { name: 'Changes and dependents' }).getByRole('button').filter({ hasText: text })
const panel = (page: Page) => page.getByTestId('change-panel')
const marks = (page: Page, kind: string) => page.locator(`.change-mark[data-kind="${kind}"]`)

test.describe('Change review on fixtures/change-reach, base..head', () => {
  test.describe.configure({ mode: 'serial' })
  let view: Awaited<ReturnType<typeof startView>>, r: ReturnType<typeof reachRepo>, context: BrowserContext, page: Page
  const tools: string[] = []
  test.beforeAll(async ({ browser }) => {
    r = reachRepo()
    view = await startView(r.repo)
    context = await browser.newContext()
    page = await context.newPage()
    page.on('request', (q) => { const m = /\/api\/v1\/tools\/([a-z_]+)$/.exec(q.url()); if (m) tools.push(m[1]!) })
    await openReview(page, view, `${r.base}..${r.head}`)
  })
  test.afterAll(async () => { await context?.close(); view?.stop() })

  test('S1 FR1810 FR1812 the link opens Diff on Change review: the list is impact_completeness\'s rows with their statuses, the summary its totals, and the gate fails on two neither', async () => {
    await expect(page.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true')
    await expect(rows(page)).toHaveText([
      'managerScore src/roles/manager.ts:2 modified, neither',
      'mean src/stats.ts:1 modified, tested: analystScoreDoubles test/analyst.test.ts:2 transitive_call depth=2',
      'calls analystScore src/roles/analyst.ts:3 tested: analystScoreDoubles test/analyst.test.ts:2 call depth=1',
      'calls auditorScore src/roles/auditor.ts:3 neither',
      'calls managerScore src/roles/manager.ts:3 changed',
      'imports index.ts src/index.ts:1 neither',
    ])
    await expect(page.getByTestId('change-summary')).toHaveText('2 changed symbols; 4 dependents: 1 changed, 1 tested, 2 neither')
    await expect(page.getByTestId('change-gate')).toHaveText('Gate failing: 2 dependents neither changed nor tested')
    await expect(page.getByTestId('change-gate')).toHaveClass(/failing/)
    // The rows are the tool's: the same answer asked directly has the same totals and names.
    const asked = await page.evaluate(async ([base, head]) => (await (await fetch('/api/v1/tools/impact_completeness', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base, head }) })).json()).data, [r.base, r.head])
    expect(asked.totals).toEqual({ changed_symbols: 2, dependents: 4, changed: 1, tested: 1, neither: 2, by_basis: { observed: 4, inferred: 0 } })
    expect(await rows(page).count()).toBe(asked.changed.length + asked.changed.reduce((n: number, c: { dependents: unknown[] }) => n + c.dependents.length, 0))
  })

  test('S2 FR1811 the auditorScore row opens its chain at once: the call to mean at src/roles/auditor.ts:3, and neither; a test file that only imports it is named, and runs none of it', async () => {
    const before = tools.length
    // SC-002: the chain is in the row, so it shows with no request, timed in the page from the click to its first hop drawn.
    const ms = await page.evaluate(async () => {
      const b = [...document.querySelectorAll<HTMLButtonElement>('.change-rows button')].find((x) => x.textContent!.startsWith('calls auditorScore'))!
      const t = performance.now()
      b.click()
      while (!document.querySelector('[data-testid="change-panel"] .change-chain li')) await new Promise((r) => requestAnimationFrame(r))
      return performance.now() - t
    })
    expect(ms).toBeLessThan(150)
    await expect(panel(page).getByRole('region', { name: 'Chain' }).getByRole('listitem')).toHaveText(['auditorScore calls mean at src/roles/auditor.ts:3', 'mean, changed, declared at src/stats.ts:1'])
    await expect(panel(page).getByTestId('change-status')).toHaveText('neither')
    const tests = panel(page).getByRole('region', { name: 'Tests' })
    await expect(tests).toContainText('auditor.test.ts test/auditor.test.ts:1 import_only depth=1 runs none of it, so it stays neither')
    expect(tools.slice(before)).toEqual(['find_tests'])
    expect(tools).not.toContain('trace_paths')
  })

  test('S3 FR1811 the analystScore row shows its test, analystScoreDoubles test/analyst.test.ts:2, with evidence call depth=1 and the test\'s chain', async () => {
    await row(page, 'calls analystScore').click()
    await expect(panel(page).getByTestId('change-status')).toHaveText('tested: analystScoreDoubles test/analyst.test.ts:2 call depth=1')
    await expect(panel(page).getByRole('region', { name: 'Chain' }).getByRole('listitem')).toHaveText(['analystScore calls mean at src/roles/analyst.ts:3', 'mean, changed, declared at src/stats.ts:1'])
    const test0 = panel(page).getByRole('region', { name: 'Tests' }).getByRole('listitem').first()
    await expect(test0).toContainText('analystScoreDoubles test/analyst.test.ts:2 call depth=1')
    await expect(test0.getByRole('listitem')).toHaveText(['analystScoreDoubles test/analyst.test.ts:3', 'analystScore src/roles/analyst.ts:2'])
    expect(tools).not.toContain('trace_paths')
  })

  test('S4 FR1814 on the map each changed symbol is a filled dot with a ring, each dependent ringed solid, double or dashed by status, and the legend names each', async () => {
    await expect(page.locator('.terrain[data-ready]')).toBeVisible()
    await expect(marks(page, 'modified')).toHaveCount(2)
    await expect(marks(page, 'modified').first().locator('circle')).toHaveCount(2)
    await expect(marks(page, 'modified').first().locator('circle').first()).not.toHaveAttribute('fill', 'none')
    await expect(page.locator('.change-mark[data-kind="tested"][data-name="analystScore"] circle')).toHaveCount(2)
    await expect(page.locator('.change-mark[data-kind="tested"] circle').first()).toHaveAttribute('fill', 'none')
    await expect(page.locator('.change-mark[data-kind="neither"]')).toHaveCount(2)
    await expect(page.locator('.change-mark[data-kind="neither"][data-name="auditorScore"] circle')).toHaveAttribute('stroke-dasharray', '4 3')
    await expect(page.locator('.change-mark[data-kind="changed"][data-name="managerScore"] circle')).not.toHaveAttribute('stroke-dasharray')
    // The importing file has no symbol of its own on the map, so its ring is at its nearest directory's cell; every row has a mark.
    await expect(page.locator('.change-mark[data-kind="neither"][data-name="index.ts"]')).toHaveCount(1)
    await expect(page.locator('.change-mark')).toHaveCount(6)
    await expect(page.getByRole('list', { name: 'Change legend' }).getByRole('listitem')).toHaveText([
      'changed symbol: filled dot with a ring 2', 'added symbol: filled dot 0', 'removed symbol: cross at its old place 0',
      'dependent changed: solid ring 1', 'dependent tested: double ring 1', 'dependent neither: dashed ring 2',
    ])
    // A mark opens its row.
    await page.locator('.change-mark[data-name="auditorScore"]').dispatchEvent('click')
    await expect(panel(page).locator('.ev-title')).toHaveText('auditorScore')
  })

  test('S5 spread only moved down a line, so it is neither listed nor marked', async () => {
    await expect(rows(page).filter({ hasText: 'spread' })).toHaveCount(0)
    await expect(page.locator('.change-mark[data-name="spread"]')).toHaveCount(0)
  })

  test('S6 at depth 2, report src/report.ts:3 is neither (via analystScore), and its two-hop chain opens with a site on both hops', async () => {
    await page.locator('#change-depth').selectOption('2')
    await expect(page.getByTestId('change-summary')).toHaveText('2 changed symbols; 5 dependents: 1 changed, 1 tested, 3 neither', { timeout: 60000 })
    expect(new URL(page.url()).search).toBe(`?change=${r.base}..${r.head}&depth=2`)
    await row(page, 'calls report').click()
    await expect(panel(page).getByTestId('change-status')).toHaveText('neither (via analystScore)')
    await expect(panel(page).getByRole('region', { name: 'Chain' }).getByRole('listitem')).toHaveText([
      'report calls analystScore at src/report.ts:3', 'analystScore → mean at src/roles/analyst.ts:3', 'mean, changed, declared at src/stats.ts:1',
    ])
  })

  test('FR1816 the export carries the gate summary, the base and head, and the limits in its caption', async ({}, testInfo) => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('group', { name: 'Export this view' }).getByRole('button', { name: 'Export page' }).click()])
    const file = testInfo.outputPath(download.suggestedFilename())
    await download.saveAs(file)
    const html = fs.readFileSync(file, 'utf8')
    expect(html).toContain(`scope: change ${r.base.slice(0, 12)}..${r.head.slice(0, 12)} at depth 2: 2 changed symbols; 5 dependents: 1 changed, 1 tested, 3 neither; gate failing: 3 dependents neither changed nor tested`)
    expect(html).toContain('limit: Symbols are matched by kind and qualified name')
    expect(html).toContain('Position shows containment')
  })

  test('edge FR1812: with only a base, the head is the working tree, and the view says so; open names a row by its stable key and opens it', async () => {
    await page.goto(`${new URL(view.launchUrl).origin}/?change=${r.base}&open=${encodeURIComponent('src/roles/auditor.ts#src/roles/auditor:auditorScore#function')}`)
    await expect(page.getByTestId('change-summary')).toHaveText('2 changed symbols; 4 dependents: 1 changed, 1 tested, 2 neither', { timeout: 60000 })
    await expect(page.getByRole('region', { name: 'Change summary' })).toContainText(`${r.base.slice(0, 12)} → working tree`)
    await expect(panel(page).locator('.ev-title')).toHaveText('auditorScore')
    await expect(row(page, 'calls auditorScore')).toHaveAttribute('aria-pressed', 'true')
  })

  test('edge FR058 FR1815: more than 500 rows are drawn a window at a time, with the counts by status always in view', async () => {
    // The answer is impact_completeness's for this range with 600 copies of the auditorScore row, so only the list's size changes.
    await page.route('**/api/v1/tools/impact_completeness', async (route) => {
      const res = await route.fetch(), env = await res.json()
      const mean = env.data.changed.find((c: { name: string }) => c.name === 'mean'), auditor = mean.dependents.find((d: { name: string }) => d.name === 'auditorScore')
      mean.dependents = Array.from({ length: 600 }, (_, i) => ({ ...auditor, name: `dependent${i}` }))
      await route.fulfill({ response: res, json: env })
    })
    await page.goto(`${new URL(view.launchUrl).origin}/?change=${r.base}..${r.head}`)
    await expect(page.getByRole('region', { name: 'Changes and dependents' }).getByRole('heading')).toHaveText('602 rows', { timeout: 60000 })
    const list = page.locator('.change-rows')
    await expect(list).toHaveAttribute('data-windowed', 'true')
    expect(await page.locator('.change-rows button').count()).toBeLessThan(120)
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(row(page, 'dependent599')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Change legend' })).toContainText('dependent neither: dashed ring 600')
    await page.unroute('**/api/v1/tools/impact_completeness')
  })
})

test.describe('Change review of a deleted symbol', () => {
  let view: Awaited<ReturnType<typeof startView>>
  test.afterAll(() => view?.stop())
  test('S4 a removed symbol is a cross at its old place, and its dependent from the base is drawn where it is in head', async ({ page }) => {
    const r = reachRepo(true)
    view = await startView(r.repo)
    await openReview(page, view, `${r.base}..${r.head}`)
    await expect(page.locator('.terrain[data-ready]')).toBeVisible()
    const cross = page.locator('.change-mark[data-kind="deleted"][data-name="spread"]')
    await expect(cross).toHaveCount(1)
    await expect(cross.locator('path')).toHaveCount(1)
    await expect(page.locator('.change-mark[data-kind="neither"][data-name="range"]')).toHaveCount(1)
    await row(page, 'calls range').click()
    await expect(panel(page).getByRole('region', { name: 'Chain' })).toContainText('From the base snapshot: spread is gone in head')
  })
})
