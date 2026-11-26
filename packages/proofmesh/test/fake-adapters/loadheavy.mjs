// An adapter that holds 300 MB while it initializes and then answers, as a large project load does; its batches cost nothing.
import crypto from 'node:crypto'
import readline from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const held = []
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  if (req.method === 'initialize') {
    held.push(crypto.randomFillSync(Buffer.allocUnsafeSlow(300 * 1048576)))
    reply({ adapter: { id: 'typescript', version: '0.1.0', protocol_version: '1.0', languages: ['typescript', 'javascript'], toolchain: {} }, capabilities: { symbols: true }, external_inputs: [] })
  } else if (req.method === 'workspace') reply({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
  else if (req.method === 'analyze') reply({ symbols: [], relationships: [], file_results: req.params.paths.map((p) => ({ path: p, status: 'ok', capabilities: { text: 'complete', symbols: 'complete' } })), diagnostics: [] })
  else if (req.method === 'shutdown') { reply({}); process.exit(0) }
}).on('close', () => process.exit(0))
