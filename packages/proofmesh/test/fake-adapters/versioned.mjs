// An adapter that speaks the protocol version its launcher sets (adapters get no test environment), and adds fields a newer 1.x minor version might.
import readline from 'node:readline'
const version = globalThis.FAKE_PROTOCOL ?? '1.0'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  if (req.method === 'initialize') {
    process.stderr.write(`core sent ${req.params.protocol_version}\n`)
    reply({ adapter: { id: 'versioned', version: '0', protocol_version: version, languages: ['typescript'], toolchain: {}, homepage: 'https://example.invalid' }, capabilities: {}, external_inputs: [], streaming: true })
  } else if (req.method === 'analyze' || req.method === 'workspace') {
    reply({ symbols: [], relationships: [], file_results: [], diagnostics: [], timings: { ms: 1 } })
  } else if (req.method === 'shutdown') { reply({}); process.exit(0) }
})
