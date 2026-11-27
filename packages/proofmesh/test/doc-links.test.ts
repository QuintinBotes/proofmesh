// Docs link to the code they name, and say when it changes (#29): fixtures/doc-links, FR820 to FR826.
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { treeFreshness } from '../src/query/tools.js'
import { cli, ROOT, symbolId, tmpDir, tool, withSnapshot } from './helpers.js'

const FIXTURE = path.join(ROOT, 'fixtures', 'doc-links')
type Expected = { path: string; line: number; text: string; target: string }
const EXPECTED = (JSON.parse(fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8')) as { mentions: Expected[] }).mentions

let d: string, repo: string
const index = () => { const r = cli(['--data-dir', d, 'index', repo]); expect(r.status, r.stderr).toBe(0); return r.stdout }

beforeAll(() => {
  repo = fs.realpathSync(tmpDir('pm-doc-links-'))
  fs.cpSync(path.join(FIXTURE, 'repo'), repo, { recursive: true })
  d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo]]) { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0) }
  index()
}, 180000)

type Rel = { type: string; direction: string; resolution: string; origin: string; basis?: string; site: { path: string; start_line: number } }
const mentionsOf = (input: Record<string, unknown>) =>
  (tool(d, 'get_relationships', { ...input, direction: 'in', types: ['mentions'] }).data.relationships as Rel[]).map((r) => [`${r.site.path}:${r.site.start_line}`, r.type, r.resolution, r.origin, r.basis])

/** Every mention the snapshot holds, as the fixture's table writes them. */
const recorded = (): Expected[] => withSnapshot(d, (db) => (db.prepare(`select f.path, e.start_line as line, json_extract(a.detail, '$.text') as text, a.resolution, a.target_kind, coalesce(ts.qualified_name, tf.path) as target,
    (select group_concat(n, ',') from (select s.qualified_name as n from assertion_candidate c join symbol s on s.id = c.symbol_id where c.assertion_id = a.id order by s.qualified_name)) as candidates
  from assertion a join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id
  left join symbol ts on a.target_kind = 'symbol' and ts.id = a.target_id left join file tf on a.target_kind = 'file' and tf.id = a.target_id
  where a.type = 'mentions' order by f.path, e.start_byte`).all() as Array<{ path: string; line: number; text: string; resolution: string; target_kind: string | null; target: string | null; candidates: string | null }>)
  .map((m) => ({ path: m.path, line: m.line, text: m.text, target: m.resolution === 'ambiguous' ? `ambiguous:${m.candidates}` : `${m.target_kind}:${m.target}` })))

describe('FR820 FR821 scenario 1: a doc names a symbol or a file, as an inferred mentions relationship', () => {
  it('get_relationships on Ledger.consume, inbound mentions, returns docs/design.md:5 and README.md:3, each inferred', () => {
    expect(mentionsOf({ subject_id: symbolId(d, 'src/ledger:Ledger.consume') }).sort()).toEqual([
      ['README.md:3', 'mentions', 'resolved', 'documentation', 'inferred'],
      ['docs/design.md:5', 'mentions', 'resolved', 'documentation', 'inferred'],
    ])
  })

  it('get_relationships on src/ledger.ts, inbound mentions, returns docs/design.md:7', () => {
    expect(mentionsOf({ path: 'src/ledger.ts' })).toEqual([['docs/design.md:7', 'mentions', 'resolved', 'documentation', 'inferred']])
  })
})

describe('FR822 FR825 scenario 2: every backticked name and link in the docs resolves as the fixture table says', () => {
  it('at least 95% resolve to the right symbol or file, none to a wrong one, and a name of several symbols is ambiguous with its candidates', () => {
    const got = recorded()
    const key = (m: { path: string; line: number; text: string }) => `${m.path}:${m.line} ${m.text}`
    const actual = new Map(got.map((m) => [key(m), m.target]))
    const right = EXPECTED.filter((e) => (actual.get(key(e)) ?? 'none') === e.target)
    // Wrong: a recorded mention whose target differs from the table's, or one the table says names nothing; a missed one only lowers the share.
    const wrong = got.filter((m) => { const e = EXPECTED.find((x) => key(x) === key(m)); return !e || e.target !== m.target })
    expect(wrong).toEqual([])
    expect(right.length / EXPECTED.length).toBeGreaterThanOrEqual(0.95)
    expect(actual.get('docs/guide.md:7 total()')).toBe('ambiguous:src/ledger:Ledger.total,src/wallet:Wallet.total')
  })

  it('FR822 nothing inside a fenced code block is a mention, and common words in backticks are not recorded', () => {
    const got = recorded()
    expect(got.filter((m) => m.path === 'docs/guide.md' && m.line >= 13 && m.line <= 16)).toEqual([])
    for (const word of ['true', 'null', 'id', '--verbose', 'npm install', 'Ledger.missing']) expect(got.find((m) => m.text === word), word).toBeUndefined()
  })
})

