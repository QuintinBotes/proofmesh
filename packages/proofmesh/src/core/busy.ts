import type Database from 'better-sqlite3'
import { log } from './log.js'

/** How long one statement waits for another process's write lock; long enough for a large seal. */
export const busyTimeoutMs = (): number => Number(process.env.PROOFMESH_BUSY_TIMEOUT_MS) || 120_000
/** Tries of one write after its busy wait ran out. Each try waits busyTimeoutMs itself, so no sleep sits between them. */
const ATTEMPTS = 10

const isBusy = (e: unknown): boolean => /^SQLITE_(BUSY|LOCKED)/.test((e as { code?: string }).code ?? '')

export function retryBusy<T>(fn: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn()
    } catch (e) {
      if (!isBusy(e) || attempt >= ATTEMPTS) throw e
      log('warning', 'database busy; retrying', { attempt })
    }
  }
}

/**
 * WAL and a long busy timeout, and every write retried when another process still holds the lock.
 * Transactions begin immediate, so a lock that cannot be had fails at BEGIN, where a retry is safe, not half way through.
 */
export function hardenDatabase(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma(`busy_timeout = ${busyTimeoutMs()}`)
  const any = db as unknown as { prepare: (sql: string) => { run: (...a: unknown[]) => unknown }; transaction: (fn: (...a: unknown[]) => unknown) => { immediate: (...a: unknown[]) => unknown } }
  const prepare = any.prepare.bind(db), transaction = any.transaction.bind(db)
  any.prepare = (sql) => {
    const statement = prepare(sql), run = statement.run.bind(statement)
    statement.run = (...a) => retryBusy(() => run(...a))
    return statement
  }
  any.transaction = (fn) => {
    const tx = transaction(fn)
    return ((...a: unknown[]) => retryBusy(() => tx.immediate(...a))) as never
  }
}
