import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import readline from 'node:readline'
import { checkAdapterMessage as check } from '../core/schemas.js'
import { log } from '../core/log.js'
import type { AnalyzeResponse, InitializeRequest, InitializeResponse } from '../core/generated.js'

export class AdapterProtocolError extends Error {}

/** Silence allowed while an adapter initializes: it compiles the workspace then, sometimes in one synchronous call. */
const INITIALIZE_SILENCE_MS = 10 * 60 * 1000

export function typescriptAdapterPath(): string {
  if (process.env.PROOFMESH_TS_ADAPTER) return process.env.PROOFMESH_TS_ADAPTER
  return createRequire(import.meta.url).resolve('@proofmesh/adapter-typescript')
}

/** .NET adapters run under `dotnet`; JavaScript adapters run under this Node. */
/** A .dll runs on .NET, a JavaScript file on this Node, and anything else as an executable, so an adapter can be written in any language. */
const launcher = (entry: string): [string, string[]] => (entry.endsWith('.dll') ? ['dotnet', [entry]] : /\.[cm]?js$/.test(entry) ? [process.execPath, [entry]] : [entry, []])

/** One adapter subprocess speaking JSON-RPC 2.0, one JSON object per line. */
/** The adapter protocol version this core speaks; it accepts any adapter that speaks 1.x (A22). */
export const PROTOCOL_VERSION = '1.1'

