import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { cli, ROOT, tmpDir, tool } from './helpers.js'

const FIXTURE = path.join(ROOT, 'fixtures', 'change-reach')
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
const overlay = (repo: string, name: string) => fs.cpSync(path.join(FIXTURE, name), repo, { recursive: true })
/** head-complete is head plus two edits (scenario 5). */
const complete = (repo: string) => {
  fs.writeFileSync(path.join(repo, 'src/roles/auditor.ts'), "import { mean } from '../stats'\nexport function auditorScore(xs: number[]): number {\n  return xs.length === 0 ? 0 : mean(xs) - 1\n}\n")
  fs.writeFileSync(path.join(repo, 'src/index.ts'), "export { mean } from './stats'\nexport { spread } from './stats'\n")
}

/** A git repository of fixtures/change-reach: base committed, then each step applied and committed on top, the last one left uncommitted when asked. */
function repository(steps: Array<(repo: string) => void>, uncommitted = false, baseStep = 0): { repo: string; base: string; head: string } {
  const repo = tmpDir('pm-reach-')
  overlay(repo, 'base')
  fs.copyFileSync(path.join(FIXTURE, 'tsconfig.json'), path.join(repo, 'tsconfig.json'))
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  let base = git(repo, 'rev-parse', 'HEAD')
  // The first baseStep steps commit what the base holds beyond the fixture's base.
  for (const [i, step] of steps.entries()) { step(repo); if (i + 1 === baseStep) base = git(repo, 'rev-parse', 'HEAD') }
  if (!uncommitted && steps.length) {
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'head')
  }
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD') }
}
const HEAD = [(r: string) => overlay(r, 'head')]
const DELETE = [...HEAD, (r: string) => overlay(r, 'head-delete')]
const COMPLETE = [...HEAD, complete]

