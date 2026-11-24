// An adapter whose only facts are a downstream service and the client that calls it, as a framework rule would declare them.
import readline from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const range = { start_byte: 0, end_byte: 22, start_line: 1, end_line: 1 }
let file = ''
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  if (req.method === 'initialize') {
    file = req.params.files.find((f) => f.language === 'typescript').path
    reply({ adapter: { id: 'typescript', version: '0', protocol_version: '1.0', languages: ['typescript'], toolchain: {} }, capabilities: {}, external_inputs: [] })
  } else if (req.method === 'workspace') {
    reply({
      symbols: [{ local_id: 'fw#service#BillingService', path: file, kind: 'service', name: 'BillingService', qualified_name: 'BillingService', range, signature: 'downstream service' }],
      relationships: [{ type: 'calls_service', origin: 'framework_adapter', source: { symbol: `${file}#class#Client#0` }, site: { path: file, range }, resolution: 'resolved', target: { symbol: 'fw#service#BillingService' }, detail: { rule: 'fake' } }],
      file_results: [], diagnostics: [],
    })
  } else if (req.method === 'analyze') {
    reply({
      symbols: req.params.paths.map((p) => ({ local_id: `${p}#class#Client#0`, path: p, kind: 'class', name: 'Client', qualified_name: 'Client', range, signature: null })),
      relationships: [],
      file_results: req.params.paths.map((p) => ({ path: p, status: 'ok', capabilities: { text: 'complete' } })),
      diagnostics: [],
    })
  } else if (req.method === 'shutdown') { reply({}); process.exit(0) }
})
