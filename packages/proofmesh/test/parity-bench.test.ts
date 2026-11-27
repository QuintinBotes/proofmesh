import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, tmpDir } from './helpers.js'

// The parity harness (bench/parity) on a small project-authored fixture, with no comparator at its pinned version:
// a graphify at another version on PATH, and no scip-typescript, scip, serena or aider. The full run, with the
// comparators installed, is `sh bench/parity/run.sh` (bench/parity/README.md).
const ERROR_TS = 'export class TypeORMError extends Error {\n    constructor(message?: string) {\n        super(message)\n        Object.setPrototypeOf(this, new.target.prototype)\n    }\n}\n'
function fixture(): string {
  const dir = fs.realpathSync(tmpDir('pm-parity-fixture-'))
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
  write('tsconfig.json', '{ "compilerOptions": { "target": "es2020", "module": "commonjs", "strict": false, "noEmit": true }, "include": ["src"] }\n')
  write('PROVENANCE', 'Project-authored for the parity harness test.\nCommit: test-fixture\n')
  write('src/error/TypeORMError.ts', ERROR_TS)
  write('src/globals.ts', 'import { TypeORMError } from "./error/TypeORMError"\nexport function getMetadataArgsStorage(): object { return {} }\nexport function fail(): never { getMetadataArgsStorage(); throw new TypeORMError("x") }\n')
  execFileSync('git', ['-C', dir, 'init', '-q'])
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'fixture'])
  return dir
}
// A graphify at another version on PATH, and no other comparator.
function parityEnv(fix: string, out: string): NodeJS.ProcessEnv {
  const bin = tmpDir('pm-parity-bin-')
  fs.writeFileSync(path.join(bin, 'graphify'), '#!/bin/sh\necho "graphify 0.9.120"\n', { mode: 0o755 })
  return { ...process.env, PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), PARITY_TOOLS: tmpDir('pm-parity-tools-'), PARITY_FIXTURE: fix, PARITY_OUT: out, PARITY_RUNS: '1' }
}
const RUN_SH = path.join(ROOT, 'bench/parity/run.sh')

