import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { CLI, expectedFor, fixtureRepo, ROOT, tmpDir, tool } from './helpers.js'

const EXPECTED = expectedFor('cs-query-source')
const FIXTURE = path.join(ROOT, 'fixtures', 'cs-query-source')
const cli = (dataDir: string, ...args: string[]) => execFileSync(process.execPath, [CLI, '--data-dir', dataDir, ...args], { encoding: 'utf8' })
type Data = { parsed: unknown; candidates: Array<{ kind: string; qualified_name: string; score: number; evidence: unknown }>; considered: number; notes: Array<{ id: string }> }

describe('A33 find_query_source and notes that map SQL text to the helper that writes it (fixtures/cs-query-source)', () => {
  let dataDir: string
  beforeAll(async () => {
    dataDir = tmpDir()
    initDataDir(dataDir)
    const catalog = Catalog.open(dataDir)
    const repoId = catalog.addRepository(fixtureRepo('cs-query-source')).id
    catalog.close()
    cli(dataDir, 'repo', 'conventions', repoId, path.join(FIXTURE, 'conventions.json'))
    await indexRepository(dataDir, repoId)
    cli(dataDir, 'notes', 'add', path.join(FIXTURE, 'notes'))
    cli(dataDir, 'notes', 'sync')
    cli(dataDir, 'notes', 'accept', 'sql-tag-clause')
  })

  it('ranks the endpoints reaching the statement\'s tables by owner, columns and helper evidence', () => {
    const r = tool(dataDir, 'find_query_source', { sql: EXPECTED.sql })
    const data = r.data as Data
    expect(data.parsed).toEqual(EXPECTED.parsed)
    expect(data.candidates.map(({ kind, qualified_name, score, evidence }) => ({ kind, qualified_name, score, evidence }))).toEqual(EXPECTED.candidates)
    expect(data.considered).toBe(EXPECTED.candidates.length)
    expect(data.notes.map((n) => n.id)).toEqual(['sql-tag-clause'])
  })

  it('search_sources names the accepted note whose pattern the searched text matches', () => {
    const r = tool(dataDir, 'search_sources', { text: EXPECTED.search.text })
    expect(((r.data as { notes?: Array<{ id: string }> }).notes ?? []).map((n) => n.id)).toEqual(EXPECTED.search.notes)
    expect(r.limitations.join(' ')).toMatch(/Note sql-tag-clause says method:Shop.Data.Trellis.Twine writes text like this/)
  })
})
