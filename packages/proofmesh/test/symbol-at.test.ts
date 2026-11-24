import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { innermost } from '../src/query/symbol-at.js'
import { ProofmeshError } from '../src/core/errors.js'
import { cli, fixtureRepo, tmpDir, tool } from './helpers.js'
import { encode, type Doc } from './helpers-scip.js'
// @ts-expect-error the benchmark helper is a plain module outside the package
import { percentile, sampleLocations } from '../../../bench/graph-bench/symbol-at-latency.mjs'

type Result = { location: string; symbol: Record<string, unknown> | null; disposition?: string; reason?: string; error?: { code: string } }
const GO = 'scip-go gomod example.com/shop v1 '
// The hand-written index of scip/cart.go: Checkout's definition names only the word, as an indexer that writes no enclosing range does.
const INDEX: Doc[] = [{
  path: 'scip/cart.go', language: 'go', typed: true,
  occurrences: [{ symbol: `${GO}\`example.com/shop/cart\`/Cart#Checkout().`, range: [13, 14, 22], def: true }],
  symbols: [{ symbol: `${GO}\`example.com/shop/cart\`/Cart#Checkout().`, kind: 26, signature: 'func (c Cart) Checkout() string' }],
}]

let d: string, repo: string
beforeAll(() => {
  repo = fs.realpathSync(tmpDir('pm-symat-'))
  fs.cpSync(fixtureRepo('symbol-at'), repo, { recursive: true })
  const file = path.join(tmpDir('pm-symat-index-'), 'cart.scip')
  fs.writeFileSync(file, encode(repo, 'hand-written', INDEX))
  d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo], ['scip', 'add', repo, file], ['index', repo]]) { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0) }
})
const at = (locations: string[], extra: Record<string, unknown> = {}) => tool(d, 'get_symbols_at', { locations, envelope: 'full', ...extra })
const results = (locations: string[]) => (at(locations).data as { results: Result[] }).results
/** The label a lean row gives a symbol: its qualified name without the file's module prefix. */
const label = (s: Record<string, unknown>) => (s.kind === 'module' ? String(s.qualified_name) : String(s.qualified_name).replace(/^[^:\s]*:/, ''))

