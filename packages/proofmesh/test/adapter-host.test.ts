import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { check } from '../src/core/schemas.js'
import { AdapterProcess, PROTOCOL_VERSION, typescriptAdapterPath } from '../src/indexer/adapter-host.js'
import type { InitializeRequest } from '../src/core/generated.js'
import { cli, FIXTURE, tmpDir } from './helpers.js'

/** The adapter is installed for `.fake` files: a built-in TypeScript or C# adapter that fails falls back to the syntax tier (FR314), an installed one fails the index. */
function indexWith(adapter: string) {
  const d = tmpDir(), src = tmpDir('pm-repo-')
  fs.writeFileSync(path.join(src, 'a.fake'), 'a\n')
  cli(['--data-dir', d, 'init'])
  cli(['--data-dir', d, 'repo', 'add', src])
  expect(cli(['--data-dir', d, 'adapter', 'add', path.join(import.meta.dirname, 'fake-adapters', adapter), '--id', 'fake', '--extension', '.fake=fake']).status).toBe(0)
  const r = cli(['--data-dir', d, 'index', src])
  const c = Catalog.open(d)
  const repo = c.repositories()[0]!
  const current = c.currentSnapshot(repo.id)
  const states = c.db.prepare('select state, failure from snapshot').all() as Array<{ state: string; failure: string }>
  c.close()
  return { r, current, states }
}

describe('A22 adapter protocol 1: semantic versioning', () => {
  const init = (): InitializeRequest => ({ protocol_version: PROTOCOL_VERSION, workspace: tmpDir('pm-ws-'), analysis_mode: 'no_execution', files: [] })
  const withVersion = async (version: string, run: (a: AdapterProcess) => Promise<void>) => {
    const a = new AdapterProcess(path.join(import.meta.dirname, 'fake-adapters', `versioned-${version}.mjs`))
    try { await run(a) } finally { await a.shutdown().catch(() => {}) }
  }

  it('the core speaks 1.2', () => {
    expect(PROTOCOL_VERSION).toBe('1.2')
  })

  it('an adapter of a newer 1.x minor version is accepted, and the fields this core does not know are dropped, not refused', async () => {
    await withVersion('1.7', async (a) => {
      const r = await a.initialize(init())
      expect(r).toEqual({ adapter: { id: 'versioned', version: '0', protocol_version: '1.7', languages: ['typescript'], toolchain: {} }, capabilities: {}, external_inputs: [] })
      await expect(a.analyze([])).resolves.toEqual({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
    })
  })

  it('an adapter of another major version is refused, naming both versions', async () => {
    for (const version of ['2.0', '0.3']) {
      await withVersion(version, async (a) => {
        await expect(a.initialize(init())).rejects.toThrow(`the adapter speaks protocol ${version} and this core speaks 1.x`)
      })
    }
  })
})

describe('AC26 adapter protocol', () => {
  it('a malformed analyze response fails the snapshot, which does not publish', () => {
    const { r, current, states } = indexWith('malformed.mjs')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('invalid analyze response')
    expect(current).toBeUndefined()
    expect(states.map((s) => s.state)).toEqual(['failed'])
  })

  it('an adapter that keeps crashing is restarted once, then the snapshot fails', () => {
    const { r, current } = indexWith('crashing.mjs')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/adapter fake (exited|failed)/)
    expect(current).toBeUndefined()
  })

  it('the timeout measures silence: progress messages keep a long analyze alive, a silent one times out', async () => {
    const slow = path.join(import.meta.dirname, 'fake-adapters', 'slow.mjs')
    const init: InitializeRequest = { protocol_version: PROTOCOL_VERSION, workspace: tmpDir('pm-ws-'), analysis_mode: 'no_execution', files: [] }
    const talking = new AdapterProcess(slow, 300)
    await talking.initialize(init)
    await expect(talking.analyze([])).resolves.toEqual({ symbols: [], relationships: [], file_results: [], diagnostics: [] })
    await talking.shutdown()
    const silent = new AdapterProcess(path.join(import.meta.dirname, 'fake-adapters', 'slow-silent.mjs'), 300)
    await silent.initialize(init)
    await expect(silent.analyze([])).rejects.toThrow('analyze timed out: no message from the adapter for 300 ms')
    await silent.shutdown()
  })

  it('A1 every message the real TypeScript adapter sends validates against the protocol schemas, and its compiler is typescript 6.x', async () => {
    const fs = await import('node:fs')
    const ws = tmpDir('pm-ws-')
    fs.cpSync(FIXTURE, ws, { recursive: true })
    const files = ['tsconfig.json', 'packages/api/src/handler.ts', 'packages/billing/src/index.ts', 'packages/billing/src/invoice.ts', 'packages/format/src/currency.ts', 'packages/format/src/index.ts', 'packages/legacy/src/format.ts']
    const a = new AdapterProcess(typescriptAdapterPath())
    const init = await a.initialize({ protocol_version: PROTOCOL_VERSION, workspace: ws, analysis_mode: 'no_execution', files: files.map((p) => ({ path: p, content_hash: '0'.repeat(64), language: p.endsWith('.json') ? 'json' : 'typescript' })) })
    expect(check('adapter-protocol/initialize.response.schema.json', init)).toBeUndefined()
    const res = await a.analyze(files.filter((f) => f.endsWith('.ts')))
    expect(check('adapter-protocol/analyze.response.schema.json', res)).toBeUndefined()
    expect(init.adapter.toolchain.typescript).toMatch(/^6\./)
    await a.shutdown()
  })
})
