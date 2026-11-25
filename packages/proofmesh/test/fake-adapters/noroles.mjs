// A third-party adapter for python files that speaks protocol 1.0 and sends no roles: `def NAME` declares a function, `call NAME` a resolved call.
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
    reply({ adapter: { id: 'noroles', version: '0.1.0', protocol_version: '1.0', languages: ['python'], toolchain: {} }, capabilities: { symbols: true, resolved_calls: true }, external_inputs: [] })
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
          symbols.push({ local_id: `${p}#${m[1]}`, path: p, kind: 'function', name: m[1], qualified_name: `${p.replace(/\.py$/, '')}:${m[1]}`, range: range(i, text, at), signature: null })
        }
        at += Buffer.byteLength(text) + 1
      }
    }
    for (const p of req.params.paths) {
      let at = 0, current = null
      for (const [i, text] of lines(p).entries()) {
        const d = /^def (\w+)/.exec(text), c = /^\s*call (\w+)/.exec(text)
        if (d) current = `${p}#${d[1]}`
        if (c && current && defs.has(c[1])) relationships.push({ type: 'calls', origin: 'semantic_resolver', source: { symbol: current }, site: { path: p, range: range(i, text, at) }, resolution: 'resolved', target: { symbol: defs.get(c[1]) } })
        at += Buffer.byteLength(text) + 1
      }
    }
    reply({ symbols, relationships, file_results: req.params.paths.map((p) => ({ path: p, status: 'ok', capabilities: { text: 'complete', symbols: 'complete', resolved_calls: 'complete' } })), diagnostics: [] })
  } else if (req.method === 'shutdown') { reply({}); process.exit(0) }
})
