import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Node throws a refused spawn (EPERM: a sandbox that will not exec the setuid /bin/ps on macOS) synchronously, not on the callback.
const refuse = vi.hoisted(() => ({ on: false }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: ((...args: Parameters<typeof real.execFile>) => {
      if (refuse.on && args[0] === 'ps') throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM', errno: -1, syscall: 'spawn' })
      return real.execFile(...args)
    }) as typeof real.execFile,
  }
})

afterEach(() => { refuse.on = false })

describe('#105 a ps that cannot run is a skipped memory sample, not a crash (FR270)', () => {
  it('psOutput answers undefined when spawning ps throws EPERM', async () => {
    const { psOutput } = await import('../src/core/ps.js')
    refuse.on = true
    await expect(psOutput(['-A', '-o', 'pid=,rss='])).resolves.toBeUndefined()
  })

  it('a verification command under a memory limit runs to its own exit when ps cannot run', async () => {
    const { execute } = await import('../src/verification/launcher.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ps-'))
    const rejected: unknown[] = []
    const onRejection = (e: unknown) => { rejected.push(e) }
    process.on('unhandledRejection', onRejection)
    refuse.on = true
    try {
      const r = await execute([process.execPath, '-e', 'setTimeout(() => {}, 300)'], dir, { PATH: process.env.PATH ?? '' }, 10000, 4096, path.join(dir, 'log'), { group: true, maxRssKb: 1 << 30, rssSampleMs: 20 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(r).toMatchObject({ code: 0, timedOut: false, memoryExceeded: false })
      expect(rejected).toEqual([])
    } finally { process.off('unhandledRejection', onRejection) }
  })

  it('psOutput answers what ps prints when ps runs', async () => {
    const { psOutput } = await import('../src/core/ps.js')
    const out = await psOutput(['-o', 'pid=', '-p', String(process.pid)])
    expect(out?.trim()).toBe(String(process.pid))
  })
})
