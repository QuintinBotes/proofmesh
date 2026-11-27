import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { answered, ROOT, startView, traceIt } from './view'

/**
 * A project-authored repository whose names and paths are hostile: markup in a directory name and a method name, a right-to-left
 * override and a zero-width space in file names, a zero-width joiner, a zero-width non-joiner and a Hangul filler (all valid in identifiers) in function names.
 * It is written at test time, so no checkout has to carry these file names.
 */
function hostileRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-hostile-'))
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }
  write('package.json', '{ "name": "hostile", "private": true }\n')
  write('tsconfig.json', '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext" }, "include": ["src"] }\n')
  write('src/<img src=x onerror=alert(1)>/entry.ts', "import { Evil } from '../bidi\u202Egnp'\nexport function start\u200Dhere(): number { return new Evil()['<b id=pwn>x</b>']() }\n")
  write('src/bidi\u202Egnp.ts', "import { \u3164 } from './zero\u200Bwidth'\nexport class Evil {\n  '<b id=pwn>x</b>'(): number { return \u3164() }\n}\n")
  write('src/zero\u200Bwidth.ts', 'export function \u3164(): number { return 1 }\n')
  return repo
}
// How Observatory must show them: markup as text, every bidi and invisible character as its code point.
const START = 'src/<img src=x onerror=alert(1)>/entry:start⟨U+200D⟩here'
const METHOD = "src/bidi⟨U+202E⟩gnp:Evil.'<b id=pwn>x</b>'"
const FILLER = 'src/zero⟨U+200B⟩width:⟨U+3164⟩'
const ADDED = 'src/zero⟨U+200B⟩width:second⟨U+200C⟩one'

let view: Awaited<ReturnType<typeof startView>>
test.beforeAll(async () => {
  const repo = hostileRepo()
  view = await startView(repo)
  // A second snapshot with one more hostile name, so Diff has a change to show.
  fs.appendFileSync(path.join(repo, 'src', 'zero\u200Bwidth.ts'), 'export function second\u200Cone(): number { return 2 }\n')
  const r = spawnSync(process.execPath, [path.join(ROOT, 'packages', 'proofmesh', 'bin', 'proofmesh.mjs'), '--data-dir', view.dataDir, 'index', repo], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`second index failed: ${r.stderr}`)
})
test.afterAll(() => view?.stop())

