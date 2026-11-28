import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Ajv } from 'ajv'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Changed } from '../src/query/completeness.js'
import { githubCommands, markdownReport, type Report, sarifReport } from '../src/query/completeness-report.js'
import { cli, ROOT, tmpDir, tool } from './helpers.js'

const FIXTURE = path.join(ROOT, 'fixtures', 'change-reach')
const EXPECTED = path.join(FIXTURE, 'expected')
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim()
const commit = (repo: string, m: string) => { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', m); return git(repo, 'rev-parse', 'HEAD') }

/** fixtures/change-reach as a git repository on branch main: base committed, then `extra` files written on top of `overlay` and committed. */
function repository(overlay: string, extra: Record<string, string> = {}): { repo: string; base: string; head: string } {
  const repo = tmpDir('pm-report-')
  fs.cpSync(path.join(FIXTURE, 'base'), repo, { recursive: true })
  fs.copyFileSync(path.join(FIXTURE, 'tsconfig.json'), path.join(repo, 'tsconfig.json'))
  git(repo, 'init', '-q', '-b', 'main')
  const base = commit(repo, 'base')
  fs.cpSync(path.join(FIXTURE, overlay), repo, { recursive: true })
  for (const [f, text] of Object.entries(extra)) fs.writeFileSync(path.join(repo, f), text)
  return { repo, base, head: commit(repo, 'head') }
}
function registered(r: { repo: string }): string {
  const d = tmpDir()
  expect(cli(['--data-dir', d, 'init']).status).toBe(0)
  expect(cli(['--data-dir', d, 'repo', 'add', r.repo]).status).toBe(0)
  return d
}
const repoId = (d: string, root: string) => (tool(d, 'list_repositories').data as { repositories: Array<{ id: string; root: string }> }).repositories.find((x) => x.root === fs.realpathSync(root))!.id

/** Commits and snapshot ids differ from run to run; the stored files name them by placeholder. */
function normalise(text: string, sides: Report['base'][]): string {
  for (const [name, s] of [['base', sides[0]!], ['head', sides[1]!]] as const) {
    text = text.split(s.commit!).join(`<${name}-commit>`).split(s.commit!.slice(0, 12)).join(`<${name}-commit>`).split(s.snapshot_id!).join(`<${name}-snapshot>`)
  }
  return text
}
const expected = (name: string) => fs.readFileSync(path.join(EXPECTED, name), 'utf8')

// The pinned test package carries the OASIS Errata 01 schema with draft-07 schema identifiers.
const schemaFile = new URL('../schemas/sarif-schema-2.1.0.json', import.meta.resolve('github-sarif-validator-jest'))
const sarifSchema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'))
const validSarif = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(sarifSchema)

/** A preload that records every TCP connection a process (and its children, which inherit NODE_OPTIONS) opens. */
function netRecorder(): { env: Record<string, string>; log: string } {
  const dir = tmpDir('pm-net-'), log = path.join(dir, 'connections.log'), preload = path.join(dir, 'record.cjs')
  fs.writeFileSync(log, '')
  fs.writeFileSync(preload, `const net = require('node:net'), fs = require('node:fs'), connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (!(typeof o === 'string' || (o && typeof o === 'object' && o.path))) fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ host: o && o.host, port: o && o.port ? o.port : o }) + '\\n')
  return connect.apply(this, args)
}
`)
  return { env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${preload}`.trim() }, log }
}

describe('FR2140 FR2141 FR2142 FR2145 proofmesh completeness --format markdown|sarif|github: the pull request report (fixtures/change-reach)', () => {
  let d: string, r: ReturnType<typeof repository>, sides: Report['base'][], first: ReturnType<typeof cli>, net: ReturnType<typeof netRecorder>
  const run = (...args: string[]) => cli(['--data-dir', d, 'completeness', r.repo, `${r.base}..${r.head}`, ...args], net.env)
  beforeAll(() => {
    r = repository('head')
    d = registered(r)
    net = netRecorder()
    // The first run indexes both sides; every later one answers from their snapshots.
    first = run('--format', 'markdown')
    const data = tool(d, 'impact_completeness', { repository_id: repoId(d, r.repo), base: r.base, head: r.head }).data as Report
    sides = [data.base, data.head]
  }, 240000)

  it('story 1 scenario 1: the Markdown report has the verdict, the neither table, the tested and changed sections, both sides, and its marker; the same snapshots give the same report', () => {
    const md = run('--format', 'markdown')
    expect(md.status, md.stderr).toBe(1)
    expect(normalise(md.stdout, sides)).toBe(expected('report.md'))
    expect(md.stdout.split('\n')[0]).toBe('<!-- proofmesh:impact-completeness -->')
    expect(md.stdout).toContain('**2 dependents are neither changed nor tested.**')
    expect(run('--format', 'markdown').stdout).toBe(md.stdout)
  }, 120000)

  it('story 1 scenario 5: a side with no snapshot is indexed first, and the report states how long each index took', () => {
    expect(first.status, first.stderr).toBe(1)
    expect(first.stdout).toMatch(new RegExp(`^Indexed head \`${r.head.slice(0, 12)}\` in \\d+\\.\\d s, base \`${r.base.slice(0, 12)}\` in \\d+\\.\\d s\\.$`, 'm'))
    // Apart from that line, the report is the one the stored snapshots give.
    expect(normalise(first.stdout.replace(/\nIndexed .*\n/, ''), sides)).toBe(expected('report.md'))
  })

  it('story 1 scenario 2: SARIF 2.1.0, valid against its schema, one warning per neither dependent at its site under proofmesh/untested-dependent', () => {
    const out = run('--format', 'sarif')
    expect(out.status, out.stderr).toBe(1)
    const sarif = JSON.parse(out.stdout)
    expect(validSarif(sarif), JSON.stringify(validSarif.errors)).toBe(true)
    expect(normalise(out.stdout, sides)).toBe(expected('report.sarif'))
    expect(sarif.runs[0].results.map((x: { ruleId: string; level: string; locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }> }) => `${x.ruleId} ${x.level} ${x.locations[0]!.physicalLocation.artifactLocation.uri}:${x.locations[0]!.physicalLocation.region.startLine}`))
      .toEqual(['proofmesh/untested-dependent warning src/roles/auditor.ts:3', 'proofmesh/untested-dependent warning src/index.ts:1'])
  }, 120000)

  it('story 1 scenario 3: --format github prints a ::warning per neither dependent and appends the Markdown report to $GITHUB_STEP_SUMMARY', () => {
    const summary = path.join(tmpDir(), 'summary.md')
    fs.writeFileSync(summary, 'an earlier step\n')
    const out = cli(['--data-dir', d, 'completeness', r.repo, `${r.base}..${r.head}`, '--format', 'github'], { ...net.env, GITHUB_STEP_SUMMARY: summary })
    expect(out.status, out.stderr).toBe(1)
    expect(normalise(out.stdout, sides)).toBe(expected('report.github.txt'))
    expect(fs.readFileSync(summary, 'utf8')).toBe(`an earlier step\n${run('--format', 'markdown').stdout}`)
  }, 120000)

  it('story 1 scenario 4: past --max-bytes, rows are cut from the changed symbols first, each cut table counting what it left out', () => {
    const full = run('--format', 'markdown').stdout
    const out = run('--format', 'markdown', '--max-bytes', String(Buffer.byteLength(full) - 1))
    expect(Buffer.byteLength(out.stdout)).toBeLessThan(Buffer.byteLength(full))
    expect(out.stdout).toContain('_1 more row not shown: the report is cut to')
    // The neither rows and the tested row stay; one changed-symbol row is left out.
    expect(out.stdout).toContain('| `auditorScore` |')
    expect(out.stdout).toContain('| `analystScore` |')
    expect(out.stdout.match(/^\| `(managerScore|mean)` \| `src\/(roles\/manager|stats)\.ts:\d` \| modified/gm)).toHaveLength(1)
    expect(run('--format', 'markdown', '--max-bytes', '0').status).toBe(2)
    expect(run('--format', 'html').status).toBe(2)
  }, 120000)

  it('FR2145: no run of these commands opened a network connection, the index runs included', () => {
    expect(first.stdout).toContain('Indexed head')
    expect(fs.readFileSync(net.log, 'utf8')).toBe('')
  })
})

