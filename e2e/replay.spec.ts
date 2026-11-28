import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { answered, ROOT, startView } from './view'

const CLI = path.join(ROOT, 'packages', 'proofmesh', 'bin', 'proofmesh.mjs')

// A copy of the fixture indexed twice, so the repository has an older and a current snapshot.
let view: Awaited<ReturnType<typeof startView>>
let older = ''
test.beforeAll(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-replay-'))
  fs.cpSync(path.join(ROOT, 'fixtures', 'ts-invoicing', 'repo'), repo, { recursive: true })
  view = await startView(repo)
  const file = path.join(repo, 'packages', 'billing', 'src', 'invoice.ts')
  fs.appendFileSync(file, '\nexport function invoiceTax(total: number): number {\n  return total * 0.2\n}\n')
  const r = spawnSync(process.execPath, [CLI, '--data-dir', view.dataDir, 'index', repo], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
})
test.afterAll(() => view?.stop())

test('FR010 Replay pins every view to an older snapshot and says so until the person returns to the current one', async ({ page }) => {
  await page.goto(view.launchUrl)
  await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  // Time's strip lists every published snapshot, newest first (FR1761).
  const strip = page.getByRole('list', { name: 'Snapshots, newest first' }).getByRole('button')
  await expect(strip).toHaveCount(2)
  await expect(strip.first()).toContainText('(current)')
  older = await strip.filter({ hasNotText: '(current)' }).getAttribute('data-snapshot') as string

  // The current snapshot knows the new function; the Terrain's table lists it.
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await page.fill('#search', 'invoiceTax')
  await expect(page.getByRole('main')).toContainText('invoiceTax')

  const pinned: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/') && r.method() === 'POST') pinned.push(`${r.url().split('/api/v1/')[1]} ${JSON.parse(r.postData() || '{}').snapshot_id ?? '-'}`)
    // The Terrain's payload is read from its snapshot's address (FR1453), which names the snapshot.
    const galaxy = /\/api\/v1\/galaxy\/v\d+\/([\w-]+)$/.exec(new URL(r.url()).pathname)
    if (galaxy) pinned.push(`galaxy ${galaxy[1]}`)
  })
  await answered(page, () => strip.filter({ hasNotText: '(current)' }).click())
  await expect(page.getByTestId('replay-banner')).toContainText(`Replaying snapshot ${older.slice(0, 13)}`)
  // The older snapshot does not know the new function: the same search now matches nothing.
  await expect(page.getByTestId('conclusion')).toContainText('0 matching symbols')
  // Every query after the pin carries the older snapshot's id, the Terrain included.
  await page.fill('#search', '')
  await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  expect(pinned.length).toBeGreaterThan(1)
  expect(pinned.filter((p) => !p.endsWith(` ${older}`))).toEqual([])

  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)
  expect(serious).toEqual([])

  await answered(page, () => page.getByRole('button', { name: 'Back to current' }).click())
  await expect(page.getByTestId('replay-banner')).toHaveCount(0)
  await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  await page.fill('#search', 'invoiceTax')
  await expect(page.getByRole('main')).toContainText('invoiceTax')
})
