// A minimal MCP stdio client (newline-delimited JSON-RPC), enough to call tools and time each call.
import { spawn } from 'node:child_process'

export class McpClient {
  constructor(cmd, args, opts = {}) {
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts })
    this.buf = ''
    this.next = 1
    this.pending = new Map()
    this.stderr = ''
    const failed = (error) => {
      this.failure = error
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    }
    this.proc.once('error', failed)
    this.proc.stdin.on('error', failed)
    this.proc.once('close', (code, signal) => failed(new Error(`MCP process closed (${signal ?? code})`)))
    this.proc.stdout.setEncoding('utf8').on('data', (d) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          resolve(msg)
        }
      }
    })
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString('utf8') })
  }
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.next++
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)) } }, 120000)
      timer.unref()
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m) }, reject: e => { clearTimeout(timer); reject(e) } })
    })
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return p
  }
  notify(method, params) { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') }
  async init() {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'graph-bench', version: '0' } })
    this.notify('notifications/initialized', {})
    return r
  }
  async tools() { return (await this.request('tools/list', {})).result.tools }
  // Returns { ms, text, bytes, json, isError }
  async call(name, args) {
    const t0 = performance.now()
    const r = await this.request('tools/call', { name, arguments: args })
    const ms = performance.now() - t0
    const content = r.result?.content ?? []
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    let json = r.result?.structuredContent ?? null
    if (!json) { try { json = JSON.parse(text) } catch { json = null } }
    return { ms, text, bytes: Buffer.byteLength(text), json, isError: !!r.result?.isError, error: r.error }
  }
  close() { try { this.proc.stdin.end(); this.proc.kill() } catch {} }
}