describe('FR2141 FR2142 deleted symbols and inferred rows in every format', () => {
  it('a deleted symbol is listed with its former dependents (fixtures/change-reach head-delete)', () => {
    const r = repository('head-delete'), d = registered(r)
    const out = cli(['--data-dir', d, 'completeness', r.repo, `${r.base}..${r.head}`, '--format', 'markdown'])
    expect(out.status, out.stderr).toBe(1)
    expect(out.stdout).toContain('| `range` | `src/range.ts:3` | calls | observed | `spread` deleted |')
    expect(out.stdout).toContain('| `spread` | `src/stats.ts:4` | deleted | none |')
  }, 240000)

  it('an inferred dependent is labelled: basis inferred in Markdown, level note in SARIF, ::notice in GitHub commands', () => {
    const dep = { id: 'sym_b', name: 'caller|x', path: 'src/b.ts', line: 7, relation: 'calls', via: null, basis: 'inferred' as const, status: 'neither' as const, test: null }
    const report: Report = {
      base: { commit: 'a'.repeat(40), snapshot_id: 'snap_a' }, head: { commit: null, snapshot_id: 'snap_b' },
      changed: [{ id: 'sym_a', key: 'k', name: 'target', path: 'src/a.ts', line: 1, change: 'modified', status: 'neither', test: null, dependents: [dep] } as Changed],
      totals: { changed_symbols: 1, dependents: 1, changed: 0, tested: 0, neither: 1 },
    }
    const md = markdownReport(report, [])
    expect(md).toContain('**1 dependent is neither changed nor tested.**')
    expect(md).toContain('| `caller\\|x` | `src/b.ts:7` | calls | inferred | `target` modified |')
    expect(md).toContain('head the working tree (snapshot `snap_b`)')
    const sarif = sarifReport(report) as { runs: Array<{ results: Array<{ level: string; message: { text: string } }> }> }
    expect(validSarif(sarif), JSON.stringify(validSarif.errors)).toBe(true)
    expect(sarif.runs[0]!.results.map((x) => x.level)).toEqual(['note'])
    expect(sarif.runs[0]!.results[0]!.message.text).toContain('Inferred')
    expect(githubCommands(report)[0]).toBe('::notice file=src/b.ts,line=7,title=Untested dependent::caller|x calls target (src/a.ts:1, modified); the change neither updates nor tests it. Inferred: reached through a candidate edge.')
  })
})

