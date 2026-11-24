// An adapter that exits during every analyze call.
import readline from 'node:readline'
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  if (req.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { adapter: { id: 'crashing', version: '0', protocol_version: '1.0', languages: ['typescript'], toolchain: {} }, capabilities: {}, external_inputs: [] } }) + '\n')
  else if (req.method === 'workspace') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { symbols: [], relationships: [], file_results: [], diagnostics: [] } }) + '\n')
  else if (req.method === 'analyze') process.exit(3)
})
