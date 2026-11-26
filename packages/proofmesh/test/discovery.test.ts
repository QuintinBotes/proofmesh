import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discover } from '../src/indexer/discovery.js'
import { tmpDir } from './helpers.js'

function tree(files: Record<string, string>): string {
  const root = tmpDir('pm-disc-')
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
    fs.writeFileSync(path.join(root, p), text)
  }
  return root
}
const git = (cwd: string, ...args: string[]) => expect(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).status).toBe(0)
const statuses = (root: string) => Object.fromEntries(discover(root).map((d) => [d.path, d.status === 'excluded' ? `excluded:${d.detail}` : d.status]))

const FILES = {
  '.gitignore': '.claude/worktrees/\n*.gen.ts\n',
  'src/app.ts': 'export const a = 1\n',
  'src/schema.gen.ts': 'export const generated = 1\n',
  'src/kept.gen.ts': 'export const tracked = 1\n',
  '.claude/worktrees/copy/src/app.ts': 'export const a = 1\n',
  'notes/private.ts': 'export const p = 1\n',
  'dist/out.js': 'console.log(1)\n',
}

describe('A19 discovery honours git ignore rules, and lists what it ignores', () => {
  it('ignored files are excluded_by_rule gitignore; tracked files, and the default rules, win', () => {
    const root = tree(FILES)
    git(root, 'init', '-q')
    fs.appendFileSync(path.join(root, '.git/info/exclude'), 'notes/\n')
    // A tracked file matching an ignore pattern is still content, as git treats it.
    git(root, 'add', '-f', 'src/kept.gen.ts')
    // A directory git ignores as a whole is one entry (FR380): .claude/ holds nothing but the ignored worktrees.
    expect(statuses(root)).toEqual({
      '.claude/': 'excluded:gitignore',
      '.gitignore': 'unsupported',
      'dist/out.js': 'excluded:**/dist/**',
      'notes/': 'excluded:gitignore',
      'src/app.ts': 'capture',
      'src/kept.gen.ts': 'capture',
      'src/schema.gen.ts': 'excluded:gitignore',
    })
  })

  it('outside a git work tree, ignore files have no effect', () => {
    const s = statuses(tree(FILES))
    expect(s['.claude/worktrees/copy/src/app.ts']).toBe('capture')
    expect(s['src/schema.gen.ts']).toBe('capture')
  })
})
