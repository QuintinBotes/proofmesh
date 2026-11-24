import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ProofmeshError } from '../src/core/errors.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { leanRow } from '../src/query/lean.js'
import { runTool } from '../src/query/tools.js'
import { fixtureRepo, indexedDataDir, symbolId, tmpDir } from './helpers.js'

const HEADER = /^# .+ · \d+ rows? · snap_[0-9a-z]+ (current|stale)$/
const lean = (d: string, name: string, input: Record<string, unknown>): string => {
  const text = runTool(d, name, { ...input, envelope: 'lean' }).text
  expect(typeof text, `${name} answers lean text`).toBe('string')
  return text!
}
/** The rows of a lean answer, after checking that its header matches the format and counts them. */
const rowsOf = (text: string): string[] => {
  const [header, ...rest] = text.split('\n')
  expect(header).toMatch(HEADER)
  const rows = rest.filter((l) => !l.startsWith('# '))
  expect(header).toContain(` · ${rows.length} row${rows.length === 1 ? '' : 's'} · `)
  // Rows come first, then the # lines: nothing follows a limitation but another # line.
  expect(rest.slice(rows.length).every((l) => l.startsWith('# '))).toBe(true)
  return rows
}

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir(fixtureRepo('tests-reach'))) }, 180000)

