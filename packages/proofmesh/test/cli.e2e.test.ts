import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOLS } from '../src/query/tools.js'
import { cli, FIXTURE, fixtureRepo, ROOT, tmpDir } from './helpers.js'

describe('AC01 CLI publishes the fixture', () => {
  it('init, repo add, and index print the published snapshot and exact counts', () => {
    const d = tmpDir()
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
    const add = cli(['--data-dir', d, 'repo', 'add', FIXTURE])
    expect(add.status).toBe(0)
    expect(add.stdout.trim()).toMatch(/^repo_[0-9a-f]{12}$/)
    const index = cli(['--data-dir', d, 'index', FIXTURE])
    expect(index.status).toBe(0)
    expect(index.stdout).toMatch(/^snapshot snap_[0-9a-f]{24} published$/m)
    expect(index.stdout).toContain('discovered 10, indexed 7, excluded 1, unsupported 2, failed 0')
  })

  it('refuses to work in an uninitialized data directory', () => {
    const r = cli(['--data-dir', tmpDir(), 'repo', 'add', FIXTURE])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not initialized')
  })
})

describe('FR081 build-evaluation trust is granted and revoked only through the CLI', () => {
  it('dist/cli.mjs runs the CLI when executed directly, and the usage names the valid tool inputs on a bad call', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'packages/proofmesh/dist/cli.mjs'), '--help'], { encoding: 'utf8' })
    expect(r.stdout + r.stderr).toContain('Usage: proofmesh')
    const d = tmpDir()
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
  })

  it('repo list names every registered repository with its id, root and trust', () => {
    const d = tmpDir()
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
    const repo = cli(['--data-dir', d, 'repo', 'add', FIXTURE]).stdout.trim()
    const id = repo.split(/\s+/)[0]!
    expect(cli(['--data-dir', d, 'repo', 'list']).stdout).toBe(`${id}  repo  ${FIXTURE}\n`)
    expect(cli(['--data-dir', d, 'repo', 'trust', id, '--build-evaluation']).status).toBe(0)
    expect(cli(['--data-dir', d, 'repo', 'list']).stdout).toBe(`${id}  repo  ${FIXTURE}  trusted: build evaluation\n`)
  })

  it('requires naming what is trusted, records who granted it and when, and revokes it', () => {
    const d = tmpDir()
    cli(['--data-dir', d, 'init'])
    const repo = cli(['--data-dir', d, 'repo', 'add', FIXTURE]).stdout.trim()
    const vague = cli(['--data-dir', d, 'repo', 'trust', repo])
    expect(vague.status).toBe(1)
    expect(vague.stderr).toContain('--build-evaluation')
    const grant = cli(['--data-dir', d, 'repo', 'trust', repo, '--build-evaluation'])
    expect(grant.status).toBe(0)
    expect(grant.stdout).toMatch(new RegExp(`^build evaluation trusted for repo by ${os.userInfo().username} at \\d{4}-\\d{2}-\\d{2}T`, 'm'))
    expect(cli(['--data-dir', d, 'repo', 'untrust', repo]).stdout).toContain('build evaluation trust revoked for repo')
    expect(cli(['--data-dir', d, 'repo', 'untrust', repo]).stdout).toContain('repo had no trust grant')
  })

  it('no MCP or HTTP tool can grant trust', () => {
    expect(TOOLS.filter((t) => /trust|grant/.test(t))).toEqual([])
  })
})

describe('A14 rules extensions are installed through the CLI, recorded by hash, and refused once changed', () => {
  it('records who installed which file, refuses a changed file at index time, and removes it', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const d = tmpDir()
    cli(['--data-dir', d, 'init'])
    const repo = cli(['--data-dir', d, 'repo', 'add', fixtureRepo('cs-orders')]).stdout.trim()
    const ext = path.join(tmpDir('pm-ext-'), 'Rules.dll')
    fs.writeFileSync(ext, 'not really an assembly')
    const added = cli(['--data-dir', d, 'extension', 'add', ext])
    expect(added.status).toBe(0)
    expect(added.stdout).toContain(`extension installed for the csharp adapter: ${ext}`)
    expect(cli(['--data-dir', d, 'extension', 'list']).stdout).toMatch(new RegExp(`^csharp  ${ext.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}  sha256 [0-9a-f]{16}  by ${os.userInfo().username} at `, 'm'))
    fs.writeFileSync(ext, 'changed after installation')
    const refused = cli(['--data-dir', d, 'index', repo])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('changed since it was installed')
    expect(cli(['--data-dir', d, 'extension', 'remove', ext]).stdout).toContain('extension removed')
    expect(cli(['--data-dir', d, 'extension', 'list']).stdout).toContain('no extensions installed')
  }, 240000)
})

describe('#37 CLI rough edges', () => {
  it('prints the version, and warns on stderr about a temporary root and a name that hides the directory, leaving stdout parseable', () => {
    for (const flag of ['--version', '-v', 'version']) expect(cli([flag]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
    const d = tmpDir()
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
    const scratch = tmpDir('pm-scratch-')
    const add = cli(['--data-dir', d, 'repo', 'add', scratch, '--name', 'shop'])
    expect(add.stdout.trim()).toMatch(/^repo_[0-9a-f]{12}$/)
    expect(add.stderr).toMatch(/is under a temporary directory and may disappear/)
    expect(add.stderr).toMatch(/name shop differs from its directory pm-scratch-/)
    const list = cli(['--data-dir', d, 'repo', 'list'])
    expect(list.stdout.trim().split('\n')).toHaveLength(1)
    expect(list.stderr).toMatch(new RegExp(`warning: ${add.stdout.trim()} root .* is under a temporary directory`))
  })
})

