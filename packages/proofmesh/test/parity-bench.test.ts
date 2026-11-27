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

describe('FR510 to FR516 FR966 the parity benchmark scores every tool on one truth, and a missing comparator is not run', () => {
  it('FR510 FR511 FR512 FR513 FR514 FR515 FR924 FR946 FR966 with no comparator at its pinned version, the harness fills the ProofMesh column, says why each other did not run, restores the fixture and exits 0', () => {
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
    // FR966: each question is asked again as one query_graph query, in a column beside the typed tools, with its p95.
    expect(md).toContain('| Q | class | ProofMesh (typed tools) | ProofMesh query_graph | same items as typed | ms (median) |')
    expect(md).toMatch(/^\| Q1 \| callers \| \d+ \/ (\d+|-) \| \d+ \/ (\d+|-) \| yes \| \d+ \|$/m)
    expect(md).toMatch(/^\| Q5 \| importers \| \d+ \/ (\d+|-) \| \d+ \/ (\d+|-) \| yes \| \d+ \|$/m)
    expect(md).toMatch(/^query_graph p95 over Q1–Q12, 1 run each: \d+ ms \(target 500 ms\)\.$/m)
    expect(fs.readFileSync(path.join(out, 'raw', 'pm-query-Q1.txt'), 'utf8')).toMatch(/^MATCH \(\)-\[r:calls\]->\(t \{qualified_name: \$t\}\) RETURN r\n\{"t":"src\/globals:getMetadataArgsStorage"\}\n# query_graph · commit [0-9a-f]{12} · \d+ rows? · snap_/)
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
    // A query_graph row ends with its median time, which is no score and differs between runs (#36).
    const rows = (md: string) => md.split('\n').filter((l) => /^\| Q\d+ \| /.test(l)).map((l) => l.replace(/snap_[0-9a-f]+/g, 'snap_').replace(/(\| (?:yes|no \([^)]*\)|error) \| )\d+ \|$/, '$1ms |'))
    for (const r of runs) expect(r.stdout).toContain('Fixture after the edit step: clean (tool caches graphify-out/, .serena/, .aider.tags.cache.v4/ are in .git/info/exclude)')
    // 16 score rows plus the 8 rows of the context map table (#33, FR924) and the 13 of the query_graph table (#36, FR966), which also start with a question.
    expect(rows(runs[0].stdout).length).toBe(37)
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

  // aider-map.py run by python3 against a stub of the aider and litellm modules it uses. The stub keeps aider 0.86.2's rule:
  // Model() downloads the model prices when ~/.aider/caches holds no file of them younger than a day.
  function aiderStub(): string {
    const dir = tmpDir('pm-parity-aider-stub-')
    const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
    write('litellm/__init__.py', '')
    write('litellm/model_prices_and_context_window_backup.json', '{"gpt-4o": {"max_input_tokens": 128000}}')
    write('aider/__init__.py', '')
    write('aider/io.py', 'class InputOutput:\n    def __init__(self, **kw):\n        pass\n')
    write('aider/models.py', [
      'import os, socket, time',
      'from pathlib import Path',
      'CACHE = Path.home() / ".aider" / "caches" / "model_prices_and_context_window.json"',
      'class Model:',
      '    def __init__(self, name):',
      '        if os.environ.get("STUB_FETCH") or not CACHE.exists() or time.time() - CACHE.stat().st_mtime > 86400:',
      '            try:',
      '                socket.create_connection(("raw.githubusercontent.com", 443), timeout=1)',
      '            except Exception as ex:',
      '                print(ex)',
      '        self.prices = CACHE.read_text() if CACHE.exists() else None',
      '',
    ].join('\n'))
    write('aider/repomap.py', [
      'import json, os',
      'class Node:',
      '    def __init__(self, at):',
      '        self.start_byte, self.end_byte = at, at + 1',
      'class RepoMap:',
      '    def __init__(self, map_tokens, root, main_model, io):',
      '        self.model = main_model',
      '    def _run_captures(self, query, node):',
      '        return {"name.reference.class": [Node(30), Node(10), Node(20)]}',
      '    def get_repo_map(self, chat, other, mentioned_fnames, mentioned_idents):',
      '        order = [n.start_byte for n in self._run_captures(None, None)["name.reference.class"]]',
      '        return json.dumps({"home": os.environ["HOME"], "prices": self.model.prices, "order": order, "chat": chat, "other": other})',
      '',
    ].join('\n'))
    return dir
  }
  const AIDER_MAP = path.join(ROOT, 'bench/parity/aider-map.py')
  function aiderMap(env: NodeJS.ProcessEnv) {
    const root = fixture()
    const input = JSON.stringify([{ file: 'src/globals.ts', ident: 'fail', tokens: 1024 }]) + '\nsrc/error/TypeORMError.ts\nsrc/globals.ts\n'
    // A HOME whose model prices are two days old, so aider would download them if it read them.
    const home = tmpDir('pm-parity-home-')
    const stale = path.join(home, '.aider/caches/model_prices_and_context_window.json')
    fs.mkdirSync(path.dirname(stale), { recursive: true })
    fs.writeFileSync(stale, '{}')
    const old = new Date(Date.now() - 2 * 86400000)
    fs.utimesSync(stale, old, old)
    const r = spawnSync('python3', ['-s', '-P', AIDER_MAP, root], { cwd: root, input, encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: tmpDir('pm-parity-pytmp-'), HOME: home, PYTHONPATH: aiderStub(), ...env } })
    return { r, root, stale, old }
  }

  it('FR1100 FR1101 FR1110 the aider step reads model prices from litellm\'s bundled copy in a HOME of its own, removed at exit, and gives aider names relative to the root with tree-sitter captures in source order', () => {
    const { r, root, stale, old } = aiderMap({ PYTHONHASHSEED: '0' })
    expect(r.status, r.stderr).toBe(0)
    const m = JSON.parse(JSON.parse(r.stdout.trim().split('\n').at(-1)!)[0].map)
    // FR1100: aider's HOME is the step's own, holding litellm's copy written fresh, so it downloads nothing (no attempt reached the guard).
    expect(m.prices).toBe('{"gpt-4o": {"max_input_tokens": 128000}}')
    expect(path.basename(m.home)).toMatch(/^aider-home-/)
    // FR1101: that HOME is removed when the step ends, and the HOME it was given is left as it was.
    expect(fs.existsSync(m.home)).toBe(false)
    expect(fs.readFileSync(stale, 'utf8')).toBe('{}')
    expect(fs.statSync(stale).mtimeMs).toBe(old.getTime())
    // FR1110: captures in source order, and no name holds the path of the copy.
    expect(m.order).toEqual([10, 20, 30])
    expect(m.chat).toEqual(['src/globals.ts'])
    expect(m.other).toEqual(['src/error/TypeORMError.ts'])
    expect(r.stdout).not.toContain(root)
  })

  it('FR1102 an aider step that tries to reach the network fails, naming the host, and prints no maps', () => {
    const { r } = aiderMap({ PYTHONHASHSEED: '0', STUB_FETCH: '1' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('aider-map.py: aider tried to reach the network (raw.githubusercontent.com); bench/parity runs offline')
    expect(r.stdout).not.toContain('"map"')
  })

  it('FR1111 the aider step refuses to run without PYTHONHASHSEED=0, as its maps would then differ between runs', () => {
    const { r } = aiderMap({})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('aider-map.py: run with PYTHONHASHSEED=0, so aider\'s maps are the same each run (#191)')
  })

  it('FR516 comparators are benchmark-only: no package depends on one, results are ignored, and the README names each licence', () => {
    const manifests = execFileSync('git', ['-C', ROOT, 'ls-files', '*package.json'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    for (const m of manifests) expect(fs.readFileSync(path.join(ROOT, m), 'utf8'), m).not.toMatch(/graphify|scip-typescript|serena|aider/)
    expect(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')).toMatch(/^\/bench\/parity\/out\/$/m)
    const readme = fs.readFileSync(path.join(ROOT, 'bench/parity/README.md'), 'utf8')
    for (const licence of ['Graphify 0.9.108 (Apache-2.0)', 'scip-typescript 0.3.15 (Apache-2.0)', 'scip CLI 0.10.0 (Apache-2.0)', 'Serena v2.1.0 (GPL-3.0', 'aider-chat 0.86.2 (Apache-2.0)', 'TypeORM (MIT)']) expect(readme).toContain(licence)
  })
})
