import { describe, expect, it } from 'vitest'
import type { SnapshotInfo } from '../src/api'
import type { CompareData } from '../src/diff'
import type { GalaxyData } from '../src/galaxyData'
import { linked, marks, neighbour, shareText, stepCounts } from '../src/time'

/** A galaxy holding only what Time reads: names and positions. */
const galaxy = (id: string, points: Array<[string, number, number]>) => ({ snapshotId: id, n: points.length, names: points.map((p) => p[0]), positions: Uint16Array.from(points.flatMap((p) => [p[1], p[2]])) }) as unknown as GalaxyData
const sym = (qualified_name: string, path = 'src/a.ts') => ({ id: `id:${qualified_name}`, qualified_name, kind: 'function', path })
const side = (snapshot_id: string) => ({ snapshot_id, published_at: '', symbols: 0, relationships: 0, unresolved: 0 })
const snap = (id: string, current = false): SnapshotInfo => ({ id, published_at: null, analysis_mode: 'no_execution', current, git: null, symbols: 10, relationships: 40, unresolved: 3 })

const base = galaxy('A', [['src/a:keep', 100, 100], ['src/a:gone', 200, 200], ['src/a:body', 300, 300], ['src/a:shift', 400, 400], ['src/old:moved', 500, 500], ['src/a:Box', 600, 600], ['src/a:Box.size', 610, 610]])
const head = galaxy('B', [['src/a:keep', 100, 100], ['src/a:new', 250, 250], ['src/a:body', 300, 300], ['src/a:shift', 400, 400], ['src/new:moved', 900, 900], ['src/a:Box', 600, 600], ['src/a:Box.size', 610, 610], ['src/b:one', 700, 700], ['src/b:two', 800, 720]])
const compared = {
  base: side('A'), head: side('B'),
  symbols: {
    counts: { added: 1, removed: 1, changed: 5 },
    added: [sym('src/a:new'), { ...sym('src/b', 'src/b.ts'), kind: 'module' }, sym('src/a:nowhere')], removed: [sym('src/a:gone')],
    changed: [{ ...sym('src/a:body'), what: ['range', 'body'] }, { ...sym('src/a:shift'), what: ['range'] }, { ...sym('src/a:Box'), what: ['range', 'body'] }, { ...sym('src/a:Box.size'), what: ['body'] }, { ...sym('src/b', 'src/b.ts'), kind: 'module', what: ['range'] }],
    paired: [{ change: 'moved', base: sym('src/old:moved', 'src/old.ts'), head: sym('src/new:moved', 'src/new.ts') }],
  },
  relationships: { added: 0, removed: 0, by_type: {} }, files: { added: [], removed: [], changed: [], disposition_changes: [] },
} as unknown as CompareData

describe('FR1762 one step of Time, drawn from compare_snapshots of two neighbouring snapshots', () => {
  it('an added symbol is a dot where it now is, a removed one a cross where it was, a body or signature change a ring, a range alone moved lines, a class changed by its member is not ringed, a new file is marked amid its symbols, and a moved symbol slides from its old place', () => {
    const m = marks(base, head, compared)
    expect(m.map((x) => [x.change, x.name, x.x, x.y, x.from ?? null, x.index])).toEqual([
      ['added', 'src/a:new', 250, 250, null, 1],
      ['added', 'src/b', 750, 710, null, null],
      ['removed', 'src/a:gone', 200, 200, null, null],
      ['changed', 'src/a:body', 300, 300, null, 2],
      ['lines', 'src/a:shift', 400, 400, null, 3],
      ['members', 'src/a:Box', 600, 600, null, 5],
      ['changed', 'src/a:Box.size', 610, 610, null, 6],
      ['lines', 'src/b', 750, 710, null, null],
      ['moved', 'src/new:moved', 900, 900, [500, 500], 4],
    ])
    // Every mark says what it is in words, never by colour alone (FR057); a move names the old path.
    expect(m.map((x) => x.title)).toEqual(['new: added', 'b: added, a new file', 'gone: removed, shown where it was', 'body: changed (body)', 'shift: moved lines, its declaration unchanged', 'Box: changed through its members', 'size: changed (body)', 'b: moved lines, its declaration unchanged', 'moved: moved from src/old.ts'])
  })

  it('counts are compare_snapshots\' own, with its changed split into a changed declaration and moved lines', () => {
    expect(stepCounts(compared)).toEqual({ added: 1, removed: 1, changed: 2, members: 1, lines: 2, moved: 1 })
  })

  it('a symbol the galaxy does not hold draws no mark', () => {
    expect(marks(galaxy('A', []), galaxy('B', []), compared)).toEqual([])
  })
})

describe('FR1761 FR1765 the strip steps one snapshot at a time and a link names a snapshot', () => {
  const list = [snap('C', true), snap('B'), snap('A')]
  it('newest first: older is the next one down, newer the one up, and neither past an end', () => {
    expect([neighbour(list, 'B', -1), neighbour(list, 'B', 1), neighbour(list, 'A', -1), neighbour(list, 'C', 1)]).toEqual(['A', 'C', null, null])
  })
  it('each snapshot says its symbols and its unresolved share', () => {
    expect(shareText(snap('A'))).toBe('10 symbols · 7.5% unresolved')
    expect(shareText({ ...snap('A'), symbols: null, relationships: null, unresolved: null })).toBe('counts unavailable')
  })
  it('a link to a listed snapshot opens it; one to a snapshot no longer listed offers the oldest listed, since retention retires the oldest first', () => {
    expect(linked(list, 'B')).toEqual({ id: 'B', gone: false })
    expect(linked(list, 'Z')).toEqual({ id: 'A', gone: true })
    expect(linked([], 'Z')).toEqual({ id: null, gone: true })
  })
})
