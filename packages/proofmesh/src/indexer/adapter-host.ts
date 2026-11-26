import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { checkAdapterMessage as check } from '../core/schemas.js'
import { log } from '../core/log.js'
import type { AnalyzeResponse, InitializeRequest, InitializeResponse } from '../core/generated.js'

/** `stored` is the message without the adapter's stderr: stderr can hold source text or environment values, so only the live error carries it. */
export class AdapterProtocolError extends Error {
  constructor(message: string, readonly stored: string = message) { super(message) }
}

/** What an error keeps of an adapter's stderr: the last lines, each cut short, so a flood cannot grow a message. */
const STDERR_TAIL_LINES = 10
const STDERR_LINE_CHARS = 300
/** A reply line longer than this many bytes is not a reply; the adapter is stopped instead of buffered without end. */
const MAX_REPLY_LINE_BYTES = 256 * 1024 * 1024
/** After the adapter closes its input and keeps running, how long it has to exit with its own status before it is stopped. */
const CLOSED_INPUT_GRACE_MS = 1000
/** After 'exit', how long the streams have to drain before a descendant that keeps them open no longer holds the result back. */
const DRAIN_GRACE_MS = 2000
const OOM_OVERLAP = 40
const OUT_OF_MEMORY = /out of memory|outofmemory|cannot allocate memory|\boom\b/i

/** Silence allowed while an adapter initializes: it compiles the workspace then, sometimes in one synchronous call. */
const INITIALIZE_SILENCE_MS = 10 * 60 * 1000

export function typescriptAdapterPath(): string {
  if (process.env.PROOFMESH_TS_ADAPTER) return process.env.PROOFMESH_TS_ADAPTER
  return createRequire(import.meta.url).resolve('@proofmesh/adapter-typescript')
}

/** .NET adapters run under `dotnet`; JavaScript adapters run under this Node. */
/** A .dll runs on .NET, a JavaScript file on this Node, and anything else as an executable, so an adapter can be written in any language. */
const launcher = (entry: string): [string, string[]] => (entry.endsWith('.dll') ? ['dotnet', [entry]] : /\.[cm]?js$/.test(entry) ? [process.execPath, [entry]] : [entry, []])

/** A promise that resolves after ms, and can be cancelled so a finished wait leaves no timer holding the process open. */
const after = (ms: number): Promise<void> & { cancel: () => void } => {
  let timer: NodeJS.Timeout
  const p = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) }) as Promise<void> & { cancel: () => void }
  p.cancel = () => clearTimeout(timer)
  return p
}

/** One adapter subprocess speaking JSON-RPC 2.0, one JSON object per line. */
/** The adapter protocol version this core speaks; it accepts any adapter that speaks 1.x (A22). */
export const PROTOCOL_VERSION = '1.1'

