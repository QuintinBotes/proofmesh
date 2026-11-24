import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { detectLanguage } from '../src/indexer/language-detect.js'
import Database from 'better-sqlite3'
import { buildCensus, CENSUS_VERSION, censusVersion, remedyTableMarkdown, REMEDY_TABLE } from '../src/indexer/census.js'
import { manifestHash, workingTree } from '../src/indexer/freshness.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { sealedPath } from '../src/meshstore/snapshot.js'
import { sha256File } from '../src/core/hash.js'
import { treeFreshness } from '../src/query/tools.js'
import { cli, fixtureRepo, ROOT, tmpDir, tool, withSnapshot } from './helpers.js'
import { encode } from './helpers-scip.js'

type Row = {
  language: string; kind: string; extension?: string; files: number
  dispositions: Record<string, number>; excluded: Record<string, number>
  tier: string; tiers: Array<{ tier: string; files: number }>
  capabilities: Record<string, Record<string, number>>; reason: string | null; remedy: string | null
}
const NO_CS = { PROOFMESH_CS_ADAPTER: '/nonexistent/Proofmesh.Adapter.CSharp.dll' }

/** Indexes a directory in a fresh data directory, with extra arguments run between registering and indexing. */
function indexed(repo: string, env: Record<string, string> = {}, before: string[][] = []) {
  const d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo], ...before, ['index', repo]]) { const r = cli(['--data-dir', d, ...args], env); expect(r.status, r.stderr).toBe(0) }
  return d
}
const languages = (d: string) => (tool(d, 'workspace_status').data.languages as Row[])
const write = (root: string, files: Record<string, string | Buffer>) => {
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text) }
  return root
}
const copyFixture = () => { const repo = fs.realpathSync(tmpDir('pm-census-')); fs.cpSync(fixtureRepo('polyglot-census'), repo, { recursive: true }); return repo }

let repo: string, d: string, rows: Row[]
beforeAll(() => {
  repo = copyFixture()
  d = indexed(repo, NO_CS)
  rows = languages(d)
}, 240000)
const row = (language: string) => rows.find((r) => r.language === language)!

describe('FR138 workspace_status lists every language with its kind, files, tier and reason (fixtures/polyglot-census)', () => {
  it('scenario 1: exactly the spec rows, code and template first, then by file count, then by name', () => {
    expect(rows.map((r) => [r.language, r.kind, r.files, r.tier, r.reason])).toEqual([
      ['C', 'code', 1, 'syntax', 'no_precise_tier'],
      ['C#', 'code', 1, 'none', 'adapter_unavailable:csharp'],
      ['Elixir', 'code', 1, 'none', 'no_grammar'],
      ['Go', 'code', 1, 'syntax', 'no_precise_tier'],
      ['Shell', 'code', 1, 'syntax', 'no_precise_tier'],
      ['TypeScript', 'code', 1, 'precise:typescript', null],
      ['ERB', 'template', 1, 'none', 'no_grammar'],
      // Issue 3 predates FR124 to FR129: the build adapter now reads go.mod as a manifest, so its row has a tier.
      ['Go Module', 'data', 1, 'precise:build', null],
      ['YAML', 'data', 1, 'none', 'not_code'],
      ['Markdown', 'prose', 1, 'none', 'not_code'],
    ])
  })

  it('scenario 3: each capability gives a count of files per level, and the counts of each row sum to its files', () => {
    for (const r of rows) {
      expect(Object.keys(r.capabilities)).toEqual(['symbols', 'imports', 'references', 'resolved_calls'])
      for (const levels of Object.values(r.capabilities)) {
        expect(Object.keys(levels)).toEqual(['complete', 'partial', 'unsupported', 'failed', 'not_run'])
        expect(Object.values(levels).reduce((a, b) => a + b, 0), r.language).toBe(r.files)
      }
    }
    expect(row('TypeScript').capabilities.symbols).toMatchObject({ complete: 1 })
    expect(row('TypeScript').capabilities.references).toMatchObject({ partial: 1 })
    // The syntax tier names declarations without resolving anything: symbols partial, calls never complete.
    expect(row('Go').capabilities.symbols).toMatchObject({ partial: 1 })
    expect(row('Go').capabilities.resolved_calls).toMatchObject({ complete: 0 })
    // A file no adapter ran on has run nothing.
    expect(row('C#').capabilities.symbols).toMatchObject({ not_run: 1 })
    expect(row('Elixir').capabilities.resolved_calls).toMatchObject({ not_run: 1 })
  })

  it('FR137 each indexed source file records the tier that produced its facts, beside its capabilities', () => {
    const files = (tool(d, 'workspace_status', { files: { disposition: ['indexed'] } }).data.files as Array<{ path: string; capabilities: Record<string, string> }>)
    const tier = Object.fromEntries(files.map((f) => [f.path, f.capabilities.tier]))
    expect(tier).toMatchObject({ 'web/app.ts': 'precise:typescript', 'svc/main.go': 'syntax', 'include/util.h': 'syntax', 'scripts/deploy': 'syntax' })
    expect(tier['api/Orders.cs']).toBeUndefined()
    // The new key never counts as a capability of the snapshot.
    const caps = tool(d, 'find_symbols', { text: 'greet', envelope: 'full' }).coverage!.capabilities
    expect(Object.keys(caps)).not.toContain('tier')
  })
})