describe('FR095 FR096 FR097 FR098 lean answers on fixtures/tests-reach: a header, then exactly one name file:line row per result', () => {
  const core = () => symbolId(d, 'src/core:core')

  it('FR097 get_relationships: the caller and its call site', () => {
    expect(lean(d, 'get_relationships', { subject_id: core(), direction: 'in', types: ['calls'], include_tests: true }).split('\n').slice(1)).toEqual(['service src/service.ts:4'])
  })

  it('FR095 a lean answer that asks for references says what the snapshot records of them', () => {
    for (const [name, input] of [['get_relationships', { subject_id: core(), direction: 'in', types: ['references'] }], ['analyze_impact', { subject_ids: [core()], types: ['references'] }]] as const) {
      expect(lean(d, name, input), name).toContain('\n# References other than calls and imports are recorded only where an adapter supports them')
    }
  })

  it('FR097 analyze_impact: each dependent at the site that reached it, with its depth', () => {
    expect(lean(d, 'analyze_impact', { subject_ids: [core()], types: ['calls'] }).split('\n').slice(1)).toEqual(['service src/service.ts:4 depth=1', 'serviceAddsOne test/service.test.ts:4 depth=2'])
  })

  it('FR098 trace_paths: each hop at its call site, in order, then the target at its declaration', () => {
    const text = lean(d, 'trace_paths', { source_id: symbolId(d, 'test/service.test:serviceAddsOne'), target_id: core() })
    expect(text.split('\n').slice(1)).toEqual(['serviceAddsOne test/service.test.ts:4', 'service src/service.ts:4', 'core src/core.ts:1'])
  })

  it('FR096 find_symbols: the symbol at its declaration, with its kind', () => {
    expect(lean(d, 'find_symbols', { text: 'core', kinds: ['function'] }).split('\n').slice(1)).toEqual(['core src/core.ts:1 function'])
    // A module is its file: a file row, with its kind.
    expect(lean(d, 'find_symbols', { text: 'core', kinds: ['module'] }).split('\n').slice(1)).toEqual(['src/core.ts:1 module'])
  })

  it('FR095 each of the four answers is a header naming the snapshot as current, with its row count, and no JSON', () => {
    const answers = [
      lean(d, 'get_relationships', { subject_id: core(), direction: 'in', types: ['calls'], include_tests: true }),
      lean(d, 'analyze_impact', { subject_ids: [core()], types: ['calls'] }),
      lean(d, 'trace_paths', { source_id: symbolId(d, 'test/service.test:serviceAddsOne'), target_id: core() }),
      lean(d, 'find_symbols', { text: 'core', kinds: ['function'] }),
    ]
    expect(answers.map((t) => rowsOf(t).length)).toEqual([1, 2, 3, 1])
    for (const t of answers) {
      expect(t.split('\n')[0]).toMatch(/ current$/)
      expect(t).not.toMatch(/[{}[\]]/)
    }
  })

  it('FR096 a query in both directions, the get_relationships default, tags each row in or out', () => {
    expect(lean(d, 'get_relationships', { subject_id: symbolId(d, 'src/service:service') }).split('\n').slice(1)).toEqual(['core src/service.ts:4 out', 'serviceAddsOne test/service.test.ts:4 in'])
  })

  it('FR095 get_symbol, find_tests and an ID given as name and path answer lean too', () => {
    expect(lean(d, 'get_symbol', { symbol_id: core() }).split('\n').slice(1)).toEqual([expect.stringMatching(/^core src\/core\.ts:1 function stable_key="src\/core\.ts#src\/core:core#function" body_hash=[0-9a-f]{64}$/)])
    expect(lean(d, 'find_tests', { subject_ids: [{ name: 'core', path: 'src/core.ts' }] }).split('\n').slice(1)).toEqual(['serviceAddsOne test/service.test.ts:4 depth=2'])
  })

  it('FR095 an empty answer is the header with 0 rows and the limitation that explains it', () => {
    expect(lean(d, 'find_symbols', { text: 'core', path_prefix: 'nowhere/' }).split('\n')).toEqual([
      expect.stringMatching(/^# find_symbols · 0 rows · snap_[0-9a-z]+ current$/),
      '# No indexed file is under path_prefix nowhere/; the search covered nothing.',
    ])
  })
})

describe('FR096 FR100 lean rows of a repository with awkward names, several sites per caller, and an older snapshot', () => {
  let w: string, repo: string, first: string
  beforeAll(async () => {
    repo = tmpDir('pm-lean-')
    fs.cpSync(fixtureRepo('tests-reach'), repo, { recursive: true })
    fs.mkdirSync(path.join(repo, 'src', 'odd dir'))
    fs.writeFileSync(path.join(repo, 'src', 'odd dir', 'odd.ts'), [
      "import { core } from '../core'",
      '',
      'export class Ledger {',
      '  "a b"(): number { return core() + core() }',
      '  #hidden(): number { return 0 }',
      '  total(): number { return this.#hidden() + Math.max(1, 2) }',
      '}',
      '',
      'export class Other {',
      '  total(): number { return core() }',
      '}',
      '',
    ].join('\n'))
    const r = await indexedDataDir(repo)
    w = r.dataDir; first = r.snapshotId
    fs.appendFileSync(path.join(repo, 'src', 'core.ts'), 'export const later = 2\n')
    await indexRepository(w, r.repoId)
  }, 240000)

  it('FR096 one row per call site, so a caller that calls twice has two rows; a name or path with a space or # is quoted', () => {
    expect(lean(w, 'get_relationships', { subject_id: { name: 'core', path: 'src/core.ts' }, direction: 'in' }).split('\n').slice(1).sort()).toEqual([
      '"Ledger.\\"a b\\"" "src/odd dir/odd.ts":4',
      '"Ledger.\\"a b\\"" "src/odd dir/odd.ts":4',
      'Other.total "src/odd dir/odd.ts":10',
      'service src/service.ts:4',
    ].sort())
    expect(lean(w, 'find_symbols', { text: 'hidden' }).split('\n').slice(1)).toEqual(['"Ledger.#hidden" "src/odd dir/odd.ts":5 method'])
  })

  it('FR096 an outbound call to code outside the repository is tagged external at its call site', () => {
    const rows = rowsOf(lean(w, 'get_relationships', { subject_id: { name: 'Ledger.total', path: 'src/odd dir/odd.ts' }, direction: 'out', include_external: true }))
    expect(rows).toContain('"Ledger.#hidden" "src/odd dir/odd.ts":6')
    expect(rows.find((r) => r.endsWith(' external'))).toMatch(/^\S*max "src\/odd dir\/odd\.ts":6 external$/)
  })

  it('FR096 a row whose site is unknown is the name and external; a file row is its path and line alone', () => {
    expect(leanRow('readFileSync', null, null, ['external'])).toBe('readFileSync external')
    expect(leanRow('src/a.ts', 'src/a.ts', 1)).toBe('src/a.ts:1')
    expect(leanRow('a b', 'my dir/x.ts', 3, ['depth=2'])).toBe('"a b" "my dir/x.ts":3 depth=2')
  })

  it('FR100 find_symbols rows end with the id only when include_ids is true', () => {
    const plain = rowsOf(lean(w, 'find_symbols', { text: 'core', kinds: ['function'] }))
    const withIds = rowsOf(lean(w, 'find_symbols', { text: 'core', kinds: ['function'], include_ids: true }))
    expect(plain).toEqual(['core src/core.ts:1 function'])
    expect(withIds).toEqual([`core src/core.ts:1 function id=${symbolId(w, 'src/core:core')}`])
  })

  it('FR100 a name unique in its file stands in for an id; an ambiguous one is refused with the candidates as lean rows', () => {
    expect(lean(w, 'get_symbol', { symbol_id: { name: 'Other.total', path: 'src/odd dir/odd.ts' } }).split('\n').slice(1)).toEqual([expect.stringMatching(/^Other\.total "src\/odd dir\/odd\.ts":10 method stable_key="src\/odd dir\/odd\.ts#src\/odd dir\/odd:Other\.total#method" body_hash=[0-9a-f]{64}$/)])
    let refused: unknown
    try { runTool(w, 'get_symbol', { symbol_id: { name: 'total', path: 'src/odd dir/odd.ts' }, envelope: 'lean' }) } catch (e) { refused = e }
    expect(refused).toBeInstanceOf(ProofmeshError)
    expect((refused as ProofmeshError).code).toBe('INVALID_ARGUMENT')
    expect((refused as ProofmeshError).message.split('\n').slice(1)).toEqual([
      expect.stringMatching(/^Ledger\.total "src\/odd dir\/odd\.ts":6 method id=sym_[0-9a-z]+$/),
      expect.stringMatching(/^Other\.total "src\/odd dir\/odd\.ts":10 method id=sym_[0-9a-z]+$/),
    ])
    expect(() => runTool(w, 'get_symbol', { symbol_id: { name: 'missing', path: 'src/core.ts' } })).toThrow(/no symbol named missing in src\/core\.ts/)
  })

  it('FR095 an answer from an older snapshot still answers, and its header says stale', () => {
    const text = lean(w, 'find_symbols', { text: 'core', kinds: ['function'], snapshot_id: first })
    expect(text.split('\n')[0]).toBe(`# find_symbols · 1 row · ${first} stale`)
    expect(rowsOf(text)).toEqual(['core src/core.ts:1 function'])
    expect(text).toContain(`\n# Snapshot ${first} is older than the repository's current snapshot snap_`)
  })

  it('FR095 a lean answer cut by max_rows ends with a cursor that continues it with no row repeated or skipped', () => {
    for (const [name, input] of [['find_symbols', { text: 'e' }], ['get_relationships', { subject_id: { name: 'core', path: 'src/core.ts' }, direction: 'in' }]] as const) {
      const whole = rowsOf(lean(w, name, input))
      expect(whole.length, name).toBeGreaterThan(2)
      const seen: string[] = []
      let cursor: string | undefined, calls = 0
      do {
        const text = lean(w, name, { ...input, limits: { max_rows: 1 }, ...(cursor ? { cursor } : {}) })
        seen.push(...rowsOf(text))
        const last = text.split('\n').at(-1)!
        cursor = /^# more: cursor (\S+)$/.exec(last)?.[1]
        calls++
      } while (cursor && calls < 50)
      expect(seen, name).toEqual(whole)
      expect(calls, name).toBe(whole.length)
    }
  })
})

describe('FR091 FR097 a file reached through the top-level code of its module answers at that site', () => {
  it('analyze_impact over calls and imports reports main.ts at its call to f and user.ts at its import of main.ts, lean and full', async () => {
    const repo = tmpDir('pm-lean-files-')
    const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text) }
    write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext' }, include: ['src'] }))
    write('src/lib.ts', 'export function f(): number {\n  return 1\n}\n')
    write('src/main.ts', "import { f } from './lib.js'\nf()\nexport const m = 1\n")
    write('src/user.ts', "import { m } from './main.js'\nexport const u = m\n")
    const { dataDir } = await indexedDataDir(repo)
    const input = { subject_ids: [symbolId(dataDir, 'src/lib:f')], types: ['calls', 'imports'] }
    expect(rowsOf(lean(dataDir, 'analyze_impact', input))).toEqual(['src/main.ts:2 depth=1 calls', 'src/user.ts:1 depth=2 imports'])
    const full = runTool(dataDir, 'analyze_impact', { ...input, envelope: 'full' }).data as { dependents: Array<{ path: string; site?: { path: string; start_line: number } }> }
    expect(full.dependents.map((x) => [x.path, x.site?.start_line])).toEqual([['src/main.ts', 2], ['src/user.ts', 1]])
  }, 120000)
})