test('SC012 FR065 hostile names and paths show as visible text in Galaxy, Map, Explore, Trace, Claims and Diff: no script runs, no markup is injected, no policy is violated, nothing loads from elsewhere', async ({ page }) => {
  test.setTimeout(180000)
  const dialogs: string[] = [], elsewhere: string[] = []
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss() })
  page.on('request', (r) => { if (!/^(data|blob):/.test(r.url()) && new URL(r.url()).origin !== view.origin) elsewhere.push(r.url()) })
  await page.addInitScript(() => {
    const w = window as unknown as { violations: string[] }
    w.violations = []
    document.addEventListener('securitypolicyviolation', (e) => w.violations.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  const injected = (where: string) => expect(page.locator('#pwn, img[src="x"]'), where).toHaveCount(0)
  const conclusion = page.getByTestId('conclusion')
  const api = async (tool: string, input: Record<string, unknown>) => (await page.request.post(`${view.origin}/api/v1/tools/${tool}`, { headers: { Origin: view.origin }, data: input })).json()

  await page.goto(view.launchUrl)
  await expect(conclusion).toContainText('symbols in', { timeout: 60000 })

  // Galaxy: the search table lists the names.
  await page.getByLabel('Search').fill('Evil')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const matches = page.getByRole('table', { name: 'Symbols matching “Evil”' })
  await expect(matches).toContainText(METHOD)
  await injected('Galaxy')

  // Explore: the focus card, the neighbours and the evidence panel.
  await answered(page, () => matches.locator('tbody tr').filter({ hasText: METHOD }).getByRole('button', { name: 'Explore' }).click())
  await expect(page.getByRole('region', { name: 'Focus' })).toContainText(METHOD)
  await expect(page.getByTestId('evidence-text')).toContainText("'<b id=pwn>x</b>'(): number { return ⟨U+3164⟩() }")
  // The Proof lens names the neighbours as text too (FR1183).
  const lens = page.getByRole('region', { name: 'Proof lens' })
  await expect(lens).toContainText('start⟨U+200D⟩here')
  await expect(lens).toContainText('src/<img src=x onerror=alert(1)>/entry')
  await injected('Explore lens')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  const neighbours = page.getByRole('table', { name: 'Symbol and its neighbours' })
  await expect(neighbours).toContainText(START)
  await expect(neighbours).toContainText(FILLER)
  await injected('Explore')

  // Map: directory and file names as areas; the first load already opened src, the only top-level directory.
  await page.getByRole('tab', { name: 'Map' }).click()
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await expect(conclusion).toHaveText('src: 3 areas, 2 links between them. Click one to open it.')
  const areas = page.getByRole('table', { name: 'Areas' })
  await expect(areas).toContainText('<img src=x onerror=alert(1)>')
  await expect(areas).toContainText('bidi⟨U+202E⟩gnp')
  await expect(areas).toContainText('zero⟨U+200B⟩width')
  await injected('Map')

  // Trace: pickers and the traced table.
  await traceIt(page, ['start', 'start⟨U+200D⟩here'], ['zero', '⟨U+3164⟩'])
  await expect(conclusion).toHaveText('Path found: 2 steps.')
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Traced nodes in order' }).locator('tbody tr td:nth-child(3)')).toHaveText([START, METHOD, 'src/bidi⟨U+202E⟩gnp:Evil', FILLER])
  await injected('Trace')

  // Claims: a claim whose statement carries markup and an override, about the hostile symbols.
  const id = async (text: string, qualified: RegExp) => ((await api('find_symbols', { text })).data.symbols as Array<{ id: string; qualified_name: string }>).find((s) => qualified.test(s.qualified_name))!.id
  const claim = await api('verify_claim', { claim: { statement: 'Starts <img src=x onerror=alert(2)> here\u202E', proposition: { type: 'relationship', source: await id('start', /entry:start/), relationship: 'calls', target: await id('Evil', /Evil\.'/) } } })
  expect(claim.data.verdict).toBe('supported')
  await page.getByRole('tab', { name: 'Claims' }).click()
  await page.getByRole('list', { name: 'Stored claims' }).getByRole('button').first().click()
  await expect(page.getByRole('region', { name: 'Claim', exact: true })).toContainText('Statement, not checked: Starts <img src=x onerror=alert(2)> here⟨U+202E⟩')
  await injected('Claims')

  // Diff: the added function, against the first snapshot.
  const base = ((await (await page.request.post(`${view.origin}/api/v1/snapshots`, { headers: { Origin: view.origin }, data: {} })).json()).snapshots as Array<{ id: string; current: boolean }>).find((s) => !s.current)!.id
  await page.getByRole('tab', { name: 'Diff' }).click()
  await page.locator('#diff-base').selectOption(base)
  await page.getByRole('button', { name: 'Compare' }).click()
  await expect(page.getByRole('table').filter({ hasText: 'symbol changes' }).locator('tbody tr[data-change="added"]')).toContainText(ADDED)
  await injected('Diff')

  const violations = () => page.evaluate(() => (window as unknown as { violations: string[] }).violations)
  expect(dialogs).toEqual([])
  expect(await violations()).toEqual([])
  expect(elsewhere).toEqual([])

  // The checks can see what they guard against: markup injected on purpose is found, and the policy blocks its handler and reports it.
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<img src=x onerror=alert(1)>'))
  await expect(page.locator('img[src="x"]')).toHaveCount(1)
  await expect.poll(violations).toEqual([expect.stringMatching(/^script-src/)])
  expect(dialogs).toEqual([])
})
