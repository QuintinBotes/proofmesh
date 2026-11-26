#!/usr/bin/env node
// The last step of pnpm build: builds the C# adapter when dotnet is on PATH, and says it skipped it when not (FR386).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const windows = process.platform === 'win32'
const what = 'build the C# adapter'
const runnable = (file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}
const onPath = (name) => (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && (windows ? ['.cmd', '.exe', ''] : ['']).some((ext) => runnable(path.join(dir, name + ext))))
const fail = (message) => { console.error(`build failed: ${message}`); process.exit(1) }

if (!onPath('dotnet')) {
  // An adapter built before would run against the new core, so a stale build is a failure, not a skip, as in scripts/update.mjs.
  if (fs.existsSync(path.join(root, 'adapters', 'csharp', 'bin', 'Release', 'net10.0', 'Proofmesh.Adapter.CSharp.dll'))) fail(`${what}: dotnet is not on PATH and an earlier build would stay in use; install the .NET 10 SDK and run pnpm build again`)
  console.log(`skipped: ${what} (dotnet is not on PATH, so C# files are read by the syntax tier; install the .NET 10 SDK and run pnpm build again)`)
  process.exit(0)
}
// -m:1 keeps MSBuild in one process, so it also builds in sandboxes that refuse its node pipes.
const args = ['build', 'adapters/csharp', '-c', 'Release', '-nologo', '-v:q', '-m:1']
console.log(`==> ${what}: dotnet ${args.join(' ')}`)
const r = spawnSync('dotnet', args, { cwd: root, stdio: 'inherit', shell: windows })
if (r.status !== 0) fail(`${what} (${r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `exit code ${r.status}`})`)
