import { describe, expect, it } from 'vitest'
import { claimsSummary, missed, pinState, stepsOf, visits, type Entry } from '../src/claimsModel'

describe('#50 claims against the current snapshot', () => {
  it('FR1951 FR1953 the summary counts refuted claims of the current snapshot, and a claim checked at another is counted apart, never as current', () => {
    const run = (verdict: 'supported' | 'refuted', snapshot_id = 'snap_b') => ({ verdict, snapshot_id })
    expect(claimsSummary([run('supported'), run('supported'), run('supported'), run('refuted')], 'snap_b')).toBe('1 of 4 claims refuted')
    expect(claimsSummary([run('supported', 'snap_a'), run('supported'), run('refuted')], 'snap_b')).toBe('1 of 2 claims refuted at the current snapshot; 1 checked at an older snapshot')
    expect(claimsSummary([run('supported'), null], 'snap_b')).toBe('0 of 1 claim refuted; 1 not checked')
    expect(pinState(run('refuted', 'snap_a'), 'snap_b')).toBe('stale')
    expect(pinState(run('refuted', 'snap_a'), 'snap_a')).toBe('refuted')
  })
})

describe('#50 a session trail as numbered steps', () => {
  const e = (seq: number, kind: string, tool: string, symbol_id: string, query_id?: string): Entry => ({ seq, kind, tool, symbol_id, outcome: 'ok', ...(query_id ? { query_id, snapshot_id: 'snap_b' } : {}) })
  it('FR1954 the entries of one query are one step, a plugin entry is a step of its own, and a subject visited again lists every step that did', () => {
    const steps = stepsOf([e(1, 'searched', 'find_symbols', 's1', 'q1'), e(2, 'searched', 'find_symbols', 's2', 'q1'), e(3, 'opened', 'get_symbol', 's1', 'q2'), e(4, 'opened', 'Read', 's1'), e(5, 'opened', 'Read', 's1')])
    expect(steps.map((s) => [s.n, s.tool, s.entries.length])).toEqual([[1, 'find_symbols', 2], [2, 'get_symbol', 1], [3, 'Read', 1], [4, 'Read', 1]])
    expect(Object.fromEntries(visits(steps, (x) => x.symbol_id ?? null))).toEqual({ s1: [1, 2, 3, 4], s2: [1] })
  })

  it('FR1956 the dependents never looked at are counted once against every dependent of the change', () => {
    const d = (id: string) => ({ id, name: id, qualified_name: id, path: 'a.ts', line: 1, depth: 1 })
    const r = missed([{ id: 'c1', never_seen: [d('a'), d('b')], searched_only: [d('c')], opened: [] }, { id: 'c2', never_seen: [d('b'), d('e')], searched_only: [], opened: [d('f')] }])
    expect(r.never.map((x) => x.id)).toEqual(['a', 'b', 'e'])
    expect(r.total).toBe(5)
  })
})

describe('#50 pins on the map', () => {
  it('FR1950 pins at nearby symbols are stacked so none covers another, and a pin alone stays at its symbol', async () => {
    const { stackPins } = await import('../src/claimsModel')
    const pins = [{ left: 100, top: 100, width: 28 }, { left: 104, top: 101, width: 28 }, { left: 102, top: 99, width: 28 }, { left: 400, top: 100, width: 28 }]
    const tops = stackPins(pins)
    expect([tops[0], tops[3]]).toEqual([100, 100])
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(Math.abs(tops[i]! - tops[j]!)).toBeGreaterThanOrEqual(26)
  })
})
