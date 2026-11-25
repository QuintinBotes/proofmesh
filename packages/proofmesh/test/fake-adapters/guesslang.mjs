// A third-party adapter for a made-up line language whose resolver sometimes guesses. In a .guess file `def NAME` declares a function,
// `call NAME` is a call the resolver proved, and `guess NAME` is a call it bound by a convention: resolved, and marked inferred.
// `ref NAME` is a reference to that function (a read, not a call), proved.
// A name no file defines is an unresolved call.
// It speaks protocol 1.0 and resolves by name across the batch.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
let workspace = ''
const lines = (p) => fs.readFileSync(path.join(workspace, p), 'utf8').split('\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  if (req.method === 'initialize') {
    workspace = req.params.workspace
    reply({ adapter: { id: 'guesslang', version: '0.1.0', protocol_version: '1.0', languages: ['guesslang'], toolchain: {} }, capabilities: { symbols: true, resolved_calls: true }, external_inputs: [] })
  } else if (req.method === 'workspace') {
    reply({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
  } else if (req.method === 'analyze') {
    const symbols = [], relationships = [], defs = new Map()
    const range = (i, text, at) => ({ start_byte: at, end_byte: at + Math.max(1, Buffer.byteLength(text)), start_line: i + 1, end_line: i + 1 })
    for (const p of req.params.paths) {
      let at = 0
      for (const [i, text] of lines(p).entries()) {
        const m = /^def (\w+)/.exec(text)
        if (m) {
          defs.set(m[1], `${p}#${m[1]}`)
          symbols.push({ local_id: `${p}#${m[1]}`, path: p, kind: 'function', name: m[1], qualified_name: `${p.replace(/\.guess$/, '')}:${m[1]}`, range: range(i, text, at), signature: null })
        }
        at += Buffer.byteLength(text) + 1
      }
    }
    for (const p of req.params.paths) {
      let at = 0, current = null
      for (const [i, text] of lines(p).entries()) {
        const d = /^def (\w+)/.exec(text), c = /^\s*(call|guess|ref) (\w+)/.exec(text)
        if (d) current = `${p}#${d[1]}`
        if (c && current) {
          const site = { path: p, range: range(i, text, at) }
          relationships.push(c[1] === 'ref' && defs.has(c[2])
            ? { type: 'references', origin: 'semantic_resolver', source: { symbol: current }, site, resolution: 'resolved', target: { symbol: defs.get(c[2]) } }
            : defs.has(c[2])
            ? { type: 'calls', origin: 'semantic_resolver', source: { symbol: current }, site, resolution: 'resolved', target: { symbol: defs.get(c[2]) }, ...(c[1] === 'guess' ? { detail: { inferred: 'name guessed from a convention' } } : {}) }
            : { type: 'calls', origin: 'semantic_resolver', source: { symbol: current }, site, resolution: 'unresolved', reason: 'unknown_name' })
        }
        at += Buffer.byteLength(text) + 1
      }
    }
    reply({ symbols, relationships, file_results: req.params.paths.map((p) => ({ path: p, status: 'ok', capabilities: { text: 'complete', symbols: 'complete', resolved_calls: 'complete' } })), diagnostics: [] })
  } else if (req.method === 'shutdown') { reply({}); process.exit(0) }
})
