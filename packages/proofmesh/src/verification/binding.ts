// What an approval binds (FR044) and how a run record is authenticated (FR047). Nothing here runs anything.
import crypto from 'node:crypto'
import { canonicalJson, sha256 } from '../core/hash.js'
import { installationKey } from '../query/cursor.js'

export type Recipe = { command: string[]; cwd: string; env_allow: string[]; network: 'none'; timeout_s: number; max_memory_mb: number; max_output_kb: number }
export type Binding = { repository_id: string; snapshot_id: string; recipe: Recipe; toolchain: Record<string, string | null>; workspace: string; filesystem: string; expires_at: string }
export type RunRecord = { vr_id: string; binding_hash: string; sandbox: 'process' | 'container'; container: string | null; started: string; ended: string; exit_code: number | null; signal: string | null; timed_out: boolean; output_sha256: string; truncated: boolean }

export const bindingHash = (b: Binding): string => sha256(canonicalJson(b))

const mac = (dataDir: string, record: RunRecord) => crypto.createHmac('sha256', installationKey(dataDir)).update(canonicalJson(record)).digest('base64url')

export const signRecord = (dataDir: string, record: RunRecord) => ({ record, mac: mac(dataDir, record) })

export function verifyRecord(dataDir: string, signed: { record: RunRecord; mac: string }): boolean {
  const want = Buffer.from(mac(dataDir, signed.record)), got = Buffer.from(signed.mac)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}