describe('FR2143 proofmesh tests --changed: the tests to run for a diff (fixtures/change-reach)', () => {
  let d: string, r: ReturnType<typeof repository>
  beforeAll(() => { r = repository('head'); d = registered(r) }, 60000)

  it('story 2 scenario 1: each test file that reaches a changed symbol or a dependent, once, sorted; the union of find_tests over them', () => {
    const out = cli(['--data-dir', d, 'tests', r.repo, '--changed', `${r.base}..${r.head}`])
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toBe('test/analyst.test.ts\n')
    expect(out.stderr).not.toContain('# incomplete')
    // SC-002: find_tests over each changed symbol and its dependents, in the snapshot of its side.
    const id = repoId(d, r.repo), data = tool(d, 'impact_completeness', { repository_id: id, base: r.base, head: r.head }).data as Report
    const union = new Set(data.changed.flatMap((c) => {
      const snapshot_id = c.change === 'deleted' ? data.base.snapshot_id : data.head.snapshot_id
      const ask = (x: object) => (tool(d, 'find_tests', { repository_id: id, snapshot_id, ...x }).data as { tests: Array<{ path: string }> }).tests.map((t) => t.path)
      return [...ask({ subject_ids: [c.id, ...c.dependents.filter((x) => x.relation !== 'imports').map((x) => x.id)] }), ...c.dependents.filter((x) => x.relation === 'imports').flatMap((x) => ask({ paths: [x.path] }))]
    }))
    expect(out.stdout.trim().split('\n')).toEqual([...union].sort())
  }, 240000)

  it('story 2 scenario 3: --json gives each test the changed symbols it reaches and the evidence kind', () => {
    const out = cli(['--data-dir', d, 'tests', r.repo, '--changed', `${r.base}..${r.head}`, '--json'])
    expect(out.status, out.stderr).toBe(0)
    const j = JSON.parse(out.stdout) as { tests: Array<{ path: string; changed: Array<{ name: string; path: string; line: number; change: string; evidence: string }> }>; incomplete: string[] }
    expect(j.tests).toEqual([{ path: 'test/analyst.test.ts', changed: [{ name: 'mean', path: 'src/stats.ts', line: 1, change: 'modified', evidence: 'call' }] }])
    expect(j.incomplete).toEqual([])
  }, 120000)

  it('story 2 scenario 2: a changed file no adapter analyses, or a language whose calls are not resolved, prints # incomplete on stderr and exits 3', () => {
    const r2 = repository('head', { 'NOTES.txt': 'notes\n', 'tool.rb': 'def helper\n  1\nend\n' }), d2 = registered(r2)
    const out = cli(['--data-dir', d2, 'tests', r2.repo, '--changed', `${r2.base}..${r2.head}`])
    expect(out.status, out.stderr).toBe(3)
    expect(out.stdout).toBe('test/analyst.test.ts\n')
    const reasons = out.stderr.split('\n').filter((l) => l.startsWith('# incomplete: '))
    expect(reasons).toEqual([
      '# incomplete: The diff touches 1 file no snapshot analyses, so their changes are not listed: NOTES.txt.',
      '# incomplete: Calls in Ruby are not resolved yet, so no test is listed as executing code in it; a test that calls it is not found.',
    ])
  }, 240000)

  it('a usage error or an unknown commit exits 2', () => {
    expect(cli(['--data-dir', d, 'tests', r.repo, '--changed']).status).toBe(2)
    expect(cli(['--data-dir', d, 'tests', r.repo, '--changed', 'nosuchref']).status).toBe(2)
    expect(cli(['--data-dir', d, 'tests', r.repo, '--changed', `${r.base}..${r.head}`, '--depth', '9']).status).toBe(2)
  }, 60000)
})

