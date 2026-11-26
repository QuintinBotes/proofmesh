import { describe, expect, it } from 'vitest'
import { indexedRepo, rows, symbolId, tool, withSnapshot } from './helpers.js'

type Rel = { type: string; other: { qualified_name?: string }; via?: { qualified_name: string } }

describe('FR226 the Python adapter records overrides, so a call through a base class reaches the subclass method', () => {
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
  it('a generic base (Base[int]) is the class it subscripts, so its methods are overridden', async () => {
    const { dataDir } = await indexedRepo({ 'm.py': 'from typing import Generic, TypeVar\n\nT = TypeVar("T")\n\n\nclass Base(Generic[T]):\n    def run(self): ...\n\n\nclass Child(Base[int]):\n    def run(self): ...\n' })
    expect(overrides(dataDir)).toEqual(['m:Child.run -> m:Base.run resolved semantic_resolver'])
  }, 240000)

  it('a private name is mangled with its class, so it overrides nothing, and a dunder name is not mangled', async () => {
    const { dataDir } = await indexedRepo({ 'm.py': 'class A:\n    def __hidden(self): ...\n    def __len__(self): ...\n\n\nclass B(A):\n    def __hidden(self): ...\n    def __len__(self): ...\n' })
    expect(overrides(dataDir)).toEqual(['m:B.__len__ -> m:A.__len__ resolved semantic_resolver'])
  }, 240000)

  it('a static method and a property are never overridden, however the decorator is spelled or imported', async () => {
    const { dataDir } = await indexedRepo({
      'm.py': 'import builtins\nimport functools\nfrom builtins import property as prop, staticmethod as sm\n\n\nclass A:\n    def run(self): ...\n    @builtins.staticmethod\n    def s1(): ...\n    @sm\n    def s2(): ...\n    @functools.cached_property\n    def p1(self): ...\n    @prop\n    def p2(self): ...\n    @builtins.property\n    def p3(self): ...\n\n\nclass B(A):\n    def run(self): ...\n    @builtins.staticmethod\n    def s1(): ...\n    @sm\n    def s2(): ...\n    @functools.cached_property\n    def p1(self): ...\n    @prop\n    def p2(self): ...\n    @builtins.property\n    def p3(self): ...\n',
    })
    expect(overrides(dataDir)).toEqual(['m:B.run -> m:A.run resolved semantic_resolver'])
  }, 240000)

  it('a call through the root reaches an override ten levels down', async () => {
    const classes = Array.from({ length: 10 }, (_, i) => `class C${i}${i ? `(C${i - 1})` : ''}:\n    def run(self): ...\n`).join('\n\n')
    const { dataDir } = await indexedRepo({ 'm.py': `${classes}\n\ndef use(c: C0):\n    c.run()\n` })
    const r = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'm:C9.run'), direction: 'in' }).data as { relationships: Rel[] }
    expect(r.relationships.filter((x) => x.type === 'calls').map((x) => [x.other.qualified_name, x.via?.qualified_name])).toEqual([['m:use', 'm:C0.run']])
  }, 240000)
})
