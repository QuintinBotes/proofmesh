import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cli, indexedDataDir, tmpDir, tool } from './helpers.js'

describe('FR050 backup and restore: a consistent copy, verified before anything is restored', () => {
  it('a restored data directory answers the same as the original; a corrupted backup restores nothing', async () => {
    const { dataDir, snapshotId } = await indexedDataDir()
    const before = tool(dataDir, 'find_symbols', { text: 'invoiceTotal' })
    const backup = path.join(tmpDir('pm-backup-'), 'b')
    const r = cli(['--data-dir', dataDir, 'backup', backup])
    expect(r.status, r.stderr).toBe(0)
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'backup-manifest.json'), 'utf8')) as { files: Record<string, string> }
    expect(Object.keys(manifest.files)).toContain('catalog.db')
    expect(Object.keys(manifest.files)).toContain(`snapshots/${snapshotId}.db`)
    expect(Object.keys(manifest.files).some((f) => f.startsWith('staging/'))).toBe(false)
    const into = path.join(tmpDir('pm-restore-'), 'data')
    expect(cli(['restore', backup, '--into', into]).status).toBe(0)
    const after = tool(into, 'find_symbols', { text: 'invoiceTotal' })
    expect(after.data).toEqual(before.data)
    expect(after.snapshot!.id).toBe(snapshotId)
    expect(cli(['restore', backup, '--into', into]).stderr).toMatch(/not empty/)
    fs.chmodSync(path.join(backup, 'snapshots', `${snapshotId}.db`), 0o644)
    fs.appendFileSync(path.join(backup, 'snapshots', `${snapshotId}.db`), 'x')
    const bad = path.join(tmpDir('pm-restore-'), 'data')
    const failed = cli(['restore', backup, '--into', bad])
    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toMatch(/does not match its hash; nothing restored/)
    expect(fs.existsSync(path.join(bad, 'catalog.db'))).toBe(false)
  })
})
