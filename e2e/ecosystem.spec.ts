import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { answered, ROOT, startView } from './view'

// The overview comes from a recorded get_ecosystem envelope (the link file is another worker's); member A is the real indexed repository.
const RECORDED = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'apps', 'observatory', 'test', 'fixtures', 'ecosystem.json'), 'utf8'))
const A = 'repo_aaaaaaaaaaaaaaaaaaaaaaaa', B = 'repo_bbbbbbbbbbbbbbbbbbbbbbbb'

// Each test opens its own view: a launch link works once.
let view: Awaited<ReturnType<typeof startView>>
test.beforeEach(async () => { view = await startView() })
test.afterEach(() => view?.stop())

async function serve(page: Page, realRepo: string) {
  const body = JSON.stringify(RECORDED).replaceAll(A, realRepo)
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: { workspaces: [{ name: 'shop', members: [{ repository_id: realRepo, name: 'storefront' }, { repository_id: B, name: 'orders-api' }] }] } }))
  await page.route('**/api/v1/tools/get_ecosystem', (route) => route.fulfill({ contentType: 'application/json', body }))
}

test('A11 the ecosystem overview draws a workspace, shows a selected repository\'s evidence, and drilling down loads only it, with browser history', async ({ page }) => {
  await page.goto(view.launchUrl)
  await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  const status = await (await page.request.post(`${view.origin}/api/v1/tools/workspace_status`, { headers: { Origin: view.origin }, data: {} })).json()
  const realRepo = status.snapshot.repository_id as string
  await serve(page, realRepo)
  const posted: Array<{ url: string; body: Record<string, unknown> }> = []
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/v1/')) posted.push({ url: r.url(), body: r.postDataJSON() ?? {} }) })

  await page.getByRole('tab', { name: 'Ecosystem' }).click()
  await expect(page.getByText('Pick a workspace')).toBeVisible()
  await answered(page, () => page.locator('#workspace').selectOption('shop'))
  await expect(page.getByTestId('conclusion')).toHaveText('shop: 3 repositories, 2 linked pairs, 2 unresolved boundaries; 1 linked from a snapshot that is no longer current. Click a repository to see its links and open only it.')
  expect(posted.filter((p) => p.url.endsWith('/get_ecosystem')).map((p) => p.body)).toEqual([{ workspace: 'shop' }])

  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const repos = page.getByRole('table', { name: 'Repositories of shop' })
  await expect(repos.locator('tbody tr td:first-child')).toHaveText(['contracts', 'orders-api', 'storefront'])
  await expect(repos.locator('tbody tr').first()).toHaveAttribute('data-current', 'false')
  await expect(repos.locator('tbody tr').first()).toContainText('a newer snapshot exists')
  const links = page.getByRole('table', { name: 'Links between repositories' })
  // A11 names no row order, and pairs() orders by repository id, which hashes the clone's path: compare the rows as a set.
  await expect.poll(async () => (await links.locator('tbody tr').allTextContents()).sort()).toEqual(['orders-apicontractsdepends on packages of020.9', 'storefrontorders-apicalls endpoints of; sends messages to410.6–1'])
  await expect(page.getByRole('list', { name: 'Unresolved boundaries' })).toContainText('storefront: 2 calls_endpoint matched nothing in the workspace, such as Storefront.Clients.IInventoryApi.GetStock (no_match)')

  // Evidence on selection: the member with the most partners is selected first; choosing another shows its links and samples.
  const panel = page.getByRole('complementary', { name: 'Repository evidence' })
  await expect(panel.getByRole('heading')).toHaveText('orders-api')
  await repos.getByRole('button', { name: 'storefront' }).click()
  await expect(panel.getByRole('heading')).toHaveText('storefront')
  await expect(panel.getByRole('list', { name: 'Links of storefront' })).toContainText('to orders-api')
  await expect(panel.getByRole('list', { name: 'Links of storefront' })).toContainText('Storefront.Clients.IOrdersApi.GetOrder')
  await expect(panel.getByRole('list', { name: 'Links of storefront' })).toContainText('2 calls_endpoint matched nothing')
  await expect(panel).toContainText('orders-api: linked from it; contracts: linked through others')
  await expect(panel.getByRole('button', { name: 'Open only storefront' })).toBeVisible()

  // Keyboard only: Tab reaches the first Open button and Enter drills down.
  const open = repos.getByRole('button', { name: 'Open' }).nth(2)
  await open.focus()
  await expect(open).toBeFocused()
  const before = posted.length
  await answered(page, () => page.keyboard.press('Enter'))
  await expect(page.getByRole('tab', { name: 'Galaxy' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('status')).toContainText('Showing one repository of workspace shop')
  await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  const after = posted.slice(before)
  expect(after.length).toBeGreaterThan(0)
  for (const p of after) expect(p.body.repository_id, p.url).toBe(realRepo)
  expect(JSON.stringify(after)).not.toContain(B)
  // Browser history: Back returns to the overview without refetching it, Forward drills in again.
  await page.goBack()
  await expect(page.getByRole('tab', { name: 'Ecosystem' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('conclusion')).toContainText('shop: 3 repositories')
  await page.goForward()
  await expect(page.getByRole('status')).toContainText('Showing one repository of workspace shop')
  await page.getByRole('button', { name: 'Back to the ecosystem' }).click()
  await expect(page.getByRole('tab', { name: 'Ecosystem' })).toHaveAttribute('aria-selected', 'true')
  expect(posted.filter((p) => p.url.endsWith('/get_ecosystem'))).toHaveLength(1)
})

test('A11 a link naming a workspace and one of its repositories opens drilled into that repository, with the overview behind Back', async ({ page }) => {
  // The launch link works once, so the repository id comes from the CLI and the link's one use is the deep link.
  const realRepo = spawnSync(process.execPath, [path.join(ROOT, 'packages', 'proofmesh', 'bin', 'proofmesh.mjs'), '--data-dir', view.dataDir, 'repo', 'list'], { encoding: 'utf8' }).stdout.split('  ')[0]!
  await serve(page, realRepo)
  const u = new URL(view.launchUrl)
  await page.goto(`${u.origin}/?workspace=shop&repository=${realRepo}${u.hash}`)
  await expect(page.getByRole('status')).toContainText('Showing one repository of workspace shop', { timeout: 60000 })
  await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  await page.getByRole('button', { name: 'Back to the ecosystem' }).click()
  await expect(page.getByTestId('conclusion')).toContainText('shop: 3 repositories')
})

test('NFR012 the ecosystem view and its table pass axe with no serious violation', async ({ page }) => {
  await page.goto(view.launchUrl)
  await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  await serve(page, 'repo_aaaaaaaaaaaaaaaaaaaaaaaa')
  await page.getByRole('tab', { name: 'Ecosystem' }).click()
  await answered(page, () => page.locator('#workspace').selectOption('shop'))
  const serious = async (where: string) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${where}: ${v.id}`)
  const found = await serious('graph')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Repositories of shop' })).toBeVisible()
  found.push(...await serious('table'))
  expect(found).toEqual([])
})
