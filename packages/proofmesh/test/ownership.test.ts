import { describe, expect, it } from 'vitest'
import { effectiveCodeowners, ownerRule, parseCodeowners } from '../src/indexer/ownership.js'

const rules = parseCodeowners(`# Owners
*                     @org/everyone
*.md                  @org/docs   # trailing comment
/src/api/             @org/api @alice
src/**/legacy/        @org/legacy
/src/api/public.ts
build/                @org/build
`)
const owners = (p: string) => ownerRule(rules, p)?.owners ?? null

describe('FR016 CODEOWNERS ownership follows GitHub: gitignore patterns, last match wins', () => {
  it('parses rules with their lines and owners, ignoring comments', () => {
    expect(rules.map((r) => [r.line, r.pattern, r.owners])).toEqual([
      [2, '*', ['@org/everyone']], [3, '*.md', ['@org/docs']], [4, '/src/api/', ['@org/api', '@alice']],
      [5, 'src/**/legacy/', ['@org/legacy']], [6, '/src/api/public.ts', []], [7, 'build/', ['@org/build']],
    ])
  })

  it('applies the last matching rule, including an explicit unowned line', () => {
    expect(owners('README.md')).toEqual(['@org/docs'])
    expect(owners('src/api/handler.ts')).toEqual(['@org/api', '@alice'])
    expect(owners('src/api/docs/guide.md')).toEqual(['@org/api', '@alice'])
    expect(owners('src/core/deep/legacy/old.ts')).toEqual(['@org/legacy'])
    expect(owners('src/api/public.ts')).toEqual([])
    expect(owners('tools/build/out.js')).toEqual(['@org/build'])
    expect(owners('lib/x.ts')).toEqual(['@org/everyone'])
  })

  it('an anchored directory does not match the same name deeper down, an unanchored one does', () => {
    expect(owners('lib/src/api/x.ts')).toEqual(['@org/everyone'])
    expect(owners('a/build/b.ts')).toEqual(['@org/build'])
  })

  it('uses the first CODEOWNERS file in GitHub order', () => {
    expect(effectiveCodeowners(['docs/CODEOWNERS', 'CODEOWNERS'])).toBe('CODEOWNERS')
    expect(effectiveCodeowners(['CODEOWNERS', '.github/CODEOWNERS'])).toBe('.github/CODEOWNERS')
    expect(effectiveCodeowners(['src/CODEOWNERS'])).toBeUndefined()
  })
})

describe('FR016 a symbol inherits the owners recorded on its file module', () => {
  it('get_relationships with owned_by on a function returns its file module\'s team and says where the fact lives', async () => {
    const { fixtureRepo, indexedDataDir, symbolId, tool } = await import('./helpers.js')
    const { dataDir } = await indexedDataDir(fixtureRepo('ownership'))
    const env = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'src/api/b:b'), types: ['owned_by'] })
    expect((env.data.relationships as any[]).map((r) => [r.direction, r.type, r.other.name])).toEqual([['out', 'owned_by', '@acme/api']])
    expect(env.data.totals).toEqual({ in: 0, out: 1 })
    expect(env.limitations).toContain('Ownership is recorded on the file module; the owned_by rows are the owners of this symbol\'s file.')
  })
})

describe('FR016 the core reads the effective CODEOWNERS into team symbols and owned_by facts', () => {
  it('owns each file module by the last matching line of .github/CODEOWNERS, and ignores the root file', async () => {
    const { fixtureRepo, indexedDataDir, withSnapshot } = await import('./helpers.js')
    const { dataDir } = await indexedDataDir(fixtureRepo('ownership'))
    withSnapshot(dataDir, (db) => {
      expect(db.prepare("select name, start_line from symbol where kind = 'team' order by name").all()).toEqual([{ name: '@acme/all', start_line: 2 }, { name: '@acme/api', start_line: 3 }])
      expect(db.prepare(`select m.qualified_name as owned, t.name as team, a.origin, e.start_line as line, f.path as evidence_file from assertion a
        join symbol m on m.id = a.source_id join symbol t on t.id = a.target_id join assertion_evidence ae on ae.assertion_id = a.id
        join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where a.type = 'owned_by' order by owned`).all()).toEqual([
        { owned: 'src/a', team: '@acme/all', origin: 'configuration_adapter', line: 2, evidence_file: '.github/CODEOWNERS' },
        { owned: 'src/api/b', team: '@acme/api', origin: 'configuration_adapter', line: 3, evidence_file: '.github/CODEOWNERS' },
      ])
      expect(db.prepare("select path, disposition from file where path like '%CODEOWNERS' order by path").all()).toEqual([{ path: '.github/CODEOWNERS', disposition: 'indexed' }, { path: 'CODEOWNERS', disposition: 'indexed' }])
    })
  })
})
