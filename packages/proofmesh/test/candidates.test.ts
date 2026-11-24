import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { indexedDataDir, symbolId, tmpDir, tool } from './helpers.js'

describe('A18 inbound candidate and ambiguous calls that name the subject are relationships', () => {
  it('each declaration a call may reach lists that call, with its resolution, and it still counts among the boundaries', async () => {
    // Two scripts declare the same global function, so the call in main.js may reach either.
    const repo = tmpDir('pm-cand-')
    fs.writeFileSync(path.join(repo, 'a.js'), 'function helper() {\n  return 1\n}\n')
    fs.writeFileSync(path.join(repo, 'b.js'), 'function helper() {\n  return 2\n}\n')
    fs.writeFileSync(path.join(repo, 'main.js'), 'function run() {\n  return helper()\n}\n')
    const { dataDir } = await indexedDataDir(repo)
    for (const declaration of ['a:helper', 'b:helper']) {
      const env = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, declaration), direction: 'in' })
      const data = env.data as { relationships: Array<{ type: string; direction: string; resolution: string; other: { qualified_name: string }; site: { path: string; start_line: number } }>; boundaries: Array<{ path: string; line: number }>; totals: { in: number } }
      expect(data.relationships.map((r) => [r.type, r.direction, r.resolution, r.other.qualified_name, `${r.site.path}:${r.site.start_line}`])).toEqual([['calls', 'in', 'ambiguous', 'main:run', 'main.js:2']])
      expect(data.totals.in).toBe(1)
      expect(data.boundaries.map((b) => `${b.path}:${b.line}`)).toContain('main.js:2')
    }
  }, 120000)
})
