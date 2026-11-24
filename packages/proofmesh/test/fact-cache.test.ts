import { describe, expect, it } from 'vitest'
import type { AnalyzeResponse } from '../src/core/generated.js'
import { fileKeys, splitByFile, type KeyInputs } from '../src/indexer/fact-cache.js'

const hashes: Record<string, string> = { 'a/One.cs': '1', 'a/Two.cs': '2', 'b/Three.cs': '3' }
const inputs = (over: Partial<KeyInputs> = {}): KeyInputs => ({
  repository: 'repo', adapter: { id: 'csharp' }, analysisMode: 'no_execution', config: {}, externalInputs: [], configs: [{ path: 'a/A.csproj', hash: 'p' }],
  sources: Object.keys(hashes), units: [{ id: 'A', files: ['a/One.cs', 'a/Two.cs'], depends_on: ['B'] }, { id: 'B', files: ['b/Three.cs'] }],
  hashOf: (p) => hashes[p], ...over,
})
const changed = (before: Map<string, string>, after: Map<string, string>) => [...before.keys()].filter((p) => before.get(p) !== after.get(p)).sort()

describe('A16 per-file cache keys follow the units an adapter declares', () => {
  it('a change reaches its own unit and every unit that depends on it, and nothing else', () => {
    const base = fileKeys(inputs())
    expect(changed(base, fileKeys(inputs({ hashOf: (p) => (p === 'a/Two.cs' ? 'x' : hashes[p]) })))).toEqual(['a/One.cs', 'a/Two.cs'])
    expect(changed(base, fileKeys(inputs({ hashOf: (p) => (p === 'b/Three.cs' ? 'x' : hashes[p]) })))).toEqual(['a/One.cs', 'a/Two.cs', 'b/Three.cs'])
  })

  it('configuration files, external inputs, analysis mode and the adapter build change every key', () => {
    const base = fileKeys(inputs())
    for (const over of [{ configs: [{ path: 'a/A.csproj', hash: 'q' }] }, { externalInputs: ['nuget:X/1'] }, { analysisMode: 'trusted_build' }, { adapter: { id: 'csharp', build: '2' } }])
      expect(changed(base, fileKeys(inputs(over)))).toEqual(Object.keys(hashes).sort())
  })

  it("a unit's id is part of its key, and so of the keys of the units that depend on it", () => {
    const base = fileKeys(inputs())
    expect(changed(base, fileKeys(inputs({ units: [{ id: 'A', files: ['a/One.cs', 'a/Two.cs'], depends_on: ['B2'] }, { id: 'B2', files: ['b/Three.cs'] }] })))).toEqual(Object.keys(hashes).sort())
    expect(changed(base, fileKeys(inputs({ units: [{ id: 'A2', files: ['a/One.cs', 'a/Two.cs'], depends_on: ['B'] }, { id: 'B', files: ['b/Three.cs'] }] })))).toEqual(['a/One.cs', 'a/Two.cs'])
  })

  it('without units, any change changes every key', () => {
    const base = fileKeys(inputs({ units: undefined }))
    expect(changed(base, fileKeys(inputs({ units: undefined, hashOf: (p) => (p === 'b/Three.cs' ? 'x' : hashes[p]) })))).toEqual(Object.keys(hashes).sort())
  })

  it('a dependency that is not declared, or a cycle, is a protocol error', () => {
    expect(() => fileKeys(inputs({ units: [{ id: 'A', files: ['a/One.cs'], depends_on: ['Z'] }] }))).toThrow('unit Z is named as a dependency but not declared')
    expect(() => fileKeys(inputs({ units: [{ id: 'A', files: ['a/One.cs'], depends_on: ['B'] }, { id: 'B', files: ['b/Three.cs'], depends_on: ['A'] }] }))).toThrow('units depend on each other in a cycle')
  })
})

describe('A16 an analyze answer is split by file', () => {
  const symbol = (path: string) => ({ local_id: `${path}#s`, path, kind: 'class', name: 'S', qualified_name: 'S', range: { start_line: 1, start_col: 0, end_line: 1, end_col: 1, start_byte: 0, end_byte: 1 }, signature: null })
  it('refuses a fact for a file it was not asked about, which belongs in the workspace answer', () => {
    const answer = { symbols: [symbol('a/One.cs'), symbol('b/Three.cs')], relationships: [], file_results: [], diagnostics: [] } as unknown as AnalyzeResponse
    expect(() => splitByFile(answer, ['a/One.cs'])).toThrow('analyze returned a symbol for b/Three.cs, which it was not asked to analyse; facts that span files belong in the workspace answer')
    expect(splitByFile(answer, ['a/One.cs', 'b/Three.cs']).get('b/Three.cs')!.symbols).toEqual([symbol('b/Three.cs')])
  })
})
