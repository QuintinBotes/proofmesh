import AxeBuilder from '@axe-core/playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startView } from './view'

test('FR1403 the directed matrix opens the counted sites, distinguishes coverage and pages both axes (#304)', async ({ page }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-matrix-'))
  const put = (p: string, contents: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true })
    fs.writeFileSync(path.join(repo, p), contents)
  }
  put('tsconfig.json', '{"include":["src/**/*.ts"]}')
  put('src/a/a.ts', 'import { b, other } from "../b/b"\nexport function a() { return b() + other() }\n')
  put('src/b/b.ts', 'import { a } from "../a/a"\nexport function b() { return a() }\nexport function other() { return 1 }\n')
  put('src/c/c.ts', 'export function c() { return 1 }\n')
  put('src/ghost/data.unknown', 'unanalysed')
  for (let i = 0; i < 15; i++) put(`src/z${i}/file.ts`, `export function value${i}() { return 0 }\n`)
  const view = await startView(repo)
  try {
    await page.goto(view.launchUrl)
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    await expect(page.locator('.table-view table').first()).toBeVisible()
    await expect(page.locator('.dependency-matrix table')).toHaveCount(0)
    await page.getByText('Dependency matrix', { exact: true }).press('Enter')
    const matrix = page.getByRole('table', { name: 'Direct relationships from source rows to target columns' })
    const axes = page.getByRole('table', { name: 'Areas', exact: true })
    const names = await axes.locator('tbody tr td:first-child').allTextContents()
    const cell = async (a: string, b: string) => {
      const r = names.indexOf(a), c = names.indexOf(b)
      expect(Math.min(r, c)).toBeGreaterThanOrEqual(0)
      await page.getByRole('spinbutton', { name: 'Source page' }).fill(String(Math.floor(r / 10) + 1))
      await page.getByRole('spinbutton', { name: 'Target page' }).fill(String(Math.floor(c / 10) + 1))
      const row = matrix.getByRole('row').filter({ has: page.getByRole('rowheader', { name: a, exact: true }) })
      return row.getByRole('cell').nth(c % 10)
    }
    expect(await (await cell('src/a', 'src/b')).textContent()).toBe('2')
    expect(await (await cell('src/b', 'src/a')).textContent()).toBe('1')
    expect(await (await cell('src/c', 'src/a')).textContent()).toBe('0')
    expect(await (await cell('src/c', 'src/ghost')).textContent()).toBe('Incomplete coverage')
    expect(await (await cell(names.at(-1)!, names.at(-1)!)).textContent()).toBe('Same area')
    expect(await matrix.getByRole('cell').count()).toBeLessThanOrEqual(100)
    const audit = await new AxeBuilder({ page }).include('.dependency-matrix').analyze()
    expect(audit.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')).toEqual([])
    await (await cell('src/a', 'src/b')).getByRole('button').press('Enter')
    const detail = page.getByRole('complementary', { name: 'Bundle' })
    await expect(detail.getByRole('cell', { name: 'src/a/a.ts:2', exact: true })).toHaveCount(2)
    await detail.getByRole('button', { name: 'Explore' }).first().click()
    await expect(page.getByTestId('evidence-text')).toContainText('return b() + other()')
  } finally { view.stop() }
})
