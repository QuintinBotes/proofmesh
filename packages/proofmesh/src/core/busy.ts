import path from 'node:path'
import type Database from 'better-sqlite3'
import { ProofmeshError, isBusy } from './errors.js'
import { log } from './log.js'

const DEFAULT_BUSY_MS = 120_000
/**
 * How long one statement waits for another process's write lock; long enough for a large seal.
 * PROOFMESH_BUSY_TIMEOUT_MS shortens it, but only where PROOFMESH_TEST_HARNESS is also set, and only to a finite positive number (clamped to 10 minutes):
 * a negative value would turn the busy handler off.
 */
export function busyTimeoutMs(): number {
  const asked = Number(process.env.PROOFMESH_BUSY_TIMEOUT_MS)
  if (!process.env.PROOFMESH_TEST_HARNESS || !Number.isFinite(asked) || asked <= 0) return DEFAULT_BUSY_MS
  return Math.min(Math.ceil(asked), 600_000)
}
/** Tries of one write after its busy wait ran out. Each try waits busyTimeoutMs itself, so no sleep sits between them. */
const ATTEMPTS = 10

/**
 * Runs a write again when the database is still busy after its busy wait. What is left of the budget ends as a BUSY error that names the database and the statement,
 * not as the driver's bare "database is locked".
 */
export function retryBusy<T>(fn: () => T, db = 'database', what = ''): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn()
    } catch (e) {
      if (!isBusy(e)) throw e
      if (attempt >= ATTEMPTS) throw new ProofmeshError('BUSY', `${db} stayed busy after ${ATTEMPTS} tries${what ? `: ${what.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`, { database: db, statement: what.slice(0, 160) })
      log('warning', 'database busy; retrying', { attempt, db, statement: what.slice(0, 80) })
    }
  }
}

/**
 * WAL and a long busy timeout, and every write retried when another process still holds the lock.
 * Transactions begin immediate, so a lock that cannot be had fails at BEGIN, where a retry is safe, not half way through.
 */
export function hardenDatabase(db: Database.Database): void {
  const name = path.basename(db.name)
  type Stmt = { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown }
  const any = db as unknown as { exec: (sql: string) => unknown; pragma: (s: string, o?: unknown) => unknown; prepare: (sql: string) => Stmt; transaction: (fn: (...a: unknown[]) => unknown) => { immediate: (...a: unknown[]) => unknown } }
  const prepare = any.prepare.bind(db), exec = any.exec.bind(db), pragma = any.pragma.bind(db), transaction = any.transaction.bind(db)
  // The busy timeout comes first: setting WAL or anything else before it meets a lock held by another run with no wait at all.
  db.pragma(`busy_timeout = ${busyTimeoutMs()}`)
  any.pragma = (s, o) => retryBusy(() => pragma(s, o), name, `pragma ${s}`)
  db.pragma('journal_mode = WAL')
  any.exec = (sql) => retryBusy(() => exec(sql), name, sql)
  any.prepare = (sql) => {
    const statement = prepare(sql)
    for (const m of ['run', 'get', 'all'] as const) {
      const f = statement[m].bind(statement)
      statement[m] = (...a) => retryBusy(() => f(...a), name, sql)
    }
    return statement
  }
  any.transaction = (fn) => {
    const tx = transaction(fn)
    const run = (...a: unknown[]) => retryBusy(() => tx.immediate(...a), name, 'transaction')
    // Callers that name a mode get the same immediate, retried run.
    return Object.assign(run, { immediate: run, deferred: run, exclusive: run }) as never
  }
}
