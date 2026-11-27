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
