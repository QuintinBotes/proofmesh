// An adapter for any file that declares one function per file and as many relationships as the file's first line asks for
// (`// rels N`), each at its own byte range, so a test can make the host hold a known number of them until the write.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
let workspace = ''
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  if (req.method === 'initialize') {
    workspace = req.params.workspace
    reply({ adapter: { id: 'flood', version: '0.1.0', protocol_version: '1.0', languages: ['typescript'], toolchain: {} }, capabilities: { symbols: true }, external_inputs: [] })
  } else if (req.method === 'workspace') {
    reply({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
  } else if (req.method === 'analyze') {
    const symbols = [], relationships = []
    for (const p of req.params.paths) {
      const first = fs.readFileSync(path.join(workspace, p), 'utf8').split('\n')[0] ?? ''
      const n = Number(/^\/\/ rels (\d+)/.exec(first)?.[1] ?? 0), local = `${p}#f`
      symbols.push({ local_id: local, path: p, kind: 'function', name: 'f', qualified_name: `${p}:f`, range: { start_byte: 0, end_byte: 1, start_line: 1, end_line: 1 }, signature: null })
      for (let i = 0; i < n; i++) relationships.push({ type: 'calls', origin: 'semantic_resolver', source: { symbol: local }, site: { path: p, range: { start_byte: i, end_byte: i + 1, start_line: 1, end_line: 1 } }, resolution: 'resolved', target: { symbol: local } })
    }
    reply({ symbols, relationships, file_results: req.params.paths.map((p) => ({ path: p, status: 'ok', capabilities: { text: 'complete', symbols: 'complete' } })), diagnostics: [] })
  } else if (req.method === 'shutdown') { reply({}); process.exit(0) }
}).on('close', () => process.exit(0))
