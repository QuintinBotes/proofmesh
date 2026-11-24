import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI, cli, copyFixture, tmpDir, tool } from './helpers.js'

function start(d: string, repo: string, args: string[]) {
  const child = spawn(process.execPath, [CLI, '--data-dir', d, 'watch', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (b) => (out += b))
  const until = async (re: RegExp, ms = 120000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
      const m = re.exec(out)
      if (m) return m
    }
    throw new Error(`watch never printed ${re}; it printed:\n${out}`)
  }
  return { until, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM') }), output: () => out }
}

const indexed = () => {
  const d = tmpDir(), repo = copyFixture()
  for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  return { d, repo, before: (tool(d, 'workspace_status', { limits: { max_rows: 1 } }) as any).snapshot.id as string }
}

describe('FR009 the watcher keeps the snapshot current without depending on notifications', () => {
  it('with notifications ignored, the periodic reconciliation alone picks up an edit and publishes it', async () => {
    const { d, repo, before } = indexed()
    const w = start(d, repo, ['--poll', '--interval', '1', '--quiet-ms', '0'])
    try {
      await w.until(new RegExp(`current ${before}`))
      fs.appendFileSync(path.join(repo, 'packages/format/src/currency.ts'), '\nexport const WATCHED = 1\n')
      const [, published] = await w.until(/snapshot (snap_\w+) published/)
      expect(published).not.toBe(before)
      expect((tool(d, 'find_symbols', { text: 'WATCHED', freshness: 'strict' }) as any).data.symbols.map((s: any) => s.name)).toEqual(['WATCHED'])
    } finally {
      await w.stop()
    }
  }, 240000)

  it('A21 build output written into excluded directories never starts an index; the next edit does', async () => {
    const { d, repo, before } = indexed()
    const w = start(d, repo, ['--poll', '--interval', '1', '--quiet-ms', '0'])
    try {
      await w.until(new RegExp(`current ${before}`))
      for (const dir of ['obj', 'bin', 'dist']) {
        fs.mkdirSync(path.join(repo, 'packages/format', dir), { recursive: true })
        fs.writeFileSync(path.join(repo, 'packages/format', dir, 'out.js'), 'export const generated = 1\n')
      }
      await new Promise((r) => setTimeout(r, 3000))
      expect(w.output()).not.toContain('working tree changed')
      fs.appendFileSync(path.join(repo, 'packages/format/src/currency.ts'), '\nexport const AFTER_BUILD = 1\n')
      await w.until(/working tree changed; indexing\nsnapshot snap_\w+ published/)
    } finally {
      await w.stop()
    }
  }, 240000)

  it('with a one-hour interval, a notification brings the check forward', async () => {
    const { d, repo, before } = indexed()
    const w = start(d, repo, ['--interval', '3600', '--quiet-ms', '300'])
    try {
      await w.until(new RegExp(`current ${before}`))
      fs.writeFileSync(path.join(repo, 'packages/format/src/added.ts'), 'export const added = 1\n')
      await w.until(/snapshot snap_\w+ published/)
      expect(w.output()).toContain('working tree changed; indexing')
    } finally {
      await w.stop()
    }
  }, 240000)
})
