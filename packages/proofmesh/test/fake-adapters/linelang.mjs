// A third-party adapter for a made-up line language, as a contributor would write one (US18): in a .fake file, `def NAME`
// declares a function and `call NAME` calls one; a line starting with `!` is a syntax error, which fails its file. It speaks protocol 1.0
// and resolves calls by name across the batch.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
// A fault for the conformance kit's own tests, set by a launcher file: intolerant, stray, range, random, or linger.
const fault = globalThis.LINELANG_FAULT
let workspace = ''
const lines = (p) => fs.readFileSync(path.join(workspace, p), 'utf8').split('\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  if (req.method === 'initialize') {
    const known = ['protocol_version', 'workspace', 'analysis_mode', 'files', 'config', 'repository_root']
    if (fault === 'intolerant' && Object.keys(req.params).some((k) => !known.includes(k))) return send({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'unknown field' } })
    workspace = req.params.workspace
    reply({ adapter: { id: 'linelang', version: '0.1.0', protocol_version: '1.0', languages: ['linelang'], toolchain: {} }, capabilities: { symbols: true, resolved_calls: true }, external_inputs: [] })
  } else if (req.method === 'workspace') {
    reply({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
  } else if (req.method === 'analyze') {
    const symbols = [], relationships = [], defs = new Map()
    const broken = new Map(req.params.paths.map((p) => [p, lines(p).findIndex((t) => t.startsWith('!'))]).filter(([, i]) => i >= 0))
    const paths = req.params.paths.filter((p) => !broken.has(p))
    for (const p of paths) {
      let at = 0
      for (const [i, text] of lines(p).entries()) {
        const bytes = Buffer.byteLength(text), range = { start_byte: at, end_byte: at + Math.max(1, bytes), start_line: i + 1, end_line: i + 1 }
        const m = /^def (\w+)/.exec(text)
        if (m) {
          const local = `${p}#${m[1]}`, name = fault === 'random' ? `${m[1]}${Math.random().toString(36).slice(2, 6)}` : m[1]
          defs.set(m[1], local)
          symbols.push({ local_id: local, path: p, kind: 'function', name, qualified_name: `${p.replace(/\.fake$/, '')}:${name}`, range: fault === 'range' ? { ...range, end_byte: range.end_byte + 10000 } : range, signature: null })
        }
        at += bytes + 1
      }
    }
    for (const p of paths) {
      let at = 0, current = null
      for (const [i, text] of lines(p).entries()) {
        const bytes = Buffer.byteLength(text), range = { start_byte: at, end_byte: at + Math.max(1, bytes), start_line: i + 1, end_line: i + 1 }
        const d = /^def (\w+)/.exec(text), c = /^\s*call (\w+)/.exec(text)
        if (d) current = `${p}#${d[1]}`
        if (c && current) {
          const target = defs.get(c[1])
          relationships.push(target
            ? { type: 'calls', origin: 'semantic_resolver', source: { symbol: current }, site: { path: p, range }, resolution: 'resolved', target: { symbol: target } }
            : { type: 'calls', origin: 'semantic_resolver', source: { symbol: current }, site: { path: p, range }, resolution: 'unresolved', reason: 'unknown_name' })
        }
        at += bytes + 1
      }
    }
    if (fault === 'stray') symbols.push({ local_id: 'elsewhere#x', path: 'not-asked.fake', kind: 'function', name: 'x', qualified_name: 'not-asked:x', range: { start_byte: 0, end_byte: 1, start_line: 1, end_line: 1 }, signature: null })
    reply({ symbols, relationships, file_results: req.params.paths.map((p) => broken.has(p)
      ? { path: p, status: 'failed', detail: `syntax_error:line ${broken.get(p) + 1}`, capabilities: { text: 'complete', symbols: 'failed', resolved_calls: 'failed' } }
      : { path: p, status: 'ok', capabilities: { text: 'complete', symbols: 'complete', resolved_calls: 'complete' } }), diagnostics: [] })
  } else if (req.method === 'shutdown') { if (fault !== 'linger') { reply({}); process.exit(0) } }
})
