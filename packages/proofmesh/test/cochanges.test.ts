import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { cli, indexedDataDir, ROOT, tmpDir, tool } from './helpers.js'
// @ts-expect-error a plain ES module of the fixture, with no types
import { build, COMMITS, FILES, PAIRS } from '../../../fixtures/history/build.mjs'

type Partner = { path: string; shared: number; subject_commits: number; partner_commits: number; degree: number; linked: boolean; relationship_types: string[]; test: boolean }
type Answer = { subjects: Array<{ path: string; commits: number; partners: Partner[] }>; history: { available: boolean; commit: string | null; commits_read: number; bulk_commits: number; shallow: boolean }; thresholds: { min_shared: number; min_degree: number; max_files_per_commit: number } }
type Pair = { a: string; b: string; shared: number; a_commits: number; b_commits: number; degree: number; linked: boolean }

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
const cochanges = (d: string, input: Record<string, unknown>) => tool(d, 'get_cochanges', input)
const partners = (d: string, input: Record<string, unknown>) => (cochanges(d, input).data as Answer).subjects[0]!.partners

describe('FR2020 FR2021 FR2022 FR2024 FR2025 get_cochanges: files that change together, from git history (fixtures/history)', () => {
  let d: string, repo: string
  beforeAll(async () => {
    repo = tmpDir('pm-history-')
    build(repo)
    d = (await indexedDataDir(repo)).dataDir
  }, 180000)

  it('scenario 1: model.ts\'s first partner is schema.sql, shared 8 with degree 0.8 and not linked', () => {
    const [first] = partners(d, { paths: ['src/model.ts'] })
    expect(first).toEqual({ path: 'db/schema.sql', shared: 8, subject_commits: 10, partner_commits: 10, degree: 0.8, linked: false, relationship_types: [], test: false })
  })

  it('SC-001: every declared pair is listed with its counts, both ways, and no other pair is', () => {
    const env = cochanges(d, { paths: FILES })
    const listed = (env.data as Answer).subjects.flatMap((s) => s.partners.map((p) => `${s.path} ${p.path} shared=${p.shared} ${p.subject_commits}/${p.partner_commits} degree=${p.degree} linked=${p.linked}`)).sort()
    const declared = (PAIRS as Pair[]).flatMap((p) => [
      `${p.a} ${p.b} shared=${p.shared} ${p.a_commits}/${p.b_commits} degree=${p.degree} linked=${p.linked}`,
      `${p.b} ${p.a} shared=${p.shared} ${p.b_commits}/${p.a_commits} degree=${p.degree} linked=${p.linked}`,
    ]).sort()
    expect(listed).toEqual(declared)
    // Partners are ordered by degree, then shared, then path.
    expect((env.data as Answer).subjects.find((s) => s.path === 'src/model.ts')!.partners.map((p) => p.path)).toEqual(['db/schema.sql', 'src/types.ts', 'test/model.test.ts'])
    expect((env.data as Answer).history).toMatchObject({ available: true, commits_read: COMMITS.length, bulk_commits: 0, shallow: false })
  })

  it('scenario 2: a partner a relationship joins says linked with its type, either direction; only_unlinked leaves it out', () => {
    const all = partners(d, { paths: ['src/model.ts'] })
    expect(all.find((p) => p.path === 'src/types.ts')).toMatchObject({ linked: true, relationship_types: expect.arrayContaining(['imports']) })
    // The test imports model.ts: the link runs the other way, and the row says it is test code.
    expect(all.find((p) => p.path === 'test/model.test.ts')).toMatchObject({ linked: true, test: true })
    expect(partners(d, { paths: ['src/model.ts'], only_unlinked: true }).map((p) => p.path)).toEqual(['db/schema.sql'])
    // A row never carries a basis: co-change is not a relationship (FR2022).
    expect(all.every((p) => !('basis' in p))).toBe(true)
  })

  it('a symbol subject is its file; renames are followed; lean rows are <path> shared=<n> degree=<d> [linked]', () => {
    const id = (tool(d, 'find_symbols', { text: 'send' }).data as { symbols: Array<{ id: string; name: string }> }).symbols.find((s) => s.name === 'send')!.id
    // serializer.ts counts the two commits it made as legacy.ts.
    expect(partners(d, { subject_ids: [id] })).toEqual([{ path: 'src/serializer.ts', shared: 4, subject_commits: 4, partner_commits: 5, degree: 1, linked: false, relationship_types: [], test: false }])
    const lean = (tool(d, 'get_cochanges', { paths: ['src/model.ts'], envelope: 'lean' }) as { text?: string }).text!
    expect(lean.split('\n').filter((l) => !l.startsWith('#'))).toEqual(['db/schema.sql shared=8 degree=0.8', 'src/types.ts shared=4 degree=0.67 linked', 'test/model.test.ts shared=3 degree=0.6 linked test'])
  })

  it('scenario 4: a pair of two shared commits is under min_shared; the answer states the thresholds; lower thresholds list it', () => {
    const env = cochanges(d, { paths: ['src/model.ts'] })
    expect((env.data as Answer).subjects[0]!.partners.some((p) => p.path === 'src/util.ts')).toBe(false)
    expect((env.data as Answer).thresholds).toEqual({ min_shared: 3, min_degree: 0.3, max_files_per_commit: 50 })
    expect(env.limitations.join('\n')).toMatch(/min_shared 3, min_degree 0\.3/)
    expect(partners(d, { paths: ['src/model.ts'], min_shared: 2 }).find((p) => p.path === 'src/util.ts')).toMatchObject({ shared: 2, degree: 1 })
    expect(partners(d, { paths: ['src/model.ts'], min_degree: 0.7 }).map((p) => p.path)).toEqual(['db/schema.sql'])
  })

  it('a commit touching more than max_files_per_commit files forms no pairs and is counted; window bounds the commits read', () => {
    const env = cochanges(d, { paths: ['src/model.ts'], max_files_per_commit: 2 })
    const bulk = (COMMITS as Array<{ files?: string[] }>).filter((c) => (c.files?.length ?? 1) > 2).length
    expect((env.data as Answer).history.bulk_commits).toBe(bulk)
    expect(env.limitations.join('\n')).toContain(`${bulk} commits touching more than 2 files formed no pairs`)
    expect((env.data as Answer).subjects[0]!.partners).toEqual([expect.objectContaining({ path: 'db/schema.sql', shared: 3, subject_commits: 3, partner_commits: 5, degree: 1 })])
    const last = cochanges(d, { paths: ['src/client.ts'], window: { commits: 3 } })
    expect((last.data as Answer).history.commits_read).toBe(3)
    expect((last.data as Answer).subjects[0]!.commits).toBe(2)
    // The fixture's commits are a day apart, the last on 2026-01-21: five days back from it reach commit 16.
    expect((cochanges(d, { paths: ['src/model.ts'], window: { days: 5 } }).data as Answer).history.commits_read).toBe(6)
  })

  it('determinism: the window ends at the snapshot\'s commit, so a commit made after it changes nothing', () => {
    const before = cochanges(d, { paths: FILES }).data
    fs.writeFileSync(path.join(repo, 'src/model.ts'), '// later\n')
    fs.writeFileSync(path.join(repo, 'db/schema.sql'), '-- later\n')
    git(repo, 'commit', '-qam', 'after the snapshot')
    expect(cochanges(d, { paths: FILES }).data).toEqual(before)
  })

  it('a path the snapshot does not hold is refused', () => {
    expect(() => cochanges(d, { paths: ['src/nothing.ts'] })).toThrow(/not found/)
  })

  it('get_cochanges is in the extra profile with capability read', () => {
    const t = (tool(d, 'list_queries').data as { tools: Array<{ name: string; profile: string; capability: string }> }).tools.find((x) => x.name === 'get_cochanges')
    expect(t).toMatchObject({ profile: 'extra', capability: 'read' })
  })
})

