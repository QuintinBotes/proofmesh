// An adapter whose analyze takes 600 ms, reporting progress every 100 ms unless it was started as slow-silent.mjs.
import readline from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  if (req.method === 'initialize') send({ jsonrpc: '2.0', id: req.id, result: { adapter: { id: 'slow', version: '0', protocol_version: '1.0', languages: ['typescript'], toolchain: {} }, capabilities: {}, external_inputs: [] } })
  else if (req.method === 'workspace') send({ jsonrpc: '2.0', id: req.id, result: { symbols: [], relationships: [], file_results: [], diagnostics: [] } })
  else if (req.method === 'analyze') {
    const tick = process.argv[1].endsWith('slow-silent.mjs') ? undefined : setInterval(() => send({ jsonrpc: '2.0', method: 'log', params: { level: 'debug', message: 'still working' } }), 100)
    setTimeout(() => { clearInterval(tick); send({ jsonrpc: '2.0', id: req.id, result: { symbols: [], relationships: [], file_results: [], diagnostics: [] } }) }, 600)
  } else if (req.method === 'shutdown') { send({ jsonrpc: '2.0', id: req.id, result: {} }); process.exit(0) }
})
