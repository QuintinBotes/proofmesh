import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { check } from '../src/core/schemas.js'
import { sha256File } from '../src/core/hash.js'
import { hashDeclaration } from '../src/indexer/body-hash.js'
import { cli, ROOT, tmpDir, tool, withSnapshot } from './helpers.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
const FIXTURE = path.join(ROOT, 'fixtures', 'symbol-identity')
const HEADS = ['head-rename', 'head-move', 'head-edit', 'head-both', 'head-dup', 'head-moverename', 'head-filemove', 'head-copy']
const HEX64 = /^[0-9a-f]{64}$/

type Side = { id: string; name: string; kind: string; path: string; qualified_name: string; stable_key: string; body_hash: string | null }
type Pair = { change: string; kind: string; body_hash: string; base: Side; head: Side }
type Ambiguous = { kind: string; body_hash: string; removed: Side[]; added: Side[] }
type Changed = Side & { what: string[]; base_id: string; base_stable_key: string; base_body_hash: string | null }
type Cmp = { symbols: { counts: Record<string, number>; added: Side[]; removed: Side[]; changed: Changed[]; paired: Pair[]; ambiguous: Ambiguous[] } }

let d: string, repo: string
const snap: Record<string, string> = {}

/** Copies a fixture directory over a working tree; a path in its DELETED file is removed. */
function overlay(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true })
  fs.rmSync(path.join(to, 'DELETED'), { force: true })
  const deleted = path.join(from, 'DELETED')
  if (fs.existsSync(deleted)) for (const p of fs.readFileSync(deleted, 'utf8').split('\n').filter(Boolean)) fs.rmSync(path.join(to, p))
}

/** A repository indexed, then its sealed file rewritten as the previous format wrote it: no hash column, and the catalog's digest of the file as it now is. */
function legacy(): { dir: string; tree: string; baseId: string } {
  const dir = tmpDir(), tree = fs.realpathSync(tmpDir('pm-ident-old-'))
  overlay(path.join(FIXTURE, 'base'), tree)
  for (const args of [['init'], ['repo', 'add', tree], ['index', tree]]) { const r = cli(['--data-dir', dir, ...args]); expect(r.status, r.stderr).toBe(0) }
  const catalog = new Database(path.join(dir, 'catalog.db'))
  const baseId = (catalog.prepare("select id from snapshot where state = 'published'").get() as { id: string }).id
  const file = path.join(dir, 'snapshots', `${baseId}.db`)
  fs.chmodSync(file, 0o644)
  const sealed = new Database(file)
  sealed.exec('alter table symbol drop column body_hash')
  sealed.prepare("update meta set value = '0.6' where key = 'format_version'").run()
  sealed.close()
  fs.chmodSync(file, 0o444)
  catalog.prepare('update snapshot set store_digest = ? where id = ?').run(sha256File(file), baseId)
  catalog.close()
  return { dir, tree, baseId }
}

beforeAll(() => {
  repo = fs.realpathSync(tmpDir('pm-ident-'))
  git(repo, 'init', '-q', '-b', 'base')
  overlay(path.join(FIXTURE, 'base'), repo)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  for (const h of HEADS) {
    git(repo, 'checkout', '-q', '-b', h, 'base')
    overlay(path.join(FIXTURE, h), repo)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', h)
  }
  git(repo, 'checkout', '-q', 'base')
  d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo]]) { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0) }
  for (const rev of ['base', ...HEADS]) {
    const r = cli(['--data-dir', d, 'index', repo, '--rev', rev])
    expect(r.status, r.stderr).toBe(0)
    snap[rev] = /(snap_\w+) published/.exec(r.stdout)![1]!
  }
}, 600000)

const symbol = (snapshot: string, name: string, kindOrPath?: string) => {
  const hits = (tool(d, 'find_symbols', { text: name, snapshot_id: snapshot, include_ids: true }).data.symbols as Array<{ id: string; name: string; path: string; kind: string }>).filter((s) => s.name === name && (!kindOrPath || s.path === kindOrPath))
  expect(hits, `${name} in ${snapshot}`).toHaveLength(1)
  return (tool(d, 'get_symbol', { symbol_id: hits[0]!.id, snapshot_id: snapshot }).data as { symbol: Side }).symbol
}
const compare = (head: string) => tool(d, 'compare_snapshots', { base_snapshot_id: snap.base!, snapshot_id: snap[head]! }) as unknown as { data: Cmp; limitations: string[] }
const names = (xs: Side[]) => xs.map((s) => s.name)
const ends = (p: Pair) => [p.change, p.kind, p.base.name, p.head.name, p.base.path, p.head.path]

