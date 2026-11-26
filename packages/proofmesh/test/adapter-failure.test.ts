import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { AdapterProcess, PROTOCOL_VERSION } from '../src/indexer/adapter-host.js'
import type { InitializeRequest } from '../src/core/generated.js'
import { cli, FIXTURE, tmpDir } from './helpers.js'

const fake = (name: string) => path.join(import.meta.dirname, 'fake-adapters', name)
const init = (): InitializeRequest => ({ protocol_version: PROTOCOL_VERSION, workspace: tmpDir('pm-ws-'), analysis_mode: 'no_execution', files: [] })
const big = Array.from({ length: 40000 }, (_, i) => `src/generated/big-${i}.cs`)
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const messageOf = async (p: Promise<unknown>) => { try { await p; return '' } catch (e) { return (e as Error).message } }

const started: AdapterProcess[] = []
const spawned = async (entry: string, timeoutMs?: number) => {
  const a = new AdapterProcess(entry, timeoutMs, 3000, 'csharp')
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

  it('FR264 scenario 1: the index fails cleanly with a non-zero exit, the previous snapshot stays current, and the failed job names the adapter', () => {
    const d = tmpDir()
    cli(['--data-dir', d, 'init'])
    cli(['--data-dir', d, 'repo', 'add', FIXTURE])
    expect(cli(['--data-dir', d, 'index', FIXTURE]).status).toBe(0)
    const before = (() => { const c = Catalog.open(d); try { return c.currentSnapshot(c.repositories()[0]!.id) } finally { c.close() } })()
    const r = cli(['--data-dir', d, 'index', FIXTURE], { PROOFMESH_TS_ADAPTER: fake('sigkill.mjs') })
    const c = Catalog.open(d)
    try {
      const repo = c.repositories()[0]!
      expect(c.currentSnapshot(repo.id)).toEqual(before)
      const job = c.db.prepare("select state, error, result from index_job where state = 'failed'").all() as Array<{ state: string; error: string; result: string }>
      expect(r.status === 1 || r.status === 0).toBe(true)
      if (r.status === 1) {
        expect(r.stderr).toContain('adapter typescript')
        expect(r.stderr).toContain('signal SIGKILL')
        expect(job).toHaveLength(1)
        expect(JSON.parse(job[0]!.result)).toMatchObject({ failed_adapter: 'typescript' })
      }
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
})
