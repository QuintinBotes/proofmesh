import fs from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { runTool } from '../src/query/tools.js'
import { copyFixture, fixtureRepo, indexedDataDir, indexedRepo, symbolId, tool } from './helpers.js'

describe('A34 #31 finding repositories over MCP when several are registered', () => {
  let d: string, first: string, second: string
  beforeAll(async () => {
    ;({ dataDir: d, repoId: first } = await indexedDataDir())
    const c = Catalog.open(d)
    second = c.addRepository(copyFixture()).id
    c.close()
    await indexRepository(d, second)
  })

  it('a tool without repository_id is refused with every registered id, name and root', () => {
    try {
      tool(d, 'find_symbols', { text: 'formatAmount' })
      expect.unreachable()
    } catch (e) {
      const err = e as { message: string; details?: { repositories?: Array<{ id: string }> } }
      expect(err.message).toContain(first)
      expect(err.message).toContain(second)
      expect(err.message).toContain('list_repositories lists them')
      expect(err.details?.repositories?.map((r) => r.id).sort()).toEqual([first, second].sort())
    }
  })

  it('list_repositories needs no repository_id and names each one\'s current snapshot', () => {
    const env = tool(d, 'list_repositories', {})
    expect(env.snapshot).toBeNull()
    expect(env.freshness.status).toBe('catalog')
    const repos = env.data.repositories as Array<{ id: string; root_exists: boolean; snapshot: { id: string } | null }>
    expect(repos.map((r) => r.id).sort()).toEqual([first, second].sort())
    for (const r of repos) {
      expect(r.root_exists).toBe(true)
      expect(r.snapshot?.id).toMatch(/^snap_/)
    }
  })

  it('list_queries answers without a repository: the tool catalog and every repository\'s records', () => {
    tool(d, 'find_symbols', { text: 'formatAmount', repository_id: first })
    tool(d, 'find_symbols', { text: 'formatAmount', repository_id: second })
    const env = tool(d, 'list_queries', {})
    expect((env.data.tools as Array<{ name: string }>).map((t) => t.name)).toContain('list_repositories')
    expect(new Set((env.data.records as Array<{ repository_id: string }>).map((r) => r.repository_id))).toEqual(new Set([first, second]))
  })
})

describe('A34 #33 compact envelopes', () => {
  let d: string
  beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })
  const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x))

  it('compact leaves out the snapshot-wide parts and keeps the query\'s own limits', () => {
    const full = tool(d, 'find_symbols', { text: 'formatAmount' })
    const compact = tool(d, 'find_symbols', { text: 'formatAmount', envelope: 'compact' })
    expect(compact.envelope).toBe('compact')
    expect(compact.data).toEqual(full.data)
    expect(compact.unresolved.by_reason).toEqual({})
    expect(compact.unresolved.count).toBe(full.unresolved.count)
    expect(compact.coverage).toBeNull()
    expect(size(compact)).toBeLessThan(size(full))
  })

  it('a session sends the full envelope once per snapshot, then compact unless full is asked for', () => {
    const session = { fullSent: new Set<string>() }
    expect(runTool(d, 'find_symbols', { text: 'formatAmount' }, session).envelope).toBeUndefined()
    expect(runTool(d, 'find_symbols', { text: 'invoiceTotal' }, session).envelope).toBe('compact')
    expect(runTool(d, 'find_symbols', { text: 'invoiceTotal', envelope: 'full' }, session).envelope).toBeUndefined()
  })

  it('an envelope that alone overflows max_bytes is compacted to fit rather than sent over it', () => {
    const full = tool(d, 'find_symbols', { text: 'zzz-no-match' })
    const budget = size(full) - 50
    const tight = tool(d, 'find_symbols', { text: 'zzz-no-match', limits: { max_bytes: budget } })
    expect(tight.envelope).toBe('compact')
    expect(size(tight)).toBeLessThanOrEqual(budget)
    expect(tight.limitations.join(' ')).toMatch(new RegExp(`compacted to fit max_bytes ${budget}`))
  })
})

describe('the standing references limitation follows the snapshot\'s capability', () => {
  it('says references are not analysed for a snapshot whose adapters record none', async () => {
    // TypeScript records references to repository types (FR086), so this repository holds only files no built-in adapter reads.
    const { dataDir } = await indexedDataDir(fixtureRepo('linelang'))
    expect(fs.existsSync(dataDir)).toBe(true)
    expect(tool(dataDir, 'find_symbols', { text: 'main' }).limitations).toContain('References other than calls and imports are not analysed for this snapshot.')
  })

  it('FR1540 says references are partial for a snapshot whose TypeScript adapter records uses of repository types', async () => {
    const { dataDir } = await indexedDataDir()
    expect(tool(dataDir, 'find_symbols', { text: 'formatAmount' }).limitations).toContain('References other than calls and imports are recorded only where an adapter supports them (C# uses of repository declarations, TypeScript uses of repository types, Python uses of repository classes and functions); elsewhere a missing reference is not evidence of no use.')
  })

  it('FR1540 names Python among the adapters that record references, for a snapshot of Python alone that records one', async () => {
    const { dataDir } = await indexedRepo({ 'shop/cart.py': 'class Cart:\n    pass\n', 'shop/app.py': 'from shop.cart import Cart\n\n\ndef make(c: Cart) -> None:\n    pass\n' })
    expect(tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'shop/cart:Cart'), types: ['references'] }).data.relationships).toHaveLength(1)
    expect(tool(dataDir, 'find_symbols', { text: 'Cart' }).limitations).toContain('References other than calls and imports are recorded only where an adapter supports them (C# uses of repository declarations, TypeScript uses of repository types, Python uses of repository classes and functions); elsewhere a missing reference is not evidence of no use.')
  })

  it('FR1640 says references are partial for a snapshot of Python alone that records none, as the adapter looked for them', async () => {
    const { dataDir } = await indexedRepo({ 'shop/cart.py': 'class Cart:\n    pass\n', 'shop/app.py': 'from shop.cart import Cart\n\n\ndef make() -> None:\n    Cart()\n' })
    expect(tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'shop/cart:Cart'), types: ['references'] }).data.relationships).toHaveLength(0)
    const limitations = tool(dataDir, 'find_symbols', { text: 'Cart' }).limitations
    expect(limitations).toContain('References other than calls and imports are recorded only where an adapter supports them (C# uses of repository declarations, TypeScript uses of repository types, Python uses of repository classes and functions); elsewhere a missing reference is not evidence of no use.')
    expect(limitations).not.toContain('References other than calls and imports are not analysed for this snapshot.')
    expect((tool(dataDir, 'workspace_status', {}).data.languages as Array<{ language: string; capabilities: Record<string, unknown> }>).find((l) => l.language === 'Python')!.capabilities.references).toMatchObject({ partial: 2, unsupported: 0 })
  })
})
