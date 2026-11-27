import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runKit } from '../src/conformance/kit.js'
import { BUILT_IN } from '../src/indexer/languages.js'
import { cli, expectedFor, fixtureRepo, tmpDir, withSnapshot } from './helpers.js'

const python = () => { const b = BUILT_IN.find((x) => x.id === 'python')!; return { id: 'python', entry: b.entry()!, extensions: b.extensions, configNames: [] } }

/** A copy of the fixture as a git work tree that ignores its virtual environment, as a real project does. */
function project(): string {
  const repo = tmpDir('pm-py-')
  fs.cpSync(fixtureRepo('py-shop'), repo, { recursive: true })
  fs.writeFileSync(path.join(repo, '.gitignore'), '.venv/\n')
  spawnSync('git', ['init', '-q'], { cwd: repo })
  return repo
}

describe('FR077 the Python adapter: Pyright resolves every call, and nothing runs Python', () => {
  it('SC014 passes the conformance kit, with dispositions, symbols, calls and imports equal to the hand-written oracle', async () => {
    const r = await runKit(python(), fixtureRepo('py-shop'), expectedFor('py-shop'))
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`)).toEqual([])
    expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['golden.symbols', 'golden.calls', 'golden.imports']))
  }, 240000)

  it('each file says which of its calls and imports it could not report', () => {
    const d = tmpDir(), repo = project()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    expect(withSnapshot(d, (db) => db.prepare(`select path, json_extract(capabilities, '$.imports') as imports, json_extract(capabilities, '$.resolved_calls') as calls from file where language = 'python' order by path`).all())).toEqual([
      { path: 'app.py', imports: 'complete', calls: 'complete' },
      { path: 'legacy.py', imports: 'complete', calls: 'complete' },
      { path: 'shop/__init__.py', imports: 'complete', calls: 'complete' },
      { path: 'shop/cart.py', imports: 'partial', calls: 'partial' },
      { path: 'shop/discounts.py', imports: 'partial', calls: 'partial' },
      { path: 'shop/pricing.py', imports: 'complete', calls: 'complete' },
    ])
  }, 240000)

  it('D14 an interpreter on the path is never run, so no environment start-up file executes', () => {
    const bin = tmpDir('pm-bin-'), marker = path.join(bin, 'ran')
    for (const name of ['python', 'python3']) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ntouch ${marker}\n`)
      fs.chmodSync(path.join(bin, name), 0o755)
    }
    const d = tmpDir(), repo = project()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args], { PATH: `${bin}:${process.env.PATH}` }).status).toBe(0)
    expect(fs.existsSync(marker)).toBe(false)
  }, 240000)

  it('A2 installed packages in a virtual environment are read, never run: calls into them resolve, and each is an external input', () => {
    const repo = project()
    const site = path.join(repo, '.venv', 'lib', 'python3.12', 'site-packages')
    fs.mkdirSync(path.join(site, 'requests'), { recursive: true })
    fs.mkdirSync(path.join(site, 'requests-2.31.0.dist-info'))
    fs.writeFileSync(path.join(site, 'requests', '__init__.py'), 'class Response:\n    def json(self):\n        return {}\n\n\ndef get(url):\n    return Response()\n')
    const d = tmpDir()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const calls = withSnapshot(d, (db) => db.prepare(`select a.resolution, x.module, x.name from assertion a join symbol s on s.id = a.source_id left join external_symbol x on x.id = a.target_id
      where a.type = 'calls' and s.qualified_name = 'shop/discounts:fetch_rate' order by x.name`).all())
    expect(calls).toEqual([{ resolution: 'resolved_external', module: 'requests', name: 'Response.json' }, { resolution: 'resolved_external', module: 'requests', name: 'get' }])
    const adapters = withSnapshot(d, (db) => JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value)) as Array<{ id: string; external_inputs: string[] }>
    expect(adapters.find((a) => a.id === 'python')!.external_inputs).toEqual(['pypi:requests/2.31.0'])
  }, 240000)

  it("an editable install of the repository's own package resolves in the indexed workspace, never in the checkout it names", () => {
    const repo = project()
    fs.mkdirSync(path.join(repo, 'libs', 'fmt', 'fmtlib'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'libs', 'fmt', 'fmtlib', '__init__.py'), 'def money(amount):\n    return amount\n')
    fs.writeFileSync(path.join(repo, 'report.py'), 'from fmtlib import money\n\n\ndef show():\n    return money(1)\n')
    const site = path.join(repo, '.venv', 'lib', 'python3.12', 'site-packages')
    fs.mkdirSync(site, { recursive: true })
    fs.writeFileSync(path.join(site, '_editable_impl_fmtlib.pth'), `${path.join(repo, 'libs', 'fmt')}\n`)
    const d = tmpDir()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    expect(withSnapshot(d, (db) => db.prepare(`select a.resolution, a.reason, t.qualified_name as target from assertion a join symbol s on s.id = a.source_id left join symbol t on t.id = a.target_id
      where a.type = 'calls' and s.qualified_name = 'report:show'`).all())).toEqual([{ resolution: 'resolved', reason: null, target: 'libs/fmt/fmtlib/__init__:money' }])

    // A16: the module found through the editable install is a dependency, so renaming its function reanalyses the caller.
    fs.writeFileSync(path.join(repo, 'libs', 'fmt', 'fmtlib', '__init__.py'), 'def cash(amount):\n    return amount\n')
    const incremental = cli(['--data-dir', d, 'index', repo]), id = /snapshot (snap_\w+) published/.exec(incremental.stdout)![1]!
    const clean = tmpDir()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', clean, ...args]).status).toBe(0)
    const dump = (dir: string) => cli(['--data-dir', dir, 'debug', 'dump', '--normalized', id]).stdout
    expect(dump(d)).toBe(dump(clean))
  }, 240000)
})

