import { spawn } from 'node:child_process'
import v8 from 'node:v8'
import { ProofmeshError } from '../core/errors.js'
import { HOST_MEMORY_ENV, hostHeapMb } from '../indexer/memory.js'

const FLAG = '--max-old-space-size='
/** V8's fatal error when the heap limit is reached; it then aborts the process, so the exit is SIGABRT (134 under a shell). */
const OUT_OF_HEAP = /FATAL ERROR: .*(Allocation failed - JavaScript heap out of memory|heap out of memory)/i
const HOST_MARKER = 'PROOFMESH_INDEX_HOST'
/** What a child's environment keeps: the variables the index and its git and .NET children read, never the rest. */
const KEEP = /^(PATH|HOME|USER|LOGNAME|TMPDIR|LANG|LC_.*|PROOFMESH_.*|DOTNET_.*|NUGET_.*|GIT_.*|XDG_.*|NODE_EXTRA_CA_CERTS|SSL_CERT_.*)$/
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** The old-space limit this process runs under, in MB: the flag it was started with, else what V8 reports. */
export const heapLimitMb = (): number => {
  const flag = [...process.execArgv].reverse().find((a) => a.startsWith(FLAG))
  return flag ? Number(flag.slice(FLAG.length)) : Math.round(v8.getHeapStatistics().heap_size_limit / 1048576)
}

/** The index host is the process that holds every relationship until the write; it starts under the rule's heap, not Node's default. */
export const needsHeap = (): boolean => !process.env[HOST_MARKER]

/** Whether a host's stderr and exit say V8 aborted it at the heap limit: its fatal-error text and an abort, not just words an adapter's error repeats. */
const aborted = (code: number | null, signal: NodeJS.Signals | null) => signal === 'SIGABRT' || code === 134
export const diedOfHeap = (stderr: string, code: number | null, signal: NodeJS.Signals | null): boolean => OUT_OF_HEAP.test(stderr) && aborted(code, signal)

export function hostOutOfMemory(mb: number): ProofmeshError {
  return new ProofmeshError('BUDGET_EXCEEDED', `the index host ran out of memory at its heap limit of ${mb} MB; raise it with ${HOST_MEMORY_ENV} (a whole number of MB), or index fewer files at a time`, { detail: 'host_out_of_memory', setting: HOST_MEMORY_ENV, heap_mb: mb })
}

/** The outer process holds an IPC channel to its host; when that closes the outer process is gone (even by SIGKILL), and the host stops with it. */
export function stopWithOuterProcess(): void {
  if (!process.channel) return
  process.channel.unref()
  process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'))
}

/**
 * Runs this CLI again under `--max-old-space-size` from the machine rule and resolves with its exit code, and how it died when that was a
 * signal or a non-zero exit, or rejects with a named error when the child died of heap exhaustion. No shell, an allowlisted environment,
 * signals passed on; no timeout, because an index has no fixed length.
 */
export function runUnderHeap(argv: string[]): Promise<{ code: number; died?: string }> {
  // A heap flag the person gave the outer process stands; it is passed on last, so it wins over the rule's.
  const given = [...process.execArgv].reverse().find((a) => a.startsWith(FLAG))
  const mb = given ? Number(given.slice(FLAG.length)) : hostHeapMb().mb
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (KEEP.test(k)) env[k] = v
    env[HOST_MARKER] = '1'
    const child = spawn(process.execPath, [`${FLAG}${mb}`, ...process.execArgv, process.argv[1]!, ...argv], { stdio: ['inherit', 'inherit', 'pipe', 'ipc'], env })
    // stderr is passed through and scanned, since V8 names the exhaustion there, once, as it aborts, ahead of a long stack trace.
    let tail = '', exhausted = false
    child.stderr!.on('data', (c: Buffer) => { process.stderr.write(c); const seen = tail + c.toString('utf8'); exhausted ||= OUT_OF_HEAP.test(seen); tail = seen.slice(-64) })
    const pass = (s: NodeJS.Signals) => child.kill(s)
    for (const s of SIGNALS) process.on(s, pass)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      for (const s of SIGNALS) process.off(s, pass)
      if (exhausted && aborted(code, signal)) reject(hostOutOfMemory(mb))
      else resolve({
        code: code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 } as Record<string, number>)[signal] ?? 0) : 1),
        ...(signal ? { died: `was killed by signal ${signal}` } : code ? { died: `exited with code ${code}` } : {}),
      })
    })
  })
}
