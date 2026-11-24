import { beforeAll, describe, expect, it } from 'vitest'
import { EXPECTED, indexedDataDir, tool } from './helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })

describe('AC19 find_symbols', () => {
  it('returns both same-named symbols, the format package first', () => {
    const env = tool(d, 'find_symbols', { text: 'formatAmount' })
    expect((env.data.symbols as any[]).map((s) => s.path)).toEqual(['packages/format/src/currency.ts', 'packages/legacy/src/format.ts'])
    expect(env.completion.truncated).toBe(false)
  })

  it('max_rows 1 truncates and says so', () => {
    const env = tool(d, 'find_symbols', { text: 'formatAmount', limits: { max_rows: 1 } })
    expect((env.data.symbols as any[]).length).toBe(1)
    expect(env.completion).toMatchObject({ truncated: true, stop_reasons: ['max_rows'] })
    expect(env.completion.next_cursor).toMatch(/^pmc1\./)
    expect(env.limitations).toContain('Results were truncated; pass completion.next_cursor as cursor to get the next page.')
    // #32: file rows only when asked, and then paged like any other list.
    const summary = tool(d, 'workspace_status', { limits: { max_rows: 1 } })
    expect(summary.completion).toMatchObject({ truncated: false, next_cursor: null })
    expect(summary.data.files).toEqual([])
    const first = tool(d, 'workspace_status', { files: {}, limits: { max_rows: 1 } })
    expect(first.completion).toMatchObject({ truncated: true })
    const second = tool(d, 'workspace_status', { files: {}, limits: { max_rows: 1 }, cursor: first.completion.next_cursor })
    expect((second.data.files as Array<{ path: string }>)[0]!.path > (first.data.files as Array<{ path: string }>)[0]!.path).toBe(true)
  })

  it('treats LIKE wildcards in the query as literal text', () => {
    expect((tool(d, 'find_symbols', { text: '%' }).data.symbols as any[]).length).toBe(0)
  })
})

describe('A4 workspace_status counts call sites and unresolved calls by reason', () => {
  it('reports the fixture exactly', () => {
    expect((tool(d, 'workspace_status', { limits: { max_rows: 1 } }).data as any).calls).toEqual({ sites: 6, unresolved: 1, by_reason: { dynamic_element_access: 1 }, dependency_missing_by_package: {} })
  })
})

describe('#32 workspace_status summarises files instead of listing them', () => {
  it('groups the oracle\'s dispositions by disposition, reason and extension, largest group first', () => {
    const want = new Map<string, { disposition: string; detail: string | null; extension: string; files: number }>()
    for (const [file, [disposition, detail]] of Object.entries(EXPECTED.dispositions as Record<string, [string, string | null]>)) {
      const name = file.slice(file.lastIndexOf('/') + 1), extension = name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : name
      const g = want.get(`${disposition}|${detail}|${extension}`) ?? { disposition, detail, extension, files: 0 }
      g.files++
      want.set(`${disposition}|${detail}|${extension}`, g)
    }
    const order = (a: { files: number; extension: string; disposition: string }, b: { files: number; extension: string; disposition: string }) => b.files - a.files || (`${a.extension}|${a.disposition}` < `${b.extension}|${b.disposition}` ? -1 : 1)
    const env = tool(d, 'workspace_status', {})
    expect([...(env.data.file_summary as Array<{ disposition: string; detail: string | null; extension: string; files: number }>)].sort(order)).toEqual([...want.values()].sort(order))
    expect(env.limitations.join(' ')).toMatch(/pass files to list rows/)
    const unsupported = tool(d, 'workspace_status', { files: { disposition: ['unsupported'] } }).data.files as Array<{ path: string }>
    expect(unsupported.map((f) => f.path)).toEqual(Object.entries(EXPECTED.dispositions as Record<string, [string]>).filter(([, [disp]]) => disp === 'unsupported').map(([p]) => p).sort())
  })
})