export class AdapterProcess {
  private child!: ChildProcess
  private nextId = 1
  private pending = new Map<number, { method: string; silenceMs: number; context?: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private exited = false
  private stderrTail: string[] = []
  private stderrOom = false
  /** Why the adapter is gone, kept so every later call fails with the same words instead of starting it again. */
  private failure?: AdapterProtocolError
  private noRestart = false
  private initParams?: InitializeRequest
  private rssTimer?: NodeJS.Timeout
  restarts = 0
  /** The largest resident set size seen, in KiB; undefined where `ps` is unavailable. */
  peakRssKb?: number

  constructor(private readonly entry: string, private readonly timeoutMs = 60000, private readonly rssSampleMs = 3000, private readonly name = path.basename(entry), private readonly maxReplyBytes = MAX_REPLY_LINE_BYTES) {
    this.start()
  }

  /** shortcut: the adapter process alone, not processes it starts (such as MSBuild nodes); sum the process tree if those grow large. */
  sampleRss(): Promise<void> {
    const pid = this.child.pid
    if (this.exited || !pid) return Promise.resolve()
    return new Promise((resolve) => execFile('ps', ['-o', 'rss=', '-p', String(pid)], { env: { PATH: process.env.PATH ?? '' }, timeout: 5000, killSignal: 'SIGKILL' }, (e, out) => {
      const kb = Number(out?.trim())
      if (!e && kb > 0) this.peakRssKb = Math.max(this.peakRssKb ?? 0, kb)
      resolve()
    }))
  }

  private start(): void {
    this.exited = false
    this.failure = undefined
    this.noRestart = false
    this.stderrTail = []
    this.stderrOom = false
    clearInterval(this.rssTimer)
    const [command, args] = launcher(this.entry)
    const child = this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so a stop reaches what the adapter started (such as MSBuild nodes) and not only the adapter.
      detached: process.platform !== 'win32',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PROOFMESH_LOG_LEVEL: process.env.PROOFMESH_LOG_LEVEL ?? 'info', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', ...(process.env.DOTNET_ROOT ? { DOTNET_ROOT: process.env.DOTNET_ROOT } : {}) },
    })
    let hostKilled: string | undefined, exit: { code: number | null; signal: NodeJS.Signals | null } | undefined, settled = false
    let inputTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined
    /** Stops the adapter for a reason of the host's own; SIGKILL, because a child that ignores SIGTERM would hang the index. */
    const stop = (why: string) => { hostKilled ??= why; this.killGroup(child) }
    this.stopChild = stop
    // The result is read on 'close', when every stream has ended, so the last stderr lines are in the message. 'exit' alone can come first.
    const settle = (what: string, restartable: boolean) => {
      if (settled) return
      settled = true
      clearInterval(this.rssTimer); clearTimeout(inputTimer); clearTimeout(drainTimer)
      this.killGroup(child)
      child.stdout!.destroy(); child.stderr!.destroy(); child.stdin!.destroy()
      this.exited = true
      this.noRestart = !restartable
      const first = [...this.pending.values()][0]
      const head = `adapter ${this.name} ${what}${first?.context ? ` while ${first.context}` : ''}`
      const cause = this.stderrTail.length ? `; the adapter's last output: ${this.stderrTail.join(' | ')}` : ''
      this.failure = new AdapterProtocolError(`${head}${cause}`, `${head}${this.stderrTail.length ? `; ${this.stderrTail.length} lines of its stderr are not stored` : ''}`)
      this.failAll(this.failure)
    }
    // A stream error (EPIPE, ECONNRESET) is a fact about the adapter, never an unhandled event: the exit status follows on 'close'.
    child.stdin!.on('error', (e) => {
      log('debug', 'adapter stdin error', { code: (e as NodeJS.ErrnoException).code })
      if (!exit) inputTimer ??= setTimeout(() => stop('closed its input while it was still running and was stopped with SIGKILL'), CLOSED_INPUT_GRACE_MS)
    })
    child.stdout!.on('error', (e) => log('debug', 'adapter stdout error', { code: (e as NodeJS.ErrnoException).code }))
    child.stderr!.on('error', (e) => log('debug', 'adapter stderr error', { code: (e as NodeJS.ErrnoException).code }))
    const decoder = new StringDecoder('utf8')
    let partial = '', lineBytes = 0
    child.stdout!.on('data', (chunk: Buffer) => {
      // The cap counts raw bytes of the unfinished line, before decoding and splitting: multi-byte text and a newline inside this chunk cannot hide a long line.
      const firstNewline = chunk.indexOf(10)
      const longest = firstNewline < 0 ? lineBytes + chunk.length : lineBytes + firstNewline
      lineBytes = firstNewline < 0 ? lineBytes + chunk.length : chunk.length - chunk.lastIndexOf(10) - 1
      if (longest > this.maxReplyBytes) { partial = ''; stop(`wrote a reply line longer than ${this.maxReplyBytes} bytes (stopped with SIGKILL)`); return }
      const lines = (partial + decoder.write(chunk)).split('\n')
      partial = lines.pop()!
      for (const line of lines) this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
    })
    child.stdout!.on('end', () => { partial += decoder.end(); if (partial) this.onLine(partial); partial = '' })
    // The last stderr lines travel with the exit error: a crash must name its cause, not just its exit code. Only the head of each line is kept.
    child.stderr!.setEncoding('utf8')
    let current = ''
    const keep = () => {
      log('debug', 'adapter stderr', { line: current })
      this.stderrTail.push(current)
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
      current = ''
    }
    // The whole stream is scanned for the marker, a chunk at a time with the end of the one before, because the line kept for the message is cut short.
    let seen = ''
    child.stderr!.on('data', (chunk: string) => {
      const window = seen + chunk
      if (OUT_OF_MEMORY.test(window)) this.stderrOom = true
      seen = window.slice(-OOM_OVERLAP)
      const parts = chunk.split('\n')
      parts.forEach((part, i) => {
        if (current.length < STDERR_LINE_CHARS) current += part.slice(0, STDERR_LINE_CHARS - current.length)
        if (i < parts.length - 1) keep()
      })
    })
    child.stderr!.on('end', () => { if (current) keep() })
    this.rssTimer = setInterval(() => void this.sampleRss(), this.rssSampleMs).unref()
    child.on('error', (e) => settle(`could not be started (${e.message}; command ${command})`, false))
    child.on('exit', (code, signal) => { exit = { code, signal }; drainTimer = setTimeout(() => settle(describe(), restartable()), DRAIN_GRACE_MS) })
    const restartable = () => !hostKilled && !(exit?.signal) && exit?.code !== 137 && !this.stderrOom
    const describe = () => {
      if (hostKilled) return hostKilled
      const how = exit?.signal ? `was terminated by signal ${exit.signal}` : `exited with code ${exit?.code}`
      return restartable() ? how : `${how} (it was killed, most likely because the machine ran out of memory)`
    }
    child.on('close', () => settle(describe(), restartable()))
  }

  /** SIGKILL to the adapter's process group (the adapter and what it started); the adapter alone where groups do not exist. */
  private killGroup(child: ChildProcess): void {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch { /* already gone */ }
  }

  private stopChild: (why: string) => void = () => {}

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown }
    try {
      msg = JSON.parse(line)
    } catch {
      this.stopChild('wrote a line that is not JSON (stopped with SIGKILL)')
      return
    }
    if (msg.method === 'log') {
      const problem = check('adapter-protocol/log.notification.schema.json', msg.params)
      if (problem) this.stopChild(`sent an invalid log notification: ${problem} (stopped with SIGKILL)`)
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

  private request(method: string, params: unknown, silenceMs = this.timeoutMs, context?: string): Promise<unknown> {
    if (this.exited) return Promise.reject(this.failure ?? new AdapterProtocolError(`adapter ${this.name} is not running`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, silenceMs, context, resolve, reject, timer: undefined as unknown as NodeJS.Timeout })
      this.arm(id)
      // A failed write is reported by the stream's own 'error' event and the exit that follows, never thrown here.
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', () => {})
    })
  }

  private arm(id: number): void {
    const p = this.pending.get(id)!
    clearTimeout(p.timer)
    // The adapter is stopped with SIGKILL and fails with its stderr tail once it has closed; a child that ignores SIGTERM must not outlive the call.
    p.timer = setTimeout(() => this.stopChild(`${p.method} timed out: no message from the adapter for ${p.silenceMs} ms (stopped with SIGKILL)`), p.silenceMs)
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initParams = params
    // Adapters compile the whole workspace here, which can take minutes without a chance to report progress.
    const result = await this.request('initialize', params, Math.max(this.timeoutMs, INITIALIZE_SILENCE_MS), 'initializing')
    const spoken = (result as { adapter?: { protocol_version?: unknown } })?.adapter?.protocol_version
    if (typeof spoken !== 'string' || !/^1\.(0|[1-9][0-9]*)$/.test(spoken)) throw new AdapterProtocolError(`the adapter speaks protocol ${String(spoken)} and this core speaks 1.x`)
    const problem = check('adapter-protocol/initialize.response.schema.json', result)
    if (problem) { this.stopChild(`sent an invalid initialize response (stopped with SIGKILL)`); throw new AdapterProtocolError(`invalid initialize response: ${problem}`) }
    return result as InitializeResponse
  }

  /** Facts that do not belong to one analysed file; asked once per index, before any batch, and never cached. */
  async workspace(): Promise<AnalyzeResponse> {
    const result = await this.request('workspace', {}, undefined, 'reading workspace facts')
    const problem = check('adapter-protocol/analyze.response.schema.json', result)
    if (problem) { this.stopChild(`sent an invalid workspace response (stopped with SIGKILL)`); throw new AdapterProtocolError(`invalid workspace response: ${problem}`) }
    return result as AnalyzeResponse
  }

  /** Analyze a batch; on a crash, restart once and retry the batch. */
  async analyze(paths: string[]): Promise<AnalyzeResponse> {
    try {
      return await this.analyzeOnce(paths)
    } catch (e) {
      if (!this.exited || this.noRestart || this.restarts >= 1 || !this.initParams) throw e
      this.restarts++
      log('warning', 'adapter crashed; restarting once', { error: (e as Error).message })
      this.start()
      await this.initialize(this.initParams)
      return this.analyzeOnce(paths)
    }
  }

  private async analyzeOnce(paths: string[]): Promise<AnalyzeResponse> {
    const result = await this.request('analyze', { paths }, undefined, `analysing ${paths[0] ?? 'no file'}${paths.length > 1 ? ` and ${paths.length - 1} more of its batch` : ''}`)
    const problem = check('adapter-protocol/analyze.response.schema.json', result)
    if (problem) { this.stopChild(`sent an invalid analyze response (stopped with SIGKILL)`); throw new AdapterProtocolError(`invalid analyze response: ${problem}`) }
    return result as AnalyzeResponse
  }

  /** Asks the adapter to shut down and reports whether it answered and exited by itself within the time; it is stopped either way. */
  async shutdownCleanly(ms = 5000): Promise<boolean> {
    if (this.exited) return false
    const closed = new Promise<boolean>((resolve) => this.child.once('close', () => resolve(true)))
    const answered = this.request('shutdown', {}).then(() => true, () => false)
    const limit = after(ms)
    const clean = await Promise.race([Promise.all([answered, closed]).then(([a, e]) => a && e), limit.then(() => false)]).finally(() => limit.cancel())
    this.killGroup(this.child)
    return clean
  }

  async shutdown(): Promise<void> {
    if (this.exited) return
    const closed = new Promise<void>((resolve) => this.child.once('close', () => resolve()))
    const answerLimit = after(2000)
    try {
      await Promise.race([this.request('shutdown', {}), answerLimit])
    } catch {
      // The adapter may exit before answering; shutdown is best effort.
    } finally { answerLimit.cancel() }
    // It was asked to exit; one that ignores the request, or SIGTERM, would keep the index process alive.
    const closeLimit = after(1000)
    await Promise.race([closed, closeLimit]).finally(() => closeLimit.cancel())
    this.killGroup(this.child)
  }
}