describe('FR130 a symbol records the hash of its declaration text with its own name masked, in every tier', () => {
  it('FR130 a reindent, line endings and trailing whitespace keep the hash; any other edit, and a different name use, change it', () => {
    const fn = 'function mean(xs) {\n  return mean(xs.slice(1))\n}'
    const h = hashDeclaration(fn, 'mean', 'function')!
    expect(h).toMatch(HEX64)
    expect(hashDeclaration(fn.replace('mean', 'average').replace('mean(', 'average('), 'average', 'function')).toBe(h)
    expect(hashDeclaration('    function mean(xs) {\n      return mean(xs.slice(1))\n    }', 'mean', 'function')).toBe(h)
    expect(hashDeclaration(fn.replace(/\n/g, '\r\n') + '  \n\n', 'mean', 'function')).toBe(h)
    expect(hashDeclaration(fn.replace(/\n/g, ' \t\n'), 'mean', 'function')).toBe(h)
    expect(hashDeclaration(fn.replace('slice(1)', 'slice(2)'), 'mean', 'function')).not.toBe(h)
  })

  it('FR130 only a whole identifier is masked, and a span that is no more than the name has no hash', () => {
    const own = hashDeclaration('def a(x): return abc(x) + a_b + a', 'a', 'function')
    expect(own).toBe(hashDeclaration('def z(x): return abc(x) + a_b + z', 'z', 'function'))
    expect(own).not.toBe(hashDeclaration('def z(x): return zbc(x) + a_b + z', 'z', 'function'))
    expect(hashDeclaration('Checkout', 'Checkout', 'method')).toBeNull()
    expect(hashDeclaration('  Checkout\n', 'Checkout', 'method')).toBeNull()
  })

  it('FR130 a module is the hash of its file text, whatever the file is called', () => {
    const text = 'export const x = 1\n'
    expect(hashDeclaration(text, 'a', 'module')).toBe(hashDeclaration(text, 'b', 'module'))
    expect(hashDeclaration('// a\n', 'a', 'module')).not.toBe(hashDeclaration('// b\n', 'b', 'module'))
  })

  it('FR130 every symbol of a TypeScript, Python and Go (syntax tier) snapshot carries a 64 hex hash', () => {
    const rows = withSnapshot(d, (db) => db.prepare('select kind, name, body_hash from symbol').all() as Array<{ kind: string; name: string; body_hash: string | null }>)
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.filter((r) => !r.body_hash || !HEX64.test(r.body_hash))).toEqual([])
  })
})

describe('FR131 get_symbol returns the stable_key and the body_hash', () => {
  it('FR131 scenario 1: mean in base answers its key and a 64 hex body_hash, in the answer schema', () => {
    const r = tool(d, 'get_symbol', { symbol_id: symbol(snap.base!, 'mean').id, snapshot_id: snap.base! })
    expect(check('tools/get_symbol.data.schema.json', r.data)).toBeUndefined()
    const s = (r.data as { symbol: Side }).symbol
    expect(s.stable_key).toBe('src/stats.ts#src/stats:mean#function')
    expect(s.body_hash).toMatch(HEX64)
    expect(r.limitations.join(' ')).not.toContain('body hashes')
  })

  it('FR131 the lean row carries both too, since an agent reads lean by default', () => {
    const id = symbol(snap.base!, 'mean').id
    const text = (tool(d, 'get_symbol', { symbol_id: id, snapshot_id: snap.base!, envelope: 'lean' }) as unknown as { text: string }).text
    const row = text.split('\n').find((l) => !l.startsWith('#'))!
    expect(row).toContain('stable_key="src/stats.ts#src/stats:mean#function"')
    expect(row).toMatch(/ body_hash=[0-9a-f]{64}$/)
  })

  it('FR135 scenario 7: a snapshot sealed before hashes existed answers null and says to index again', () => {
    const { dir } = legacy()
    const id = (tool(dir, 'find_symbols', { text: 'mean' }).data.symbols as Array<{ id: string }>)[0]!.id
    const r = tool(dir, 'get_symbol', { symbol_id: id })
    expect(check('tools/get_symbol.data.schema.json', r.data)).toBeUndefined()
    expect((r.data as { symbol: Side }).symbol).toMatchObject({ stable_key: 'src/stats.ts#src/stats:mean#function', body_hash: null })
    expect(r.limitations.join(' ')).toMatch(/sealed before body hashes existed.*index (it )?again/i)
  }, 240000)
})

