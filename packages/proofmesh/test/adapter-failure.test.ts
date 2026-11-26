import path from 'node:path'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { AdapterProcess, PROTOCOL_VERSION } from '../src/indexer/adapter-host.js'
import type { InitializeRequest } from '../src/core/generated.js'
import { CLI, cli, copyFixture, FIXTURE, ROOT, tmpDir } from './helpers.js'

const fake = (name: string) => path.join(import.meta.dirname, 'fake-adapters', name)
const init = (): InitializeRequest => ({ protocol_version: PROTOCOL_VERSION, workspace: tmpDir('pm-ws-'), analysis_mode: 'no_execution', files: [] })
const big = Array.from({ length: 40000 }, (_, i) => `src/generated/big-${i}.cs`)
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const messageOf = async (p: Promise<unknown>) => { try { await p; return '' } catch (e) { return (e as Error).message } }

const started: AdapterProcess[] = []
const spawned = async (entry: string, timeoutMs?: number, maxReplyBytes?: number) => {
  const a = new AdapterProcess(entry, timeoutMs, 3000, 'csharp', maxReplyBytes)
  started.push(a)
  await a.initialize(init())
  return a
}
afterEach(async () => { for (const a of started.splice(0)) await a.shutdown().catch(() => {}) })

describe('FR260 to FR269 a dying adapter fails the index with its name and exit status, and never crashes it', () => {
  it('FR260 scenario 1: an adapter that exits while the host is still writing fails that call, naming the adapter, its exit code and the file, and raises no unhandled error', async () => {
    const a = await spawned(fake('exits-while-written.mjs'))
    const message = await messageOf(a.analyze(big))
    expect(message).toContain('adapter csharp')
    expect(message).toContain('exited with code 9')
    expect(message).toContain('src/generated/big-0.cs')
    expect(message).toContain(`${big.length - 1} more`)
  })

  it('FR261 scenario 1: an adapter killed by SIGKILL mid-stream says so, with the memory hint, and is not restarted', async () => {
    const a = await spawned(fake('sigkill.mjs'))
    const message = await messageOf(a.analyze(['a.cs', 'b.cs']))
    expect(message).toContain('adapter csharp')
    expect(message).toContain('signal SIGKILL')
    expect(message).toContain('out of memory')
    expect(a.restarts).toBe(0)
  })

  it('FR261 scenario 2: exit 137 and an out-of-memory line on stderr are reported as memory evidence, with the stderr line', async () => {
    const a = await spawned(fake('oom-137.mjs'))
    const message = await messageOf(a.analyze(['a.cs']))
    expect(message).toContain('exited with code 137')
    expect(message).toContain('out of memory')
    expect(message).toContain('FATAL ERROR: Out of memory')
    expect(a.restarts).toBe(0)
  })

  it('FR260 scenario 2: an adapter that closes its input but keeps running fails the call, and is stopped', async () => {
    const a = await spawned(fake('closes-stdin.mjs'))
    const message = await messageOf(a.analyze(big))
    expect(message).toContain('adapter csharp')
    expect(message).toContain('closed its input while it was still running')
    expect(message).toContain('src/generated/big-0.cs')
    expect(a.restarts).toBe(0)
  })

  it('FR262 scenario 1: an adapter that floods stderr is read to its end, and the error carries only a capped tail', async () => {
    const a = await spawned(fake('floods-stderr.mjs'))
    const message = await messageOf(a.analyze(['a.cs']))
    expect(message).toContain('exited with code 1')
    expect(message).toContain('the last words')
    expect(message.length).toBeLessThan(4000)
  })

  it('FR263 scenario 1: an adapter that ignores SIGTERM is killed with SIGKILL when its call times out, and the error names the timeout', async () => {
    const a = await spawned(fake('ignores-sigterm.mjs'), 300)
    const message = await messageOf(a.analyze(['a.cs']))
    const pid = Number(/pid=(\d+)/.exec(message)?.[1])
    try {
      expect(message).toContain('adapter csharp')
      expect(message).toContain('analyze timed out: no message from the adapter for 300 ms')
      expect(Number.isInteger(pid)).toBe(true)
      expect(alive(pid)).toBe(false)
    } finally { if (alive(pid)) process.kill(pid, 'SIGKILL') }
  })

  it('FR263 scenario 2: after an adapter fails once, later calls fail at once with the same reason and nothing is started again', async () => {
    const a = await spawned(fake('sigkill.mjs'))
    const first = await messageOf(a.analyze(['a.cs']))
    expect(await messageOf(a.analyze(['b.cs']))).toBe(first)
    expect(await messageOf(a.workspace())).toBe(first)
  })

  it('FR264 scenario 1: the index fails with exit 1, the previous snapshot stays current, and the failed job names the failed adapter and the one that had finished', () => {
    const d = tmpDir(), repo = copyFixture()
    fs.writeFileSync(`${repo}/Orders.cs`, 'class Orders { }\n')
    cli(['--data-dir', d, 'init'])
    cli(['--data-dir', d, 'repo', 'add', repo])
    expect(cli(['--data-dir', d, 'index', repo]).status).toBe(0)
    const before = (() => { const c = Catalog.open(d); try { return c.currentSnapshot(c.repositories()[0]!.id) } finally { c.close() } })()
    fs.writeFileSync(`${repo}/Billing.cs`, 'class Billing { }\n')
    const r = cli(['--data-dir', d, 'index', repo], { PROOFMESH_CS_ADAPTER: fake('sigkill.mjs') })
    const c = Catalog.open(d)
    try {
      expect(r.status).toBe(1)
      expect(c.currentSnapshot(c.repositories()[0]!.id)).toEqual(before)
      expect(r.stderr).toContain('adapter csharp')
      expect(r.stderr).toContain('signal SIGKILL')
      const jobs = c.db.prepare("select result from index_job where state = 'failed'").all() as Array<{ result: string }>
      expect(jobs).toHaveLength(1)
      expect(JSON.parse(jobs[0]!.result)).toEqual({ failed_adapter: 'csharp', completed_adapters: ['typescript'] })
    } finally { c.close() }
  })

  it('FR266 scenario 1: stderr text reaches the live error but never the stored job or snapshot failure', () => {
    const d = tmpDir()
    cli(['--data-dir', d, 'init'])
    cli(['--data-dir', d, 'repo', 'add', FIXTURE])
    const r = cli(['--data-dir', d, 'index', FIXTURE], { PROOFMESH_TS_ADAPTER: fake('secret-stderr.mjs') })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('unhandled failure in the analyzer')
    const c = Catalog.open(d)
    try {
      const stored = JSON.stringify([c.db.prepare('select * from index_job').all(), c.db.prepare('select * from snapshot').all()])
      expect(stored).toContain('exited with code 3')
      for (const text of [['tok', 'live', '5f2a9c1e7b3d4a68'].join('_'), 'LEDGER_API_TOKEN', 'invoiceTotal', 'unhandled failure']) expect(stored).not.toContain(text)
    } finally { c.close() }
  })

  it('FR265 scenario 1: a stage line follows the end of capture, and every later stage prints its own', () => {
    const d = tmpDir()
    cli(['--data-dir', d, 'init'])
    cli(['--data-dir', d, 'repo', 'add', FIXTURE])
    const r = cli(['--data-dir', d, 'index', FIXTURE])
    const stages = r.stderr.split('\n').map((l) => /^\[\S+\] (\w+)/.exec(l)?.[1]).filter(Boolean)
    expect(stages).toEqual(expect.arrayContaining(['discover', 'capture', 'prepare', 'initialize', 'analyze', 'write', 'check', 'seal']))
    expect(stages.indexOf('prepare')).toBe(stages.indexOf('capture') + 1)
  })

  it('FR267 scenario 1: a timeout kills the adapter\'s whole process group, so a grandchild does not outlive the call', async () => {
    const a = await spawned(fake('grandchild.mjs'), 300)
    const message = await messageOf(a.analyze(['a.cs']))
    const pid = Number(/grandchild=(\d+)/.exec(message)?.[1])
    try {
      expect(Number.isInteger(pid)).toBe(true)
      for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50))
      expect(alive(pid)).toBe(false)
    } finally { if (alive(pid)) process.kill(pid, 'SIGKILL') }
  })

  it('FR262 scenario 2: the reply cap counts bytes, so multi-byte characters and a newline in the crossing chunk cannot pass an oversize line', async () => {
    for (const mode of ['multibyte', 'crossing']) {
      const a = await spawned(fake('oversize-reply.mjs'), undefined, 1000)
      expect(await messageOf(a.analyze([mode]))).toContain('wrote a reply line longer than 1000 bytes')
    }
  })

  it('FR263 scenario 3: output that is not JSON from a live adapter is terminal: it is stopped and every later call fails with the same error', async () => {
    const a = await spawned(fake('not-json.mjs'))
    const first = await messageOf(a.analyze(['a.cs']))
    expect(first).toContain('adapter csharp')
    expect(first).toContain('not JSON')
    expect(await messageOf(a.analyze(['b.cs']))).toBe(first)
    expect(await messageOf(a.workspace())).toBe(first)
    expect(a.restarts).toBe(0)
  })

  it('FR261 scenario 3: an out-of-memory marker past the head of a long stderr line is still found', async () => {
    const a = await spawned(fake('oom-late.mjs'))
    const message = await messageOf(a.analyze(['a.cs']))
    expect(message).toContain('exited with code 1')
    expect(message).toContain('out of memory')
    expect(a.restarts).toBe(0)
  })

  it('FR263 scenario 4: a clean shutdown leaves none of its own timers running', async () => {
    const made: unknown[] = []
    const cleared = new Set<unknown>()
    const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout }
    const set = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => { const t = real.set(fn, ms, ...args) as unknown; if (ms === 1000 || ms === 2000) made.push(t); return t as never }) as unknown as typeof setTimeout)
    const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((t: never) => { cleared.add(t); real.clear(t) }) as typeof clearTimeout)
    try {
      const a = await spawned(fake('versioned-1.7.mjs'))
      await a.shutdown()
      expect(made.length).toBeGreaterThan(0)
      expect(made.filter((t) => !cleared.has(t))).toEqual([])
    } finally { set.mockRestore(); clear.mockRestore() }
  })

  it('FR268 scenario 1: SIGINT to the index kills the adapter\'s process group, even one that ignores SIGTERM, and the CLI exits 130', async () => {
    const d = tmpDir(), cwd = tmpDir('pm-cwd-')
    cli(['--data-dir', d, 'init'])
    cli(['--data-dir', d, 'repo', 'add', FIXTURE])
    const child = spawn(process.execPath, [CLI, '--data-dir', d, 'index', FIXTURE], { cwd, env: { ...process.env, PROOFMESH_TS_ADAPTER: fake('ignores-sigterm-pidfile.mjs') }, stdio: 'ignore' })
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    let pid = NaN
    try {
      // The ready gate: the adapter has been asked to analyze and wrote its pid.
      while (Number.isNaN(pid)) {
        await new Promise((r) => setTimeout(r, 50))
        try { pid = Number(fs.readFileSync(path.join(cwd, 'adapter.pid'), 'utf8')) } catch { /* not yet */ }
      }
      expect(alive(pid)).toBe(true)
      child.kill('SIGINT')
      expect(await closed).toBe(130)
      for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50))
      expect(alive(pid)).toBe(false)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
})

