import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProofmeshError } from '../core/errors.js'

/** Who holds a repository's index lock, as the lock file records it. */
export type LockHolder = { pid: number; host: string; started_at: string }
export type HeldLock = { release(): void }

const lockDir = (dataDir: string) => path.join(dataDir, 'locks')
export const lockFile = (dataDir: string, repositoryId: string) => path.join(lockDir(dataDir), `index-${repositoryId}.lock`)
export const ownerOf = (h: LockHolder) => `pid:${h.pid}@${h.host}`

// shortcut: a holder on another host counts as alive, because its pid cannot be checked from here; remove the lock file by hand if that host is gone.
const alive = (h: LockHolder): boolean => {
  if (h.host !== os.hostname()) return true
  try { process.kill(h.pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
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
  const mine: LockHolder = { pid: process.pid, host: os.hostname(), started_at: new Date().toISOString() }
  const tmp = `${file}.${process.pid}.tmp`
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
      const aside = `${file}.${process.pid}.stale`
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

/**
 * Takes a repository's index lock. Another run holding it is waited for, or with wait false refused with INDEX_IN_PROGRESS naming its pid and start time.
 * A lock whose process is gone on this host is taken over, and onNotice says so.
 */
export async function acquireIndexLock(dataDir: string, repositoryId: string, name: string, o: { wait?: boolean; onNotice?: (line: string) => void } = {}): Promise<HeldLock> {
  const file = lockFile(dataDir, repositoryId)
  let told = false
  for (;;) {
    const a = tryAcquire(file)
    if ('held' in a) {
      if (a.tookOver) o.onNotice?.(a.tookOver === 'unreadable' ? 'took over an unreadable index lock' : `took over the stale index lock of pid ${a.tookOver.pid} (started ${a.tookOver.started_at}); that process is gone`)
      return a.held
    }
    const { pid, host, started_at } = a.holder
    if (o.wait === false) throw new ProofmeshError('INDEX_IN_PROGRESS', `${name} is already being indexed by pid ${pid} on ${host}, started ${started_at}; run again without --no-wait to wait for it`, { pid, host, started_at, repository_id: repositoryId })
    if (!told) o.onNotice?.(`waiting for the index of ${name} running in pid ${pid} on ${host} since ${started_at}`)
    told = true
    await new Promise((r) => setTimeout(r, 200))
  }
}
