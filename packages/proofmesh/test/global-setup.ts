import { execFileSync, execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..', '..')
/** What the builds below read, besides the built Observatory the CLI build copies when it exists. */
const INPUTS = ['adapters/typescript', 'adapters/syntax', 'adapters/csharp', 'packages/proofmesh', 'schemas', 'package.json', 'pnpm-lock.yaml']
const OUTPUTS = ['adapters/typescript/dist/main.mjs', 'adapters/syntax/dist/main.mjs', 'packages/proofmesh/dist/cli.mjs', 'adapters/csharp/bin/Release/net10.0/Proofmesh.Adapter.CSharp.dll']
const cache = path.join(root, 'node_modules', '.cache')
const stamp = path.join(cache, 'proofmesh-test-build.json')
const lock = path.join(cache, 'proofmesh-test-build.lock')

/** A digest of every build input's content, or undefined outside a git checkout (then the builds always run). */
function inputsDigest(): string | undefined {
  let files: string[]
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', ...INPUTS], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0')
  } catch { return undefined }
  const h = crypto.createHash('sha256')
  for (const f of files.filter((f) => f && !/(^|\/)(dist|bin|obj|test)\//.test(f)).sort()) {
    h.update(`${f}\0`)
    try { h.update(fs.readFileSync(path.join(root, f))) } catch { h.update('\0missing\0') }
  }
  try { const s = fs.statSync(path.join(root, 'apps', 'observatory', 'dist', 'index.html')); h.update(`observatory ${s.size} ${s.mtimeMs}`) } catch { h.update('no observatory') }
  return h.digest('hex')
}

const current = (digest: string | undefined) => {
  if (!digest || !OUTPUTS.every((o) => fs.existsSync(path.join(root, o)))) return false
  try { return (JSON.parse(fs.readFileSync(stamp, 'utf8')) as { digest?: string }).digest === digest } catch { return false }
}

/** One builder at a time across every vitest run of this checkout; a lock older than 15 minutes is a crashed run's. */
async function withLock<T>(fn: () => T): Promise<T> {
  fs.mkdirSync(cache, { recursive: true })
  for (;;) {
    try { fs.mkdirSync(lock); break } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 15 * 60_000) fs.rmSync(lock, { recursive: true, force: true }) } catch { /* released meanwhile */ }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  try { return fn() } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}

/**
 * Tests spawn the adapters and the CLI as real processes, so all of them must be built first. Each build empties its dist, so a run
 * rebuilds only when an input changed since the last build: another run in the same checkout may be executing from those files (#106).
 */
export default async function setup(): Promise<void> {
  await withLock(() => {
    const digest = inputsDigest()
    if (current(digest)) return
    execSync('pnpm --filter @proofmesh/adapter-typescript build && pnpm --filter @proofmesh/adapter-syntax build && pnpm --filter proofmesh build', { cwd: root, stdio: 'inherit' })
    execSync('dotnet build adapters/csharp -c Release -nologo -v:q', { cwd: root, stdio: 'inherit' })
    if (digest) fs.writeFileSync(stamp, JSON.stringify({ digest }) + '\n')
  })
}
