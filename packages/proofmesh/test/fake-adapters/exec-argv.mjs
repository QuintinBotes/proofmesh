// A TypeScript adapter that names, in its toolchain, the Node flags it and its parent (the index host) were started with, and analyses nothing (#32).
import { execFileSync } from 'node:child_process'
import readline from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const parent = () => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim() } catch { return 'unknown' } }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  if (req.method === 'initialize') reply({ adapter: { id: 'typescript', version: '0.0.1', protocol_version: '1.3', languages: ['typescript', 'javascript'], toolchain: { exec_argv: JSON.stringify(process.execArgv), parent: parent() } }, capabilities: {}, external_inputs: [] })
  else if (req.method === 'shutdown') { reply({}); process.exit(0) }
  else if (req.method === 'analyze') reply({ symbols: [], relationships: [], file_results: req.params.paths.map((path) => ({ path, status: 'ok', capabilities: {} })), diagnostics: [] })
  else reply({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
})
