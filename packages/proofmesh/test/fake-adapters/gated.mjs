// An adapter whose analyze waits until a file named `open` exists beside it, so a test can look at an index while it runs.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
const gate = path.join(path.dirname(process.argv[1]), 'open')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const empty = { symbols: [], relationships: [], file_results: [], diagnostics: [] }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  if (req.method === 'initialize') reply({ adapter: { id: 'gated', version: '0', protocol_version: '1.0', languages: ['typescript'], toolchain: {} }, capabilities: {}, external_inputs: [] })
  else if (req.method === 'workspace') reply(empty)
  else if (req.method === 'analyze') { const wait = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(wait); reply(empty) } }, 50) }
  else if (req.method === 'shutdown') { reply({}); process.exit(0) }
}).on('close', () => process.exit(0))
