import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITY } from '../src/query/tools.js'
import { indexedDataDir, indexedRepo, symbolId, tool } from './helpers.js'

type Row = { direction: string; resolution: string; reason: string | null; basis?: string; other: { kind: string; name?: string; qualified_name?: string }; site: { path: string; start_line: number }; evidence_ids: string[]; evidence: { id: string; path: string; start_line: number; integrity: { status: string }; context: { start_line: number; text: string; highlight: [number, number] } | null } | null }
type Side = { rows: Row[]; total: number; next_offset: number | null }
const card = (d: string, input: Record<string, unknown>) => tool(d, 'get_symbol_card', input).data as { symbol: { id: string; qualified_name: string }; declaration: { text: string | null; integrity: { status: string }; path: string; start_line: number }; incoming: Side | null; outgoing: Side | null }
const cited = (r: Row) => r.evidence!.context!.text.slice(...r.evidence!.context!.highlight)

describe('FR1180 one request answers a symbol card: the symbol, its verified declaration, and each side with its call sites', () => {
  it('invoiceTotal: the declaration text, its caller and callees, each row with its basis and the cited span inside its lines', async () => {
    const { dataDir } = await indexedDataDir()
    const id = symbolId(dataDir, 'packages/billing/src/invoice:invoiceTotal')
    const c = card(dataDir, { symbol_id: id })
    expect(c.symbol.qualified_name).toBe('packages/billing/src/invoice:invoiceTotal')
    expect(c.declaration).toMatchObject({ path: 'packages/billing/src/invoice.ts', start_line: 7, integrity: { status: 'verified' } })
    expect(c.declaration.text).toContain('export function invoiceTotal')
    expect(c.incoming!.total).toBe(1)
    expect(c.incoming!.rows.map((r) => [r.other.qualified_name, `${r.site.path}:${r.site.start_line}`, r.basis])).toEqual([['packages/api/src/handler:handleInvoice', 'packages/api/src/handler.ts:5', 'observed']])
    const out = c.outgoing!.rows.find((r) => r.other.qualified_name === 'packages/format/src/currency:formatAmount')!
    expect(out).toMatchObject({ resolution: 'resolved', basis: 'observed', site: { path: 'packages/billing/src/invoice.ts', start_line: 9 }, evidence: { path: 'packages/billing/src/invoice.ts', start_line: 9, integrity: { status: 'verified' }, context: { start_line: 9 } } })
    // The cited span is exactly what read_evidence returns for the row's evidence, inside the whole line of the site.
    const read = (tool(dataDir, 'read_evidence', { evidence_ids: out.evidence_ids }).data.evidence as Array<{ text: string }>)[0]!.text
    expect(cited(out)).toBe(read)
    expect(out.evidence!.context!.text).toBe('  return formatAmount(cents, currency);')
    // The same rows, in the same order, as get_relationships answers for the same question.
    const rels = tool(dataDir, 'get_relationships', { subject_id: id, direction: 'both', include_external: true }).data as { relationships: Row[]; totals: { in: number; out: number } }
    expect([...c.outgoing!.rows, ...c.incoming!.rows].map((r) => r.evidence_ids)).toEqual(rels.relationships.map((r) => r.evidence_ids))
    expect([c.incoming!.total, c.outgoing!.total]).toEqual([rels.totals.in, rels.totals.out])
    expect(CAPABILITY.get_symbol_card).toBe('read')
  })

  it('an unresolved call is a row with its reason and the call text as its cited span', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
      'src/naming.ts': 'export function columnName(name: string): string {\n  return name.trim() + titleCase(name)\n}\n',
    })
    const c = card(dataDir, { symbol_id: symbolId(dataDir, 'src/naming:columnName') })
    const row = c.outgoing!.rows.find((r) => r.resolution === 'unresolved')!
    expect(row).toMatchObject({ reason: 'unknown_name', other: { kind: 'none' }, site: { path: 'src/naming.ts', start_line: 2 } })
    expect(row.basis).toBeUndefined()
    expect(cited(row)).toBe('titleCase(name)')
  })
})

