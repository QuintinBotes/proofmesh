import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { runKit } from '../src/conformance/kit.js'
import { BUILT_IN } from '../src/indexer/languages.js'
import { cli, evidenceSlice, expectedFor, fixtureRepo, ROOT, tmpDir, withSnapshot } from './helpers.js'

// Python goes to its semantic adapter by default; the syntax tier still reads it, and is checked on it here.
const syntax = () => { const b = BUILT_IN.find((x) => x.id === 'syntax')!; return { id: 'syntax', entry: b.entry()!, extensions: { ...b.extensions, '.py': 'python' }, configNames: [] } }
const EXPECTED = expectedFor('syntax-tier')
let indexed: string | undefined
const syntaxTierIndex = () => {
  if (!indexed) {
    const d = tmpDir()
    for (const args of [['init'], ['repo', 'add', fixtureRepo('syntax-tier')], ['index', fixtureRepo('syntax-tier')]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    indexed = d
  }
  return indexed
}

describe('A6 A23 the Tree-sitter syntax tier', () => {
  it('SC014 passes the conformance kit on thirteen languages, with hand-written expected facts', async () => {
    const r = await runKit(syntax(), fixtureRepo('syntax-tier'), EXPECTED)
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`)).toEqual([])
    expect(r.checks.map((c) => c.id)).toContain('golden.calls')
  }, 240000)

  it('each grammar is pinned: its package version and the hash of its WebAssembly join the adapter identity', () => {
    const d = syntaxTierIndex()
    const adapters = withSnapshot(d, (db) => JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value)) as Array<{ id: string; toolchain: Record<string, string> }>
    const toolchain = adapters.find((a) => a.id === 'syntax')!.toolchain
    const require = createRequire(path.join(ROOT, 'adapters', 'syntax', 'package.json'))
    const wasm = fs.readFileSync(path.join(path.dirname(require.resolve('tree-sitter-python/package.json')), 'tree-sitter-python.wasm'))
    expect(toolchain['grammar:python']).toBe(`tree-sitter-python@0.25.0 ${createHash('sha256').update(wasm).digest('hex').slice(0, 16)}`)
    // FR310: the TypeScript, TSX and C# grammars are pinned with the others.
    expect(Object.keys(toolchain).filter((k) => k.startsWith('grammar:')).sort()).toEqual(['bash', 'c', 'cpp', 'csharp', 'go', 'java', 'kotlin', 'php', 'prisma', 'python', 'ruby', 'rust', 'scala', 'sql', 'swift', 'tsx', 'typescript'].map((l) => `grammar:${l}`))
    // Built from their packages' source by adapters/syntax/grammars/rebuild.mjs, because the packages ship no WebAssembly.
    expect([toolchain['grammar:swift'], toolchain['grammar:sql'], toolchain['grammar:prisma']]).toEqual(['tree-sitter-swift@0.7.1 24a6afb13db61ffd', '@derekstride/tree-sitter-sql@0.3.13 3c7acad1cda9d565', 'tree-sitter-prisma@1.6.0 5df064fd975d5b8e'])
  }, 240000)

  it('A6 Swift imports are unresolved import statements; a table a SQL statement names is a candidate only when the file declares it', () => {
    const d = syntaxTierIndex()
    const byLine = (a: { from: string; line: number }, b: { from: string; line: number }) => a.from.localeCompare(b.from) || a.line - b.line
    withSnapshot(d, (db) => {
      const qn = (id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name
      const imports = (db.prepare(`select f.path, a.reason, ae.evidence_id from assertion a join file f on f.id = a.source_id join assertion_evidence ae on ae.assertion_id = a.id where a.type = 'imports' and a.origin = 'syntax'`).all() as Array<{ path: string; reason: string; evidence_id: string }>)
        .map((r) => ({ from: r.path, line: (db.prepare('select start_line from evidence where id = ?').get(r.evidence_id) as { start_line: number }).start_line, site_text: evidenceSlice(d, db, r.evidence_id), reason: r.reason }))
      expect(imports.sort(byLine)).toEqual(EXPECTED.imports_unresolved.map((i: object) => ({ ...i, reason: 'outside_capability' })))
      const references = (db.prepare(`select a.id, a.source_id, a.resolution, a.reason, a.detail, ae.evidence_id from assertion a join assertion_evidence ae on ae.assertion_id = a.id where a.type = 'references' and a.origin = 'syntax'`).all() as Array<{ id: string; source_id: string; resolution: string; reason: string; detail: string; evidence_id: string }>)
        .map((r) => {
          const candidate = db.prepare('select symbol_id from assertion_candidate where assertion_id = ?').get(r.id) as { symbol_id: string } | undefined
          return { from: qn(r.source_id), line: (db.prepare('select start_line from evidence where id = ?').get(r.evidence_id) as { start_line: number }).start_line, site_text: evidenceSlice(d, db, r.evidence_id), name: JSON.parse(r.detail).name, resolution: r.resolution, ...(candidate ? { candidate: qn(candidate.symbol_id) } : { reason: r.reason }) }
        })
      expect(references.sort(byLine)).toEqual([...EXPECTED.table_references].sort(byLine))
      expect(db.prepare(`select path, json_extract(capabilities, '$.imports') as imports, json_extract(capabilities, '$.references') as refs from file where path in ('java/Main.java', 'sql/schema.sql', 'swift/Shop.swift') order by path`).all()).toEqual([
        // #4 scenario 5: "nothing reports `complete` for imports, because nothing is resolved"; Java's query names imports since FR115.
        { path: 'java/Main.java', imports: 'partial', refs: 'unsupported' },
        { path: 'sql/schema.sql', imports: 'unsupported', refs: 'partial' },
        { path: 'swift/Shop.swift', imports: 'partial', refs: 'unsupported' },
      ])
    })
  }, 240000)
})

describe('the adapters built on Tree-sitter: syntax, Python and Terraform', () => {
  it('an empty file is indexed with no symbols, even one a local module call depends on', () => {
    const repo = tmpDir('pm-empty-')
    fs.mkdirSync(path.join(repo, 'pkg'))
    fs.mkdirSync(path.join(repo, 'net'))
    for (const f of ['pkg/__init__.py', 'blank.rb', 'net/empty.tf']) fs.writeFileSync(path.join(repo, f), '')
    fs.writeFileSync(path.join(repo, 'app.py'), 'import pkg\n')
    fs.writeFileSync(path.join(repo, 'main.tf'), 'module "net" {\n  source = "./net"\n}\n')
    const d = tmpDir()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0) }
    expect(withSnapshot(d, (db) => db.prepare(`select f.path, f.disposition, count(s.id) as symbols from file f left join symbol s on s.file_id = f.id group by f.path order by f.path`).all())).toEqual([
      { path: 'app.py', disposition: 'indexed', symbols: 1 },
      { path: 'blank.rb', disposition: 'indexed', symbols: 0 },
      { path: 'main.tf', disposition: 'indexed', symbols: 2 },
      { path: 'net/empty.tf', disposition: 'indexed', symbols: 0 },
      { path: 'pkg/__init__.py', disposition: 'indexed', symbols: 0 },
    ])
  }, 240000)
})
