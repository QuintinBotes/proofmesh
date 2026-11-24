import type { Limits } from './generated.js'

export type AppliedLimits = Required<Limits>
export const DEFAULT_LIMITS: AppliedLimits = { timeout_ms: 10000, max_rows: 100, max_bytes: 65536, max_depth: 6 }
export const MAX_LIMITS: AppliedLimits = { timeout_ms: 30000, max_rows: 1000, max_bytes: 1048576, max_depth: 12 }

export function applyLimits(requested: Limits = {}): { applied: AppliedLimits; limitations: string[] } {
  const applied = { ...DEFAULT_LIMITS }
  const limitations: string[] = []
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof AppliedLimits>) {
    const value = requested[key]
    if (value === undefined) continue
    if (value > MAX_LIMITS[key]) {
      applied[key] = MAX_LIMITS[key]
      limitations.push(`Requested ${key} ${value} exceeds the server maximum; applied ${MAX_LIMITS[key]}.`)
    } else applied[key] = value
  }
  return { applied, limitations }
}
