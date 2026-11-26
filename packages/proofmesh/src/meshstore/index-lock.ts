import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ProofmeshError } from '../core/errors.js'
import { randomToken, sha256 } from '../core/hash.js'

/** Who holds a repository's index lock, as the lock file records it. */
/** `start` is the process's own start time as ps prints it, so a reused pid is not mistaken for the holder. */
export type LockHolder = { pid: number; host: string; started_at: string; start?: string }
export type HeldLock = { release(): void }

/** Locks this process holds, released on exit: a signal handler that calls process.exit skips every finally. */
const held = new Set<() => void>()
const EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
const releaseAll = () => { for (const release of [...held]) release() }
// A signal that nothing else handles would end the process with no exit event, so the lock would be left for a takeover; release first. Another handler that exits runs the exit event.
const onSignal = (signal: NodeJS.Signals) => { if (process.listenerCount(signal) === 1) { releaseAll(); process.exit(EXIT_CODES[signal]) } }
function track(lock: HeldLock): HeldLock {
  const release = () => {
    held.delete(release)
    lock.release()
    if (!held.size) { process.off('exit', releaseAll); for (const sig of Object.keys(EXIT_CODES)) process.off(sig as NodeJS.Signals, onSignal) }
  }
  if (!held.size) { process.on('exit', releaseAll); for (const sig of Object.keys(EXIT_CODES)) process.on(sig as NodeJS.Signals, onSignal) }
  held.add(release)
  return { release }
}

const lockDir = (dataDir: string) => path.join(dataDir, 'locks')
export const lockFile = (dataDir: string, repositoryId: string) => path.join(lockDir(dataDir), `index-${repositoryId}.lock`)
export const ownerOf = (h: LockHolder) => `pid:${h.pid}@${h.host}`

/** The start time of a process on this host as ps prints it, or undefined where ps cannot say. Bounded: no shell, allowlisted env, SIGKILL on timeout, capped output. */
function processStart(pid: number): string | undefined {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096, env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' } })
  const out = r.status === 0 ? r.stdout.trim() : ''
  return out || undefined
}

// shortcut: a holder on another host counts as alive, because its pid cannot be checked from here; remove the lock file by hand if that host is gone.
const alive = (h: LockHolder): boolean => {
  if (h.host !== os.hostname()) return true
  try { process.kill(h.pid, 0) } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
  // The pid answers; a different start time means the pid now belongs to another process.
  const now = h.start ? processStart(h.pid) : undefined
  return !(h.start && now && now !== h.start)
}

function read(file: string): LockHolder | undefined {
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8')) as LockHolder
    return typeof h.pid === 'number' && typeof h.host === 'string' && typeof h.started_at === 'string' ? h : undefined
  } catch { return undefined }
}

/** The live holder of a repository's lock, if any. */
export function lockHolder(dataDir: string, repositoryId: string): LockHolder | undefined {
  const h = read(lockFile(dataDir, repositoryId))
  return h && alive(h) ? h : undefined
}

/** Every live index lock in the data directory. */
export function liveLocks(dataDir: string): Array<{ repository_id: string; holder: LockHolder }> {
  let names: string[] = []
  try { names = fs.readdirSync(lockDir(dataDir)) } catch { /* no lock was ever taken */ }
  return names.flatMap((n) => {
    const m = /^index-(.+)\.lock$/.exec(n), h = m ? lockHolder(dataDir, m[1]!) : undefined
    return m && h ? [{ repository_id: m[1]!, holder: h }] : []
  })
}

type Attempt = { held: HeldLock; tookOver?: LockHolder | 'unreadable' } | { holder: LockHolder }

