import { describe, expect, it } from 'vitest'
import { indexedRepo, symbolId, tool } from './helpers.js'

type Row = { other: { qualified_name: string }; site: { start_line: number }; detail: { use: string } }

describe('FR1010 a type query of a function or a variable is a reference', () => {
  it('FR1010 typeof f and typeof g are each one inbound references row from the type alias, at its line, with use typeof', async () => {
    const { dataDir } = await indexedRepo({ 'src/a.ts': 'export function f(): number { return 1 }\nexport type F = typeof f\nexport const g = 1\nexport type G = typeof g\n' })
    const refs = (subject: string) => (tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, subject), direction: 'in', types: ['references'] }).data.relationships as Row[])
      .map((x) => `${x.other.qualified_name} ${x.site.start_line} ${x.detail.use}`)
    expect(refs('src/a:f')).toEqual(['src/a:F 2 typeof'])
    expect(refs('src/a:g')).toEqual(['src/a:G 4 typeof'])
  }, 120000)
})
