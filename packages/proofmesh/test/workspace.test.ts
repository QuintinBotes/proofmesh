import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cli, fixtureRepo, tmpDir } from './helpers.js'

describe('A29 named workspaces group repositories into an ecosystem', () => {
  it('a person creates one by adding repositories, lists it, and removes members or the whole workspace', () => {
    const d = tmpDir(), a = tmpDir('pm-ws-a-'), b = tmpDir('pm-ws-b-')
    fs.cpSync(fixtureRepo('ts-invoicing'), a, { recursive: true })
    fs.cpSync(fixtureRepo('cs-orders'), b, { recursive: true })
    for (const args of [['init'], ['repo', 'add', a, '--name', 'alpha'], ['repo', 'add', b, '--name', 'beta']]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    expect(cli(['--data-dir', d, 'workspace', 'list']).stdout).toMatch(/^no workspaces/)
    expect(cli(['--data-dir', d, 'workspace', 'add', 'shop', a, b]).stdout).toMatch(/^workspace shop: 2 repositories \(added alpha, beta\)/)
    expect(cli(['--data-dir', d, 'workspace', 'add', 'shop', a]).stdout).toMatch(/^workspace shop: 2 repositories/)
    expect(cli(['--data-dir', d, 'workspace', 'list']).stdout).toMatch(/^shop {2}alpha, beta {2}by \S+ at /)
    expect(cli(['--data-dir', d, 'workspace', 'remove', 'shop', b]).stdout).toBe('1 repositories removed from workspace shop\n')
    expect(cli(['--data-dir', d, 'workspace', 'remove', 'shop']).stdout).toBe('workspace shop removed\n')
    expect(cli(['--data-dir', d, 'workspace', 'list']).stdout).toMatch(/^no workspaces/)
    expect(cli(['--data-dir', d, 'workspace', 'add', 'bad name', a]).status).not.toBe(0)
  })
})
