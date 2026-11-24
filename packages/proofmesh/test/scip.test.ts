import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeScip } from '../src/scip/decode.js'
import { encode, type Doc } from './helpers-scip.js'
import { cli, evidenceSlice, fixtureRepo, tmpDir, tool, withSnapshot } from './helpers.js'

const GO = 'scip-go gomod example.com/shop v1 ', SWIFT = 'scip-swift swiftpm ShopUI 1.0 '
const INDEX: Doc[] = [
  {
    path: 'cart/cart.go', language: 'go', typed: true,
    occurrences: [
      { symbol: `${GO}\`example.com/shop/cart\`/Cart#`, range: [9, 5, 9], enclosing: [9, 0, 11, 1], def: true },
      { symbol: `${GO}\`example.com/shop/cart\`/Cart#Prices.`, range: [10, 1, 7], enclosing: [10, 1, 13], def: true },
      { symbol: `${GO}\`example.com/shop/cart\`/Cart#Checkout().`, range: [13, 14, 22], enclosing: [13, 0, 15, 1], def: true },
      { symbol: 'scip-go gomod github.com/golang/go/src go1.22 fmt/Sprint().', range: [14, 12, 18] },
      { symbol: `${GO}\`example.com/shop/pricing\`/Total().`, range: [14, 27, 32] },
      { symbol: `${GO}\`example.com/shop/cart\`/Cart#Prices.`, range: [14, 35, 41] },
      { symbol: `${GO}\`example.com/shop/cart\`/Legacy().`, range: [17, 5, 11], enclosing: [17, 0, 41], def: true },
      { symbol: `${GO}\`example.com/shop/legacy\`/Old().`, range: [17, 34, 37] },
    ],
    symbols: [{ symbol: `${GO}\`example.com/shop/cart\`/Cart#`, kind: 49 }, { symbol: `${GO}\`example.com/shop/cart\`/Cart#Checkout().`, kind: 26, signature: 'func (c Cart) Checkout() string' }],
  },
  {
    path: 'pricing/pricing.go', language: 'go', typed: false,
    occurrences: [
      { symbol: `${GO}\`example.com/shop/pricing\`/Total().`, range: [3, 5, 10], enclosing: [3, 0, 9, 1], def: true },
      { symbol: 'local 0', range: [5, 19, 25] },
    ],
    symbols: [{ symbol: `${GO}\`example.com/shop/pricing\`/Total().`, kind: 17, signature: 'func Total(prices []int) int' }],
  },
  { path: 'legacy/old.go', language: 'go', typed: true, occurrences: [{ symbol: `${GO}\`example.com/shop/legacy\`/Old().`, range: [2, 5, 8], enclosing: [2, 0, 27], def: true }] },
  {
    path: 'ui/View.swift', language: 'swift', typed: true,
    occurrences: [
      { symbol: `${SWIFT}View#`, range: [0, 7, 11], enclosing: [0, 0, 3, 1], def: true },
      { symbol: `${SWIFT}View#body().`, range: [1, 9, 13], enclosing: [1, 4, 37], def: true },
      { symbol: 'scip-swift swiftpm Swift 5.9 String#', range: [1, 19, 25] },
      { symbol: `${SWIFT}View#label().`, range: [1, 28, 33] },
      { symbol: `${SWIFT}View#label().`, range: [2, 9, 14], enclosing: [2, 4, 35], def: true },
      // A symbol no SCIP grammar reads: its file's references are partial.
      { symbol: `${SWIFT}View#label(`, range: [1, 28, 33] },
    ],
    symbols: [{ symbol: `${SWIFT}View#`, kind: 49 }],
  },
  { path: 'web/greet.ts', language: 'typescript', typed: true, occurrences: [{ symbol: 'scip-typescript npm shop 1.0 web/greet.ts/greet.', range: [0, 13, 18], def: true }] },
  { path: 'gone/missing.go', language: 'go', typed: true, occurrences: [] },
]

