import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson } from '../core/hash.js'
import { ProofmeshError } from '../core/errors.js'

/** What a cursor binds: the tool, repository, snapshot, and query it continues, where the next page starts, and when it expires. */
export type Cursor = { v: 1; tool: string; repo: string; snap: string; query: string; offset: number; exp: number }

const TTL_MS = 60 * 60 * 1000

/** The installation key cursors and verification records are signed with, created on first use and never leaving the data directory. */
export function installationKey(dataDir: string): Buffer {
  const file = path.join(dataDir, 'tokens', 'cursor')
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex')
}

const mac = (dataDir: string, body: string) => crypto.createHmac('sha256', installationKey(dataDir)).update(body).digest('base64url')

/** The question a cursor continues: the input without cursor, limits, and scope, so a page may change size but not question. */
export function queryHash(tool: string, input: Record<string, unknown>): string {
  // The envelope mode changes only how the answer is wrapped, so a cursor carries across it; budget_bytes is a limit too.
  const { cursor: _c, limits: _l, budget_bytes: _b, snapshot_id: _s, repository_id: _r, envelope: _e, ...question } = input
  return crypto.createHash('sha256').update(`${tool}\n${canonicalJson(question)}`).digest('hex').slice(0, 32)
}

export function sealCursor(dataDir: string, c: Omit<Cursor, 'v' | 'exp'>): string {
  const body = Buffer.from(JSON.stringify({ v: 1, ...c, exp: Date.now() + TTL_MS })).toString('base64url')
  return `pmc1.${body}.${mac(dataDir, body)}`
}

/** A cursor only continues the query it was issued for; it never selects a repository or grants access on its own. */
export function openCursor(dataDir: string, token: string, expected: { tool: string; repo: string; query: string; snapshot?: string }): Cursor {
  const fail = (detail: string, message: string) => new ProofmeshError('INVALID_ARGUMENT', message, { detail })
  const [tag, body, sig] = token.split('.')
  if (tag !== 'pmc1' || !body || !sig) throw fail('cursor_invalid', 'the cursor is not one Proofmesh issued')
  const want = Buffer.from(mac(dataDir, body)), got = Buffer.from(sig)
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw fail('cursor_invalid', 'the cursor failed its integrity check')
  const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Cursor
  if (c.exp < Date.now()) throw fail('cursor_expired', 'the cursor expired; repeat the query without it')
  if (c.tool !== expected.tool || c.repo !== expected.repo || c.query !== expected.query || (expected.snapshot && expected.snapshot !== c.snap)) {
    throw fail('cursor_mismatch', 'the cursor continues a different query')
  }
  return c
}