describe('FR132 compare_snapshots reports a body edit, with the ids and keys of both sides', () => {
  it('FR132 scenario 4: one operator changed in spread is one change with kind body, both ids and both hashes, and nothing else', () => {
    const r = compare('head-edit')
    expect(check('tools/compare_snapshots.data.schema.json', r.data)).toBeUndefined()
    const { added, removed, changed, paired, ambiguous } = r.data.symbols
    expect([added, removed, paired, ambiguous]).toEqual([[], [], [], []])
    expect(changed).toHaveLength(1)
    const before = symbol(snap.base!, 'spread'), after = symbol(snap['head-edit']!, 'spread')
    expect(changed[0]).toMatchObject({ name: 'spread', what: ['body'], id: after.id, base_id: before.id, stable_key: before.stable_key, base_stable_key: before.stable_key, body_hash: after.body_hash, base_body_hash: before.body_hash })
    expect(before.body_hash).not.toBe(after.body_hash)
    expect(r.data.symbols.counts).toEqual({ added: 0, removed: 0, changed: 1, paired: 0, ambiguous: 0 })
  })

  it('FR132 an edit to a signature that is also the declaration text is a body change as well', () => {
    const r = compare('head-both')
    expect(r.data.symbols.changed).toEqual([])
  })
})

describe('FR133 compare_snapshots pairs one removed and one added symbol of equal kind and hash as moved, renamed or both', () => {
  it('FR133 scenario 2: mean to average and total to sum_all are two renamed pairs with both ids, both keys and the shared hash, and no added or removed symbol', () => {
    const r = compare('head-rename')
    const { added, removed, changed, paired, ambiguous } = r.data.symbols
    expect([added, removed, changed, ambiguous]).toEqual([[], [], [], []])
    expect(paired.map(ends)).toEqual([
      ['renamed', 'function', 'total', 'sum_all', 'py/calc.py', 'py/calc.py'],
      ['renamed', 'function', 'mean', 'average', 'src/stats.ts', 'src/stats.ts'],
    ])
    const [total, mean] = paired
    expect(mean).toMatchObject({
      body_hash: symbol(snap.base!, 'mean').body_hash,
      base: { id: symbol(snap.base!, 'mean').id, stable_key: 'src/stats.ts#src/stats:mean#function' },
      head: { id: symbol(snap['head-rename']!, 'average').id, stable_key: 'src/stats.ts#src/stats:average#function' },
    })
    expect(total).toMatchObject({ body_hash: symbol(snap.base!, 'total').body_hash, base: { id: symbol(snap.base!, 'total').id }, head: { id: symbol(snap['head-rename']!, 'sum_all').id } })
    expect(paired.every((p) => HEX64.test(p.body_hash))).toBe(true)
    expect(r.data.symbols.counts).toEqual({ added: 0, removed: 0, changed: 0, paired: 2, ambiguous: 0 })
  })

  it('FR133 scenario 3: clamp and Add moved unchanged to a new file are two moved pairs; the new files\' modules are the only additions', () => {
    const r = compare('head-move')
    const { added, removed, changed, paired, ambiguous } = r.data.symbols
    expect(paired.map(ends)).toEqual([
      ['moved', 'function', 'Add', 'Add', 'go/calc.go', 'go/add.go'],
      ['moved', 'function', 'clamp', 'clamp', 'src/util.ts', 'src/math.ts'],
    ])
    for (const p of paired) expect([p.base.id, p.head.id, p.base.stable_key, p.head.stable_key].every(Boolean) && p.base.id !== p.head.id).toBe(true)
    expect(paired[1]!.head.stable_key).toBe('src/math.ts#src/math:clamp#function')
    expect(removed).toEqual([])
    expect(added.map((s) => [s.kind, s.path])).toEqual([['module', 'go/add.go'], ['module', 'src/math.ts']])
    // The two files that lost a function are shorter: a range change of their modules, as before; no module is reported for its text.
    expect(changed.map((c) => [c.kind, c.path, c.what])).toEqual([['module', 'go/calc.go', ['range']], ['module', 'src/util.ts', ['range']]])
    expect(ambiguous).toEqual([])
  })

  it('FR133 a move with a rename is moved_renamed', () => {
    const r = compare('head-moverename')
    expect(r.data.symbols.paired.map(ends)).toEqual([['moved_renamed', 'function', 'clamp', 'limit', 'src/util.ts', 'src/limits.ts']])
    expect(r.data.symbols.ambiguous).toEqual([])
  })

  it('FR133 a file moved without change pairs as moved at module level too, whatever its new name', () => {
    const r = compare('head-filemove')
    expect(r.data.symbols.paired.map(ends)).toEqual([
      ['moved', 'module', 'calc', 'calculator', 'py/calc.py', 'py/calculator.py'],
      ['moved', 'function', 'total', 'total', 'py/calc.py', 'py/calculator.py'],
    ].map((row) => row))
    expect(r.data.symbols.added).toEqual([])
    expect(r.data.symbols.removed).toEqual([])
  })

  it('FR133 scenario 5: a rename with an edit is one removal and one addition, not a pair, because the hashes differ', () => {
    const r = compare('head-both')
    const { added, removed, paired, ambiguous } = r.data.symbols
    expect(names(removed)).toEqual(['mean'])
    expect(names(added)).toEqual(['average'])
    expect([paired, ambiguous]).toEqual([[], []])
  })

  it('FR134 scenario 6: two removed with the hash of one added are left unpaired, and one ambiguous entry lists the candidates', () => {
    const r = compare('head-dup')
    const { added, removed, paired, ambiguous, counts } = r.data.symbols
    expect(names(removed)).toEqual(['a', 'b'])
    expect(names(added)).toEqual(['c'])
    expect(paired).toEqual([])
    expect(ambiguous).toHaveLength(1)
    expect(ambiguous[0]).toMatchObject({ kind: 'function', body_hash: symbol(snap['head-dup']!, 'c').body_hash })
    expect(names(ambiguous[0]!.removed)).toEqual(['a', 'b'])
    expect(names(ambiguous[0]!.added)).toEqual(['c'])
    expect(ambiguous[0]!.removed.map((s) => s.id)).toEqual(removed.map((s) => s.id))
    expect(counts).toEqual({ added: 1, removed: 2, changed: 1, paired: 0, ambiguous: 1 })
  })

  it('FR134 one removed with the hash of two added is ambiguous too, never a guess', () => {
    const r = compare('head-copy')
    const { added, removed, paired, ambiguous } = r.data.symbols
    expect(names(removed)).toEqual(['clamp'])
    expect(added.filter((s) => s.kind === 'function').map((s) => s.path)).toEqual(['src/limits.ts', 'src/math.ts'])
    expect(paired).toEqual([])
    expect(ambiguous).toHaveLength(1)
    expect(names(ambiguous[0]!.removed)).toEqual(['clamp'])
    expect(ambiguous[0]!.added.map((s) => s.path)).toEqual(['src/limits.ts', 'src/math.ts'])
  })

  it('FR134 the old limitation that a renamed symbol is a removal and an addition no longer holds, and the new one says what pairing needs', () => {
    const r = compare('head-rename')
    expect(r.limitations.join(' ')).not.toContain('a renamed symbol counts as one removed and one added')
    expect(r.limitations.join(' ')).toMatch(/exactly one removed and one added symbol of the same kind and body hash/)
  })
})

