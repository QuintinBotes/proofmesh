import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { expect, type Page } from '@playwright/test'

export const ROOT = path.resolve(import.meta.dirname, '..')
export const CLI = path.join(ROOT, 'packages', 'proofmesh', 'bin', 'proofmesh.mjs')
const FIXTURE = path.join(ROOT, 'fixtures', 'ts-invoicing', 'repo')

/** Index a fixture into a fresh data directory and start `proofmesh view`; resolves with the printed launch URL. */
export async function startView(fixture = FIXTURE): Promise<{ launchUrl: string; origin: string; dataDir: string; stop: () => void }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-e2e-'))
  for (const args of [['init'], ['repo', 'add', fixture], ['index', fixture]]) {
    const r = spawnSync(process.execPath, [CLI, '--data-dir', dataDir, ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`proofmesh ${args.join(' ')} failed: ${r.stderr}`)
  }
  return serveView(dataDir)
}

/** Start `proofmesh view` on a data directory as it is; resolves with the printed launch URL. */
export async function serveView(dataDir: string): Promise<{ launchUrl: string; origin: string; dataDir: string; stop: () => void }> {
  const child: ChildProcess = spawn(process.execPath, [CLI, '--data-dir', dataDir, 'view', '--port', '0', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const launchUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('proofmesh view did not print a URL')), 20000)
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      const m = /^Observatory: (http:\/\/(?:localhost|127\.0\.0\.1):\d+\/#t=[0-9a-f]{64})$/.exec(line)
      if (m) { clearTimeout(t); resolve(m[1]!) }
    })
  })
  return { launchUrl, origin: new URL(launchUrl).origin, dataDir, stop: () => child.kill() }
}

/** Opens a symbol in Explore's Proof lens from the command palette: a search for text, then the result showing match. */
export async function openInLens(page: Page, text: string, match: string): Promise<void> {
  // The palette's key is listened for once the page has mounted; the repository's crumbs show it has, with a repository open.
  await page.locator('.crumbs').waitFor()
  await page.keyboard.press('Control+K')
  await page.keyboard.type(text)
  // A symbol's option names its kind and qualified name in a dim line; a command, such as Trace a path from it, has none.
  await answered(page, () => page.getByRole('dialog', { name: 'Command palette' }).getByRole('option').filter({ has: page.locator('.dim', { hasText: match }) }).first().click())
  await expect(page.getByRole('region', { name: 'Focus' })).toContainText(match)
}

/** Traces a path from the lens's focus to the symbol picked in Path to, at the given depth when one is given (FR1300). */
export async function traceTo(page: Page, target: [string, string], depth?: number): Promise<void> {
  if (depth !== undefined) {
    await page.focus('#depth')
    await page.keyboard.press('Home')
    for (let i = 1; i < depth; i++) await page.keyboard.press('ArrowRight')
  }
  await page.fill('#picker-path-to', target[0])
  await answered(page, () => page.getByRole('listbox', { name: 'Path to candidates' }).getByRole('button').filter({ hasText: target[1] }).first().click())
}

/** The lens replaced the Trace a path tab (FR1300): open the source in it, then trace from it to the target. */
export async function traceIt(page: Page, source: [string, string], target: [string, string], depth?: number): Promise<void> {
  await openInLens(page, ...source)
  await traceTo(page, target, depth)
}

/** Runs an action and waits for Observatory to finish answering the query it starts. */
export async function answered(page: Page, action: () => Promise<unknown>): Promise<void> {
  const conclusion = page.getByTestId('conclusion')
  const before = await conclusion.getAttribute('data-answered')
  await action()
  await expect(conclusion).not.toHaveAttribute('data-answered', before ?? '0', { timeout: 60000 })
  // Another query that was already in flight, such as the Galaxy's first load, may have bumped the counter: wait until nothing is loading.
  await expect(conclusion).toHaveAttribute('aria-busy', 'false', { timeout: 60000 })
}
