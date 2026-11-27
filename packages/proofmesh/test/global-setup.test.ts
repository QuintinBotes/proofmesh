import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import setup from './global-setup.js'
import { ROOT } from './helpers.js'

describe('#106 a test run in a checkout whose builds are current leaves the built dist folders alone', () => {
  it('the global setup run again does not rebuild, so a file in dist that another run may be reading stays', async () => {
    // The suite's own global setup has just built (or found current) every dist; a second run in the same checkout starts now.
    // One sentinel per run: a fixed name is removed by whichever concurrent run finishes first (#227).
    const sentinel = path.join(ROOT, 'packages', 'proofmesh', 'dist', `.another-run-reads-this-${process.pid}`)
    fs.writeFileSync(sentinel, 'x')
    try {
      await setup()
      expect(fs.existsSync(sentinel)).toBe(true)
      expect(fs.existsSync(path.join(ROOT, 'packages', 'proofmesh', 'dist', 'cli.mjs'))).toBe(true)
    } finally { fs.rmSync(sentinel, { force: true }) }
  }, 300000)
})

describe('FR1660 vitest started in packages/proofmesh gives a test the repository\'s settings, as `pnpm test` at the root does (#225)', () => {
  it('FR1660 a test gets git with the person\'s hooks off and the 60 s timeout', ({ task }) => {
    expect([process.env.GIT_CONFIG_COUNT, process.env.GIT_CONFIG_KEY_0, process.env.GIT_CONFIG_VALUE_0]).toEqual(['1', 'core.hooksPath', '/dev/null'])
    expect(task.timeout).toBe(60000)
  })

  it('FR1660 `npx vitest run test/<file>` in packages/proofmesh runs that test with those settings', () => {
    // The child must not inherit this run's settings, so it shows only what its own config gives it.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_CONFIG_|VITEST)/.test(k)))
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'test/global-setup.test.ts', '-t', 'gets git with'], { cwd: path.join(ROOT, 'packages', 'proofmesh'), encoding: 'utf8', env })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/Tests +1 passed \| 2 skipped \(3\)/)
  }, 300000)
})