describe('FR1181 a card is bounded: max_rows per side with a total and a next offset, max_bytes on the whole answer', () => {
  it('a hub with 30 callers lists 24, counts 30, and the rest page in by direction and offset with no row twice', async () => {
    const files: Record<string, string> = { 'tsconfig.json': '{}\n', 'src/hub.ts': 'export function hub(): number {\n  return 1\n}\n' }
    for (let i = 0; i < 30; i++) files[`src/c${String(i).padStart(2, '0')}.ts`] = `import { hub } from './hub'\nexport function caller${i}(): number {\n  return hub()\n}\n`
    const { dataDir } = await indexedRepo(files)
    const id = symbolId(dataDir, 'src/hub:hub')
    const first = card(dataDir, { symbol_id: id, limits: { max_rows: 24 } })
    expect([first.incoming!.rows.length, first.incoming!.total, first.incoming!.next_offset]).toEqual([24, 30, 24])
    const env = tool(dataDir, 'get_symbol_card', { symbol_id: id, limits: { max_rows: 24 } })
    expect(env.completion.stop_reasons).toEqual(['max_rows'])
    const rest = card(dataDir, { symbol_id: id, direction: 'in', offset: 24, limits: { max_rows: 24 } })
    expect(rest.outgoing).toBeNull()
    expect([rest.incoming!.rows.length, rest.incoming!.next_offset]).toEqual([6, null])
    const ids = [...first.incoming!.rows, ...rest.incoming!.rows].map((r) => r.other.qualified_name)
    expect(new Set(ids).size).toBe(30)
    // A byte budget too small for every row cuts rows from the end and keeps next_offset on what was listed.
    const small = tool(dataDir, 'get_symbol_card', { symbol_id: id, limits: { max_rows: 24, max_bytes: 12000 } })
    const side = (small.data as { incoming: Side }).incoming
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(12000)
    expect(side.rows.length).toBeLessThan(24)
    expect(side.next_offset).toBe(side.rows.length)
    expect(small.completion.stop_reasons).toContain('max_bytes')
  })
})

describe('FR1182 a card never shows unverified source: a row whose evidence fails its integrity check stays, with no text', () => {
  it('a tampered object leaves the row and the declaration in the card, each failed and without text', async () => {
    const { dataDir } = await indexedDataDir()
    const id = symbolId(dataDir, 'packages/billing/src/invoice:invoiceTotal')
    const row = card(dataDir, { symbol_id: id }).outgoing!.rows.find((r) => r.other.qualified_name === 'packages/format/src/currency:formatAmount')!
    const hash = (tool(dataDir, 'read_evidence', { evidence_ids: row.evidence_ids }).data.evidence as Array<{ object_hash: string }>)[0]!.object_hash
    const object = path.join(dataDir, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash)
    fs.chmodSync(object, 0o644)
    fs.appendFileSync(object, '// tampered\n')
    const after = card(dataDir, { symbol_id: id })
    const same = after.outgoing!.rows.find((r) => r.other.qualified_name === 'packages/format/src/currency:formatAmount')!
    expect(same.evidence).toMatchObject({ integrity: { status: 'failed' }, context: null })
    expect(after.declaration).toMatchObject({ integrity: { status: 'failed' }, text: null })
  })
})

describe('FR1185 a path reads as a chain of proofs: each hop of a path carries its call site', () => {
  it('handleInvoice to formatAmount: two hops, each at the line that makes the call, and the path observed', async () => {
    const { dataDir } = await indexedDataDir()
    const t = tool(dataDir, 'trace_paths', { source_id: symbolId(dataDir, 'packages/api/src/handler:handleInvoice'), target_id: symbolId(dataDir, 'packages/format/src/currency:formatAmount') }).data as { paths: Array<{ assertions: string[]; basis: string }>; relationships: Record<string, { basis: string; site?: { path: string; start_line: number } }> }
    expect(t.paths[0]!.basis).toBe('observed')
    expect(t.paths[0]!.assertions.map((a) => t.relationships[a]!.site)).toEqual([{ path: 'packages/api/src/handler.ts', start_line: 5 }, { path: 'packages/billing/src/invoice.ts', start_line: 9 }])
  })
})