describe('FR119 FR120 FR121 FR122 FR123 get_symbols_at: the innermost symbol at path:line, in every tier (fixtures/symbol-at)', () => {
  const ASKED = ['ts/shapes.ts:6', 'ts/shapes.ts:4', 'ts/shapes.ts:1', 'py/calc.py:3', 'py/calc.py:8', 'go/calc.go:4', 'go/calc.go:2', 'cs/Calc.cs:6', 'scip/cart.go:15', 'tf/main.tf:2', 'README.md:1', 'ts/shapes.ts:99', 'nope.ts:1']

  it('FR119 scenario 1: one result per location, in the order asked, with the symbol and kind of the spec table', () => {
    const rs = results(ASKED)
    expect(rs.map((r) => [r.location, r.symbol ? label(r.symbol) : null, r.symbol?.kind ?? null])).toEqual([
      ['ts/shapes.ts:6', 'Circle.area', 'method'],
      ['ts/shapes.ts:4', 'Circle', 'class'],
      ['ts/shapes.ts:1', 'LIMIT', 'variable'],
      ['py/calc.py:3', 'Calc.add', 'method'],
      ['py/calc.py:8', 'py/calc', 'module'],
      ['go/calc.go:4', 'Add', 'function'],
      ['go/calc.go:2', 'go/calc', 'module'],
      ['cs/Calc.cs:6', 'Calc.Add', 'method'],
      // The SCIP importer's own qualified name; issue 15 gives every tier one name.
      ['scip/cart.go:15', 'example.com/shop/cart.Cart.Checkout', 'method'],
      ['tf/main.tf:2', 'aws_s3_bucket.logs', 'resource'],
      ['README.md:1', null, null],
      ['ts/shapes.ts:99', null, null],
      ['nope.ts:1', null, null],
    ])
    expect(rs[10]).toMatchObject({ symbol: null, disposition: 'unsupported', reason: 'not_indexed' })
    expect(rs[11]).toMatchObject({ symbol: null, error: { code: 'line_out_of_range' } })
    expect(rs[12]).toMatchObject({ symbol: null, error: { code: 'not_found' } })
    // A location that cannot be answered does not fail the call.
    expect(rs.slice(0, 11).every((r) => !r.error)).toBe(true)
  })

  it('FR120 scenario 2: each found symbol carries its id, stable_key, name, kind, path, lines and tier', () => {
    const [area, , , , , add, , , checkout, tf] = results(ASKED)
    expect(area!.symbol).toEqual({ id: expect.stringMatching(/^sym_[0-9a-z]+$/), stable_key: 'ts/shapes.ts#ts/shapes:Circle.area#method', name: 'area', qualified_name: 'ts/shapes:Circle.area', kind: 'method', path: 'ts/shapes.ts', start_line: 5, end_line: 8, tier: 'precise' })
    expect(add!.symbol).toMatchObject({ name: 'Add', path: 'go/calc.go', start_line: 3, end_line: 5, tier: 'syntax' })
    expect(checkout!.symbol).toMatchObject({ name: 'Checkout', path: 'scip/cart.go', tier: 'scip' })
    expect(tf!.symbol).toMatchObject({ path: 'tf/main.tf', start_line: 1, end_line: 4, tier: 'precise' })
  })

  it('FR123 scenario 3: the lean envelope is one row per location: the location, then name path:line kind, or - and the reason', () => {
    const text = (tool(d, 'get_symbols_at', { locations: ASKED, envelope: 'lean' }) as unknown as { text: string }).text
    expect(text.split('\n').filter((l) => !l.startsWith('# '))).toEqual([
      'ts/shapes.ts:6 Circle.area ts/shapes.ts:5 method',
      'ts/shapes.ts:4 Circle ts/shapes.ts:3 class',
      'ts/shapes.ts:1 LIMIT ts/shapes.ts:1 variable',
      'py/calc.py:3 Calc.add py/calc.py:2 method',
      'py/calc.py:8 py/calc.py:1 module',
      'go/calc.go:4 Add go/calc.go:3 function',
      'go/calc.go:2 go/calc.go:1 module',
      'cs/Calc.cs:6 Calc.Add cs/Calc.cs:5 method',
      'scip/cart.go:15 example.com/shop/cart.Cart.Checkout scip/cart.go:14 method',
      'tf/main.tf:2 aws_s3_bucket.logs tf/main.tf:1 resource',
      'README.md:1 - not_indexed',
      'ts/shapes.ts:99 - line_out_of_range',
      'nope.ts:1 - not_found',
    ])
  })

  it('FR121 scenario 4: a SCIP definition with no enclosing range takes its span from the syntax tier\'s parse of the declaration', () => {
    const [r] = results(['scip/cart.go:15'])
    expect(r!.symbol).toMatchObject({ start_line: 14, end_line: 16, tier: 'scip' })
    // The line inside the body, not on the name, is found at all.
    expect(results(['scip/cart.go:15', 'scip/cart.go:14', 'scip/cart.go:16']).map((x) => x.symbol?.kind)).toEqual(['method', 'method', 'method'])
  })

  it('FR119 scenario 5: equal spans give one symbol by a fixed order: function or method, then property or variable, then type', () => {
    const row = (id: string, kind: string) => ({ id, kind, start_line: 3, end_line: 9 })
    const all = [row('c', 'class'), row('b', 'variable'), row('a', 'function')]
    for (const order of [all, [...all].reverse(), [all[1]!, all[2]!, all[0]!]]) expect(innermost(order, 5)?.id).toBe('a')
    expect(innermost([row('c', 'class'), row('b', 'property')], 5)?.id).toBe('b')
    expect(innermost([row('d', 'struct'), row('c', 'class')], 5)?.id).toBe('c')
    // A narrower span still wins over any kind.
    expect(innermost([...all, { id: 'z', kind: 'class', start_line: 4, end_line: 6 }], 5)?.id).toBe('z')
    expect(innermost(all, 10)).toBeUndefined()
  })

  it('FR122 scenario 6: the benchmark samples locations reproducibly and reports a p95', () => {
    const symbols = Array.from({ length: 50 }, (_, i) => ({ file: `f${i}.ts`, line: i + 1, kind: 'function' }))
    expect(sampleLocations(symbols, 20, 7)).toEqual(sampleLocations(symbols, 20, 7))
    expect(sampleLocations(symbols, 20, 7)).not.toEqual(sampleLocations(symbols, 20, 8))
    expect(percentile([5, 1, 4, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.95)).toBe(19)
    expect(fs.readFileSync(path.join(import.meta.dirname, '../../../bench/graph-bench/run.mjs'), 'utf8')).toMatch(/symbol_at_latency/)
  })

  it('FR119 edge: a location with a column uses the line and says so', () => {
    const env = at(['ts/shapes.ts:6:12', 'ts/shapes.ts:6'])
    const rs = (env.data as { results: Result[] }).results
    expect(rs[0]!.symbol).toEqual(rs[1]!.symbol)
    expect(env.limitations.join(' ')).toMatch(/column.*line only/i)
    expect(at(['ts/shapes.ts:6']).limitations.join(' ')).not.toMatch(/column/i)
  })

  it('FR119 edge: more than 100 locations is INVALID_ARGUMENT naming the limit; 100 are answered', () => {
    const many = Array.from({ length: 101 }, () => 'ts/shapes.ts:6')
    let err: unknown
    try { at(many) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ProofmeshError)
    expect((err as ProofmeshError).code).toBe('INVALID_ARGUMENT')
    expect((err as ProofmeshError).message).toMatch(/100/)
    expect(results(many.slice(1))).toHaveLength(100)
  })

  it('FR119 edge: a file with no symbol (an empty file) is a null symbol with reason no_symbol', () => {
    const empty = fs.realpathSync(tmpDir('pm-symat-empty-'))
    fs.writeFileSync(path.join(empty, 'empty.ts'), '')
    fs.writeFileSync(path.join(empty, 'a.ts'), 'export const a = 1\n')
    const dd = tmpDir()
    for (const args of [['init'], ['repo', 'add', empty], ['index', empty]]) expect(cli(['--data-dir', dd, ...args]).status).toBe(0)
    const rs = (tool(dd, 'get_symbols_at', { locations: ['empty.ts:1'], envelope: 'full' }).data as { results: Result[] }).results
    expect(rs[0]).toMatchObject({ symbol: null, reason: 'no_symbol' })
  })

  it('FR119 edge: strict freshness follows the existing rules, so a changed file is never answered from the snapshot', () => {
    const edited = fs.realpathSync(tmpDir('pm-symat-fresh-'))
    fs.cpSync(path.join(repo, 'ts'), path.join(edited, 'ts'), { recursive: true })
    const dd = tmpDir()
    for (const args of [['init'], ['repo', 'add', edited], ['index', edited]]) expect(cli(['--data-dir', dd, ...args]).status).toBe(0)
    expect((tool(dd, 'get_symbols_at', { locations: ['ts/shapes.ts:6'], freshness: 'strict', envelope: 'full' }).freshness as { status: string }).status).toBe('current')
    fs.appendFileSync(path.join(edited, 'ts/shapes.ts'), 'export const more = 1\n')
    let err: unknown
    try { tool(dd, 'get_symbols_at', { locations: ['ts/shapes.ts:6'], freshness: 'strict' }) } catch (e) { err = e }
    expect((err as ProofmeshError).code).toBe('STALE_INPUT')
  })
})