describe('FR670 FR671 PROOFMESH_PYRIGHT_UNANNOTATED reaches the Python adapter', () => {
  it('FR670 FR671 UNANNOTATED=off is passed in the configuration of initialize, the toolchain names it, and the other setting builds its own snapshot', () => {
    const spec = BUILT_IN.find((x) => x.id === 'python')!, before = process.env.PROOFMESH_PYRIGHT_UNANNOTATED
    try {
      process.env.PROOFMESH_PYRIGHT_UNANNOTATED = 'off'
      expect(spec.config?.()).toEqual({ pyright_unannotated: 'off' })
      delete process.env.PROOFMESH_PYRIGHT_UNANNOTATED
      expect(spec.config?.()).toEqual({ pyright_unannotated: 'on' })
    } finally { if (before === undefined) delete process.env.PROOFMESH_PYRIGHT_UNANNOTATED; else process.env.PROOFMESH_PYRIGHT_UNANNOTATED = before }

    const d = tmpDir(), repo = project()
    for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const index = (value: string) => {
      const r = cli(['--data-dir', d, 'index', repo], { PROOFMESH_PYRIGHT_UNANNOTATED: value })
      expect(r.status).toBe(0)
      const adapters = withSnapshot(d, (db) => JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value)) as Array<{ id: string; toolchain: Record<string, string> }>
      return { published: /snapshot (snap_\w+) published/.exec(r.stdout)?.[1], toolchain: adapters.find((a) => a.id === 'python')!.toolchain }
    }
    const off = index('off'), on = index('')
    expect(off.toolchain.pyright_unannotated).toBe('off')
    expect(on.toolchain.pyright_unannotated).toBe('on')
    expect(on.published).toBeDefined()
    expect(on.published).not.toBe(off.published)
  }, 240000)
})

describe('FR780 a source file that is not UTF-8 fails alone', () => {
  it('FR780 not UTF-8: a Latin-1 a.py and a c.py with an invalid UTF-8 sequence are failed as not_utf8, the snapshot is published, and the UTF-8 b.py keeps its symbols at the right bytes', () => {
    const repo = tmpDir('pm-py-enc-'), d = tmpDir()
    fs.writeFileSync(path.join(repo, 'a.py'), Buffer.from('# coding: latin_1\nx = "caf\xe9"\ndef f():\n    return x\n', 'latin1'))
    fs.writeFileSync(path.join(repo, 'c.py'), Buffer.concat([Buffer.from('x = "'), Buffer.from([0xff, 0xc0, 0x80]), Buffer.from('"\ndef h():\n    return x\n')]))
    fs.writeFileSync(path.join(repo, 'b.py'), 'y = "café"\ndef g():\n    return y\n')
    spawnSync('git', ['init', '-q'], { cwd: repo })
    for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const r = cli(['--data-dir', d, 'index', repo])
    expect(r.stderr).not.toMatch(/does not fit/)
    expect(r.status).toBe(0)
    expect(withSnapshot(d, (db) => db.prepare('select path, disposition, disposition_detail as detail from file order by path').all())).toEqual([
      { path: 'a.py', disposition: 'failed', detail: 'not_utf8' },
      { path: 'b.py', disposition: 'indexed', detail: null },
      { path: 'c.py', disposition: 'failed', detail: 'not_utf8' },
    ])
    const g = withSnapshot(d, (db) => db.prepare("select s.start_byte, s.end_byte from symbol s join file f on f.id = s.file_id where f.path = 'b.py' and s.name = 'g'").get()) as { start_byte: number; end_byte: number }
    expect(fs.readFileSync(path.join(repo, 'b.py')).subarray(g.start_byte, g.end_byte).toString()).toBe('def g():\n    return y')
  }, 240000)
})
