import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, tmpDir } from './helpers.js'

/** A PATH holding only fake tools: each records its arguments in calls.log and runs the given shell lines. Nothing is installed or built. */
function fakePath(tools: Record<string, string>): { dir: string; calls: () => string[] } {
  const dir = tmpDir('pm-update-'), log = path.join(dir, 'calls.log')
  for (const [name, body] of Object.entries(tools)) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 })
  return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) }
}
const update = (dir: string) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'update.mjs')], { encoding: 'utf8', env: { PATH: dir } })
const CSHARP = 'dotnet build adapters/csharp -c Release -nologo -v:q'

describe('#26 scripts/update.mjs updates a checkout without a global pnpm, or says exactly what to run', () => {
  it('with neither pnpm nor Corepack on PATH it runs nothing, prints the npx fallback, and exits non-zero', () => {
    const fake = fakePath({ dotnet: 'exit 0' })
    const r = update(fake.dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('  npx --yes pnpm@10.14.0 install --frozen-lockfile\n  npx --yes pnpm@10.14.0 build\n  dotnet build adapters/csharp -c Release\n')
    expect(fake.calls()).toEqual([])
  })

  it('with pnpm on PATH it installs, builds, and builds the C# adapter, in that order', () => {
    const fake = fakePath({ pnpm: 'exit 0', dotnet: 'exit 0' })
    const r = update(fake.dir)
    expect(r.status, r.stderr).toBe(0)
    expect(fake.calls()).toEqual(['pnpm install --frozen-lockfile', 'pnpm build', CSHARP])
  })

  it('with only Corepack it enables pnpm through it first', () => {
    const fake = fakePath({ dotnet: 'exit 0' })
    fs.writeFileSync(path.join(fake.dir, 'corepack'), `#!/bin/sh\necho "corepack $*" >> "${fake.dir}/calls.log"\nprintf '#!/bin/sh\\necho "pnpm $*" >> "${fake.dir}/calls.log"\\n' > "${fake.dir}/pnpm"\n/bin/chmod +x "${fake.dir}/pnpm"\n`, { mode: 0o755 })
    const r = update(fake.dir)
    expect(r.status, r.stderr).toBe(0)
    expect(fake.calls()).toEqual(['corepack enable pnpm', 'pnpm install --frozen-lockfile', 'pnpm build', CSHARP])
  })

  it('stops at the first failing step, runs none after it, and says the checkout is not updated', () => {
    const fake = fakePath({ pnpm: '[ "$1" = build ] && exit 3; exit 0', dotnet: 'exit 0' })
    const r = update(fake.dir)
    expect(r.status).toBe(1)
    expect(fake.calls()).toEqual(['pnpm install --frozen-lockfile', 'pnpm build'])
    expect(r.stderr).toContain('update failed: build (exit code 3); the steps after it did not run, so this checkout is not updated')
  })
})
