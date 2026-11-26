import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { indexRepository } from '../src/indexer/coordinator.js'
import { discover, discoverAsync } from '../src/indexer/discovery.js'
import { BUILT_IN_REGISTRY } from '../src/indexer/languages.js'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { openSnapshot } from '../src/meshstore/snapshot.js'
import { tmpDir } from './helpers.js'

function tree(files: Record<string, string>): string {
  const root = tmpDir('pm-ign-')
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
    fs.writeFileSync(path.join(root, p), text)
  }
  return root
}
const git = (cwd: string, ...args: string[]) => expect(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd }).status).toBe(0)
/** `count` build outputs under dir: half beside each other, half one level down. */
const outputs = (dir: string, count = 40) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${dir}/${i % 2 ? 'Debug/' : ''}out${i}.txt`, `${i}\n`]))
const statuses = (entries: Array<{ path: string; status: string; detail: string | null }>) =>
  Object.fromEntries(entries.map((d) => [d.path, d.status === 'excluded' || d.status === 'unsupported' ? `${d.status}:${d.detail}` : d.status]))

/** Every filesystem call discovery makes on a path inside `dir`, counted by wrapping the fs functions it uses. */
function fileCallsInside(dir: string): () => number {
  let n = 0
  // A registered repository is read at its real path (/private/var on macOS), a bare discover at the path it is given.
  const prefixes = [dir, fs.realpathSync(dir)].map((d) => d + path.sep)
  const inside = (p: unknown) => typeof p === 'string' && prefixes.some((d) => p.startsWith(d))
  for (const name of ['readdirSync', 'statSync', 'lstatSync', 'openSync', 'readFileSync', 'existsSync'] as const) {
    const real = fs[name] as (...a: unknown[]) => unknown
    vi.spyOn(fs, name).mockImplementation(((...a: unknown[]) => { if (inside(a[0])) n++; return real(...a) }) as never)
  }
  return () => n
}

function indexFiles(root: string, rev?: string): Promise<Array<{ path: string; disposition: string; detail: string | null }>> {
  const d = tmpDir()
  initDataDir(d)
  const c = Catalog.open(d)
  const id = c.addRepository(root).id
  c.close()
  return indexRepository(d, id, undefined, undefined, rev).then(() => {
    const catalog = Catalog.open(d)
    try {
      const db = openSnapshot(catalog, catalog.currentSnapshot(id)!)
      try { return db.prepare('select path, disposition, disposition_detail as detail from file order by path').all() as Array<{ path: string; disposition: string; detail: string | null }> } finally { db.close() }
    } finally { catalog.close() }
  })
}

afterEach(() => { vi.restoreAllMocks() })

describe('FR380 a directory git ignores as a whole is one ignored entry, and discovery never enters it', () => {
  it('an ignored obj/ with many files gets no file calls inside it, and the snapshot lists obj/ once, as ignored', async () => {
    const root = tree({ '.gitignore': 'obj/\n', 'src/a.txt': 'a\n', ...outputs('obj') })
    git(root, 'init', '-q')
    const calls = fileCallsInside(path.join(root, 'obj'))
    const files = await indexFiles(root)
    expect(calls()).toBe(0)
    expect(files.filter((f) => f.path.startsWith('obj'))).toEqual([{ path: 'obj/', disposition: 'excluded_by_rule', detail: 'gitignore' }])
    expect(files.map((f) => f.path)).toEqual(['.gitignore', 'obj/', 'src/a.txt'])
  }, 120000)
})

describe('FR381 a directory git ignores only in part is still walked', () => {
  it('its tracked and untracked files are recorded as before, and only its wholly ignored subdirectory is one entry', () => {
    const root = tree({ '.gitignore': 'p/*.log\np/obj/\n', 'p/tracked.txt': 't\n', 'p/new.txt': 'n\n', 'p/run.log': 'l\n', ...outputs('p/obj') })
    git(root, 'init', '-q')
    git(root, 'add', 'p/tracked.txt')
    const calls = fileCallsInside(path.join(root, 'p', 'obj'))
    const found = discover(root)
    expect(calls()).toBe(0)
    expect(statuses(found)).toEqual({
      '.gitignore': 'unsupported:no_adapter:.gitignore',
      'p/new.txt': 'unsupported:no_adapter:.txt',
      'p/obj/': 'excluded:gitignore',
      'p/run.log': 'excluded:gitignore',
      'p/tracked.txt': 'unsupported:no_adapter:.txt',
    })
  })
})

describe('FR382 an index of a commit is unchanged', () => {
  it('--rev reads tracked files under an ignored directory one by one, as before, and no directory entry', async () => {
    const root = tree({ '.gitignore': 'out/\n', 'src/a.txt': 'a\n', 'out/keep.txt': 'k\n' })
    git(root, 'init', '-q')
    git(root, 'add', '.gitignore', 'src/a.txt')
    git(root, 'add', '-f', 'out/keep.txt')
    git(root, 'commit', '-q', '-m', 'c')
    // Untracked output in the working tree is no part of the commit.
    for (const [p, t] of Object.entries(outputs('out'))) fs.writeFileSync(path.join(root, p.replace('/Debug/', '/')), t)
    const files = await indexFiles(root, 'HEAD')
    expect(files.map((f) => [f.path, f.disposition])).toEqual([['.gitignore', 'unsupported'], ['out/keep.txt', 'unsupported'], ['src/a.txt', 'unsupported']])
  }, 120000)
})

describe('FR383 a negation inside an ignored directory still finds that file', () => {
  it('obj/* with !obj/keep.txt walks obj/, finds keep.txt, and skips only obj/sub/, which git ignores as a whole', () => {
    const root = tree({ '.gitignore': 'obj/*\n!obj/keep.txt\n', 'obj/keep.txt': 'k\n', 'obj/a.dll.txt': 'a\n', ...outputs('obj/sub') })
    git(root, 'init', '-q')
    const calls = fileCallsInside(path.join(root, 'obj', 'sub'))
    const found = discover(root)
    expect(calls()).toBe(0)
    expect(statuses(found)).toEqual({
      '.gitignore': 'unsupported:no_adapter:.gitignore',
      'obj/a.dll.txt': 'excluded:**/obj/**',
      'obj/keep.txt': 'excluded:**/obj/**',
      'obj/sub/': 'excluded:gitignore',
    })
  })
})

describe('FR384 the index\'s discovery and the synchronous one give the same entries', () => {
  it('discover and discoverAsync agree on a tree with whole, partly and negated ignored directories', async () => {
    const root = tree({
      '.gitignore': 'obj/\np/*.log\nq/*\n!q/keep.txt\n',
      'src/a.ts': 'export const a = 1\n', 'p/new.txt': 'n\n', 'p/run.log': 'l\n', 'q/keep.txt': 'k\n', 'q/drop.txt': 'd\n',
      ...outputs('obj'), ...outputs('src/obj', 10), ...outputs('q/sub', 10),
    })
    git(root, 'init', '-q')
    const sync = discover(root)
    expect(sync.filter((d) => d.path.endsWith('/')).map((d) => d.path)).toEqual(['obj/', 'q/sub/', 'src/obj/'])
    expect(await discoverAsync(root, BUILT_IN_REGISTRY, undefined)).toEqual(sync)
  })
})
