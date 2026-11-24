import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectedFor, fixtureRepo, indexedDataDir, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('cs-pulumi')

describe('A8 A25 Pulumi rules in C#: the resource graph a .NET program constructs, named as the TypeScript rule names it', () => {
  it('A8 each resource is a symbol named by its type and name, related to the resources whose outputs it reads and those its DependsOn option names', async () => {
    const { dataDir: d } = await indexedDataDir(fixtureRepo('cs-pulumi'))
    expect(withSnapshot(d, (db) => db.prepare(`select qualified_name, name, signature, start_line, end_line from symbol where kind = 'resource' order by qualified_name`).all())).toEqual(EXPECTED.resources)
    const facts = withSnapshot(d, (db) => db.prepare(`
      select a.type, s.qualified_name as src, t.qualified_name as dst, ev.start_line as line, ev.start_byte as start, ev.end_byte as end, f.path
      from assertion a join symbol s on s.id = a.source_id join symbol t on t.id = a.target_id
      join assertion_evidence ae on ae.assertion_id = a.id join evidence ev on ev.id = ae.evidence_id join file f on f.id = ev.file_id
      where a.origin = 'framework_adapter' and a.type in ('references', 'depends_on') order by f.path, ev.start_byte`).all() as Array<{ type: string; src: string; dst: string; line: number; start: number; end: number; path: string }>)
    const text = fs.readFileSync(path.join(fixtureRepo('cs-pulumi'), 'src/Shop.Infra/Program.cs'), 'utf8')
    expect(facts.map((r) => [r.line, r.type, r.src, r.dst, Buffer.from(text).subarray(r.start, r.end).toString('utf8')])).toEqual(EXPECTED.facts)
    expect(new Set(facts.map((r) => r.path))).toEqual(new Set(['src/Shop.Infra/Program.cs']))
  }, 180000)
})
