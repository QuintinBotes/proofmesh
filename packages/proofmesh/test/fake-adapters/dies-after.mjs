// A per-file adapter for `.fake` files that exits during the analyze call after the Nth, and declares one unit per file.
// It reads `limit` (analyze calls it may answer in all, restarts included; none means all) and appends each call's paths to `calls.log`, both next to this script.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
const here = path.dirname(process.argv[1])
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const limit = fs.existsSync(path.join(here, 'limit')) ? Number(fs.readFileSync(path.join(here, 'limit'), 'utf8')) : Infinity
let files = []
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  if (req.method === 'initialize') {
    files = req.params.files.map((f) => f.path)
    send(req.id, { adapter: { id: 'dying', version: '0', protocol_version: '1.0', languages: ['dying'], toolchain: {} }, capabilities: {}, external_inputs: [], units: files.map((p) => ({ id: p, files: [p] })) })
  } else if (req.method === 'workspace') send(req.id, { symbols: [], relationships: [], file_results: [], diagnostics: [] })
  else if (req.method === 'analyze') {
    fs.appendFileSync(path.join(here, 'calls.log'), JSON.stringify(req.params.paths) + '\n')
    // The host starts a crashed adapter once more, so the count lives in the log, not in this process.
    if (fs.readFileSync(path.join(here, 'calls.log'), 'utf8').trim().split('\n').length > limit) process.exit(3)
    const range = { start_byte: 0, end_byte: 1, start_line: 1, end_line: 1 }
    send(req.id, {
      symbols: req.params.paths.map((p) => ({ local_id: `${p}#f`, path: p, kind: 'function', name: path.basename(p, '.fake'), qualified_name: `${p}:f`, range, signature: null })),
      relationships: [],
      file_results: req.params.paths.map((p) => ({ path: p, status: 'ok', capabilities: { text: 'complete', symbols: 'complete' } })),
      diagnostics: [],
    })
  } else if (req.method === 'shutdown') { send(req.id, {}); process.exit(0) }
}).on('close', () => process.exit(0))
