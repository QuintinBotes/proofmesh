// A broken adapter: valid initialize, then an analyze response that violates the protocol schema.
import readline from 'node:readline'
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
  if (req.method === 'initialize') reply({ adapter: { id: 'broken', version: '0', protocol_version: '1.0', languages: ['typescript'], toolchain: {} }, capabilities: {}, external_inputs: [] })
  else if (req.method === 'workspace') reply({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
  else if (req.method === 'analyze') reply({ symbols: [{ local_id: 'x', kind: 'not-a-kind' }], relationships: [], file_results: [], diagnostics: [] })
  else if (req.method === 'shutdown') { reply({}); process.exit(0) }
})
