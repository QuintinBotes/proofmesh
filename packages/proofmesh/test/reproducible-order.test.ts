import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProofmeshError } from '../src/core/errors.js'
import { runTool } from '../src/query/tools.js'
import { indexedDataDir, ROOT, tmpDir } from './helpers.js'

// Issue 70: the same repository in two directories answers every call with the rows in the same order.
const ROSETTA = path.join(ROOT, 'fixtures', 'rosetta')
type Subjects = Record<string, { name: string; path: string }>
type Expected = { census_language: string; tiers: Record<string, { subjects: Subjects }> }

const ALL_TYPES = ['calls', 'references', 'imports', 'implements', 'inherits', 'overrides', 'contains', 'owned_by']
const ID = /\b[a-z]{2,5}_[0-9a-z]{16,}\b/g

/** A copy of the fixture repository at a path of its own, so ids built from the location differ between copies. */
const checkout = (lang: string, ...dirs: string[]): string => {
  const home = path.join(tmpDir('pm-repro-'), ...dirs)
  fs.mkdirSync(home, { recursive: true })
  fs.cpSync(path.join(ROSETTA, lang, 'repo'), home, { recursive: true })
  return home
}

/** Every call a language's subjects allow, whatever the tool, as the tool's name and its input. */
function calls(subjects: Subjects): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [['find_symbols', { text: 'a' }], ['find_symbols', { text: 'e', include_ids: false }], ['find_symbols', { text: 'area' }], ['get_overview', {}]]
  const named = Object.values(subjects)
  for (const s of named) {
    out.push(['get_relationships', { subject_id: s, direction: 'both', types: ALL_TYPES }], ['get_relationships', { subject_id: s, direction: 'in', types: ['calls', 'imports', 'implements'] }],
      ['get_relationships', { path: s.path, direction: 'both', types: ALL_TYPES }], ['get_relationships', { path: s.path, direction: 'in', types: ['imports'], include_tests: false }],
      ['analyze_impact', { subject_ids: [s], types: ALL_TYPES, limits: { max_depth: 4 } }], ['analyze_impact', { paths: [s.path], limits: { max_depth: 3 } }],
      ['find_tests', { subject_ids: [s] }], ['find_tests', { paths: [s.path] }])
    for (const t of named) out.push(['trace_paths', { source_id: s, target_id: t }])
  }
  return out
}

/** One answer, in lean and in JSON with ids masked (ids are what differs), or the code of a refusal. */
function answer(dataDir: string, tool: string, input: Record<string, unknown>): string {
  try {
    const lean = runTool(dataDir, tool, { ...input, envelope: 'lean' }).text!
    const full = JSON.stringify(runTool(dataDir, tool, { ...input, envelope: 'full' }).data)
    return `${lean}\n${full}`.replace(ID, '<id>')
  } catch (e) {
    if (e instanceof ProofmeshError) return `error ${e.code}`
    throw e
  }
}

const sub = (input: unknown, subjects: Subjects): unknown => {
  if (Array.isArray(input)) return input.map((i) => sub(i, subjects))
  if (input && typeof input === 'object' && 'name' in input && 'path' in input) return input
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, sub(v, subjects)]))
  return input
}

describe('FR234 a repository in two checkouts answers every call with the same rows in the same order', () => {
  it.each(['python', 'typescript', 'go', 'java'])('FR234 %s: every tool returns byte-identical rows from two paths of different name and depth', async (lang) => {
    const expected = JSON.parse(fs.readFileSync(path.join(ROSETTA, lang, 'expected.json'), 'utf8')) as Expected
    const subjects = Object.values(expected.tiers)[0]!.subjects
    const a = await indexedDataDir(checkout(lang, 'zz'))
    const b = await indexedDataDir(checkout(lang, 'a', 'b', 'c', 'deeper-name'))
    const list = calls(subjects)
    const asked = list.map(([tool, input]) => `${tool} ${JSON.stringify(input)}`)
    const one = list.map(([tool, input]) => answer(a.dataDir, tool, sub(input, subjects) as Record<string, unknown>))
    const two = list.map(([tool, input]) => answer(b.dataDir, tool, sub(input, subjects) as Record<string, unknown>))
    expect(one.filter((x) => !x.startsWith('error')).length, `${lang} gives answers to compare`).toBeGreaterThan(10)
    expect(two.map((x, i) => [asked[i], x])).toEqual(one.map((x, i) => [asked[i], x]))
  }, 300000)
})
