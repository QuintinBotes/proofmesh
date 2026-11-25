import { describe, expect, it } from 'vitest'
import { indexedRepo, rows, symbolId, tool, withSnapshot } from './helpers.js'

type Rel = { type: string; other: { qualified_name?: string }; via?: { qualified_name: string } }

describe('FR223 the Python adapter records overrides, so a call through a base class reaches the subclass method', () => {
  const overrides = (dataDir: string) => withSnapshot(dataDir, (db) => rows(db, 'overrides').map((r) => `${r.from} -> ${r.to} ${r.resolution} ${r.origin}`))

  it('a direct override and a two-level chain give one row each, and a method that overrides nothing gives none', async () => {
    const { dataDir } = await indexedRepo({
      'm.py': 'class A:\n    def run(self): ...\n    def only_a(self): ...\n\n\nclass B(A):\n    def run(self): ...\n    def extra(self): ...\n\n\nclass C(B):\n    def run(self): ...\n    def only_c(self): ...\n\n\ndef use(a: A):\n    a.run()\n',
    })
    expect(overrides(dataDir)).toEqual(['m:B.run -> m:A.run resolved semantic_resolver', 'm:C.run -> m:B.run resolved semantic_resolver'])
    const r = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'm:C.run'), direction: 'in' }).data as { relationships: Rel[] }
    expect(r.relationships.filter((x) => x.type === 'calls').map((x) => [x.other.qualified_name, x.via?.qualified_name])).toEqual([['m:use', 'm:A.run']])
  }, 240000)

  it('a base that is not indexed gives no row and no failure', async () => {
    const { dataDir } = await indexedRepo({ 'm.py': 'from collections import OrderedDict\nimport missing_pkg\n\n\nclass A(OrderedDict, missing_pkg.Base):\n    def keys(self): ...\n    def run(self): ...\n' })
    expect(overrides(dataDir)).toEqual([])
  }, 240000)

  it('multiple inheritance gives one row for each base that declares the method', async () => {
    const { dataDir } = await indexedRepo({ 'm.py': 'class L:\n    def go(self): ...\n\n\nclass R:\n    def go(self): ...\n    def other(self): ...\n\n\nclass Both(L, R):\n    def go(self): ...\n    def other(self): ...\n' })
    expect(overrides(dataDir)).toEqual(['m:Both.go -> m:L.go resolved semantic_resolver', 'm:Both.go -> m:R.go resolved semantic_resolver', 'm:Both.other -> m:R.other resolved semantic_resolver'])
  }, 240000)
})
