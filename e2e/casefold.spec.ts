import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { answered, startView } from './view'

/**
 * A repository whose names change length when lowered: İ lowers to two code units, so a search that maps a match back with the
 * original names' offsets lands on a later name. ẞ, ß, a combining mark and an emoji path sit beside it. Written at test time.
 */
function casefoldRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-casefold-'))
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }
  write('package.json', '{ "name": "casefold", "private": true }\n')
  write('tsconfig.json', '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext" }, "include": ["src"] }\n')
  write('src/🚀İstanbul.ts', Array.from({ length: 12 }, (_, i) => `export function İİİİİİİİİİİİİİİİİİİİ${i}(): number { return ${i} }\n`).join(''))
  write('src/straße.ts', 'export function GROẞe\u0301(): number { return 1 }\nexport function maße(): number { return 2 }\n')
  write('src/target.ts', 'export function findMe(): number { return 1 }\n')
  write('src/zz.ts', Array.from({ length: 12 }, (_, i) => `export function bystander${i}(): number { return ${i} }\n`).join(''))
  return repo
}

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => { view = await startView(casefoldRepo()) })
test.afterAll(() => view?.stop())

test('FR1200 the Terrain and the palette find the symbol the text is in, after names that lengthen when lowered', async ({ page }) => {
  test.setTimeout(120000)
  await page.goto(view.launchUrl)
  const conclusion = page.getByTestId('conclusion')
  await expect(conclusion).toContainText('symbols in', { timeout: 60000 })

  await page.getByLabel('Search').fill('findMe')
  await expect(conclusion).toHaveText('“findMe”: showing the 1 matching symbol; click one to explore it.')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const rows = page.getByRole('table', { name: 'Symbols matching “findMe”' }).locator('tbody tr')
  await expect(rows.locator('td:nth-child(3)')).toHaveText(['src/target:findMe'])
  await answered(page, () => rows.getByRole('button', { name: 'Explore' }).click())
  await expect(page.getByRole('region', { name: 'Focus' })).toContainText('src/target:findMe')

  await page.getByRole('tab', { name: 'Terrain' }).click()
  await page.getByLabel('Search').fill('straße')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Symbols matching “straße”' }).locator('tbody tr td:nth-child(3)')).toHaveText(['src/straße:GROẞe\u0301', 'src/straße:maße'])

  await page.keyboard.press('Control+K')
  await page.keyboard.type('findme')
  await expect(page.getByRole('dialog', { name: 'Command palette' }).getByRole('option').filter({ hasText: 'src/' })).toHaveText([/src\/target:findMe/])
})