describe('FR2146 proofmesh completeness --branches: open local branches by blast radius and overlap', () => {
  it('ranks each branch with commits main lacks, from its merge base, and skips a branch main already holds', () => {
    const r = repository('head')
    git(r.repo, 'branch', '-m', 'main', 'feat-a')
    git(r.repo, 'checkout', '-q', '-b', 'main', r.base)
    git(r.repo, 'branch', 'merged', r.base)
    git(r.repo, 'checkout', '-q', '-b', 'feat-b', r.base)
    fs.copyFileSync(path.join(FIXTURE, 'head-delete', 'src', 'stats.ts'), path.join(r.repo, 'src', 'stats.ts'))
    commit(r.repo, 'feat-b')
    git(r.repo, 'checkout', '-q', 'main')
    const d = registered(r)
    const out = cli(['--data-dir', d, 'completeness', r.repo, '--branches'])
    expect(out.status, out.stderr).toBe(0)
    // feat-b changes mean (three dependents neither) and deletes spread (range neither); feat-a changes mean and managerScore, which nothing calls.
    expect(out.stdout).toBe([
      '# branches · 2 open branches · against main',
      'feat-b blast=2 changed=2 neither=4 overlap=1 with feat-a:1',
      'feat-a blast=1 changed=2 neither=2 overlap=1 with feat-b:1',
      '',
    ].join('\n'))
    const j = JSON.parse(cli(['--data-dir', d, 'completeness', r.repo, '--branches', '--json']).stdout)
    expect(j.branches.map((b: { branch: string; blast_radius: number }) => [b.branch, b.blast_radius])).toEqual([['feat-b', 2], ['feat-a', 1]])
    expect(cli(['--data-dir', d, 'completeness', r.repo, '--branches', '--format', 'markdown']).status).toBe(2)
  }, 360000)
})

describe('FR2144 FR2145 docs/proofmesh/ci: the sample workflow and job post with the host token only, on pull_request', () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'ci', f), 'utf8')
  it('the GitHub Actions workflow restores the data directory, runs the report and posts one comment with gh pr comment --edit-last', () => {
    const y = read('github-actions.yml')
    expect(y).toMatch(/^on:\n {2}pull_request:/m)
    expect(y).not.toMatch(/^\s*pull_request_target:/m)
    expect(y).toContain('actions/cache')
    expect(y).toMatch(/completeness .*--format markdown/)
    expect(y).toMatch(/gh pr comment .*--edit-last/)
    expect(y).toContain('GITHUB_STEP_SUMMARY')
    // The workflow's own token and nothing else: no secret is named.
    expect(y).not.toMatch(/secrets\./)
    expect(y).toContain('GH_TOKEN: ${{ github.token }}')
    expect(y).toMatch(/^permissions:\n {2}contents: read\n {2}pull-requests: write\n/m)
  })
  it('the GitLab CI job runs on merge requests and posts only when the person opts in with a token variable of their own', () => {
    const y = read('gitlab-ci.yml')
    expect(y).toContain('merge_request_event')
    expect(y).toMatch(/completeness .*--format markdown/)
    expect(y).toMatch(/if \[ -n "\$PROOFMESH_NOTE_TOKEN" \]/)
  })
})
