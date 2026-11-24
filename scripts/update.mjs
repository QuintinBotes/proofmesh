#!/usr/bin/env node
// Brings a checkout up to date after a pull: install, build, and the C# adapter build, in order, stopping at the first failure.
// Plain Node with no dependencies, so it runs before anything is installed: node scripts/update.mjs (or pnpm update:all).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pinned = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager
const windows = process.platform === 'win32'
const csharpBuild = path.join(root, 'adapters', 'csharp', 'bin', 'Release', 'net10.0', 'Proofmesh.Adapter.CSharp.dll')

const runnable = (file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}
const onPath = (name) => (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && (windows ? ['.cmd', '.exe', ''] : ['']).some((ext) => runnable(path.join(dir, name + ext))))
const fail = (message) => { console.error(`update failed: ${message}`); process.exit(1) }

if (!onPath('pnpm') && !onPath('corepack')) {
  console.error(`Neither pnpm nor Corepack is on PATH, so nothing was run. Run the pinned pnpm through npx instead, from ${root}:`)
  console.error(`  npx --yes ${pinned} install --frozen-lockfile`)
  console.error(`  npx --yes ${pinned} build`)
  console.error('  dotnet build adapters/csharp -c Release')
  process.exit(1)
}

const steps = [
  ...(onPath('pnpm') ? [] : [['enable pnpm through Corepack', 'corepack', ['enable', 'pnpm']]]),
  ['install dependencies', 'pnpm', ['install', '--frozen-lockfile']],
  ['build', 'pnpm', ['build']],
  ['build the C# adapter', 'dotnet', ['build', 'adapters/csharp', '-c', 'Release', '-nologo', '-v:q']],
]
for (const [what, command, args] of steps) {
  if (command === 'dotnet' && !onPath('dotnet')) {
    // An adapter built before this update would run against the new core, so a stale build is a failure, not a skip.
    if (fs.existsSync(csharpBuild)) fail(`${what}: dotnet is not on PATH and an earlier build of the C# adapter would stay in use; install the .NET 10 SDK and run this again`)
    console.log(`skipped: ${what} (dotnet is not on PATH; C# files are reported unsupported until it is built)`)
    continue
  }
  console.log(`==> ${what}: ${command} ${args.join(' ')}`)
  const r = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: windows })
  if (r.status !== 0) fail(`${what} (${r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `exit code ${r.status}`}); the steps after it did not run, so this checkout is not updated`)
  console.log(`ok: ${what}`)
}
console.log('Updated. Re-index each repository (proofmesh repo list) so its snapshot comes from the new build: proofmesh index <repository>')
