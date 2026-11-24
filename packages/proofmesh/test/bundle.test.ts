import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkBundle } from '../src/bundle/bundle.js'
import { cli, indexedDataDir, symbolId, tmpDir } from './helpers.js'

const query = (d: string) => JSON.stringify({ tool: 'get_symbol', input: { symbol_id: symbolId(d, 'packages/billing/src/invoice:invoiceTotal') } })

describe('FR032 FR052 evidence bundles are checked offline, and carry source only with consent', () => {
  it('SC009 exports a bundle whose manifest hashes every file, checks it with no data directory, and fails on any change', async () => {
    const { dataDir, snapshotId, repoId } = await indexedDataDir()
    const out = path.join(tmpDir('pm-bundle-'), 'answers.pmb')
    const r = cli(['--data-dir', dataDir, 'bundle', 'export', repoId, '--out', out, '--query', query(dataDir), '--include-source'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^bundle pmb_[0-9a-f]{24} written to .*answers\.pmb: 1 queries, \d+ evidence items with source, as you consented/)
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
    expect(manifest.snapshot.id).toBe(snapshotId)
    expect(manifest.evidence.length).toBeGreaterThan(0)
    expect(manifest.evidence.every((e: { file: string | null }) => e.file)).toBe(true)
    const check = cli(['bundle', 'check', out], { PROOFMESH_DATA_DIR: tmpDir('pm-nodata-') })
    expect(check.status, check.stderr).toBe(0)
    expect(check.stdout).toMatch(/^ok: \d+ verified, 0 failed, 0 unverifiable\n$/)
    const evidence = fs.readdirSync(path.join(out, 'evidence'))[0]!
    fs.appendFileSync(path.join(out, 'evidence', evidence), 'x')
    expect(checkBundle(out)).toMatchObject({ ok: false, failed: [`evidence/${evidence} does not match its hash`] })
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ ...manifest, created_at: 'later' }, null, 2))
    expect(checkBundle(out).failed).toContain('manifest hash does not match its content')
    fs.rmSync(path.join(out, 'queries', '1.json'))
    expect(checkBundle(out).failed).toContain('queries/1.json is missing')
  })

  it('without consent no source byte leaves the data directory, and the checker says what it could not verify', async () => {
    const { dataDir, repoId } = await indexedDataDir()
    const out = path.join(tmpDir('pm-bundle-'), 'hashes.pmb')
    expect(cli(['--data-dir', dataDir, 'bundle', 'export', repoId, '--out', out, '--query', query(dataDir)]).stdout).toMatch(/hashes only \(add --include-source/)
    expect(fs.existsSync(path.join(out, 'evidence'))).toBe(false)
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
    expect(manifest.evidence.every((e: { file: string | null; slice_sha256: string }) => e.file === null && /^[0-9a-f]{64}$/.test(e.slice_sha256))).toBe(true)
    const r = checkBundle(out)
    expect(r.ok).toBe(true)
    expect(r.unverifiable.length).toBe(manifest.evidence.length)
    expect(cli(['--data-dir', dataDir, 'bundle', 'export', repoId, '--out', out]).stderr).toMatch(/already exists/)
  })
})