describe('FR140 one remedy table names the precise route of each language', () => {
  it('scenario 2: Go names scip-go, C# the .NET 10 SDK, Elixir the adapter command; TypeScript, data and prose have none', () => {
    expect(row('Go').remedy).toMatch(/scip-go/)
    expect(row('Go').remedy).toMatch(/proofmesh scip add/)
    expect(row('C#').remedy).toMatch(/\.NET 10 SDK/)
    expect(row('C#').remedy).toMatch(/dotnet build adapters\/csharp -c Release/)
    expect(row('Elixir').remedy).toMatch(/proofmesh adapter add/)
    expect(row('C').remedy).toMatch(/scip-clang/)
    for (const l of ['TypeScript', 'Go Module', 'YAML', 'Markdown']) expect(row(l).remedy, l).toBeNull()
  })

  it('docs/proofmesh/languages.md shows the same table the remedies come from', () => {
    expect(fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'languages.md'), 'utf8')).toContain(remedyTableMarkdown())
  })
})

describe('FR139 a file whose language is known only from its shebang or content is routed to that language', () => {
  it('scenario 4: the extensionless script with a bash shebang is Shell, analysed by the syntax tier, and its function is a symbol', () => {
    expect(row('Shell').files).toBe(1)
    const symbols = tool(d, 'find_symbols', { text: 'deploy', path_prefix: 'scripts/' }).data.symbols as Array<{ name: string; kind: string; path: string }>
    expect(symbols.map((s) => [s.name, s.kind, s.path])).toContainEqual(['deploy', 'function', 'scripts/deploy'])
  })

  it('detection: shebangs through env and versions, a .h with C++ content, and an extension no content settles', () => {
    const at = (p: string, text: string) => detectLanguage(p, (n = 8192) => text.slice(0, n))
    expect(at('bin/run', '#!/bin/sh\n')).toMatchObject({ name: 'Shell', via_content: true })
    expect(at('bin/run', '#!/usr/bin/env -S bash -eu\n')).toMatchObject({ name: 'Shell' })
    expect(at('bin/tool', '#!/usr/bin/env python3.11\n')).toMatchObject({ name: 'Python' })
    expect(at('bin/tool', '#!/usr/bin/env node\n')).toMatchObject({ name: 'JavaScript' })
    expect(at('bin/plain', 'no shebang\n')).toMatchObject({ name: 'unknown', extension: '(no extension)' })
    expect(at('src/a.h', 'class Shape {\n public:\n  virtual double area() = 0;\n};\n')).toMatchObject({ name: 'C++', via_content: true })
    expect(at('src/b.h', '#include <stdio.h>\nint add(int a, int b);\n')).toMatchObject({ name: 'C' })
    expect(at('src/c.h', '@interface Shape : NSObject\n@end\n')).toMatchObject({ name: 'Objective-C' })
    expect(at('src/d.m', 'x')).toMatchObject({ name: 'unknown', extension: '.m' })
    expect(at('src/e.xyz', 'x')).toMatchObject({ name: 'unknown', extension: '.xyz' })
    // Longest extension first: a template is not the HTML it renders.
    expect(at('views/index.html.erb', '')).toMatchObject({ name: 'ERB', kind: 'template' })
    expect(at('web/App.tsx', '')).toMatchObject({ name: 'TypeScript' })
    expect(at('go.mod', '')).toMatchObject({ name: 'Go Module', kind: 'data' })
    // The source of the table is named where it is vendored, with its licence in THIRD_PARTY_NOTICES.md.
    expect(fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toMatch(/Linguist[\s\S]*MIT License[\s\S]*Copyright \(c\) 2017 GitHub, Inc\./)
  })
})

describe('FR141 proofmesh status prints the census, one line per language, and --json the tool rows', () => {
  it('scenario 5: the lines follow the rows; --json is the tool\'s languages array unchanged', () => {
    const out = cli(['--data-dir', d, 'status', repo])
    expect(out.status, out.stderr).toBe(0)
    const lines = out.stdout.split('\n')
    const at = lines.findIndex((l) => l.startsWith('languages '))
    expect(lines[at]).toBe('languages 10')
    const printed = lines.slice(at + 1, at + 11)
    expect(printed.map((l) => l.replace(/^ {2}/, '').split(':')[0])).toEqual(rows.map((r) => r.language))
    expect(printed[0]).toBe('  C: 1 file, tier syntax, weakest imports=unsupported, remedy: ' + rows[0]!.remedy)
    const go = printed[rows.findIndex((r) => r.language === 'Go')]!
    expect(go).toMatch(/^ {2}Go: 1 file, tier syntax, weakest \w+=\w+, remedy: .*scip-go/)
    const ts = printed[rows.findIndex((r) => r.language === 'TypeScript')]!
    expect(ts).toMatch(/^ {2}TypeScript: 1 file, tier precise:typescript, weakest references=partial$/)
    const json = JSON.parse(cli(['--data-dir', d, 'status', repo, '--json']).stdout)
    expect(json.data.languages).toEqual(rows)
  })
})

describe('FR136 every file is in exactly one language row', () => {
  it('scenario 6: the rows sum to the inventory; excluded, binary, unknown, C++ headers and ambiguous extensions are named', () => {
    const edge = tmpDir('pm-census-edge-')
    write(edge, {
      '.gitignore': 'gen/\n',
      'src/a.go': 'package a\n\nfunc A() {}\n',
      'gen/b.go': 'package b\n',
      'big/huge.py': `x = 1\n${'#'.repeat(1_100_000)}\n`,
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
      'blob.bin': Buffer.from([0, 1, 2, 3]),
      'data.xyz': 'one\n',
      'more.xyz': 'two\n',
      'proofs/lemma.v': 'Lemma x.\n',
      'include/shape.h': 'namespace geo {\nclass Shape { public: virtual ~Shape(); };\n}\n',
      'include/api.h': 'int api(void);\n',
      'node_modules/dep/index.js': 'module.exports = 1\n',
      'NOTES': 'plain notes\n',
    })
    // A link is never followed, and is still in exactly one row.
    fs.symlinkSync('.', path.join(edge, 'loop'))
    spawnSync('git', ['init', '-q'], { cwd: edge })
    const e = indexed(edge)
    const rs = languages(e)
    const total = withSnapshot(e, (db) => (db.prepare('select count(*) as n from file').get() as { n: number }).n)
    expect(rs.reduce((a, r) => a + r.files, 0)).toBe(total)
    expect(rs.reduce((a, r) => a + Object.values(r.dispositions).reduce((x, y) => x + y, 0), 0)).toBe(total)
    const by = (l: string, ext?: string) => rs.find((r) => r.language === l && (ext === undefined || r.extension === ext))!
    expect(by('Go')).toMatchObject({ files: 2, excluded: { gitignore: 1 }, dispositions: { indexed: 1, excluded: 1, unsupported: 0, failed: 0 }, tier: 'syntax' })
    expect(by('Python')).toMatchObject({ files: 1, excluded: { 'max_file_bytes:1048576': 1 }, tier: 'none', reason: 'excluded' })
    expect(by('JavaScript')).toMatchObject({ files: 1, excluded: { '**/node_modules/**': 1 } })
    expect(by('binary')).toMatchObject({ kind: 'binary', files: 2, reason: 'binary' })
    expect(by('unknown', '.xyz')).toMatchObject({ kind: 'unknown', files: 2, reason: 'unknown_language' })
    expect(by('unknown', '.v')).toMatchObject({ files: 1 })
    // NOTES, and the link named loop: a link is never followed and is still in exactly one row.
    expect(by('unknown', '(no extension)')).toMatchObject({ files: 2, dispositions: { indexed: 0, unsupported: 2 } })
    expect(by('C++')).toMatchObject({ files: 1, tier: 'syntax' })
    expect(by('C')).toMatchObject({ files: 1, tier: 'syntax' })
    // The C++ header is analysed by the C++ grammar: a class is a symbol.
    expect((tool(e, 'find_symbols', { text: 'Shape' }).data.symbols as Array<{ path: string }>).map((s) => s.path)).toContain('include/shape.h')
  }, 240000)

  it('a repository with no recognisable code gives only data and prose rows, and says so', () => {
    const docs = write(tmpDir('pm-census-docs-'), { 'README.md': '# Notes\n', 'config.yml': 'a: 1\n', 'package.json': '{"name":"x"}\n' })
    const env = tool(indexed(docs), 'workspace_status')
    expect((env.data.languages as Row[]).map((r) => [r.language, r.kind])).toEqual([['JSON', 'data'], ['YAML', 'data'], ['Markdown', 'prose']])
    expect(env.limitations?.join(' ')).toMatch(/No code was recognised/)
  }, 120000)
})

describe('FR138 FR137 a language read by two tiers shows both, and a stale SCIP index says so (scenario 7)', () => {
  const GO = 'scip-go gomod example.com/svc v1 '
  it('a covered file and an uncovered one are two tiers of one row; after an edit the row is syntax with scip_stale and a remedy to name the index again', () => {
    const r = copyFixture()
    write(r, { 'svc/util.go': 'package main\n\nfunc helper() int {\n\treturn 1\n}\n' })
    const file = path.join(tmpDir('pm-census-scip-'), 'svc.scip')
    fs.writeFileSync(file, encode(r, 'hand-written', [{
      path: 'svc/main.go', language: 'go', typed: true,
      occurrences: [{ symbol: `${GO}\`example.com/svc\`/serve().`, range: [2, 5, 10], def: true }],
      symbols: [{ symbol: `${GO}\`example.com/svc\`/serve().`, kind: 17, signature: 'func serve() string' }],
    }]))
    const x = indexed(r, NO_CS, [['scip', 'add', r, file, '--name', 'svc']])
    expect(languages(x).find((l) => l.language === 'Go')).toMatchObject({ files: 2, tier: 'scip:svc', tiers: [{ tier: 'scip:svc', files: 1 }, { tier: 'syntax', files: 1 }], reason: 'no_precise_tier' })
    fs.appendFileSync(path.join(r, 'svc/main.go'), '\nfunc more() {}\n')
    const again = cli(['--data-dir', x, 'index', r], NO_CS)
    expect(again.status, again.stderr).toBe(0)
    const go = languages(x).find((l) => l.language === 'Go')!
    expect(go).toMatchObject({ files: 2, tier: 'syntax', tiers: [{ tier: 'syntax', files: 2 }], reason: 'scip_stale:svc' })
    expect(go.remedy).toMatch(/again/)
    expect(go.remedy).toMatch(/svc/)
    expect(go.remedy).toMatch(/proofmesh scip add/)
  }, 240000)
})

const edgeRepo = (files: Record<string, string | Buffer>, git = false) => {
  const r = write(fs.realpathSync(tmpDir('pm-census-r-')), files)
  if (git) spawnSync('git', ['init', '-q'], { cwd: r })
  return r
}
const censusOf = (r: string, env: Record<string, string> = {}) => { const x = indexed(r, env); return { x, rows: languages(x) } }

describe('FR136 FR139 header detection reads code, not comments or strings, and an Objective-C header is not C', () => {
  const at = (p: string, text: string) => detectLanguage(p, (n = 8192) => text.slice(0, n))
  it('comments and string literals never make a C header C++, and a long banner does not hide C++', () => {
    expect(at('a.h', '/* the std::vector class Foo { } */\n// namespace geo\nconst char *s = "template<typename T> public:";\nint f(void);\n')).toMatchObject({ name: 'C' })
    expect(at('b.h', `/*${' licence text '.repeat(900)}*/\nnamespace geo {\nclass Shape { public: virtual ~Shape(); };\n}\n`)).toMatchObject({ name: 'C++' })
  })
  it('an Objective-C header has its own row, tier none with a remedy, and stays out of the C parser', () => {
    const r = edgeRepo({ 'ui/Shape.h': '@interface Shape : NSObject\n- (void)draw;\n@end\n', 'src/add.c': 'int add(int a, int b) { return a + b; }\n' })
    const { x, rows } = censusOf(r)
    expect(rows.find((l) => l.language === 'Objective-C')).toMatchObject({ kind: 'code', files: 1, tier: 'none', reason: 'no_grammar', remedy: expect.stringMatching(/proofmesh adapter add/) })
    expect(rows.find((l) => l.language === 'C')).toMatchObject({ files: 1 })
    expect(withSnapshot(x, (db) => db.prepare("select disposition from file where path = 'ui/Shape.h'").get())).toEqual({ disposition: 'unsupported' })
  }, 120000)
  it('through the census: a banner header is C++, a header that only mentions C++ in comments is C', () => {
    const r = edgeRepo({ 'inc/banner.h': `/*${' licence text '.repeat(900)}*/\nnamespace geo { class Shape {}; }\n`, 'inc/plain.h': '/* class Foo { std::vector } */\nint plain(void);\n' })
    const { rows } = censusOf(r)
    expect(rows.map((l) => [l.language, l.files])).toEqual([['C', 1], ['C++', 1]])
  }, 120000)
})

describe('FR136 a row\'s kind does not depend on file order', () => {
  it('SQL read by the syntax tier and SQL left out by git ignore are one code row, whichever sorts first', () => {
    for (const [read, ignored] of [['a.sql', 'z.sql'], ['z.sql', 'a.sql']] as const) {
      const r = edgeRepo({ '.gitignore': `${ignored}\n`, [read]: 'select 1;\n', [ignored]: 'select 2;\n' }, true)
      const sql = censusOf(r).rows.find((l) => l.language === 'SQL')!
      expect(sql, read).toMatchObject({ kind: 'code', files: 2, excluded: { gitignore: 1 } })
    }
  }, 240000)
})

describe('FR136 FR138 unknown files are bounded: one row for extensionless files, one for implausible extensions, a capped row list', () => {
  it('detection: only a short final dot-suffix of letters and digits is an extension', () => {
    const at = (p: string) => detectLanguage(p, () => undefined)
    expect(at('bin/tool001')).toMatchObject({ name: 'unknown', extension: '(no extension)' })
    expect(at('logs/app.log.2024-11-24')).toMatchObject({ name: 'unknown', extension: '(other)' })
    expect(at('data/a.q00')).toMatchObject({ name: 'unknown', extension: '.q00' })
  })
  it('many extensionless files are one row, and app.log.2024-11-24 joins the other-extension row', () => {
    const files: Record<string, string> = { 'logs/app.log.2024-11-24': 'x\n', 'logs/app.log.2024-11-25': 'y\n' }
    for (let i = 0; i < 120; i++) files[`bin/tool${String(i).padStart(3, '0')}`] = 'plain\n'
    const rows = censusOf(edgeRepo(files)).rows
    expect(rows.map((l) => [l.language, l.extension, l.files])).toEqual([['unknown', '(no extension)', 120], ['unknown', '(other)', 2]])
  }, 120000)
  it('past the cap an other row comes last and the rows still sum to the inventory', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 80; i++) files[`d/f.q${String(i).padStart(2, '0')}`] = 'x\n'
    const r = edgeRepo(files)
    const { x, rows } = censusOf(r)
    const total = withSnapshot(x, (db) => (db.prepare('select count(*) as n from file').get() as { n: number }).n)
    expect(rows.length).toBeLessThanOrEqual(64)
    expect(rows.at(-1)).toMatchObject({ language: 'other', kind: 'unknown' })
    expect(rows.reduce((a, l) => a + l.files, 0)).toBe(total)
    expect(tool(x, 'workspace_status').limitations?.join(' ')).toMatch(/other row/)
  }, 120000)
})

