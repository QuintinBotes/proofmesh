import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './helpers.js'

const script = path.join(ROOT, 'bench/graph-bench/go-truth.py')
function normalize(documents: unknown[]) {
  const load = "import json, runpy, sys; normalize=runpy.run_path(sys.argv[1])['fact_lines']; print(json.dumps(normalize(json.load(sys.stdin))))"
  return spawnSync('python3', ['-c', load, script], { input: JSON.stringify({ documents }), encoding: 'utf8' })
}

describe('FR3001 Go compiler observations for the language benchmark', () => {
  it('preserves location, repeated occurrences, role bits and relationship flags across producer order changes', () => {
    const site = { symbol: 'local 1', symbol_roles: 1, range: [1, 3, 7], enclosing_range: [0, 0, 2, 0] }
    const use = { ...site, symbol_roles: 0, range: [2, 3, 7] }
    const link = { symbol: 'pkg Interface#', is_implementation: true }
    const first = { relative_path: 'a.go', position_encoding: 1, occurrences: [site, use, use], symbols: [{ symbol: 'local 1', kind: 9, display_name: 'x', relationships: [link] }] }
    const other = { relative_path: 'b.go', occurrences: [site] }
    const a = normalize([first, other]), b = normalize([other, { ...first, occurrences: [use, use, site] }])
    expect(a.status, a.stderr).toBe(0)
    expect(b.stdout).toBe(a.stdout)
    const facts = (JSON.parse(a.stdout) as string[]).map(line => JSON.parse(line))
    expect(facts).toHaveLength(6)
    expect(facts).toContainEqual(['relationship', 'a.go', 'local 1', link])
    expect(facts).toContainEqual(['site', 'a.go', 1, 'local 1', 1, [1, 3, 7], [0, 0, 2, 0]])
    expect(facts).toContainEqual(['site', 'b.go', 0, 'local 1', 1, [1, 3, 7], [0, 0, 2, 0]])
  })

  it('refuses an empty index or a named occurrence without a range', () => {
    expect(normalize([]).status).not.toBe(0)
    expect(normalize([{ relative_path: 'broken.go', occurrences: [{ diagnostics: [{ severity: 1, message: 'unknown package' }] }] }]).stderr).toContain('Compiler error in broken.go')
    expect(normalize([{ relative_path: 'a.go', occurrences: [{ symbol: 'local 1' }] }]).stderr).toContain('Missing location')
  })
})
