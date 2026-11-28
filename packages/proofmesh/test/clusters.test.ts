import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { fileClusters } from '../src/query/clusters.js'
import type { FindClustersData, GetOverviewData } from '../src/core/generated.js'
import { ROOT, indexedDataDir, tmpDir, tool, withSnapshot } from './helpers.js'

describe('FR2220 FR2221 FR2222 FR2223 FR2224 FR2225 FR2226 file communities', () => {
  const repo = tmpDir('pm-planted-')
  let dataDir: string
  const query = (input = {}, dir = dataDir) => tool(dir, 'find_clusters', input).data as unknown as FindClustersData
  beforeAll(async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'fixtures/clusters/build.mjs'), repo])
    ;({ dataDir } = await indexedDataDir(repo))
  }, 120000)

  it('recovers the four complete groups across directories and counts the hub separately', () => {
    const all = query()
    expect(all.clusters.map(c => c.files)).toEqual([8, 8, 8, 8])
    expect(all.shared).toEqual([{ path: 'shared.ts', degree: 32 }])
    expect(all.singletons).toBe(1)
    for (const name of ['amber', 'blue', 'green', 'red']) {
      const answer = query({ path: 'layer0/' + name + '.ts' })
      const c = answer.clusters[0]!
      expect(all.clusters).toContainEqual(c)
      expect(c.symbols).toBe(8)
      expect(c.label).toContain(name)
      expect(c.cohesion).toBe(c.internal_edges / (c.internal_edges + c.external_edges))
      expect(answer.members.map(m => m.path).sort()).toEqual(['layer0', 'layer1', 'layer2', 'layer3', 'layer4', 'layer5', 'layer6', 'tests'].map(dir => dir + '/' + name + '.ts'))
      expect(answer.members.map(m => m.internal_degree)).toEqual(answer.members.map(m => m.internal_degree).sort((a, b) => b - a))
      expect(answer.boundaries.map(b => b.target)).toContain('shared')
      expect(answer.boundaries.length).toBeGreaterThan(1)
      expect(answer.boundaries.reduce((n, b) => n + b.edges, 0)).toBe(c.external_edges)
    }
    expect(query({ include_singletons: true }).clusters).toHaveLength(5)
    expect(query({ path: 'alone.ts' }).members).toHaveLength(1)
    expect(query({ path: 'shared.ts' }).clusters).toEqual([])
    expect(query({ path: 'tests/blue.ts', include_tests: false }).members).toEqual([])
    const key = withSnapshot(dataDir, db => db.prepare("select stable_key from symbol where name='blue0' and kind='function'").pluck().get())
    expect(query({ key })).toEqual(query({ path: 'layer0/blue.ts' }))
    const page = tool(dataDir, 'find_clusters', { limits: { max_rows: 1 } })
    expect(query({ cursor: page.completion.next_cursor, limits: { max_rows: 1 } }).clusters).toEqual(all.clusters.slice(1, 2))
  })

  it('annotates mixed directories, files and symbols on request', () => {
    const overview = (path: string) => (tool(dataDir, 'get_overview', { path, include_clusters: true }).data as unknown as GetOverviewData).children
    expect(overview('').find(row => row.key === 'layer0')!.clusters).toHaveLength(4)
    const dir = overview('layer0')
    expect(new Set(dir.flatMap(row => row.clusters!.map(c => c.id))).size).toBe(4)
    expect(overview('layer0/red.ts')[0]!.clusters).toEqual(dir.find(row => row.name === 'red.ts')!.clusters)
  })

  it('returns identical membership after independent indexing and stable IDs after adding a file', async () => {
    const other = tmpDir('pm-planted-copy-')
    fs.cpSync(repo, other, { recursive: true })
    const copy = await indexedDataDir(other)
    expect(JSON.stringify(query({}, copy.dataDir))).toBe(JSON.stringify(query()))
    for (const c of query().clusters) {
      expect(query({ path: c.representative }, copy.dataDir)).toEqual(query({ path: c.representative }))
    }
    fs.writeFileSync(path.join(other, 'new.ts'), "import { red0 } from './layer0/red'\nexport function another() { return red0() }\n")
    const updated = await indexedDataDir(other)
    for (const name of ['amber', 'blue', 'green']) {
      const input = { path: 'layer0/' + name + '.ts' }
      expect(query(input, updated.dataDir).clusters[0]!.id).toBe(query(input).clusters[0]!.id)
    }
  }, 180000)

  it('counts inferred candidates and resolved inferred assertions only in the default graph', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`create table file(id,path,disposition); create table symbol(id,file_id,kind,qualified_name,stable_key);
        create table assertion(id,type,source_id,target_id,resolution,detail,origin); create table assertion_candidate(assertion_id,symbol_id);
        insert into file values ('a','a.ts','indexed'),('b','b.ts','indexed');
        insert into symbol values ('s','b','function','beta','beta');
        insert into assertion values ('1','inherits','a','s','resolved',null,'syntax'),('2','implements','a','s','resolved',null,'contract_match'),
        ('3','references','a',null,'ambiguous',null,'syntax'),('4','contains','a','s','resolved',null,'syntax');
        insert into assertion_candidate values ('3','s')`)
      const all = fileClusters(db, 'small')
      expect(all.tiny).toBe(true)
      expect(all.clusters[0]).toMatchObject({ files: 2, symbols: 1, internal_edges: 3, external_edges: 0, cohesion: 1 })
      expect(fileClusters(db, 'small', { observed_only: true }).clusters[0]!.internal_edges).toBe(1)
      expect(fileClusters(db, 'small')).toBe(all)
    } finally { db.close() }
  })
})