describe('FR140 remedies give the real command, or the tool\'s README where the flags are not certain', () => {
  it('the table names each indexer\'s command, and the doc shows the same table', () => {
    const t = remedyTableMarkdown()
    for (const cmd of ['scip-java index', 'scip-typescript index', 'scip-python index . --project-name', 'rust-analyzer scip .', 'scip-dotnet index', 'scip-clang --compdb-path=compile_commands.json', 'scip-go']) expect(t, cmd).toContain(cmd)
    expect(t).toContain('https://github.com/davidrjenni/scip-php')
    expect(t).toContain('https://github.com/sourcegraph/scip-ruby')
    expect(REMEDY_TABLE.find((r) => r.language === 'Go')!.run).toBe('scip-go')
  })
  it('a remedy keeps "in a repository you trust", gives the command, and clang says it needs compile_commands.json', () => {
    expect(row('C').remedy).toMatch(/in a repository you trust/)
    expect(row('C').remedy).toMatch(/scip-clang --compdb-path=compile_commands\.json/)
    expect(row('C').remedy).toMatch(/needs a compile_commands\.json/)
    expect(row('Go').remedy).toMatch(/`scip-go`/)
    const php = buildCensus([{ label: { language: 'PHP', kind: 'code' }, disposition: 'unsupported', detail: 'no_adapter:.php', capabilities: {} }])[0]!
    expect(php.remedy).toContain('https://github.com/davidrjenni/scip-php')
    expect(php.remedy).toMatch(/in a repository you trust/)
  })
  it('a mistyped PROOFMESH_CS_ADAPTER says the override path does not exist, names it, and still says how to build', () => {
    expect(row('C#').remedy).toMatch(/PROOFMESH_CS_ADAPTER names \/nonexistent\/Proofmesh\.Adapter\.CSharp\.dll, which does not exist/)
    expect(row('C#').remedy).toMatch(/\.NET 10 SDK/)
  })
})

