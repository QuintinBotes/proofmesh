import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { indexRepository } from '../src/indexer/coordinator.js'
import { Registry } from '../src/indexer/languages.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { cli, EXPECTED, FIXTURE, tmpDir, tool } from './helpers.js'

const LINELANG = new Registry([{ id: 'linelang', languages: new Set(['linelang']), extensions: { '.fake': 'linelang' }, isConfig: () => false, entry: () => path.join(import.meta.dirname, 'fake-adapters', 'linelang.mjs'), unavailable: () => 'adapter_unavailable:linelang' }])
const MARKER = 'OUTSIDE-THE-ROOT-7f3a9c'

function write(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
    fs.writeFileSync(path.join(root, p), text)
  }
}

async function indexed(repo: string): Promise<string> {
  const d = tmpDir()
  initDataDir(d)
  const c = Catalog.open(d)
  c.addRepository(repo)
  c.close()
  await indexRepository(d, repo, undefined, LINELANG)
  return d
}

type FileRow = { path: string; disposition: string; detail: string | null; capabilities: Record<string, string> }
const rows = (d: string, files: Record<string, unknown> = {}) => tool(d, 'workspace_status', { files }).data.files as FileRow[]
const objects = (d: string) => fs.readdirSync(path.join(d, 'objects'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name)))

/**
 * A repository outside any git work tree, with one file of each disposition a published snapshot can hold, and three symbolic links:
 * one back to the root (a cycle), one to a file outside the root and one to a directory outside it.
 */
describe('discovery and coverage of a repository with every disposition', () => {
  let repo: string, d: string
  beforeAll(async () => {
    repo = tmpDir('pm-cov-')
    const outside = tmpDir('pm-outside-')
    write(repo, {
      'main.fake': 'def main\n  call helper\n',
      'lib.fake': 'def helper\n',
      'broken.fake': 'def half\n! unterminated\n',
      'big.fake': `def big\n${'#'.repeat(1048576)}\n`,
      'node_modules/dep/index.fake': 'def dep\n',
      'notes.txt': 'notes\n',
    })
    write(outside, { 'secret.fake': `def leaked\n# ${MARKER}\n`, 'dir/inner.fake': `def inner\n# ${MARKER}\n` })
    fs.symlinkSync('.', path.join(repo, 'loop'))
    fs.symlinkSync(path.join(outside, 'secret.fake'), path.join(repo, 'secret.fake'))
    fs.symlinkSync(path.join(outside, 'dir'), path.join(repo, 'ext'))
    d = await indexed(repo)
  }, 120000)

  it('FR002 every file has exactly one disposition: indexed, excluded_by_rule, unsupported, or failed when its adapter fails it', () => {
    expect(Object.fromEntries(rows(d).map((f) => [f.path, [f.disposition, f.detail]]))).toEqual({
      'big.fake': ['excluded_by_rule', 'max_file_bytes:1048576'],
      'broken.fake': ['failed', 'syntax_error:line 2'],
      ext: ['unsupported', 'symlink_not_followed'],
      'lib.fake': ['indexed', null],
      loop: ['unsupported', 'symlink_not_followed'],
      'main.fake': ['indexed', null],
      'node_modules/dep/index.fake': ['excluded_by_rule', '**/node_modules/**'],
      'notes.txt': ['unsupported', 'no_adapter:.txt'],
      'secret.fake': ['unsupported', 'symlink_not_followed'],
    })
    expect(tool(d, 'workspace_status').coverage!.dispositions).toEqual({ indexed: 2, excluded_by_rule: 2, unsupported: 4, failed: 1, pending: 0 })
  })

  it('FR094 a file the snapshot holds as failed is refused by its path, naming that disposition, never answered empty', () => {
    let refused = 'answered'
    try { tool(d, 'get_relationships', { path: 'broken.fake' }) } catch (e: any) { refused = `${e.code}: ${e.message}` }
    expect(refused).toMatch(/^INVALID_ARGUMENT: .*broken\.fake.*failed/)
  })

  it('FR003 every file row reports each of the seven capabilities separately', () => {
    // An analysed source file also records the tier that read it, as the additive key tier (FR137).
    const analysed = { text: 'complete', syntax: 'unsupported', symbols: 'complete', imports: 'unsupported', references: 'unsupported', resolved_calls: 'complete', framework: 'unsupported', tier: 'precise:linelang' }
    const failed = { text: 'complete', syntax: 'failed', symbols: 'failed', imports: 'failed', references: 'failed', resolved_calls: 'failed', framework: 'failed' }
    const notRun = { text: 'not_run', syntax: 'not_run', symbols: 'not_run', imports: 'not_run', references: 'not_run', resolved_calls: 'not_run', framework: 'not_run' }
    expect(Object.fromEntries(rows(d).map((f) => [f.path, f.capabilities]))).toEqual({
      'big.fake': notRun, 'broken.fake': failed, ext: notRun, 'lib.fake': analysed, loop: notRun, 'main.fake': analysed,
      'node_modules/dep/index.fake': notRun, 'notes.txt': notRun, 'secret.fake': notRun,
    })
  })

  it('FR004 exclusion rules, oversized files and errors are listed by rule, and status names the analysis configuration and each adapter\'s external inputs', () => {
    expect(rows(d, { disposition: ['excluded_by_rule', 'failed'] }).map((f) => [f.path, f.disposition, f.detail])).toEqual([
      ['big.fake', 'excluded_by_rule', 'max_file_bytes:1048576'],
      ['broken.fake', 'failed', 'syntax_error:line 2'],
      ['node_modules/dep/index.fake', 'excluded_by_rule', '**/node_modules/**'],
    ])
    const status = cli(['--data-dir', d, 'status'])
    expect(status.status, status.stderr).toBe(0)
    expect(status.stdout).toContain('analysis binary_probe_bytes 8192; excluded_dirs **/node_modules/** **/dist/** **/build/** **/bin/** **/obj/**; ignore git; max_file_bytes 1048576; metadata_dirs .git; symlinks not_followed\n')
    expect(status.stdout).toContain('adapter linelang 0.1.0 no_execution: 0 external inputs read, 0 missing\n')
    // The same over MCP, with the generated-source policy of the mode.
    const analysis = (tool(d, 'workspace_status').data as { analysis: { mode: string; config: Record<string, unknown>; generated_sources: string; dependencies: unknown[] } }).analysis
    expect(analysis.config).toMatchObject({ max_file_bytes: 1048576, symlinks: 'not_followed', ignore: 'git' })
    expect(analysis.mode).toBe('no_execution')
    expect(analysis.generated_sources).toMatch(/^No build logic ran, so no source generator/)
    expect(analysis.dependencies).toEqual([{ adapter: 'linelang', analysis_mode: 'no_execution', inputs_read: 0, inputs_missing: 0, missing: [] }])
  })

  it('FR005 discovery ends on a symlink cycle, follows no link out of the root, and stores no byte from outside it', () => {
    const inventory = rows(d).map((f) => f.path)
    expect(inventory.filter((p) => p.startsWith('loop/') || p.startsWith('ext/'))).toEqual([])
    const stored = objects(d)
    expect(stored.some((o) => o.toString('utf8') === 'def helper\n')).toBe(true)
    expect(stored.filter((o) => o.includes(MARKER))).toEqual([])
    expect((tool(d, 'find_symbols', { text: 'helper' }).data.symbols as Array<{ qualified_name: string }>).map((s) => s.qualified_name)).toEqual(['lib:helper'])
    expect(tool(d, 'find_symbols', { text: 'leaked' }).data.symbols).toEqual([])
    expect(tool(d, 'find_symbols', { text: 'inner' }).data.symbols).toEqual([])
  })

  it('FR006 a repository outside git is indexed, and its git metadata is reported unavailable with the reason', () => {
    const env = tool(d, 'workspace_status')
    expect((env.data.repository as { git: unknown }).git).toEqual({ available: false, reason: 'no_git' })
    expect(env.snapshot).toMatchObject({ commit: null, ref: null })
  })
})

