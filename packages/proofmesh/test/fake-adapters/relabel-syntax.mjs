// The syntax adapter under the name `csharp`: a "precise" C# adapter whose facts are exactly the syntax tier's, so a test can move files
// between tiers without the .NET SDK and know every key is the same.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import readline from 'node:readline'
const child = spawn(process.execPath, [createRequire(import.meta.url).resolve('@proofmesh/adapter-syntax')], { stdio: ['pipe', 'pipe', 'inherit'] })
process.stdin.pipe(child.stdin)
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.result?.adapter) msg.result.adapter = { ...msg.result.adapter, id: 'csharp', languages: ['csharp'] }
  process.stdout.write(JSON.stringify(msg) + '\n')
})
child.on('close', (code) => process.exit(code ?? 0))
