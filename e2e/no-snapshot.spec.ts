import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { expect, test } from '@playwright/test'
import { CLI, ROOT, serveView } from './view'

const pm = (dataDir: string, ...args: string[]) => spawnSync(process.execPath, [CLI, '--data-dir', dataDir, ...args], { encoding: 'utf8' })

let view: Awaited<ReturnType<typeof serveView>>
let repoId: string, job: string
test.beforeAll(async () => {
  // A first index killed partway, host and all, leaves no snapshot and a last job that was interrupted.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-e2e-')), repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-e2e-killed-'))
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(repo, `f${i}.ts`), `export const x${i} = ${i}\n`)
  pm(dataDir, 'init')
  repoId = pm(dataDir, 'repo', 'add', repo).stdout.trim()
  const env = { ...process.env, PROOFMESH_TS_ADAPTER: path.join(ROOT, 'packages', 'proofmesh', 'test', 'fake-adapters', 'slow.mjs'), PROOFMESH_INDEX_BATCH: '1' }
  const index = spawn(process.execPath, [CLI, '--data-dir', dataDir, 'index', repoId], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  await new Promise<void>((resolve) => readline.createInterface({ input: index.stderr! }).on('line', (l) => { if (/analyze typescript/.test(l)) resolve() }))
  const gone = new Promise((r) => index.on('close', r))
  process.kill(-index.pid!, 'SIGKILL')
  await gone
  job = JSON.parse(pm(dataDir, 'status', repoId, '--json').stdout).error.details.job_id
  view = await serveView(dataDir)
})
test.afterAll(() => view?.stop())

test('FR1001 the Observatory and its galaxy API name the failed last index job of a repository with no snapshot (#173)', async ({ page }) => {
  expect(job).toMatch(/^job_/)
  await page.goto(view.launchUrl)
  const said = `no published snapshot for this repository; last index job ${job} interrupted`
  await expect(page.getByRole('alert')).toContainText(said)
  // The galaxy's own route, which the view asks once a repository answers, refuses in the same words.
  const galaxy = await page.request.post(`${view.origin}/api/v1/galaxy`, { headers: { origin: view.origin }, data: { repository_id: repoId } })
  expect(galaxy.status()).toBe(409)
  expect((await galaxy.json()).error).toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE', details: { job_id: job } })
  expect((await galaxy.json()).error.message).toContain(said)
})
