import { describe, expect, it } from 'vitest'
import { check } from '../src/core/schemas.js'
import { TOOLS } from '../src/query/tools.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { indexedDataDir, tool } from './helpers.js'

const withCatalog = <T>(d: string, fn: (db: Catalog['db']) => T): T => { const c = Catalog.open(d); try { return fn(c.db) } finally { c.close() } }

describe('FR019 list_queries: the tool catalog and a record of every query, holding hashes and never inputs', () => {
  it('lists every tool with its schema files, and records each call newest first', async () => {
    const { dataDir: d } = await indexedDataDir()
    tool(d, 'find_symbols', { text: 'formatAmount' })
    tool(d, 'find_symbols', { text: 'handleInvoice' })
    const r = tool(d, 'list_queries', {}) as any
    expect(check('envelope.schema.json', r)).toBeUndefined()
    expect(check('tools/list_queries.data.schema.json', r.data)).toBeUndefined()
    expect(r.data.tools.map((t: any) => t.name).sort()).toEqual([...TOOLS].sort())
    for (const t of r.data.tools) { expect(() => check(t.input_schema, {})).not.toThrow(); expect(t.description.length).toBeGreaterThan(10) }
    expect(r.data.tools.find((t: any) => t.name === 'find_symbols').paged).toBe(true)
    expect(r.data.tools.find((t: any) => t.name === 'compare_snapshots').paged).toBe(false)
    // The two find_symbols calls, newest first; the list_queries call itself is recorded after it answers, so it is not in its own list.
    expect(r.data.records.map((x: any) => x.tool)).toEqual(['find_symbols', 'find_symbols'])
    expect(r.data.records[0].input_hash).not.toBe(r.data.records[1].input_hash)
    expect(r.data.records[0]).toMatchObject({ repository_id: r.snapshot.repository_id, snapshot_id: r.snapshot.id, truncated: false })
    expect(r.data.records[0].input_hash).toMatch(/^[0-9a-f]{16,64}$/)
    const only = tool(d, 'list_queries', { tool: 'list_queries' }) as any
    expect(only.data.records.map((x: any) => x.tool)).toEqual(['list_queries'])
    const one = tool(d, 'list_queries', { limit: 1 }) as any
    expect(one.data.records).toHaveLength(1)
    expect(one.completion.truncated).toBe(true)
  }, 120000)

  it('stores no query text and no result anywhere in the catalog (NFR008)', async () => {
    const { dataDir: d } = await indexedDataDir()
    tool(d, 'find_symbols', { text: 'zebraUnicornNeedle' })
    const rows = withCatalog(d, (db) => db.prepare('select * from query_record').all() as Array<Record<string, unknown>>)
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('zebraUnicornNeedle')
    expect(Object.keys(rows[0]!).sort()).toEqual(['duration_ms', 'input_hash', 'query_id', 'repository_id', 'requested_at', 'snapshot_id', 'tool', 'truncated'])
  }, 120000)
})
