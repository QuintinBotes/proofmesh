import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { snapshotSummary } from '../src/query/summary.js'
import { indexedDataDir, ROOT, tmpDir, tool, withSnapshot } from './helpers.js'

const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x))

describe('FR365 FR366 FR367 cutting an answer to max_bytes leaves the cached data, and every later answer, unchanged (fixtures/change-reach)', () => {
  let d: string
  let calls: Array<{ name: string; input: Record<string, unknown> }>
  // Each test indexes its own copy (a file of its own name), so a summary cached by one test cannot hide a mutation in the next.
  const fresh = async (tag: string) => {
    const repo = fs.realpathSync(tmpDir('pm-cache-'))
    const fx = path.join(ROOT, 'fixtures', 'change-reach')
    fs.cpSync(path.join(fx, 'base'), repo, { recursive: true })
    fs.copyFileSync(path.join(fx, 'tsconfig.json'), path.join(repo, 'tsconfig.json'))
    fs.writeFileSync(path.join(repo, `${tag}.ts`), `export const ${tag} = 1\n`)
    ;({ dataDir: d } = await indexedDataDir(repo))
    const id = (q: string) => withSnapshot(d, (db) => (db.prepare('select id from symbol where qualified_name = ?').get(q) as { id: string }).id)
    const mean = id('src/stats:mean'), source = id('test/analyst.test:analystScoreDoubles')
    calls = [
      { name: 'workspace_status', input: {} },
      { name: 'find_symbols', input: { text: 'a' } },
      { name: 'get_relationships', input: { subject_id: mean, direction: 'in' } },
      { name: 'analyze_impact', input: { subject_ids: [mean], limits: { max_depth: 3 } } },
      { name: 'find_tests', input: { subject_ids: [mean] } },
      { name: 'trace_paths', input: { source_id: source, target_id: mean } },
      { name: 'search_sources', input: { text: 'export' } },
      { name: 'get_overview', input: {} },
    ]
  }

  /** The answer's data, then the same call cut at several budgets, then its data again: the two must be equal. */
  const cutLeavesNoTrace = ({ name, input }: { name: string; input: Record<string, unknown> }) => {
    const before = JSON.stringify(tool(d, name, input).data)
    const full = size(tool(d, name, input))
    let cuts = 0
    for (const f of [0.95, 0.8, 0.6]) {
      try {
        const a = tool(d, name, { ...input, limits: { ...(input.limits as object | undefined), max_bytes: Math.floor(full * f) } })
        if (a.completion.stop_reasons.includes('max_bytes')) cuts++
      } catch (e) {
        // A budget under the envelope is refused (FR331); the cached data must be intact after that too.
        if ((e as { details?: { detail?: string } }).details?.detail !== 'max_bytes_too_small') throw e
      }
    }
    expect(JSON.stringify(tool(d, name, input).data), `${name} after cuts`).toBe(before)
    return cuts
  }

  it('FR365 workspace_status answered without max_bytes after a cut equals the answer taken before it', async () => {
    await fresh('one')
    expect(cutLeavesNoTrace({ name: 'workspace_status', input: {} })).toBeGreaterThan(0)
  }, 240000)

  it('FR366 the same holds for every tool that prunes', async () => {
    await fresh('two')
    for (const c of calls) cutLeavesNoTrace(c)
  }, 240000)

  it('FR367 a cached summary is frozen, and no tool throws when it cuts an answer', async () => {
    await fresh('three')
    const summary = withSnapshot(d, (db) => snapshotSummary(db, tool(d, 'workspace_status').snapshot!.id))
    expect(Object.isFrozen(summary)).toBe(true)
    expect(Object.isFrozen(summary.hubs)).toBe(true)
    for (const c of calls) expect(() => cutLeavesNoTrace(c), c.name).not.toThrow()
  }, 240000)
})
