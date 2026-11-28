import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { check } from '../../../packages/proofmesh/src/core/schemas.js'
import { gate, hopText, markCounts, marksOf, parseRange, rangeText, reviewRows, rowTitle, rowWords, summaryText, type Completeness } from '../src/changeModel'
import type { Terrain } from '../src/terrainModel'
import { caveatLines, CONTAINMENT } from '../src/exporting'

// impact_completeness on fixtures/change-reach, base..head-delete at depth 2, recorded from the CLI (--json).
const recorded = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'completeness.json'), 'utf8'))
const data = recorded.data as Completeness

describe('FR1810 Change review reads impact_completeness and decides no status of its own', () => {
  it('the recorded answer is valid against the tool contract, chains included', () => {
    expect(check('tools/impact_completeness.data.schema.json', data)).toBeUndefined()
  })

  it('lists every changed symbol then its dependents, each in the tool\'s words, and the summary and gate from its totals', () => {
    expect(reviewRows(data).map((r) => `${rowTitle(r)} | ${rowWords(r)}`)).toEqual([
      'managerScore src/roles/manager.ts:2 | modified, neither',
      'mean src/stats.ts:1 | modified, tested: analystScoreDoubles test/analyst.test.ts:2 transitive_call depth=2',
      'calls report src/report.ts:3 | neither (via analystScore)',
      'calls analystScore src/roles/analyst.ts:3 | tested: analystScoreDoubles test/analyst.test.ts:2 call depth=1',
      'calls auditorScore src/roles/auditor.ts:3 | neither',
      'calls managerScore src/roles/manager.ts:3 | changed',
      'imports index.ts src/index.ts:1 | neither',
      'spread src/stats.ts:4 | deleted, neither',
      'calls range src/range.ts:3 | neither',
    ])
    expect(summaryText(data.totals)).toBe('3 changed symbols; 6 dependents: 1 changed, 1 tested, 4 neither')
    expect(gate(data.totals)).toEqual({ passing: false, text: 'failing: 4 dependents neither changed nor tested' })
    expect(gate({ ...data.totals, neither: 0 }).passing).toBe(true)
    // A deleted symbol's ids are the base snapshot's.
    expect(reviewRows(data).filter((r) => r.changed.name === 'spread').map((r) => r.snapshot)).toEqual([data.base.snapshot_id, data.base.snapshot_id])
  })

  it('FR1811 a chain reads hop by hop, each at its site, to the change at its declaration', () => {
    const report = data.changed[1]!.dependents.find((d) => d.name === 'report')!
    expect(report.chain.map((_, i) => hopText(report.chain, i, report.relation))).toEqual([
      'report calls analystScore at src/report.ts:3', 'analystScore → mean at src/roles/analyst.ts:3', 'mean, changed, declared at src/stats.ts:1',
    ])
  })

  it('FR1812 a link names base..head, or base alone for the working tree', () => {
    expect(parseRange('abc..def')).toEqual({ base: 'abc', head: 'def' })
    expect(parseRange('HEAD~1')).toEqual({ base: 'HEAD~1', head: null })
    expect(parseRange('abc..')).toEqual({ base: 'abc', head: null })
    expect(parseRange('..def')).toBeNull()
    expect(parseRange(' ')).toBeNull()
    expect(rangeText({ base: 'a', head: 'b' })).toBe('a..b')
    expect(rangeText({ base: 'a', head: null })).toBe('a')
  })

  it('FR1814 marks: a symbol at its point, a deleted one at its base point, an importing file at its cell or its nearest directory\'s, and the rest counted', () => {
    const rows = reviewRows(data)
    const id = (name: string, dependent = true) => rows.find((r) => (dependent ? r.dependent?.name === name : !r.dependent && r.changed.name === name))!.id
    const head = new Map([[id('managerScore', false), 0], [id('mean', false), 1], [id('report'), 2], [id('analystScore'), 3], [id('auditorScore'), 4], [id('managerScore'), 0], [id('range'), -1]])
    const base = new Map([[id('spread', false), 7]])
    const t = { paths: ['', 'src', 'src/roles'] } as unknown as Terrain
    const { marks, unplaced } = marksOf(rows, t, head, base)
    expect(marks.map((m) => [(m.row.dependent ?? m.row.changed).name, m.kind, 'cell' in m ? `cell ${m.cell}` : `${m.base ? 'base ' : ''}point ${m.point}`])).toEqual([
      ['managerScore', 'modified', 'point 0'], ['mean', 'modified', 'point 1'], ['report', 'neither', 'point 2'], ['analystScore', 'tested', 'point 3'],
      ['auditorScore', 'neither', 'point 4'], ['managerScore', 'changed', 'point 0'], ['index.ts', 'neither', 'cell 1'], ['spread', 'deleted', 'base point 7'],
    ])
    // range has no point in this map, so it is counted, and the list still holds it.
    expect(unplaced).toBe(1)
    expect(markCounts(rows)).toEqual({ modified: 2, added: 0, deleted: 1, changed: 1, tested: 1, covered: 0, neither: 4 })
  })

  it('FR1816 an export of Change review says, as the Terrain\'s does, that position shows containment, with its range, gate and limits in the caption', () => {
    const lines = caveatLines({ view: 'Change review', repository: 'r', snapshotId: 's', analysisMode: 'no_execution', scope: `change a..b at depth 1: ${summaryText(data.totals)}; gate ${gate(data.totals).text}`, limits: recorded.limitations, coverage: [] }, null)
    expect(lines).toContain('scope: change a..b at depth 1: 3 changed symbols; 6 dependents: 1 changed, 1 tested, 4 neither; gate failing: 4 dependents neither changed nor tested')
    expect(lines).toContain(`limit: ${recorded.limitations[0]}`)
    expect(lines.at(-1)).toBe(CONTAINMENT)
  })
})