describe('FR2020 scenario 5: no usable history answers no rows and says why', () => {
  it('a root that is not a git working tree: no_history', async () => {
    const repo = tmpDir('pm-history-'), copy = tmpDir('pm-nogit-')
    build(repo)
    for (const f of FILES as string[]) { fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true }); fs.copyFileSync(path.join(repo, f), path.join(copy, f)) }
    const d = (await indexedDataDir(copy)).dataDir
    const env = cochanges(d, { paths: ['src/model.ts'] })
    expect((env.data as Answer).subjects[0]!.partners).toEqual([])
    expect((env.data as Answer).history).toMatchObject({ available: false, commits_read: 0 })
    expect(env.limitations.join('\n')).toMatch(/^no_history: /m)
  }, 180000)

  it('a shallow clone of one commit: history_shallow', async () => {
    const repo = tmpDir('pm-history-'), clone = path.join(tmpDir('pm-shallow-'), 'clone')
    build(repo)
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, clone])
    const d = (await indexedDataDir(clone)).dataDir
    const env = cochanges(d, { paths: ['src/model.ts'] })
    expect((env.data as Answer).subjects[0]!.partners).toEqual([])
    expect((env.data as Answer).history).toMatchObject({ available: true, shallow: true, commits_read: 1 })
    expect(env.limitations.join('\n')).toMatch(/^history_shallow: /m)
  }, 180000)
})

