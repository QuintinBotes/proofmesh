// Claims & trace (#50), the pure part: claims summarised against the current snapshot, a session's entries as numbered steps, the
// visits to each subject, and the dependents of the session's change it never looked at.
import type { GalaxyData } from './galaxyData'
import type { View } from './terrainModel'
import { plural } from './plural'

export type Verdict = 'supported' | 'refuted' | 'inconclusive' | 'invalid'
export type ClaimRun = { verdict: Verdict; snapshot_id: string }
export type Entry = { seq: number; kind: string; tool: string; path?: string; symbol_id?: string; query_id?: string; snapshot_id?: string; outcome: string }
export type Step = { n: number; kind: string; tool: string; snapshot_id?: string; entries: Entry[] }
export type Dependent = { id: string; name: string; qualified_name: string; path: string; line: number; depth: number }
export type Changed = { id: string; never_seen: Dependent[]; searched_only: Dependent[]; opened: Dependent[] }

/** What a pin shows: the verdict of a run against the snapshot on screen, or that its last run was against another one. */
export const pinState = (run: ClaimRun | null, current: string | null): Verdict | 'stale' | 'none' => (!run ? 'none' : current && run.snapshot_id !== current ? 'stale' : run.verdict)
export const GLYPH: Record<string, string> = { supported: '✓', refuted: '✗', inconclusive: '?', invalid: '!', stale: '○', none: '·' }

/** `1 of 4 claims refuted`; claims last checked against another snapshot are counted apart, never as current. */
export function claimsSummary(runs: Array<ClaimRun | null>, current: string | null): string {
  const states = runs.map((r) => pinState(r, current))
  const stale = states.filter((s) => s === 'stale').length, checked = states.filter((s) => s !== 'stale' && s !== 'none').length
  const refuted = states.filter((s) => s === 'refuted').length
  const head = `${refuted} of ${plural(checked, 'claim')} refuted${stale ? ' at the current snapshot' : ''}`
  return [head, ...(stale ? [`${stale} checked at an older snapshot`] : []), ...(states.length - checked - stale ? [`${states.length - checked - stale} not checked`] : [])].join('; ')
}

/** Entries of one recorded query are one step; an entry the plugin recorded is a step of its own. Steps are numbered from 1. */
export function stepsOf(entries: Entry[]): Step[] {
  const steps: Step[] = []
  for (const e of entries) {
    const last = steps.at(-1)
    if (last && e.query_id !== undefined && last.entries[0]!.query_id === e.query_id) last.entries.push(e)
    else steps.push({ n: steps.length + 1, kind: e.kind, tool: e.tool, snapshot_id: e.snapshot_id, entries: [e] })
  }
  return steps
}

/** The steps that visited each subject, keyed by `key` (a subject's place on the map), in order. */
export function visits(steps: Step[], key: (e: Entry) => string | null): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const s of steps) for (const e of s.entries) {
    const k = key(e)
    if (k === null) continue
    const list = out.get(k) ?? []
    if (list.at(-1) !== s.n) list.push(s.n)
    out.set(k, list)
  }
  return out
}

/** Every dependent of the change once, and those the session neither searched for nor opened. */
export function missed(changed: Changed[]): { never: Dependent[]; total: number } {
  const all = new Set<string>(), never = new Map<string, Dependent>()
  for (const c of changed) {
    for (const d of [...c.never_seen, ...c.searched_only, ...c.opened]) all.add(d.id)
    for (const d of c.never_seen) never.set(d.id, d)
  }
  return { never: [...never.values()], total: all.size }
}

/** Galaxy point indices by `kind:qualified_name`, the way a claim names a symbol. */
export function pointsByRef(d: GalaxyData): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < d.n; i++) out.set(`${d.kinds[d.kind[i]!]}:${d.names[i]}`, i)
  return out
}

/** A point's place on screen in the Terrain's current view. */
export const pointOnScreen = (d: GalaxyData, v: View, i: number) => ({ left: d.positions[i * 2]! * v.kx + v.bx, top: d.positions[i * 2 + 1]! * v.ky + v.by })

/** Pins at nearby symbols are stacked upwards, a pin's height apart, so none covers another: each pin is `width` pixels wide. */
export function stackPins(pins: Array<{ left: number; top: number; width: number }>, height = 26): number[] {
  const placed: Array<{ left: number; top: number; width: number }> = []
  return pins.map((p) => {
    let top = p.top
    while (placed.some((q) => Math.abs(q.left - p.left) < (q.width + p.width) / 2 && Math.abs(q.top - top) < height)) top -= height
    placed.push({ ...p, top })
    return top
  })
}