/** The rows as scenario 1 writes them: one space between fields, dependents indented by two. */
const rows = (text: string) => text.split('\n').filter((l) => l.trim() && !/^(# |summary: |limitation: )/.test(l)).map((l) => l.replace(/(\S) +/g, '$1 ').trimEnd())
const summary = (text: string) => text.split('\n').find((l) => l.startsWith('summary: ') || l.startsWith('# summary: '))?.replace(/^# /, '')

/** The CLI form, which indexes base and head when no snapshot of them exists and waits. */
function completeness(steps: Array<(repo: string) => void>, args: string[] = [], uncommitted = false, baseStep = 0) {
  const d = tmpDir(), r = repository(steps, uncommitted, baseStep)
  expect(cli(['--data-dir', d, 'init']).status).toBe(0)
  expect(cli(['--data-dir', d, 'repo', 'add', r.repo]).status).toBe(0)
  const range = uncommitted ? r.base : `${r.base}..${r.head}`
  return { d, ...r, out: cli(['--data-dir', d, 'completeness', r.repo, range, ...args]) }
}

// Changed symbols are ordered by path, then line (FR-6), so src/roles/manager.ts comes before src/stats.ts.
const SCENARIO_1 = [
  'changed managerScore src/roles/manager.ts:2 modified neither',
  'changed mean src/stats.ts:1 modified tested: analystScoreDoubles test/analyst.test.ts:2 transitive_call depth=2',
  '  calls analystScore src/roles/analyst.ts:3 tested: analystScoreDoubles test/analyst.test.ts:2 call depth=1',
  '  calls auditorScore src/roles/auditor.ts:3 neither',
  '  calls managerScore src/roles/manager.ts:3 changed',
  '  imports src/index.ts:1 neither',
]

describe('FR108 FR109 FR110 FR111 FR112 FR113 FR114 impact_completeness: what a change reaches, and which of it the diff or a test covers (fixtures/change-reach)', () => {
  // One indexed base..head serves the questions that do not change the repository.
  let once: ReturnType<typeof completeness>
  beforeAll(() => { once = completeness(HEAD) }, 180000)
  it('scenario 1: base..head at depth 1 lists both changed symbols and every dependent, marked; the CLI exits 1 for the two neither', () => {
    const { out } = once
    expect(rows(out.stdout)).toEqual(SCENARIO_1)
    expect(summary(out.stdout)).toBe('summary: 2 changed symbols; 4 dependents: 1 changed, 1 tested, 2 neither')
    expect(out.status, out.stderr).toBe(1)
  }, 180000)

  it('scenario 1: the structured answer carries the same rows as fields', () => {
    const { d, repo, base, head } = once
    const data = tool(d, 'impact_completeness', { repository_id: repoId(d, repo), base, head }).data as Answer
    expect(data.changed.map((c) => [c.name, c.path, c.line, c.change, c.status, c.test && `${c.test.name} ${c.test.path}:${c.test.line} ${c.test.evidence} depth=${c.test.depth}`])).toEqual([
      ['managerScore', 'src/roles/manager.ts', 2, 'modified', 'neither', null],
      ['mean', 'src/stats.ts', 1, 'modified', 'tested', 'analystScoreDoubles test/analyst.test.ts:2 transitive_call depth=2'],
    ])
    expect(data.changed[1]!.dependents.map((x) => [x.relation, x.name, x.path, x.line, x.via, x.status])).toEqual([
      ['calls', 'analystScore', 'src/roles/analyst.ts', 3, null, 'tested'],
      ['calls', 'auditorScore', 'src/roles/auditor.ts', 3, null, 'neither'],
      ['calls', 'managerScore', 'src/roles/manager.ts', 3, null, 'changed'],
      ['imports', 'index.ts', 'src/index.ts', 1, null, 'neither'],
    ])
    expect(data.totals).toEqual({ changed_symbols: 2, dependents: 4, changed: 1, tested: 1, neither: 2 })
  }, 180000)

  it('scenario 2: depth 2 adds the caller of a caller, via it', () => {
    const { out } = completeness(HEAD, ['--depth', '2'])
    // Dependents are ordered by relation, then path: src/report.ts comes before src/roles/.
    expect(rows(out.stdout)).toEqual([...SCENARIO_1.slice(0, 2), '  calls report src/report.ts:3 neither (via analystScore)', ...SCENARIO_1.slice(2)])
    expect(summary(out.stdout)).toBe('summary: 2 changed symbols; 5 dependents: 1 changed, 1 tested, 3 neither')
  }, 180000)

  it('scenario 3: with base only, the working tree is the head', () => {
    const { out } = completeness(HEAD, [], true)
    expect(rows(out.stdout)).toEqual(SCENARIO_1)
    expect(summary(out.stdout)).toBe('summary: 2 changed symbols; 4 dependents: 1 changed, 1 tested, 2 neither')
  }, 180000)

  it('scenario 4: a deleted symbol is listed with its callers from the base snapshot', () => {
    const { out } = completeness(DELETE)
    expect(rows(out.stdout)).toEqual([...SCENARIO_1, 'changed spread src/stats.ts:4 deleted neither', '  calls range src/range.ts:3 neither'])
    expect(summary(out.stdout)).toBe('summary: 3 changed symbols; 5 dependents: 1 changed, 1 tested, 3 neither')
  }, 180000)

  it('scenario 5: once every dependent is changed or tested, the CLI exits 0, though a changed symbol has no test', () => {
    const { out } = completeness(COMPLETE)
    expect(rows(out.stdout)).toEqual([
      'changed auditorScore src/roles/auditor.ts:2 modified neither',
      SCENARIO_1[0],
      SCENARIO_1[1],
      SCENARIO_1[2],
      '  calls auditorScore src/roles/auditor.ts:3 changed',
      SCENARIO_1[4],
      '  imports src/index.ts:1 changed',
    ])
    expect(summary(out.stdout)).toBe('summary: 3 changed symbols; 4 dependents: 3 changed, 1 tested, 0 neither')
    expect(out.status, out.stderr).toBe(0)
  }, 180000)

  it('base equal to head is 0 changed symbols and exit 0; an unknown commit or a usage error exits 2', () => {
    const { d, repo, head } = once
    const same = cli(['--data-dir', d, 'completeness', repo, `${head}..${head}`])
    expect(summary(same.stdout)).toBe('summary: 0 changed symbols; 0 dependents: 0 changed, 0 tested, 0 neither')
    expect(same.status).toBe(0)
    expect(cli(['--data-dir', d, 'completeness', repo, 'nosuchref']).status).toBe(2)
    expect(cli(['--data-dir', d, 'completeness', repo]).status).toBe(2)
  }, 180000)

  it('over MCP, a commit with no snapshot starts its index job and answers pending with the job id; the job leaves the current snapshot alone', async () => {
    const d = tmpDir(), r = repository(HEAD)
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
    expect(cli(['--data-dir', d, 'repo', 'add', r.repo]).status).toBe(0)
    expect(cli(['--data-dir', d, 'index', r.repo]).status).toBe(0)
    const id = repoId(d, r.repo)
    const env = tool(d, 'impact_completeness', { repository_id: id, base: r.base })
    const data = env.data as Answer
    expect(data.pending).toEqual([{ commit: r.base, job_id: expect.stringMatching(/^job_/) }])
    expect(data.changed).toEqual([])
    const current = () => (tool(d, 'list_snapshots', { repository_id: id }).data as { snapshots: Array<{ id: string; current: boolean }> }).snapshots.find((x) => x.current)!.id
    const before = current()
    for (let i = 0; i < 240 && ['queued', 'running'].includes((tool(d, 'get_job', { repository_id: id, job_id: data.pending[0]!.job_id }).data as { job: { state: string } }).job.state); i++) await new Promise((t) => setTimeout(t, 500))
    expect(current()).toBe(before)
    const again = (tool(d, 'impact_completeness', { repository_id: id, base: r.base, envelope: 'lean' }) as { text?: string }).text!
    expect(rows(again)).toEqual(SCENARIO_1)
  }, 180000)

  it('edges: a changed test says so, a pure rename is its module, a file no snapshot analyses is named, test code is left out unless asked, and the rows page', () => {
    const { d, repo, base, head } = completeness([...HEAD, (r) => {
      fs.writeFileSync(path.join(r, 'test/analyst.test.ts'), fs.readFileSync(path.join(r, 'test/analyst.test.ts'), 'utf8').replace("new Error('analystScore')", "new Error('analystScore doubles')"))
      fs.writeFileSync(path.join(r, 'README.md'), 'notes\n')
      git(r, 'mv', 'src/range.ts', 'src/span.ts')
    }])
    const ask = (input: Record<string, unknown> = {}) => tool(d, 'impact_completeness', { repository_id: repoId(d, repo), base, head, ...input })
    const lean = (ask({ envelope: 'lean' }) as { text?: string }).text!
    expect(rows(lean)).toEqual([
      SCENARIO_1[0],
      'changed src/span.ts:1 modified neither',
      'changed mean src/stats.ts:1 modified tested: analystScoreDoubles test/analyst.test.ts:2 transitive_call depth=2 (test changed)',
      '  calls analystScore src/roles/analyst.ts:3 tested: analystScoreDoubles test/analyst.test.ts:2 call depth=1 (test changed)',
      ...SCENARIO_1.slice(3),
    ])
    expect(lean).toContain('\n# The diff touches 1 file no snapshot analyses, so their changes are not listed: README.md.')
    expect((ask({ include_tests: true }).data as Answer).changed.map((c) => c.name)).toContain('analystScoreDoubles')
    const first = ask({ limits: { max_rows: 1 } })
    expect((first.data as Answer).changed.map((c) => c.name)).toEqual(['managerScore'])
    expect((first.data as Answer).totals.changed_symbols).toBe(3)
    const rest = ask({ limits: { max_rows: 5 }, cursor: first.completion.next_cursor })
    expect((rest.data as Answer).changed.map((c) => c.name)).toEqual(['src/span.ts', 'mean'])
    // A test past the depth limit is not found: the answer says the search stopped, so neither may be wrong.
    const shallow = ask({ limits: { max_depth: 1 } })
    expect((shallow.data as Answer).changed.find((c) => c.name === 'mean')!.status).toBe('neither')
    expect(shallow.limitations).toContainEqual(expect.stringMatching(/^The test search stopped at the depth limit for \d+ rows?; a row marked neither may have a test further away\.$/))
  }, 180000)

  it('--json prints the structured answer', () => {
    const { d, repo, base, head } = once
    const env = JSON.parse(cli(['--data-dir', d, 'completeness', repo, `${base}..${head}`, '--json']).stdout)
    expect(env.tool).toBe('impact_completeness')
    expect(env.data.totals).toEqual({ changed_symbols: 2, dependents: 4, changed: 1, tested: 1, neither: 2 })
  }, 180000)
})

describe('FR125 impact_completeness answers the same with a named package.json, which only adds the project of each file', () => {
  it('scenario 1 and its summary are unchanged when the repository is a named package', () => {
    // The package.json is committed in the base, so the diff is the same two edits.
    const { out } = completeness([(r) => fs.writeFileSync(path.join(r, 'package.json'), '{ "name": "reach-pkg" }\n'), ...HEAD], [], false, 1)
    expect(rows(out.stdout)).toEqual(SCENARIO_1)
    expect(summary(out.stdout)).toBe('summary: 2 changed symbols; 4 dependents: 1 changed, 1 tested, 2 neither')
  }, 180000)
})

describe('FR110 FR111 FR112 impact_completeness edge cases: non-ASCII paths, moved code, a deleted symbol whose caller changed, callers past a reference', () => {
  const write = (repo: string, file: string, lines: string[]) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), [...lines, ''].join('\n')) }
  const fn = (name: string, body: string) => [`export function ${name}(): number {`, `  ${body}`, '}']
  let out: string
  beforeAll(() => {
    out = completeness([
      (r) => {
        // The base these steps start from is base plus this first commit, so the second step's changes are the diff.
        // A person's git configuration may drop the a/ and b/ prefixes; the diff must not depend on it.
        git(r, 'config', 'diff.noprefix', 'true')
        write(r, 'src/config.ts', ['export default { retries: 3 }'])
        write(r, 'src/use-config.ts', ["import config from './config'", ...fn('retries', 'return config.retries')])
        write(r, 'src/café.ts', fn('crème', 'return 1'))
        write(r, 'src/use-cafe.ts', ["import { crème } from './café'", ...fn('useIt', 'return crème()')])
        write(r, 'src/pair.ts', [...fn('one', 'return 1'), ...fn('two', 'return 2')])
        write(r, 'src/old.ts', fn('old', 'return 1'))
        write(r, 'src/caller.ts', ["import { old } from './old'", ...fn('caller', 'return old()')])
        write(r, 'src/chain.ts', ["import { mean } from './stats'", 'export function wrapper(xs: number[]): number {', '  return mean(xs)', '}', 'export function bridge(xs: number[]): number {', '  const f = mean', '  return wrapper(xs) + f(xs)', '}', 'export function entry(xs: number[]): number {', '  return bridge(xs)', '}'])
        git(r, 'add', '-A')
        git(r, 'commit', '-q', '-m', 'base plus')
      },
      (r) => overlay(r, 'head'),
      (r) => {
        write(r, 'src/café.ts', fn('crème', 'return 2'))
        write(r, 'src/config.ts', ['export default { retries: 0 }'])
        write(r, 'src/pair.ts', [...fn('two', 'return 2'), ...fn('one', 'return 1')])
        fs.rmSync(path.join(r, 'src/old.ts'))
        write(r, 'src/caller.ts', ["import { old } from './old'", 'export function caller(): number {', '  if (Date.now() < 0) return 0', '  return old()', '}'])
      },
    ], ['--depth', '3'], false, 1).out.stdout
  }, 180000)

  it('a changed file whose path git would quote is read by its real path', () => {
    expect(rows(out)).toContain('changed crème src/café.ts:1 modified neither')
    expect(rows(out)).toContain('  calls useIt src/use-cafe.ts:3 neither')
  })

  it('a changed export default expression changes the module, whose importers are its dependents', () => {
    expect(rows(out)).toEqual(expect.arrayContaining(['changed src/config.ts:1 modified neither', '  imports src/use-config.ts:1 neither']))
  })

  it('two functions that only swapped places are no change', () => {
    expect(rows(out).filter((l) => l.includes('src/pair.ts'))).toEqual([])
  })

  it('a caller of a deleted symbol that changed only by an inserted line is changed', () => {
    expect(rows(out)).toContain('changed old src/old.ts:1 deleted neither')
    expect(rows(out)).toContain('  calls caller src/caller.ts:3 changed')
  })

  it('a symbol that references the change and calls a caller of it is followed as a caller too', () => {
    expect(rows(out)).toEqual(expect.arrayContaining(['  references bridge src/chain.ts:6 neither', '  calls bridge src/chain.ts:7 neither (via wrapper)', '  calls entry src/chain.ts:10 neither (via bridge)']))
  })
})

type Test = { name: string; path: string; line: number; evidence: string; depth: number; changed: boolean }
type Answer = {
  pending: Array<{ commit: string | null; job_id: string }>
  changed: Array<{ name: string; path: string; line: number; change: string; status: string; test: Test | null; dependents: Array<{ relation: string; name: string; path: string; line: number; via: string | null; status: string; test: Test | null }> }>
  totals: Record<string, number>
}
const repoId = (d: string, root: string) => (tool(d, 'list_repositories').data as { repositories: Array<{ id: string; root: string }> }).repositories.find((x) => fs.realpathSync(x.root) === fs.realpathSync(root))!.id