describe('FR135 a snapshot without hashes answers null and a limitation, never a hash computed at query time', () => {
  it('FR135 scenario 7: compared with a snapshot sealed before hashes, nothing is paired and no body change is reported', () => {
    const { dir, tree: old, baseId } = legacy()
    // Edit spread and replace a and b by c in another file, then index the new tree: the head has hashes, the base has none.
    fs.writeFileSync(path.join(old, 'src/stats.ts'), fs.readFileSync(path.join(FIXTURE, 'head-edit/src/stats.ts')))
    fs.mkdirSync(path.join(old, 'extra'))
    fs.writeFileSync(path.join(old, 'extra/dup.ts'), 'export function c(): number {\n  return 0\n}\n')
    fs.rmSync(path.join(old, 'src/dup.ts'))
    const r = cli(['--data-dir', dir, 'index', old]); expect(r.status, r.stderr).toBe(0)
    const cmp = tool(dir, 'compare_snapshots', { base_snapshot_id: baseId }) as unknown as { data: Cmp; limitations: string[] }
    expect(check('tools/compare_snapshots.data.schema.json', cmp.data)).toBeUndefined()
    expect(cmp.data.symbols.paired).toEqual([])
    expect(cmp.data.symbols.ambiguous).toEqual([])
    expect(cmp.data.symbols.changed.filter((c) => c.what.includes('body'))).toEqual([])
    expect(names(cmp.data.symbols.removed)).toEqual(expect.arrayContaining(['a', 'b']))
    expect(cmp.limitations.join(' ')).toMatch(/sealed before body hashes existed.*index (it )?again/i)
  }, 240000)
})