describe('FR823 FR824 scenarios 3 and 4: a rename and a delete make the doc mentions stale', () => {
  const stale = () => (tool(d, 'find_stale_mentions', {}).data.mentions as Array<{ path: string; line: number; mention: string; change: string; to: { name: string } | null }>)
    .map((m) => `${m.path}:${m.line} ${m.mention} ${m.change}${m.to ? `→${m.to.name}` : ''}`)

  it('a snapshot with nothing changed reports no stale mention', () => {
    expect(stale()).toEqual([])
    expect((tool(d, 'workspace_status', {}).data.doc_mentions as { stale: number }).stale).toBe(0)
  })

  it('FR823 find_stale_mentions after the overlay returns the renamed and the deleted mentions, renames paired', () => {
    fs.cpSync(path.join(FIXTURE, 'overlay'), repo, { recursive: true })
    index()
    expect(stale().sort()).toEqual([
      'README.md:3 Ledger.consume renamed→Ledger.spend',
      'docs/design.md:5 Ledger.consume renamed→Ledger.spend',
      'docs/design.md:9 Ledger.refund deleted',
    ])
    expect(tool(d, 'find_stale_mentions', { path_prefix: 'docs/' }).data.mentions).toHaveLength(2)
  })

  it('FR824 workspace_status reports 3 stale doc mentions', () => {
    const env = tool(d, 'workspace_status', {})
    expect((env.data.doc_mentions as { stale: number }).stale).toBe(3)
    expect(env.limitations.join('\n')).toContain('3 doc mentions name code that was renamed, moved or deleted')
  })

  it('FR826 a doc-only edit indexes again, and a stale mention keeps its change at its new line', () => {
    expect(withSnapshot(d, (db) => treeFreshness(db, d, repo))).toEqual({ current: true, changed: [] })
    fs.writeFileSync(path.join(repo, 'README.md'), `<!-- intro -->\n${fs.readFileSync(path.join(repo, 'README.md'), 'utf8')}`)
    // Strict freshness names the doc alone as changed, not every doc.
    expect(withSnapshot(d, (db) => treeFreshness(db, d, repo))).toEqual({ current: false, changed: [{ path: 'README.md', change: 'modified' }] })
    expect(index()).toMatch(/published/)
    expect(withSnapshot(d, (db) => treeFreshness(db, d, repo)).current).toBe(true)
    expect(stale()).toContain('README.md:4 Ledger.consume renamed→Ledger.spend')
    expect(stale()).toHaveLength(3)
  })
})

describe('FR823 a moved doc, a failed file and an accepted note, each on their own repository', () => {
  let d2: string, repo2: string
  const index2 = () => { const r = cli(['--data-dir', d2, 'index', repo2]); expect(r.status, r.stderr).toBe(0) }
  const stale2 = () => (tool(d2, 'find_stale_mentions', {}).data.mentions as Array<{ path: string; line: number; mention: string; change: string; to: { name: string } | null }>)
    .map((m) => `${m.path}:${m.line} ${m.mention} ${m.change}${m.to ? `→${m.to.name}` : ''}`)
  const note = () => (tool(d2, 'get_memory', { symbol_id: symbolId(d2, 'src/wallet:Wallet.open') }).data as { notes: Array<{ id: string; staleness: string }> }).notes.map((n) => [n.id, n.staleness])

  beforeAll(() => {
    repo2 = fs.realpathSync(tmpDir('pm-doc-links-2-'))
    fs.cpSync(path.join(FIXTURE, 'repo'), repo2, { recursive: true })
    d2 = tmpDir()
    const notes = tmpDir('pm-doc-notes-')
    fs.writeFileSync(path.join(notes, 'open.md'), '---\nid: wallet-open\ntitle: "Wallet.open makes a wallet"\nkind: invariant\nnodes:\n  - method:src/wallet:Wallet.open\n---\n\nA wallet is only made through Wallet.open.\n')
    for (const args of [['init'], ['repo', 'add', repo2], ['index', repo2], ['notes', 'add', notes], ['notes', 'sync'], ['notes', 'accept', 'wallet-open']]) { const r = cli(['--data-dir', d2, ...args]); expect(r.status, r.stderr).toBe(0) }
  }, 180000)

  it('a doc moved unchanged is moved to its new path, and a note on code a doc names stays current across snapshots', () => {
    expect(note()).toEqual([['wallet-open', 'current']])
    fs.mkdirSync(path.join(repo2, 'docs', 'arch'))
    fs.renameSync(path.join(repo2, 'docs', 'design.md'), path.join(repo2, 'docs', 'arch', 'design.md'))
    index2()
    expect(stale2()).toEqual(['README.md:5 docs/design.md moved→docs/arch/design.md'])
    expect(note()).toEqual([['wallet-open', 'current']])
  }, 120000)

  it('the symbols of a file that failed this time are not reported deleted', () => {
    fs.appendFileSync(path.join(repo2, 'src', 'wallet.ts'), Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0a]))
    index2()
    expect(withSnapshot(d2, (db) => db.prepare("select disposition_detail from file where path = 'src/wallet.ts'").get())).toEqual({ disposition_detail: 'not_utf8' })
    expect(stale2()).toEqual(['README.md:5 docs/design.md moved→docs/arch/design.md'])
  }, 120000)
})