/** A copy of the fixture with the index named for it, as a person would after producing it. */
function named() {
  const repo = fs.realpathSync(tmpDir('pm-scip-'))
  fs.cpSync(fixtureRepo('scip-mixed'), repo, { recursive: true })
  const file = path.join(tmpDir('pm-scip-index-'), 'shop.scip')
  fs.writeFileSync(file, encode(repo, 'hand-written', INDEX))
  const d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  const added = cli(['--data-dir', d, 'scip', 'add', repo, file])
  expect(added.status, added.stderr).toBe(0)
  return { repo, file, d, added: added.stdout }
}
const index = (d: string, repo: string) => { const r = cli(['--data-dir', d, 'index', repo]); expect(r.status, r.stderr).toBe(0); return r.stdout }
const files = (d: string) => withSnapshot(d, (db) => db.prepare(`select f.path, f.language, f.disposition, f.disposition_detail as detail, group_concat(distinct ev.extractor) as producer
  from file f left join symbol s on s.file_id = f.id left join evidence ev on ev.id = s.evidence_id where f.path not in ('go.mod') group by f.path order by f.path`).all())

describe('A24 A27 SCIP indexes a person produced: read, never run, and only where no semantic adapter is', () => {
  it('the reader takes the typed ranges and the deprecated packed ones alike', () => {
    const doc = (typed: boolean) => decodeScip(encode('/r', 't', [{ ...INDEX[0]!, typed }])).documents[0]!
    expect(doc(true).occurrences).toEqual(doc(false).occurrences)
    expect(doc(true).occurrences[0]).toEqual({ symbol: `${GO}\`example.com/shop/cart\`/Cart#`, roles: 1, range: { startLine: 9, startChar: 5, endLine: 9, endChar: 9 }, enclosing: { startLine: 9, startChar: 0, endLine: 11, endChar: 1 } })
  })

  it('serves symbols and references for the files it covers, leaves first-party files alone, and sends a stale file back to its usual adapter', () => {
    const { repo, d, added } = named()
    expect(added).toMatch(/^SCIP index shop named for pm-scip-\w+: 5 files covered, 1 of its documents names no file in the repository; produced by hand-written 1\.0; by /)
    fs.appendFileSync(path.join(repo, 'legacy/old.go'), '\nfunc Older() int { return 2 }\n')
    index(d, repo)
    expect(files(d)).toEqual([
      { path: 'cart/cart.go', language: 'go', disposition: 'indexed', detail: null, producer: 'scip' },
      { path: 'legacy/old.go', language: 'go', disposition: 'indexed', detail: 'scip_stale:shop', producer: 'syntax' },
      { path: 'pricing/pricing.go', language: 'go', disposition: 'indexed', detail: null, producer: 'scip' },
      { path: 'ui/View.swift', language: 'swift', disposition: 'indexed', detail: null, producer: 'scip' },
      { path: 'web/greet.ts', language: 'typescript', disposition: 'indexed', detail: null, producer: 'typescript' },
    ])
    expect(withSnapshot(d, (db) => db.prepare(`select s.kind, s.qualified_name, s.start_line, s.end_line, s.signature from symbol s join evidence ev on ev.id = s.evidence_id where ev.extractor = 'scip' order by s.qualified_name collate binary`).all())).toEqual([
      { kind: 'struct', qualified_name: 'View', start_line: 1, end_line: 4, signature: null },
      { kind: 'method', qualified_name: 'View.body', start_line: 2, end_line: 2, signature: null },
      { kind: 'method', qualified_name: 'View.label', start_line: 3, end_line: 3, signature: null },
      { kind: 'module', qualified_name: 'cart/cart', start_line: 1, end_line: 18, signature: null },
      { kind: 'struct', qualified_name: 'example.com/shop/cart.Cart', start_line: 10, end_line: 12, signature: null },
      { kind: 'method', qualified_name: 'example.com/shop/cart.Cart.Checkout', start_line: 14, end_line: 16, signature: 'func (c Cart) Checkout() string' },
      { kind: 'field', qualified_name: 'example.com/shop/cart.Cart.Prices', start_line: 11, end_line: 11, signature: null },
      { kind: 'function', qualified_name: 'example.com/shop/cart.Legacy', start_line: 18, end_line: 18, signature: null },
      { kind: 'function', qualified_name: 'example.com/shop/pricing.Total', start_line: 4, end_line: 10, signature: 'func Total(prices []int) int' },
      { kind: 'module', qualified_name: 'pricing/pricing', start_line: 1, end_line: 10, signature: null },
      { kind: 'module', qualified_name: 'ui/View', start_line: 1, end_line: 4, signature: null },
    ])
    const refs = withSnapshot(d, (db) => (db.prepare(`select a.resolution, a.reason, a.detail, s.qualified_name as src, t.qualified_name as dst, x.module, x.name, ev.start_line as line, ae.evidence_id as ev
      from assertion a join symbol s on s.id = a.source_id left join symbol t on t.id = a.target_id left join external_symbol x on x.id = a.target_id
      join assertion_evidence ae on ae.assertion_id = a.id join evidence ev on ev.id = ae.evidence_id where a.adapter = 'scip' and a.type = 'references' order by ev.file_id, ev.start_byte`).all() as Array<Record<string, string | number | null>>)
      .map((r) => [r.line, evidenceSlice(d, db, String(r.ev)), r.src, r.resolution, r.dst ?? (r.module ? `${r.module}:${r.name}` : null), r.reason, r.detail ? JSON.parse(String(r.detail)) : null]))
    expect(refs.sort((a, b) => String(a[2]).localeCompare(String(b[2])) || Number(a[0]) - Number(b[0]) || String(a[1]).localeCompare(String(b[1])))).toEqual([
      [15, 'Prices', 'example.com/shop/cart.Cart.Checkout', 'resolved', 'example.com/shop/cart.Cart.Prices', null, null],
      [15, 'Sprint', 'example.com/shop/cart.Cart.Checkout', 'resolved_external', 'github.com/golang/go/src:fmt.Sprint', null, null],
      [15, 'Total', 'example.com/shop/cart.Cart.Checkout', 'resolved', 'example.com/shop/pricing.Total', null, null],
      [18, 'Old', 'example.com/shop/cart.Legacy', 'unresolved', null, 'outside_capability', { symbol: 'example.com/shop/legacy.Old' }],
      [2, 'label', 'View.body', 'resolved', 'View.label', null, null],
      [2, 'String', 'View.body', 'resolved_external', 'Swift:String', null, null],
    ])
    expect(withSnapshot(d, (db) => db.prepare(`select path, json_extract(capabilities, '$.references') as refs from file where path in ('cart/cart.go', 'pricing/pricing.go', 'ui/View.swift') order by path`).all())).toEqual([
      { path: 'cart/cart.go', refs: 'complete' }, { path: 'pricing/pricing.go', refs: 'complete' }, { path: 'ui/View.swift', refs: 'partial' },
    ])
    // The index's hash is part of snapshot identity, and strict freshness classifies files the way the index did.
    const adapters = withSnapshot(d, (db) => JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value)) as Array<{ id: string; external_inputs: string[] }>
    expect(adapters.find((a) => a.id === 'scip')!.external_inputs).toEqual([expect.stringMatching(/^scip:shop\/[0-9a-f]{64}$/)])
    expect((tool(d, 'find_symbols', { text: 'Checkout', freshness: 'strict' }) as { freshness: { status: string } }).freshness.status).toBe('current')
  }, 240000)

  it('an index file that changed after it was named covers nothing until a person names it again', () => {
    const { repo, file, d } = named()
    fs.writeFileSync(file, encode(repo, 'hand-written-again', INDEX))
    index(d, repo)
    expect(files(d)).toEqual([
      { path: 'cart/cart.go', language: 'go', disposition: 'indexed', detail: 'scip_stale:shop', producer: 'syntax' },
      { path: 'legacy/old.go', language: 'go', disposition: 'indexed', detail: 'scip_stale:shop', producer: 'syntax' },
      { path: 'pricing/pricing.go', language: 'go', disposition: 'indexed', detail: 'scip_stale:shop', producer: 'syntax' },
      { path: 'ui/View.swift', language: 'swift', disposition: 'indexed', detail: 'scip_stale:shop', producer: 'syntax' },
      { path: 'web/greet.ts', language: 'typescript', disposition: 'indexed', detail: null, producer: 'typescript' },
    ])
    expect(cli(['--data-dir', d, 'scip', 'list', repo]).stdout).toMatch(/^shop {2}\S+shop\.scip {2}5 files {2}hand-written 1\.0 {2}changed since it was added {2}by /)
    expect(cli(['--data-dir', d, 'scip', 'add', repo, file]).status).toBe(0)
    index(d, repo)
    expect(files(d).map((f) => (f as { producer: string }).producer)).toEqual(['scip', 'scip', 'scip', 'scip', 'typescript'])
  }, 240000)
})
