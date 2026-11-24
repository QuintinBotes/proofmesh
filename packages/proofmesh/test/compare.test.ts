import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { check } from '../src/core/schemas.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { cli, copyFixture, expectedFor, tmpDir, tool } from './helpers.js'

const repoId = (d: string, root: string) => { const c = Catalog.open(d); try { return c.repository(root).id } finally { c.close() } }

const index = (d: string, repo: string) => { const r = cli(['--data-dir', d, 'index', repo]); expect(r.status, r.stderr).toBe(0); return /snapshot (snap_\w+) published/.exec(r.stdout)![1]! }

describe('FR019 FR063 compare_snapshots: two sealed files of one repository, read side by side', () => {
  it('reports exactly the symbols, relationships and files that changed between two indexes', () => {
    const repo = copyFixture(), d = tmpDir()
    for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const base = index(d, repo)
    // Three edits a reviewer would make: a signature change, a new file with a new function, a deleted file.
    const currency = path.join(repo, 'packages/format/src/currency.ts')
    fs.writeFileSync(currency, fs.readFileSync(currency, 'utf8').replace('export function formatAmount(cents: number, currency: string)', 'export function formatAmount(cents: number, currency: string, locale = "en")'))
    fs.writeFileSync(path.join(repo, 'packages/format/src/extra.ts'), 'export function extra(): number {\n  return 1\n}\n')
    fs.rmSync(path.join(repo, 'packages/legacy/src/format.ts'))
    const head = index(d, repo)
    expect(head).not.toBe(base)

    const r = tool(d, 'compare_snapshots', { base_snapshot_id: base }) as any
    expect(check('envelope.schema.json', r)).toBeUndefined()
    expect(check('tools/compare_snapshots.data.schema.json', r.data)).toBeUndefined()
    expect(r.snapshot.id).toBe(head)
    expect(r.data.base.snapshot_id).toBe(base)
    expect(r.data.head.snapshot_id).toBe(head)
    const sym = (s: any) => [s.kind, s.qualified_name, s.path]
    expect(r.data.symbols.added.map(sym)).toEqual([['module', 'packages/format/src/extra', 'packages/format/src/extra.ts'], ['function', 'packages/format/src/extra:extra', 'packages/format/src/extra.ts']])
    expect(r.data.symbols.removed.map(sym)).toEqual(expectedFor('ts-invoicing').symbols.filter((s: any) => s.qualified_name.startsWith('packages/legacy/src/format')).map((s: any) => [s.kind, s.qualified_name, 'packages/legacy/src/format.ts']).sort((a: string[], b: string[]) => (a[1]! < b[1]! ? -1 : 1)))
    expect(r.data.symbols.changed.map((s: any) => [s.qualified_name, s.what])).toEqual([['packages/format/src/currency:formatAmount', ['signature', 'body']]])
    expect(r.data.symbols.counts).toEqual({ added: 2, removed: r.data.symbols.removed.length, changed: 1, paired: 0, ambiguous: 0 })
    expect(r.data.files).toEqual({ added: ['packages/format/src/extra.ts'], removed: ['packages/legacy/src/format.ts'], changed: ['packages/format/src/currency.ts'], disposition_changes: [] })
    // The deleted decoy's relationships leave; the new file's module has none, so nothing is added.
    expect(r.data.relationships.added).toBe(0)
    expect(r.data.relationships.removed).toBeGreaterThan(0)
    expect(Object.values(r.data.relationships.by_type).reduce((a: number, t: any) => a + t.removed, 0)).toBe(r.data.relationships.removed)
    expect(r.data.base.symbols - r.data.head.symbols).toBe(r.data.symbols.counts.removed - r.data.symbols.counts.added)
    expect(r.completion.truncated).toBe(false)
    expect(r.limitations).toContain('Symbols are matched by kind and qualified name; a removed and an added symbol that match by body hash are paired instead.')
  }, 240000)

  it('a snapshot compared with itself changes nothing, and a snapshot of another repository is refused', () => {
    const repo = copyFixture(), other = copyFixture(), d = tmpDir()
    for (const args of [['init'], ['repo', 'add', repo, '--name', 'one'], ['repo', 'add', other, '--name', 'two']]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const a = index(d, repo), b = index(d, other)
    const same = tool(d, 'compare_snapshots', { repository_id: repoId(d, repo), base_snapshot_id: a, snapshot_id: a }) as any
    expect(same.data.symbols.counts).toEqual({ added: 0, removed: 0, changed: 0, paired: 0, ambiguous: 0 })
    expect(same.data.relationships).toMatchObject({ added: 0, removed: 0 })
    expect(same.data.files).toEqual({ added: [], removed: [], changed: [], disposition_changes: [] })
    expect(() => tool(d, 'compare_snapshots', { repository_id: same.snapshot.repository_id, base_snapshot_id: b })).toThrow(/same repository/)
  }, 240000)

  it('shortens its lists to max_rows and says so', () => {
    const repo = copyFixture(), d = tmpDir()
    for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const base = index(d, repo)
    fs.rmSync(path.join(repo, 'packages/legacy/src/format.ts'))
    index(d, repo)
    const r = tool(d, 'compare_snapshots', { base_snapshot_id: base, limits: { max_rows: 1 } }) as any
    expect(r.data.symbols.removed).toHaveLength(1)
    expect(r.data.symbols.counts.removed).toBeGreaterThan(1)
    expect(r.completion).toMatchObject({ truncated: true, stop_reasons: ['max_rows'] })
  }, 240000)
})