export class AdapterProcess {
  private child!: ChildProcess
  private nextId = 1
  private pending = new Map<number, { method: string; silenceMs: number; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private exited = false
  private stderrTail: string[] = []
  private initParams?: InitializeRequest
  private rssTimer?: NodeJS.Timeout
  restarts = 0
  /** The largest resident set size seen, in KiB; undefined where `ps` is unavailable. */
  peakRssKb?: number

  constructor(private readonly entry: string, private readonly timeoutMs = 60000, private readonly rssSampleMs = 3000) {
    this.start()
  }

  /** shortcut: the adapter process alone, not processes it starts (such as MSBuild nodes); sum the process tree if those grow large. */
  sampleRss(): Promise<void> {
    const pid = this.child.pid
    if (this.exited || !pid) return Promise.resolve()
    return new Promise((resolve) => execFile('ps', ['-o', 'rss=', '-p', String(pid)], (e, out) => {
      const kb = Number(out?.trim())
      if (!e && kb > 0) this.peakRssKb = Math.max(this.peakRssKb ?? 0, kb)
      resolve()
    }))
  }

  private start(): void {
    this.exited = false
    clearInterval(this.rssTimer)
    const [command, args] = launcher(this.entry)
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PROOFMESH_LOG_LEVEL: process.env.PROOFMESH_LOG_LEVEL ?? 'info', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', ...(process.env.DOTNET_ROOT ? { DOTNET_ROOT: process.env.DOTNET_ROOT } : {}) },
    })
    readline.createInterface({ input: this.child.stdout! }).on('line', (line) => this.onLine(line))
    // The last stderr lines travel with the exit error: a crash must name its cause, not just its exit code.
    readline.createInterface({ input: this.child.stderr! }).on('line', (line) => { log('debug', 'adapter stderr', { line: line.slice(0, 500) }); this.stderrTail.push(line.slice(0, 500)); if (this.stderrTail.length > 20) this.stderrTail.shift() })
    this.rssTimer = setInterval(() => void this.sampleRss(), this.rssSampleMs).unref()
    const died = (what: string) => {
      this.exited = true
      clearInterval(this.rssTimer)
      const cause = this.stderrTail.length ? `; the adapter's last output: ${this.stderrTail.join(' | ')}` : ''
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new AdapterProtocolError(`${what}${cause}`)) }
      this.pending.clear()
    }
    this.child.on('error', (e) => died(`adapter could not be started (${e.message}; command ${command})`))
    this.child.on('exit', (code, signal) => died(`adapter exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown }
    try {
      msg = JSON.parse(line)
    } catch {
      this.failAll(new AdapterProtocolError('adapter wrote a line that is not JSON'))
      return
    }
    if (msg.method === 'log') {
      const problem = check('adapter-protocol/log.notification.schema.json', msg.params)
      if (problem) this.failAll(new AdapterProtocolError(`invalid log notification: ${problem}`))
      // The timeout measures silence, not duration: an adapter that reports progress may work as long as it needs.
      else for (const id of this.pending.keys()) this.arm(id)
      return
    }
    const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined
    if (!p) return
    this.pending.delete(msg.id!)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new AdapterProtocolError(msg.error.message))
    else p.resolve(msg.result)
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e) }
    this.pending.clear()
  }

  private request(method: string, params: unknown, silenceMs = this.timeoutMs): Promise<unknown> {
    if (this.exited) return Promise.reject(new AdapterProtocolError('adapter is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, silenceMs, resolve, reject, timer: undefined as unknown as NodeJS.Timeout })
      this.arm(id)
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  private arm(id: number): void {
    const p = this.pending.get(id)!
    clearTimeout(p.timer)
    p.timer = setTimeout(() => {
      this.pending.delete(id)
      p.reject(new AdapterProtocolError(`${p.method} timed out: no message from the adapter for ${p.silenceMs} ms`))
    }, p.silenceMs)
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initParams = params
    // Adapters compile the whole workspace here, which can take minutes without a chance to report progress.
    const result = await this.request('initialize', params, Math.max(this.timeoutMs, INITIALIZE_SILENCE_MS))
    const spoken = (result as { adapter?: { protocol_version?: unknown } })?.adapter?.protocol_version
    if (typeof spoken !== 'string' || !/^1\.(0|[1-9][0-9]*)$/.test(spoken)) throw new AdapterProtocolError(`the adapter speaks protocol ${String(spoken)} and this core speaks 1.x`)
    const problem = check('adapter-protocol/initialize.response.schema.json', result)
    if (problem) throw new AdapterProtocolError(`invalid initialize response: ${problem}`)
    return result as InitializeResponse
  }

  /** Facts that do not belong to one analysed file; asked once per index, before any batch, and never cached. */
  async workspace(): Promise<AnalyzeResponse> {
    const result = await this.request('workspace', {})
    const problem = check('adapter-protocol/analyze.response.schema.json', result)
    if (problem) throw new AdapterProtocolError(`invalid workspace response: ${problem}`)
    return result as AnalyzeResponse
  }

  /** Analyze a batch; on a crash, restart once and retry the batch. */
  async analyze(paths: string[]): Promise<AnalyzeResponse> {
    try {
      return await this.analyzeOnce(paths)
    } catch (e) {
      if (!this.exited || this.restarts >= 1 || !this.initParams) throw e
      this.restarts++
      log('warning', 'adapter crashed; restarting once', { error: (e as Error).message })
      this.start()
      await this.initialize(this.initParams)
      return this.analyzeOnce(paths)
    }
  }

  private async analyzeOnce(paths: string[]): Promise<AnalyzeResponse> {
    const result = await this.request('analyze', { paths })
    const problem = check('adapter-protocol/analyze.response.schema.json', result)
    if (problem) throw new AdapterProtocolError(`invalid analyze response: ${problem}`)
    return result as AnalyzeResponse
  }

  /** Asks the adapter to shut down and reports whether it answered and exited by itself within the time; it is stopped either way. */
  async shutdownCleanly(ms = 5000): Promise<boolean> {
    if (this.exited) return false
    const exited = new Promise<boolean>((resolve) => this.child.once('exit', () => resolve(true)))
    const answered = this.request('shutdown', {}).then(() => true, () => false)
    const clean = await Promise.race([Promise.all([answered, exited]).then(([a, e]) => a && e), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])
    this.child.kill()
    return clean
  }

  async shutdown(): Promise<void> {
    if (this.exited) return
    try {
      await Promise.race([this.request('shutdown', {}), new Promise((r) => setTimeout(r, 2000))])
    } catch {
      // The adapter may exit before answering; shutdown is best effort.
    }
    this.child.kill()
  }
}
