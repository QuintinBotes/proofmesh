// An adapter for `.mem` files whose resident memory grows with its work, so a test can hold it to a small memory budget. In a file,
// `def NAME` declares a function. The initialize config sets the model: `mb_per_file` (`huge_mb` for a file named huge*) is what a
// batch needs, and a batch that needs more than `hold_over_mb` allocates that much and then never answers, as an adapter does when it is
// about to run out of memory; the host is expected to stop it. `init_mb` and `workspace_mb` do the same while initializing and answering
// `workspace`. `child_hold_mb` makes a child process of the adapter hold that much, the adapter itself staying small. `reply_mb` holds
// that much and answers at once. `load_mb` holds that much while initializing and then answers, as a project load that finishes but is
// large does; `init_log` is a file each initialize appends a line to, so a test can count how often the adapter was started. A batch of more than `die_over_files` files kills the adapter with SIGKILL, as the kernel does.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const held = []
const hold = (mb) => held.push(crypto.randomFillSync(Buffer.allocUnsafeSlow(mb * 1048576)))
let workspace = '', cfg = {}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  if (req.method === 'initialize') {
    workspace = req.params.workspace
    cfg = req.params.config ?? {}
    if (cfg.init_log) fs.appendFileSync(cfg.init_log, 'initialize\n')
    if (cfg.init_mb) return hold(cfg.init_mb)
    if (cfg.load_mb) hold(cfg.load_mb)
    reply({ adapter: { id: 'memlang', version: '0.1.0', protocol_version: '1.0', languages: ['memlang'], toolchain: {} }, capabilities: { symbols: true }, external_inputs: [] })
  } else if (req.method === 'workspace') {
    if (cfg.workspace_mb) return hold(cfg.workspace_mb)
    reply({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
  } else if (req.method === 'analyze') {
    if (req.params.paths.length > (cfg.die_over_files ?? Infinity)) process.kill(process.pid, 'SIGKILL')
    if (cfg.child_hold_mb) { spawn(process.execPath, ['-e', `require('crypto').randomFillSync(Buffer.allocUnsafeSlow(${cfg.child_hold_mb} * 1048576)); setInterval(() => {}, 1000)`], { stdio: 'ignore' }); return }
    if (cfg.reply_mb) hold(cfg.reply_mb)
    const need = req.params.paths.reduce((sum, p) => sum + (path.basename(p).startsWith('huge') ? cfg.huge_mb : cfg.mb_per_file), 0)
    if (need > cfg.hold_over_mb) return hold(need)
    const symbols = []
    for (const p of req.params.paths) {
      let at = 0
      for (const [i, text] of fs.readFileSync(path.join(workspace, p), 'utf8').split('\n').entries()) {
        const bytes = Buffer.byteLength(text), m = /^def (\w+)/.exec(text)
        if (m) symbols.push({ local_id: `${p}#${m[1]}`, path: p, kind: 'function', name: m[1], qualified_name: `${p.replace(/\.mem$/, '')}:${m[1]}`, range: { start_byte: at, end_byte: at + Math.max(1, bytes), start_line: i + 1, end_line: i + 1 }, signature: null })
        at += bytes + 1
      }
    }
    reply({ symbols, relationships: [], file_results: req.params.paths.map((p) => ({ path: p, status: 'ok', capabilities: { text: 'complete', symbols: 'complete' } })), diagnostics: [] })
  } else if (req.method === 'shutdown') { reply({}); process.exit(0) }
}).on('close', () => process.exit(0))