describe('FR269 every adapter exits when its input ends, so none outlives an index that was killed', () => {
  const require = createRequire(import.meta.url)
  const exits = (command: string, args: string[]) => new Promise<number | null>((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('close', (code) => resolve(code))
    child.stdin.end()
  })
  const entries: Record<string, string> = {
    typescript: require.resolve('@proofmesh/adapter-typescript'),
    syntax: require.resolve('@proofmesh/adapter-syntax'),
    python: require.resolve('@proofmesh/adapter-syntax/python'),
    terraform: require.resolve('@proofmesh/adapter-syntax/terraform'),
    build: require.resolve('@proofmesh/adapter-syntax/build'),
    scip: path.join(ROOT, 'packages', 'proofmesh', 'dist', 'scip-adapter.mjs'),
  }
  for (const [name, entry] of Object.entries(entries)) {
    it(`FR269 scenario 1: the ${name} adapter exits when stdin closes`, async () => {
      expect(await exits(process.execPath, [entry])).toBe(0)
    })
  }

  // Docker verify builds the C# adapter, as for the other C# tests; where dotnet is missing the dll is absent and this is skipped.
  const dll = path.join(ROOT, 'adapters', 'csharp', 'bin', 'Release', 'net10.0', 'Proofmesh.Adapter.CSharp.dll')
  it.runIf(fs.existsSync(dll) && spawnSync('dotnet', ['--version']).status === 0)('FR269 scenario 2: the csharp adapter exits when stdin closes (Docker only)', async () => {
    expect(await exits('dotnet', [dll])).toBe(0)
  })
})
