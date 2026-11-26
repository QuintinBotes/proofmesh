// A precise TypeScript adapter for the fallback tests. Each file gets a module symbol and complete capabilities, except
// `src/app.ts`, which it answers `failed` for, and `die.ts`, which kills it while a file `<repository>.die` exists (every time it is asked, so a restart dies too). It logs the files it is asked about to `<repository>.calls`, and `<repository>.noworkspace` makes it fail workspace.
import fs from 'node:fs'
import readline from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const CAPS = { text: 'complete', syntax: 'complete', symbols: 'complete', imports: 'complete', references: 'complete', resolved_calls: 'complete' }
let root = ''
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  const beside = (ext) => `${root}${ext}`
  if (req.method === 'initialize') { root = req.params.repository_root; reply({ adapter: { id: 'typescript', version: '0', protocol_version: '1.0', languages: ['typescript'], toolchain: {} }, capabilities: {}, external_inputs: [], units: req.params.files.map((f) => ({ id: f.path, files: [f.path] })) }) }
  else if (req.method === 'workspace') { if (fs.existsSync(beside('.noworkspace'))) send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'no project model' } }); else reply({ symbols: [], relationships: [], file_results: [], diagnostics: [] }) }
  else if (req.method === 'analyze') {
    fs.appendFileSync(beside('.calls'), req.params.paths.join('\n') + '\n')
    if (fs.existsSync(beside('.die')) && req.params.paths.some((p) => p.endsWith('die.ts'))) { process.stderr.write('LEDGER_SECRET_TOKEN_5f2a\n', () => process.exit(1)); return }
    const symbols = [], file_results = []
    for (const p of req.params.paths) {
      if (p === 'src/app.ts') { file_results.push({ path: p, status: 'failed', detail: 'compile_error', capabilities: { text: 'complete', syntax: 'failed' } }); continue }
      const module = p.replace(/\.[^./]+$/, '')
      symbols.push({ local_id: `${p}#module`, path: p, kind: 'module', name: module.split('/').at(-1), qualified_name: module, range: { start_byte: 0, end_byte: 1, start_line: 1, end_line: 1 }, signature: null })
      file_results.push({ path: p, status: 'ok', capabilities: CAPS })
    }
    reply({ symbols, relationships: [], file_results, diagnostics: [] })
  } else if (req.method === 'shutdown') { reply({}); process.exit(0) }
})
