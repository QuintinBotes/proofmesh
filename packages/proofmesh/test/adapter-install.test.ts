import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cli, tmpDir, tool, withSnapshot } from './helpers.js'

/** A repository in a language no built-in adapter knows, and a copy of its third-party adapter that the test can change. */
function setup() {
  const d = tmpDir(), repo = tmpDir('pm-repo-'), adapterDir = tmpDir('pm-adapter-')
  fs.writeFileSync(path.join(repo, 'main.fake'), 'def main\n  call helper\n  call missing\n')
  fs.writeFileSync(path.join(repo, 'lib.fake'), 'def helper\n')
  const entry = path.join(adapterDir, 'linelang.mjs')
  fs.copyFileSync(path.join(import.meta.dirname, 'fake-adapters', 'linelang.mjs'), entry)
  for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  return { d, repo, entry }
}
const files = (d: string) => withSnapshot(d, (db) => db.prepare("select path, disposition, disposition_detail from file where path like '%.fake' order by path").all())
const symbols = (d: string) => withSnapshot(d, (db) => (db.prepare('select qualified_name from symbol order by qualified_name').all() as Array<{ qualified_name: string }>).map((r) => r.qualified_name))

describe('US18 a contributor adds a language without changing the core', () => {
  it('a person installs a third-party adapter, its files are indexed through the protocol, a changed entry is refused, and removal undoes it', () => {
    const { d, repo, entry } = setup()
    expect(cli(['--data-dir', d, 'index', repo]).status).toBe(0)
    expect(files(d)).toEqual([{ path: 'lib.fake', disposition: 'unsupported', disposition_detail: 'no_adapter:.fake' }, { path: 'main.fake', disposition: 'unsupported', disposition_detail: 'no_adapter:.fake' }])

    const added = cli(['--data-dir', d, 'adapter', 'add', entry, '--id', 'linelang', '--extension', '.fake=linelang'])
    expect(added.status).toBe(0)
    expect(added.stdout).toContain('Installing an adapter is trusting its code')
    expect(cli(['--data-dir', d, 'adapter', 'list']).stdout).toMatch(/^linelang\s+\.fake=linelang\s+.*linelang\.mjs\s+sha256 [0-9a-f]{16}\s+unverified/m)
    expect(cli(['--data-dir', d, 'index', repo]).status).toBe(0)
    expect(files(d)).toEqual([{ path: 'lib.fake', disposition: 'indexed', disposition_detail: null }, { path: 'main.fake', disposition: 'indexed', disposition_detail: null }])
    expect(symbols(d)).toEqual(['lib:helper', 'main:main'])
    const calls = withSnapshot(d, (db) => db.prepare("select resolution, reason from assertion where type = 'calls' order by resolution").all())
    expect(calls).toEqual([{ resolution: 'resolved', reason: null }, { resolution: 'unresolved', reason: 'unknown_name' }])
    const identity = withSnapshot(d, (db) => JSON.parse((db.prepare("select value from meta where key = 'identity'").get() as { value: string }).value))
    expect(identity.adapters.find((a: { id: string }) => a.id === 'linelang')).toMatchObject({ version: '0.1.0', protocol_version: '1.0', entry_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect((tool(d, 'find_symbols', { text: 'helper', freshness: 'strict' }) as any).freshness.status).toBe('current')

    fs.appendFileSync(entry, '// changed after installation\n')
    expect(cli(['--data-dir', d, 'index', repo]).status).toBe(0)
    expect(files(d)).toEqual([{ path: 'lib.fake', disposition: 'unsupported', disposition_detail: 'adapter_changed:linelang' }, { path: 'main.fake', disposition: 'unsupported', disposition_detail: 'adapter_changed:linelang' }])
    expect(symbols(d)).toEqual([])

    expect(cli(['--data-dir', d, 'adapter', 'remove', 'linelang']).status).toBe(0)
    expect(cli(['--data-dir', d, 'index', repo]).status).toBe(0)
    expect(files(d).map((f: any) => f.disposition_detail)).toEqual(['no_adapter:.fake', 'no_adapter:.fake'])
  })

  it('an adapter may not take a built-in name or an extension another adapter analyses', () => {
    const { d, entry } = setup()
    const builtIn = cli(['--data-dir', d, 'adapter', 'add', entry, '--id', 'typescript', '--extension', '.fake=linelang'])
    expect(builtIn.status).not.toBe(0)
    expect(builtIn.stderr).toContain('typescript is a built-in adapter')
    const taken = cli(['--data-dir', d, 'adapter', 'add', entry, '--id', 'linelang', '--extension', '.ts=linelang'])
    expect(taken.status).not.toBe(0)
    expect(taken.stderr).toContain('.ts is analysed by the typescript adapter')
  })
})
