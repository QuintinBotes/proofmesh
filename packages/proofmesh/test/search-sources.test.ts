import { beforeAll, describe, expect, it, vi } from 'vitest'
import { indexedDataDir, tool, withSnapshot } from './helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })
const hits = (input: Record<string, unknown>) => (tool(d, 'search_sources', input).data as any).hits.map((h: any) => [h.path, h.line, h.text, h.symbol?.qualified_name ?? null])

describe('FR019 search_sources: lexical hits with the enclosing symbol', () => {
  it('finds each matching line with its file, line, excerpt, and enclosing symbol, in path order', () => {
    expect(hits({ text: 'formatAmount(' })).toEqual([
      ['packages/billing/src/invoice.ts', 9, 'return formatAmount(cents, currency);', 'packages/billing/src/invoice:invoiceTotal'],
      ['packages/format/src/currency.ts', 1, 'export function formatAmount(cents: number, currency: string): string {', 'packages/format/src/currency:formatAmount'],
      ['packages/legacy/src/format.ts', 1, 'export function formatAmount(value: number): string {', 'packages/legacy/src/format:formatAmount'],
    ])
  })

  it('is case-insensitive unless asked, narrows by path prefix, and never searches excluded files', () => {
    expect(hits({ text: 'FORMATAMOUNT(', path_prefix: 'packages/legacy/' }).map((h: any[]) => h[0])).toEqual(['packages/legacy/src/format.ts'])
    expect(hits({ text: 'FORMATAMOUNT(', case_sensitive: true })).toEqual([])
    expect(hits({ text: 'String(lines.length)' })).toEqual([])
  })

  it('pages by whole files: following next_cursor to the end yields exactly the unpaged hits, in order', () => {
    const all = (tool(d, 'search_sources', { text: 'export' }).data as any).hits
    expect(all.length).toBeGreaterThan(4)
    const pages: any[] = []
    let cursor: string | null = null
    do {
      const env = tool(d, 'search_sources', { text: 'export', limits: { max_rows: 2 }, ...(cursor ? { cursor } : {}) })
      const page = (env.data as any).hits
      pages.push(page)
      // A page is whole files unless one file alone overflows it, which the limitations then name.
      const files = new Set(page.map((h: any) => h.path))
      for (const f of files) if (!env.limitations.some((l) => l.startsWith(`${f} has more matches`))) expect(page.filter((h: any) => h.path === f).length).toBe(all.filter((h: any) => h.path === f).length)
      cursor = env.completion.next_cursor
      if (cursor) expect(env.limitations).toContain('Results were truncated; pass completion.next_cursor as cursor to get the next page.')
    } while (cursor)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.flat()).toEqual(all)
  })

  it('stops at the row limit and says so; semantic mode is refused', () => {
    const env = tool(d, 'search_sources', { text: 'export', limits: { max_rows: 2 } })
    expect((env.data as any).hits).toHaveLength(2)
    expect(env.completion.stop_reasons).toEqual(['max_rows'])
    expect(() => tool(d, 'search_sources', { text: 'export', mode: 'semantic' })).toThrow('only lexical search is available')
  })

  it('NFR001 reads a hit file\'s symbols through the symbol-by-file index, not a scan of every symbol', () => {
    const plan = withSnapshot(d, (db) => db.prepare("explain query plan select id, kind, qualified_name, start_line, end_line from symbol where file_id = ? and kind <> 'module' order by (end_line - start_line), start_line").all('file_x') as Array<{ detail: string }>)
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/USING INDEX symbol_by_file/)
  })

  it('a scan stopped by the time limit says how many more calls the rest would take', () => {
    let t = Date.now()
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (t += 400))
    try {
      const r = tool(d, 'search_sources', { text: 'export', limits: { timeout_ms: 1000 } })
      expect(r.completion.stop_reasons).toContain('timeout')
      expect(r.limitations.join(' ')).toMatch(/the rest takes about \d+ more calls?, so a local text search/)
    } finally {
      now.mockRestore()
    }
  })
})

