import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runKit } from '../src/conformance/kit.js'
import { BUILT_IN } from '../src/indexer/languages.js'
import { cli, evidenceSlice, expectedFor, fixtureRepo, ROOT, tmpDir, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('syntax-structure')
const syntax = () => { const b = BUILT_IN.find((x) => x.id === 'syntax')!; return { id: 'syntax', entry: b.entry()!, extensions: b.extensions, configNames: [] } }
let indexed: string | undefined
const structureIndex = () => {
  if (!indexed) {
    const d = tmpDir()
    for (const args of [['init'], ['repo', 'add', fixtureRepo('syntax-structure')], ['index', fixtureRepo('syntax-structure')]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    indexed = d
  }
  return indexed
}

describe('FR115 FR116 FR117 the syntax tier records imports and heritage in Go and Java', () => {
  it('FR115 FR117 each import statement is one unresolved row with the module as written, its alias, and no target', () => {
    const d = structureIndex()
    withSnapshot(d, (db) => {
      const rows = (db.prepare(`select f.path, a.resolution, a.reason, a.target_id, a.detail, ae.evidence_id from assertion a join file f on f.id = a.source_id join assertion_evidence ae on ae.assertion_id = a.id where a.type = 'imports' and a.origin = 'syntax'`).all() as Array<{ path: string; resolution: string; reason: string; target_id: string | null; detail: string; evidence_id: string }>)
      expect(new Set(rows.map((r) => `${r.resolution} ${r.reason} ${r.target_id}`))).toEqual(new Set(['unresolved outside_capability null']))
      const facts = rows.map((r) => ({ from: r.path, line: (db.prepare('select start_line from evidence where id = ?').get(r.evidence_id) as { start_line: number }).start_line, site_text: evidenceSlice(d, db, r.evidence_id), detail: JSON.parse(r.detail) }))
      expect(facts.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line)).toEqual(EXPECTED.imports_unresolved)
      expect(db.prepare(`select path, json_extract(capabilities, '$.imports') as imports from file order by path`).all()).toEqual([
        { path: 'go/shape.go', imports: 'partial' },
        { path: 'java/Circle.java', imports: 'partial' },
      ])
    })
  }, 240000)

  it('FR116 FR117 SC014 heritage rows name each supertype from the type that declares it, unresolved, and pass the conformance kit', async () => {
    const r = await runKit(syntax(), fixtureRepo('syntax-structure'), EXPECTED)
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`)).toEqual([])
    expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['golden.symbols', 'golden.calls', 'golden.structure']))
    withSnapshot(structureIndex(), (db) => {
      expect(db.prepare(`select distinct resolution, reason, target_id from assertion where type in ('inherits', 'implements')`).all()).toEqual([{ resolution: 'unresolved', reason: 'outside_capability', target_id: null }])
    })
  }, 240000)

  it('FR118 languages.md states imports, heritage and calls for every syntax-tier language', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'languages.md'), 'utf8')
    const rows = new Map(doc.split('\n').filter((l) => /^\| [A-Z]/.test(l) && !l.startsWith('| Language')).flatMap((l) => { const [names, ...cells] = l.split('|').slice(1, -1).map((c) => c.trim()); return names!.split(', ').map((n) => [n.toLowerCase().replace('c++', 'cpp'), cells] as const) }))
    const grammars = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'syntax', 'dist', 'grammars', 'grammars.json'), 'utf8')) as Record<string, unknown>
    // Python goes to its own adapter, and HCL to the Terraform adapter.
    expect([...rows.keys()].sort()).toEqual(Object.keys(grammars).filter((l) => l !== 'hcl' && l !== 'python').sort())
    expect(rows.get('go')).toEqual(['yes, with module and alias', 'struct embedding', 'yes'])
    expect(rows.get('java')).toEqual(['yes, with module', '`extends`, `implements`', 'yes'])
  })
})