describe('FR138 a snapshot sealed before this census is stale, answers no rows, and says so', () => {
  /** Makes the current snapshot of a data directory look as one sealed before the census: no census meta, an older manifest hash. */
  function age(x: string) {
    const catalog = Catalog.open(x)
    const snap = catalog.currentSnapshot(catalog.repositories()[0]!.id)!
    catalog.close()
    const file = sealedPath(x, snap.id)
    fs.chmodSync(file, 0o644)
    const db = new Database(file)
    db.prepare("delete from meta where key = 'census'").run()
    const identity = JSON.parse((db.prepare("select value from meta where key = 'identity'").get() as { value: string }).value)
    db.prepare("update meta set value = ? where key = 'identity'").run(JSON.stringify({ ...identity, manifest_hash: 'sealed-before-the-census' }))
    db.close()
    fs.chmodSync(file, 0o444)
    const cat = new Database(path.join(x, 'catalog.db'))
    cat.prepare('update snapshot set store_digest = ? where id = ?').run(sha256File(file), snap.id)
    cat.close()
  }
  it('workspace_status answers languages [] with a limitation, and strict freshness finds the tree changed', () => {
    const r = copyFixture()
    const x = indexed(r, NO_CS)
    expect(languages(x).length).toBeGreaterThan(0)
    age(x)
    const env = tool(x, 'workspace_status')
    expect(env.data.languages).toEqual([])
    expect(env.limitations?.join(' ')).toMatch(/sealed before the language census existed/)
    const fresh = withSnapshot(x, (db) => treeFreshness(db, x, r))
    expect(fresh.current).toBe(false)
  }, 240000)
  it('the census version is part of the manifest hash that identifies a snapshot, and is derived from what it depends on', () => {
    const d = [{ path: 'a.ts', size: 1, status: 'capture' as const, detail: null, language: 'typescript', role: 'source' as const }]
    expect(manifestHash(d, () => 'h', 'one')).not.toBe(manifestHash(d, () => 'h', 'two'))
    expect(manifestHash(d, () => 'h')).toBe(manifestHash(d, () => 'h', CENSUS_VERSION))
    expect(workingTree(fixtureRepo('polyglot-census')).manifest).toBeTruthy()
    expect(censusVersion([...REMEDY_TABLE, { language: 'Zig' }])).not.toBe(CENSUS_VERSION)
    expect(censusVersion(REMEDY_TABLE)).toBe(CENSUS_VERSION)
  })
})

describe('FR141 proofmesh status given a path', () => {
  it('names the repository at that path even when another registered repository has the same name', () => {
    const a = write(fs.realpathSync(tmpDir('pm-census-a-')), { 'proj/one.go': 'package one\n' }) + '/proj'
    const b = write(fs.realpathSync(tmpDir('pm-census-b-')), { 'proj/two.py': 'x = 1\n' }) + '/proj'
    const x = tmpDir()
    for (const args of [['init'], ['repo', 'add', a], ['repo', 'add', b], ['index', a], ['index', b]]) { const r = cli(['--data-dir', x, ...args]); expect(r.status, r.stderr).toBe(0) }
    const out = cli(['--data-dir', x, 'status', b])
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toMatch(/^ {2}Python: 1 file/m)
    expect(out.stdout).not.toMatch(/^ {2}Go: /m)
  }, 240000)
})
