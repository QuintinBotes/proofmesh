import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { answered, CLI, ROOT, startView } from './view'

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' })
const input = (page: Page) => palette(page).getByRole('combobox', { name: 'Find a symbol, file or command' })
const options = (page: Page) => palette(page).getByRole('option')
const note = (page: Page) => palette(page).getByRole('status')
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

// A launch link works once, so each group shares one page.
test.describe('the command palette on the TypeORM sample', () => {
  test.describe.configure({ mode: 'serial' })
  let view: Awaited<ReturnType<typeof startView>>
  let context: BrowserContext
  let page: Page
  test.beforeAll(async ({ browser }) => {
    view = await startView(path.join(ROOT, 'fixtures', 'ts-typeorm', 'repo'))
    context = await browser.newContext()
    page = await context.newPage()
    await page.goto(view.launchUrl)
    await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  })
  test.afterAll(async () => { await context?.close(); view?.stop() })

  test('FR1140 /, Meta+K and Control+K open the palette, even from the search box; Escape closes it and returns focus where it was', async () => {
    const table = page.getByRole('button', { name: 'Table', exact: true })
    await table.focus()
    await page.keyboard.press('/')
    await expect(input(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(palette(page)).toHaveCount(0)
    await expect(table).toBeFocused()
    await page.keyboard.press('Meta+K')
    await expect(input(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(table).toBeFocused()
    const search = page.getByLabel('Search', { exact: true })
    await search.focus()
    await page.keyboard.press('Control+K')
    await expect(input(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(search).toBeFocused()
    await blur(page)
  })

  test('FR1142 a one-character query lists only commands and says symbols wait for two characters', async () => {
    await page.keyboard.press('Control+K')
    await page.keyboard.type('e')
    await expect(note(page)).toHaveText('Type at least two characters to search symbols and files.')
    expect(await options(page).count()).toBeGreaterThan(0)
    await expect(options(page).filter({ hasText: 'src/' })).toHaveCount(0)
    await page.keyboard.type('n')
    await expect(options(page).filter({ hasText: 'src/entities' }).first()).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('FR1140 FR1404 a file is listed by its name, and Enter brings it into view in the Terrain, named', async () => {
    const label = page.locator('.terrain-label.file', { hasText: 'service.ts' })
    const before = (await label.boundingBox())!
    await page.keyboard.press('Control+K')
    await page.keyboard.type('service.ts')
    await expect(options(page).first()).toHaveText('service.ts file · src/service.ts')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: 'Terrain' })).toHaveAttribute('aria-selected', 'true')
    // The file's cell now fills most of the view, its name at its top left.
    await expect.poll(async () => (await label.boundingBox())?.y ?? before.y).toBeLessThan(before.y - 100)
    await page.getByRole('toolbar', { name: 'Terrain controls' }).getByRole('button', { name: 'Fit everything' }).click()
    await blur(page)
  })

  test('FR1143 typing view or overlay lists the matching commands with their keys, and Enter runs the highlighted one', async () => {
    await page.keyboard.press('Control+K')
    await page.keyboard.type('view')
    await expect(options(page)).toHaveText(['Terrain view1', 'Explore view2', 'Claims view3', 'Diff view4', 'Ecosystem view5', 'Table or graph viewt'])
    await expect(options(page).first()).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(palette(page)).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Explore' })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Control+K')
    await page.keyboard.type('overlay')
    await expect(options(page)).toHaveText(['Diff overlay on the Terrain, shown or hiddend'])
    await page.keyboard.press('Escape')
    await blur(page)
  })

  test('FR1144 with no input focused, the number keys open the views, each tab shows its key, and ? lists every key', async () => {
    // Paths are traced in Explore's lens, so there is no Trace a path tab (FR1300); the Terrain replaced the Galaxy and Map tabs (FR1400).
    const views = ['Terrain', 'Explore', 'Claims', 'Diff', 'Ecosystem']
    for (const [i, name] of views.entries()) {
      const key = String(i + 1)
      await page.keyboard.press(key)
      const tab = page.getByRole('tab', { name })
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(tab).toHaveAttribute('aria-keyshortcuts', key)
      expect(await tab.evaluate((e) => getComputedStyle(e, '::after').content)).toContain(`"${key}"`)
    }
    // A key typed into a field is text, never a shortcut.
    await page.keyboard.press('1')
    await page.locator('#search').focus()
    await page.keyboard.press('2')
    await expect(page.getByRole('tab', { name: 'Terrain' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#search')).toHaveValue('2')
    await page.locator('#search').fill('')
    await blur(page)
    await page.keyboard.press('1')
    await page.keyboard.press('?')
    await expect(input(page)).toHaveValue('')
    await expect(options(page).locator('kbd')).toHaveText(['1', '2', '3', '4', '5', 't', 'd'])
    await expect(note(page)).toContainText('Control+K, ⌘K or / opens this palette, ? lists every key, Escape closes it')
    await page.keyboard.press('Escape')
  })

  test('FR1143 FR1145 the palette opens a symbol, exports its view, and traces a path from it', async () => {
    await page.keyboard.press('Control+K')
    await page.keyboard.type('initialize')
    await answered(page, () => page.keyboard.press('Enter'))
    await expect(page.getByRole('region', { name: 'Focus' })).toContainText('src/data-source:DataSource.initialize')
    await expect(page.getByRole('complementary', { name: 'Evidence' })).toBeFocused()
    await page.keyboard.press('Control+K')
    await page.keyboard.type('export')
    await expect(options(page)).toHaveText(['Export page', 'Export image'])
    const download = page.waitForEvent('download')
    await page.keyboard.press('Enter')
    expect((await download).suggestedFilename()).toMatch(/^proofmesh-explore-.+\.html$/)
    await page.keyboard.press('Control+K')
    await page.keyboard.type('trace a path from')
    await expect(options(page)).toHaveText(['Trace a path from src/data-source:DataSource.initialize'])
    await page.keyboard.press('Enter')
    // The lens traces from its focus (FR1300): the command puts the keyboard in its Path to field.
    await expect(page.getByRole('tab', { name: 'Explore' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('region', { name: 'Focus' })).toContainText('src/data-source:DataSource.initialize')
    await expect(page.locator('#picker-path-to')).toBeFocused()
  })
})

/** A repository written at test time: 45 names that start with load, one more behind a right-to-left override and a zero-width joiner, and markup in a method name. */
function manyNames(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-palette-'))
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }
  write('package.json', '{ "name": "many", "private": true }\n')
  write('tsconfig.json', '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext" }, "include": ["src"] }\n')
  write('src/a\u202Eb.ts', "export function load\u200Dhidden(): number { return 0 }\nexport class Evil {\n  '<b id=pwn>x</b>'(): number { return 1 }\n}\n")
  write('src/items.ts', Array.from({ length: 45 }, (_, i) => `export function loadItem${String(i).padStart(2, '0')}(): number { return ${i} }\n`).join(''))
  return repo
}

test.describe('the command palette on many and hostile names', () => {
  test.describe.configure({ mode: 'serial' })
  let view: Awaited<ReturnType<typeof startView>>
  let context: BrowserContext
  let page: Page
  const dialogs: string[] = []
  test.beforeAll(async ({ browser }) => {
    const repo = manyNames()
    view = await startView(repo)
    // A second snapshot, so there is one to pin.
    fs.appendFileSync(path.join(repo, 'src', 'items.ts'), 'export function later(): number { return 1 }\n')
    const r = spawnSync(process.execPath, [CLI, '--data-dir', view.dataDir, 'index', repo], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`second index failed: ${r.stderr}`)
    context = await browser.newContext()
    page = await context.newPage()
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss() })
    await page.goto(view.launchUrl)
    await expect(page.getByTestId('conclusion')).toContainText('symbols in', { timeout: 60000 })
  })
  test.afterAll(async () => { await context?.close(); view?.stop() })

  test('FR1141 FR1146 more than 30 matches list the first 30 in rank order and say how many more; repository text shows as visible text, never markup', async () => {
    await page.keyboard.press('Control+K')
    await page.keyboard.type('load')
    await expect(note(page)).toHaveText('46 symbols and files match; the first 30 are listed, 16 more. Type more to narrow them.')
    await expect(options(page)).toHaveCount(30)
    await expect(options(page).first()).toHaveText('load⟨U+200D⟩hidden function · src/a⟨U+202E⟩b:load⟨U+200D⟩hidden')
    await expect(options(page).nth(1)).toContainText('src/items:loadItem00')
    await expect(options(page).last()).toContainText('src/items:loadItem28')
    await input(page).fill('pwn')
    await expect(options(page)).toHaveText([/src\/a⟨U\+202E⟩b:Evil\.'<b id=pwn>x<\/b>'/])
    await expect(page.locator('#pwn')).toHaveCount(0)
    expect(dialogs).toEqual([])
    await page.keyboard.press('Escape')
  })

  test('FR1143 a published snapshot can be pinned from the palette, and the current one restored', async () => {
    await page.keyboard.press('Control+K')
    await page.keyboard.type('pin snapshot')
    await expect(options(page)).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('replay-banner')).toBeVisible()
    await page.keyboard.press('Control+K')
    await page.keyboard.type('current snapshot')
    await expect(options(page)).toHaveText(['Back to the current snapshot'])
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('replay-banner')).toHaveCount(0)
  })
})