describe('FR2023 impact_completeness include_cochanges: partners of changed files the diff leaves unchanged', () => {
  it('scenario 3: a diff changing model.ts and not schema.sql lists schema.sql as not_changed; the other fields are as without the flag', () => {
    const repo = tmpDir('pm-history-'), d = tmpDir()
    const base = build(repo)
    fs.writeFileSync(path.join(repo, 'src/model.ts'), fs.readFileSync(path.join(repo, 'src/model.ts'), 'utf8').replace('return kind', 'return kind ?? \'a\''))
    git(repo, 'commit', '-qam', 'head')
    const head = git(repo, 'rev-parse', 'HEAD')
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
    expect(cli(['--data-dir', d, 'repo', 'add', repo]).status).toBe(0)
    // The CLI indexes both sides and waits.
    expect(cli(['--data-dir', d, 'completeness', repo, `${base}..${head}`]).status).not.toBe(2)
    const without = tool(d, 'impact_completeness', { base, head }), withFlag = tool(d, 'impact_completeness', { base, head, include_cochanges: true })
    const { cochange, ...rest } = withFlag.data as { cochange: Array<Record<string, unknown>> }
    expect('cochange' in without.data).toBe(false)
    expect(rest).toEqual(without.data)
    expect(cochange[0]).toEqual({ path: 'db/schema.sql', of: 'src/model.ts', shared: 8, subject_commits: 10, partner_commits: 10, degree: 0.8, linked: false, relationship_types: [], test: false, status: 'not_changed' })
    expect(cochange.every((c) => c.of === 'src/model.ts' && c.status === 'not_changed')).toBe(true)
    const lean = (tool(d, 'impact_completeness', { base, head, include_cochanges: true, envelope: 'lean' }) as { text?: string }).text!
    expect(lean).toContain('cochange db/schema.sql shared=8 degree=0.8 not_changed (with src/model.ts)')
    expect((tool(d, 'impact_completeness', { base, head, envelope: 'lean' }) as { text?: string }).text!).not.toContain('cochange')
  }, 240000)
})

describe('FR2026 traceability', () => {
  it('FR2020 to FR2025 each have a spec line and a traceability entry naming this test', () => {
    const spec = fs.readFileSync(path.join(ROOT, 'specs', '001-proofmesh-foundation', 'spec.md'), 'utf8')
    const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'policy', 'traceability.json'), 'utf8')).items as Record<string, string[]>
    for (let n = 2020; n <= 2026; n++) {
      expect(spec, `FR${n}`).toMatch(new RegExp(`^- FR${n}: MUST `, 'm'))
      expect(items[`FR${n}`], `FR${n}`).toContain('packages/proofmesh/test/cochanges.test.ts')
    }
  })
})

describe('fixtures/history', () => {
  it('the fixture builds the same commits every time', () => {
    const a = tmpDir('pm-history-'), b = tmpDir('pm-history-')
    expect(build(a)).toBe(build(b))
    expect(fs.existsSync(path.join(ROOT, 'fixtures', 'history', 'PROVENANCE.md'))).toBe(true)
  })
})
