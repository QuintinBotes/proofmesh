import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runKit } from '../src/conformance/kit.js'
import { BUILT_IN } from '../src/indexer/languages.js'
import { cli, copyTrackedFixture, expectedFor, fixtureRepo, ROOT, tmpDir } from './helpers.js'

const fake = (name: string) => path.join(import.meta.dirname, 'fake-adapters', `${name}.mjs`)
const linelang = (name = 'linelang') => ({ id: 'linelang', entry: fake(name), extensions: { '.fake': 'linelang' }, configNames: [] })
const builtIn = (id: string) => { const b = BUILT_IN.find((x) => x.id === id)!; return { id, entry: b.entry()!, extensions: b.extensions, configNames: [] } }
const failed = (r: Awaited<ReturnType<typeof runKit>>) => r.checks.filter((c) => !c.passed).map((c) => c.id)
const ALL = ['protocol.initialize', 'protocol.workspace', 'protocol.analyze', 'protocol.shutdown', 'index.publishes', 'index.deterministic']

describe('FR071 FR072 SC014 the public conformance kit', () => {
  it('SC014 the TypeScript adapter passes on its fixture and reviewed expected facts', async () => {
    const r = await runKit(builtIn('typescript'), fixtureRepo('ts-invoicing'), expectedFor('ts-invoicing'))
    expect(failed(r)).toEqual([])
    expect(r.checks.map((c) => c.id)).toEqual([...ALL, 'golden.dispositions', 'golden.symbols', 'golden.calls', 'golden.imports'])
    expect(r.adapter).toMatchObject({ id: 'typescript', protocol_version: '1.3' })
  }, 240000)

  it('SC014 the C# adapter passes on its fixture and reviewed expected facts', async () => {
    const r = await runKit(builtIn('csharp'), copyTrackedFixture('cs-orders'), expectedFor('cs-orders'))
    expect(failed(r)).toEqual([])
    expect(r.checks.map((c) => c.id)).toEqual([...ALL, 'golden.dispositions', 'golden.symbols', 'golden.calls', 'golden.structure'])
  }, 240000)

  it('US18 a third-party adapter passes on its own fixture and expected facts', async () => {
    const r = await runKit(linelang(), fixtureRepo('linelang'), expectedFor('linelang'))
    expect(failed(r)).toEqual([])
  }, 120000)

  it('each broken adapter fails the check that names its fault', async () => {
    const fixture = fixtureRepo('linelang')
    expect(failed(await runKit(linelang('linelang-intolerant'), fixture))).toContain('protocol.initialize')
    expect(failed(await runKit(linelang('linelang-stray'), fixture))).toContain('protocol.analyze')
    const range = await runKit(linelang('linelang-range'), fixture)
    expect(failed(range)).toContain('index.publishes')
    expect(range.checks.find((c) => c.id === 'index.publishes')!.detail).toContain('does not fit')
    expect(failed(await runKit(linelang('linelang-random'), fixture))).toEqual(['index.deterministic'])
    expect(failed(await runKit(linelang('linelang-linger'), fixture))).toEqual(['protocol.shutdown'])
    const expected = expectedFor('linelang')
    expected.calls[0].to = 'main:main'
    expect(failed(await runKit(linelang(), fixture, expected))).toEqual(['golden.calls'])
  }, 240000)

  it('FR072 an installed adapter is unverified until it passes, and its verdict lapses when its entry changes', () => {
    const d = tmpDir(), adapterDir = tmpDir('pm-adapter-')
    const entry = path.join(adapterDir, 'linelang.mjs')
    fs.copyFileSync(fake('linelang'), entry)
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
    expect(cli(['--data-dir', d, 'adapter', 'add', entry, '--id', 'linelang', '--extension', '.fake=linelang']).status).toBe(0)
    expect(cli(['--data-dir', d, 'adapter', 'list']).stdout).toContain('unverified')
    const checked = cli(['--data-dir', d, 'adapter', 'check', 'linelang', '--fixture', fixtureRepo('linelang'), '--expected', path.join(ROOT, 'fixtures', 'linelang', 'expected.json')])
    expect(checked.status).toBe(0)
    expect(checked.stdout).toContain('linelang passes the conformance kit')
    expect(cli(['--data-dir', d, 'adapter', 'list']).stdout).toContain('passed the conformance kit at')
    fs.appendFileSync(entry, '// changed\n')
    expect(cli(['--data-dir', d, 'adapter', 'add', entry, '--id', 'linelang', '--extension', '.fake=linelang']).status).toBe(0)
    expect(cli(['--data-dir', d, 'adapter', 'list']).stdout).toContain('unverified')
  }, 240000)
})