/** One atomic try: the lock file is hard-linked into place already complete, so a reader never sees half of it. */
function tryAcquire(file: string): Attempt {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const mine: LockHolder = { pid: process.pid, host: os.hostname(), started_at: new Date().toISOString(), start: processStart(process.pid) }
  // Host and a nonce in the names, so hosts sharing a data directory cannot collide on a pid.
  const unique = `${sha256(mine.host).slice(0, 8)}.${process.pid}.${randomToken().slice(0, 8)}`
  const tmp = `${file}.${unique}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(mine))
  let tookOver: LockHolder | 'unreadable' | undefined
  try {
    for (;;) {
      try {
        fs.linkSync(tmp, file)
        const release = () => { const h = read(file); if (h && h.pid === mine.pid && h.started_at === mine.started_at) fs.rmSync(file, { force: true }) }
        return { held: { release }, ...(tookOver ? { tookOver } : {}) }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      const h = read(file)
      if (h && alive(h)) return { holder: h }
      // Stale: move it aside first, so two runs taking it over cannot both remove the other's fresh lock.
      const aside = `${file}.${unique}.stale`
      try { fs.renameSync(file, aside) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
      const moved = read(aside)
      if (moved && alive(moved)) {
        // What was moved was a live lock another run had just taken: put it back.
        try { fs.linkSync(aside, file) } catch { /* someone else holds it now, which is fine */ }
        fs.rmSync(aside, { force: true })
        return { holder: moved }
      }
      fs.rmSync(aside, { force: true })
      tookOver = moved ?? 'unreadable'
    }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

const GC_LOCK = (dataDir: string) => path.join(lockDir(dataDir), 'gc.lock')
const gcRunning = (dataDir: string) => { const h = read(GC_LOCK(dataDir)); return h && alive(h) ? h : undefined }

/** Takes the data directory's gc lock, which indexes check after taking their own, so gc and an index starting never both proceed. */
export function takeGcLock(dataDir: string): HeldLock {
  const a = tryAcquire(GC_LOCK(dataDir))
  if (!('held' in a)) throw new ProofmeshError('INVALID_ARGUMENT', `another gc (pid ${a.holder.pid} on ${a.holder.host}, started ${a.holder.started_at}) is running`)
  return track(a.held)
}

const nap = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(done, ms)
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve() }
  signal?.addEventListener('abort', done, { once: true })
})

/**
 * Takes a repository's index lock. Another run holding it is waited for, or with wait false refused with INDEX_IN_PROGRESS naming its pid and start time.
 * A lock whose process is gone on this host is taken over, and onNotice says so. A running gc is waited for the same way, and abort ends the wait with CANCELLED.
 */
export async function acquireIndexLock(dataDir: string, repositoryId: string, name: string, o: { wait?: boolean; onNotice?: (line: string) => void; onWait?: () => void; signal?: AbortSignal } = {}): Promise<HeldLock> {
  const file = lockFile(dataDir, repositoryId)
  let told = false
  for (;;) {
    if (o.signal?.aborted) throw new ProofmeshError('CANCELLED', `waiting for the index lock of ${name} was cancelled`)
    const a = tryAcquire(file)
    let blocker: { what: string; h: LockHolder } | undefined
    if ('held' in a) {
      const gc = gcRunning(dataDir)
      if (!gc) {
        if (a.tookOver) o.onNotice?.(a.tookOver === 'unreadable' ? 'took over an unreadable index lock' : `took over the stale index lock of pid ${a.tookOver.pid} (started ${a.tookOver.started_at}); that process is gone`)
        return track(a.held)
      }
      // gc took its lock first or at the same moment: step aside so it sees no index, and wait for it.
      a.held.release()
      blocker = { what: 'a gc', h: gc }
    } else blocker = { what: `the index of ${name}`, h: a.holder }
    const { pid, host, started_at } = blocker.h
    if (o.wait === false) throw new ProofmeshError('INDEX_IN_PROGRESS', `${blocker.what === 'a gc' ? `a gc is running, so ${name} cannot be indexed` : `${name} is already being indexed`} by pid ${pid} on ${host}, started ${started_at}; run again without --no-wait to wait for it`, { pid, host, started_at, repository_id: repositoryId })
    if (!told) o.onNotice?.(`waiting for ${blocker.what} running in pid ${pid} on ${host} since ${started_at}`)
    told = true
    o.onWait?.()
    await nap(200, o.signal)
  }
}
