// Shared by the dying fake adapters: answers initialize and workspace, and hands analyze to the caller.
import readline from 'node:readline'
export const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
export const EMPTY = { symbols: [], relationships: [], file_results: [], diagnostics: [] }
export const INITIALIZED = { adapter: { id: 'dying', version: '0', protocol_version: '1.0', languages: ['typescript'], toolchain: {} }, capabilities: {}, external_inputs: [] }
export function serve(onAnalyze, afterInitialize = () => {}) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const req = JSON.parse(line)
    if (req.method === 'initialize') {
      afterInitialize()
      reply(req.id, INITIALIZED)
    } else if (req.method === 'workspace') reply(req.id, EMPTY)
    else if (req.method === 'analyze') onAnalyze(req)
  })
}
