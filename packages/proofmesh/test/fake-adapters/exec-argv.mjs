// An adapter that names the Node flags it was started with, in its toolchain, and analyses nothing (#32).
import readline from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  if (req.method === 'initialize') reply({ adapter: { id: 'argv', version: '0.1.0', protocol_version: '1.3', languages: ['argv'], toolchain: { exec_argv: JSON.stringify(process.execArgv) } }, capabilities: {}, external_inputs: [] })
  else if (req.method === 'shutdown') { reply({}); process.exit(0) }
  else reply({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
})
