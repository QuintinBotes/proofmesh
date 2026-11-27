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
      const m = /^Observatory: (http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64})$/.exec(line)
      if (m) { clearTimeout(t); resolve(m[1]!) }
    })
  })
  return { launchUrl, origin: new URL(launchUrl).origin, dataDir, stop: () => child.kill() }
}

export async function pick(page: Page, label: 'Source' | 'Target', text: string, match: string): Promise<void> {
  await page.fill(`#picker-${label.toLowerCase()}`, text)
  await page.getByRole('listbox', { name: `${label} candidates` }).getByRole('button').filter({ hasText: match }).first().click()
}

export async function traceIt(page: Page, source: [string, string], target: [string, string], depth?: number): Promise<void> {
  await page.getByRole('tab', { name: 'Trace a path' }).click()
  await pick(page, 'Source', ...source)
  await pick(page, 'Target', ...target)
  if (depth !== undefined) {
    await page.focus('#depth')
    await page.keyboard.press('Home')
    for (let i = 1; i < depth; i++) await page.keyboard.press('ArrowRight')
  }
  await answered(page, () => page.getByRole('button', { name: 'Trace', exact: true }).click())
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