describe('FR510 to FR516 the parity benchmark scores every tool on one truth, and a missing comparator is not run', () => {
  it('FR510 FR511 FR512 FR513 FR514 FR515 FR924 FR946 with no comparator at its pinned version, the harness fills the ProofMesh column, says why each other did not run, restores the fixture and exits 0', () => {
    const fix = fixture()
    const out = tmpDir('pm-parity-out-')
    const r = spawnSync('sh', [RUN_SH], { encoding: 'utf8', env: parityEnv(fix, out) })
    expect(r.status, r.stderr).toBe(0)
    const md = fs.readFileSync(path.join(out, 'parity.md'), 'utf8')
    expect(md).toBe(r.stdout.replace(/\n$/, ''))
    // FR510: one row per question class, one column per tool, the fixture and ProofMesh commits and every version in the header.
    expect(md).toContain('| Q | class | truth | ProofMesh | Graphify | scip-typescript | Serena | aider |')
    for (let i = 1; i <= 13; i++) expect(md).toMatch(new RegExp(`^\\| Q${i} \\| `, 'm'))
    expect(md).toMatch(/^Fixture: typeorm @ test-fixture \(src\/, 2 files\)\. ProofMesh 0\.1\.0 @ [0-9a-f]+\. Truth: typescript-checker /m)
    expect(md).toMatch(/^Versions: ProofMesh 0\.1\.0 @ [0-9a-f]+; Graphify not run \(graphify 0\.9\.120 is not the pinned 0\.9\.108\); scip-typescript not run/m)
    // FR511 and FR514: another version and a missing tool are each `not run: <reason>`; the ProofMesh cells are scored.
    const q1 = md.split('\n').find((l) => l.startsWith('| Q1 |'))!.split(' | ')
    expect(q1[3]).toMatch(/^\d+ \/ (\d+|-)$/)
    expect(q1.slice(4).join(' | ')).toBe('not run: graphify 0.9.120 is not the pinned 0.9.108 | not run: scip-typescript is not installed (sh bench/parity/install.sh); scip is not installed (sh bench/parity/install.sh) | not run: serena is not installed (sh bench/parity/install.sh) | not run: aider is not installed (sh bench/parity/install.sh) |')
    // FR946: ProofMesh answers Q10 to Q13 through its structure tools over MCP, so its cells carry no (data) mark.
    for (const [q, kind] of [['Q10', 'dead_code'], ['Q11', 'cycles'], ['Q12', 'roots'], ['Q13', 'hubs']]) expect(md).toMatch(new RegExp(`^\\| ${q} \\| ${kind} \\| \\d+ \\| \\d+ / (\\d+|-) \\| not run`, 'm'))
    // FR924 (issue 33 scenario 5): the context map's inbound and outbound shares beside aider's, at each budget, and their mean.
    expect(md).toContain('| Q | focus | ProofMesh get_context_map 4096 bytes | ProofMesh get_context_map 16384 bytes | aider 1k tokens | aider 4k tokens |')
    expect(md).toMatch(/^\| Q1 \| `src\/globals\.ts` \| in \d+% out \d+% \| in \d+% out \d+% \| not run \| not run \|$/m)
    expect(md).toMatch(/^\| mean \| \| in \d+% out \d+% \| in \d+% out \d+% \| not run \| not run \|$/m)
    expect(fs.readFileSync(path.join(out, 'raw', 'proofmesh-context-Q1-4096.txt'), 'utf8')).toMatch(/^# get_context_map · \d+ rows? · snap_\w+ current\n/)
    // FR512: callers at three levels; FR513: the cost rows, with ProofMesh measured and its tools/list bytes.
    expect(md).toMatch(/^\| Q1 \| \d+ \/ (\d+|-) · \d+ \/ (\d+|-) · \d+ \/ (\d+|-) \| not run/m)
    for (const row of ['Full build', 'Peak memory (largest process)', 'Disk (own store)', 'No-change re-index', 'One edit (a statement in the constructor of src/error/TypeORMError.ts)']) expect(md).toMatch(new RegExp(`^\\| ${row.replace(/[()./]/g, '\\$&')} \\| \\d+(\\.\\d)? (ms|s|MB) \\| not run \\| not run \\| not run \\| not run \\|$`, 'm'))
    expect(md).toMatch(/^\| `tools\/list` bytes \(MCP\) \| \d+ \(\d+ tools\) \| not run/m)
    expect(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).meta.runs).toBe(1)
    // FR515: the edit is undone and the fixture lists nothing but the excluded caches.
    expect(md).toContain('Fixture after the edit step: clean')
    expect(fs.readFileSync(path.join(fix, 'src/error/TypeORMError.ts'), 'utf8')).toBe(ERROR_TS)
    expect(execFileSync('git', ['-C', fix, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')
  }, 300000)

  it('FR1030 FR1031 two runs started together on one PARITY_FIXTURE and one PARITY_OUT each work on their own copy, leave the fixture as it was, remove their copy and exit 0 with the same scores', async () => {
    const fix = fixture()
    const before = { error: fs.readFileSync(path.join(fix, 'src/error/TypeORMError.ts'), 'utf8'), exclude: fs.readFileSync(path.join(fix, '.git/info/exclude'), 'utf8'), head: execFileSync('git', ['-C', fix, 'rev-parse', 'HEAD'], { encoding: 'utf8' }) }
    const out = tmpDir('pm-parity-out-')
    const tmp = fs.realpathSync(tmpDir('pm-parity-tmp-'))
    const env = { ...parityEnv(fix, out), TMPDIR: tmp }
    const runOnce = () => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn('sh', [RUN_SH], { env })
      let stdout = '', stderr = ''
      p.stdout.on('data', (d) => (stdout += d))
      p.stderr.on('data', (d) => (stderr += d))
      p.on('close', (status) => resolve({ status, stdout, stderr }))
    })
    const runs = await Promise.all([runOnce(), runOnce()])
    for (const r of runs) expect(r.status, r.stderr).toBe(0)
    // FR1030: each run names its own copy under TMPDIR, never the fixture it was given, and removes it when it ends.
    const copies = runs.map((r) => /^parity: fixture copy (.+)$/m.exec(r.stderr)?.[1] ?? '')
    expect(copies[0]).not.toBe(copies[1])
    for (const c of copies) {
      expect(c.startsWith(tmp + path.sep), c).toBe(true)
      expect(fs.existsSync(c), c).toBe(false)
    }
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith('parity-'))).toEqual([])
    // FR1030: the fixture both runs were given is only read: its file, commit, status and exclude are as before.
    expect(fs.readFileSync(path.join(fix, 'src/error/TypeORMError.ts'), 'utf8')).toBe(before.error)
    expect(execFileSync('git', ['-C', fix, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(before.head)
    expect(execFileSync('git', ['-C', fix, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' })).toBe('')
    expect(fs.readFileSync(path.join(fix, '.git/info/exclude'), 'utf8')).toBe(before.exclude)
    // FR515 and FR1031: each run's copy was clean after its edit step, both score alike, and out/ holds one whole result.
    // A snapshot id names the repository, so it differs between the two copies; an error cell may quote it.
    const rows = (md: string) => md.split('\n').filter((l) => /^\| Q\d+ \| /.test(l)).map((l) => l.replace(/snap_[0-9a-f]+/g, 'snap_'))
    for (const r of runs) expect(r.stdout).toContain('Fixture after the edit step: clean (tool caches graphify-out/, .serena/, .aider.tags.cache.v4/ are in .git/info/exclude)')
    expect(rows(runs[0].stdout).length).toBe(16)
    expect(rows(runs[1].stdout)).toEqual(rows(runs[0].stdout))
    const md = fs.readFileSync(path.join(out, 'parity.md'), 'utf8')
    expect(runs.map((r) => r.stdout.replace(/\n$/, ''))).toContain(md)
    expect(fs.readdirSync(out).sort()).toEqual(['parity.md', 'raw', 'results.json', 'truth.json'])
  }, 300000)

  it('FR1032 run.sh refuses a PARITY_FIXTURE that is not a parity fixture, naming it, and leaves it as it was', () => {
    const dir = tmpDir('pm-parity-notfixture-')
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'mine\n')
    const r = spawnSync('sh', [RUN_SH], { encoding: 'utf8', env: parityEnv(dir, tmpDir('pm-parity-out-')), timeout: 60000 })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`parity: ${dir} is not a parity fixture (no PROVENANCE); remove it or set PARITY_FIXTURE to another directory`)
    expect(fs.readdirSync(dir)).toEqual(['keep.txt'])
  })

  it('FR516 comparators are benchmark-only: no package depends on one, results are ignored, and the README names each licence', () => {
    const manifests = execFileSync('git', ['-C', ROOT, 'ls-files', '*package.json'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    for (const m of manifests) expect(fs.readFileSync(path.join(ROOT, m), 'utf8'), m).not.toMatch(/graphify|scip-typescript|serena|aider/)
    expect(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')).toMatch(/^\/bench\/parity\/out\/$/m)
    const readme = fs.readFileSync(path.join(ROOT, 'bench/parity/README.md'), 'utf8')
    for (const licence of ['Graphify 0.9.108 (Apache-2.0)', 'scip-typescript 0.3.15 (Apache-2.0)', 'scip CLI 0.10.0 (Apache-2.0)', 'Serena v2.1.0 (GPL-3.0', 'aider-chat 0.86.2 (Apache-2.0)', 'TypeORM (MIT)']) expect(readme).toContain(licence)
  })
})