describe('FR006 git metadata of a root inside a work tree it is not the top of', () => {
  it('is reported unavailable, naming root_is_not_worktree_top', async () => {
    const top = tmpDir('pm-gittop-')
    expect(spawnSync('git', ['init', '-q'], { cwd: top }).status).toBe(0)
    write(top, { 'sub/main.fake': 'def main\n' })
    const d = await indexed(path.join(top, 'sub'))
    expect((tool(d, 'workspace_status').data.repository as { git: unknown }).git).toEqual({ available: false, reason: 'root_is_not_worktree_top' })
  }, 120000)
})

describe('FR002 pending is the disposition of a captured file not yet analysed, and no published snapshot holds it', () => {
  it('an interrupted index leaves its captured files pending in staging, publishes nothing, and the resumed index publishes none pending', () => {
    const d = tmpDir()
    for (const args of [['init'], ['repo', 'add', FIXTURE]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const index = (env: Record<string, string> = {}) => cli(['--data-dir', d, 'index', FIXTURE], { PROOFMESH_INDEX_BATCH: '1', ...env })
    expect(index({ PROOFMESH_FAULT_POINT: 'after_batch' }).status).toBe(70)

    const staging = fs.readdirSync(path.join(d, 'staging')).find((n) => n.startsWith('snap_'))!
    const db = new Database(path.join(d, 'staging', staging, 'snapshot.db'), { readonly: true })
    const staged = Object.fromEntries((db.prepare('select path, disposition, disposition_detail from file').all() as Array<{ path: string; disposition: string; disposition_detail: string | null }>).map((f) => [f.path, [f.disposition, f.disposition_detail]]))
    db.close()
    const captured = Object.fromEntries(Object.entries(EXPECTED.dispositions as Record<string, [string, string | null]>).map(([p, [disposition, detail]]) => [p, [disposition === 'indexed' ? 'pending' : disposition, detail]]))
    expect(staged).toEqual(captured)
    const refused = cli(['--data-dir', d, 'status'])
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('no published snapshot for this repository')

    expect(index().status).toBe(0)
    expect(rows(d, { disposition: ['pending'] })).toEqual([])
    expect(rows(d, { disposition: ['indexed'] })).toHaveLength(7)
    expect(tool(d, 'workspace_status').coverage!.dispositions.pending).toBe(0)
  }, 300000)
})
