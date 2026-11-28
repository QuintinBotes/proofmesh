import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LAYOUT_SCALE, type LayoutCell, layoutPositions, type Placed, powerOfTwo } from '../src/query/layout.js'

/** A repository-shaped path tree: 500 files of 1 to 15 symbols in nested directories of uneven size, from a fixed seed. */
function repository(): Placed[] {
  let s = 44
  const next = (n: number) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n }
  const dirs = ['src/core', 'src/driver/mysql', 'src/driver/postgres', 'src/driver/sqlite', 'src/query', 'src/query/builder', 'src/schema', 'src/util', 'src/decorator/columns', 'src/decorator/options', 'test/unit', 'test/functional/query']
  const items: Placed[] = []
  for (let f = 0; f < 500; f++) {
    const path = `${dirs[next(dirs.length)]}/File${f}.ts`
    const n = 1 + next(15)
    for (let k = 0; k < n; k++) items.push({ path, name: `${path.slice(0, -3)}:Thing${f}.member${next(40)}`, line: 1 + k * 10, byte: k * 400 })
  }
  return items
}

const key = (p: Placed) => `${p.path}|${p.name}|${p.line}`
/** Positions fitted to view, as the Galaxy does: the bounding box scaled to the unit square by its larger side. */
function fitted(items: Placed[]): Map<string, [number, number]> {
  const p = layoutPositions(items)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < items.length; i++) { x0 = Math.min(x0, p[i * 2]!); x1 = Math.max(x1, p[i * 2]!); y0 = Math.min(y0, p[i * 2 + 1]!); y1 = Math.max(y1, p[i * 2 + 1]!) }
  const span = Math.max(x1 - x0, y1 - y0)
  return new Map(items.map((it, i) => [key(it), [(p[i * 2]! - x0) / span, (p[i * 2 + 1]! - y0) / span]]))
}
const dir = (path: string) => path.slice(0, path.lastIndexOf('/'))
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** The benchmark's kind of commit: a new file of three functions, one changed body, one added method and one deleted function. */
function commit(a: Placed[]) {
  const files = [...new Set(a.map((x) => x.path))].sort()
  const changed = files[40]!, grown = files[200]!, shrunk = files[333]!
  const deleted = a.find((x) => x.path === shrunk)!
  const added = `${dir(files[120]!)}/Fresh.ts`
  const b = a.filter((x) => x !== deleted).map((x) => (x.path === changed && x.line > 1 ? { ...x, line: x.line + 3, byte: x.byte + 90 } : x))
  b.push({ path: grown, name: `${grown.slice(0, -3)}:Thing.added`, line: 900, byte: 40000 })
  for (const f of ['alpha', 'beta', 'gamma']) b.push({ path: added, name: `${added.slice(0, -3)}:${f}`, line: 1, byte: 0 })
  return { b, deleted, added, touched: new Set([changed, grown, shrunk, added]) }
}

describe('FR1220 positions are a pure function of the path tree and the names', () => {
  it('the same symbols in any order get the same position each, and the same bytes on every machine', () => {
    const a = repository()
    const p = layoutPositions(a)
    expect(p).toHaveLength(a.length * 2)
    const shuffled = a.map((x, i) => [x, i] as const).sort((x, y) => ((x[1] * 7919) % 5003) - ((y[1] * 7919) % 5003))
    const q = layoutPositions(shuffled.map((x) => x[0]))
    shuffled.forEach(([, i], j) => expect([q[j * 2], q[j * 2 + 1]]).toEqual([p[i * 2], p[i * 2 + 1]]))
    // Pinned: only IEEE 754 arithmetic that rounds the same everywhere, so another machine must print the same digest. A new
    // digest means the layout changed: bump GALAXY_FORMAT with it, so cached payloads are rebuilt.
    expect(crypto.createHash('sha256').update(p).digest('hex')).toBe('aa0e39e897e4453525621d6a9ab81966b50efb3b96f412aab05bdda266d781d3')
  })

  it('directories, then files, then symbols in name order; overloads take their own places by declaration line', () => {
    const items: Placed[] = [
      { path: 'src/b.ts', name: 'src/b:run', line: 30, byte: 900 },
      { path: 'src/b.ts', name: 'src/b:run', line: 10, byte: 300 },
      { path: 'src/b.ts', name: 'src/b:alpha', line: 50, byte: 1500 },
    ]
    const p = layoutPositions(items), at = (i: number): [number, number] => [p[i * 2]!, p[i * 2 + 1]!]
    expect(new Set([0, 1, 2].map((i) => at(i).join()))).toHaveProperty('size', 3)
    const swapped = layoutPositions([items[1]!, items[0]!, items[2]!])
    expect([swapped[0], swapped[1]]).toEqual(at(1))
    expect([swapped[2], swapped[3]]).toEqual(at(0))
    // Within a file the order reads along the strips: alpha, then run at line 10, then run at line 30 in the next strip.
    expect(at(2)[0]).toBeLessThan(at(1)[0])
    expect(at(1)[1]).toBeLessThan(at(0)[1])
  })

  it('a directory of tens of thousands of symbols still gives every symbol its own point', () => {
    const items: Placed[] = Array.from({ length: 30000 }, (_, i) => ({ path: 'src/huge/Generated.ts', name: `src/huge/Generated:g${i}`, line: i + 1, byte: i * 30 }))
    for (let i = 0; i < 40; i++) items.push({ path: `src/small/F${i}.ts`, name: `src/small/F${i}:f`, line: 1, byte: 0 })
    items.push({ path: 'README.ts', name: 'README:x', line: 1, byte: 0 })
    const p = layoutPositions(items)
    expect(new Set(Array.from({ length: items.length }, (_, i) => p[i * 2]! * LAYOUT_SCALE + p[i * 2 + 1]!)).size).toBe(items.length)
  })

  it('FR1225 SC-002 lays out 250,000 symbols in under a second of CPU time (FR1620)', () => {
    const items: Placed[] = []
    for (let i = 0; i < 250000; i++) { const f = Math.floor(i / 10), path = `pkg${f % 7}/mod${f % 23}/sub${f % 41}/file${f}.ts`; items.push({ path, name: `${path.slice(0, -3)}:s${i % 10}`, line: i % 10, byte: (i % 10) * 40 }) }
    // The process's own CPU time, GC threads included: a busy machine stretches wall-clock time, not the work the layout does.
    const t0 = process.cpuUsage()
    layoutPositions(items)
    const t = process.cpuUsage(t0)
    expect((t.user + t.system) / 1000).toBeLessThan(1000)
  })
})

describe('FR1222 a commit moves only what it touches', () => {
  const a = repository(), before = fitted(a)
  const { b, deleted, added, touched } = commit(a), after = fitted(b)
  const shared = a.filter((x) => after.has(key(x)))

  it('SC-003 at most 1% of the symbols present in both snapshots move more than 2% of the map\'s width', () => {
    expect(shared.length).toBeGreaterThan(3000)
    const moved = shared.filter((x) => dist(before.get(key(x))!, after.get(key(x))!) > 0.02)
    expect(moved.length / shared.length).toBeLessThanOrEqual(0.01)
  })

  it('no symbol takes a deleted symbol\'s place unless its file or directory also changed', () => {
    const place = before.get(key(deleted))!
    const outside = (x: Placed) => !touched.has(x.path) && dir(x.path) !== dir(deleted.path)
    const nearestBefore = Math.min(...a.filter(outside).map((x) => dist(before.get(key(x))!, place)))
    const nearestAfter = Math.min(...b.filter(outside).map((x) => dist(after.get(key(x))!, place)))
    expect(nearestAfter).toBeGreaterThan(nearestBefore * 0.9)
  })

  it('a file added appears inside its directory\'s cell, and only that directory and its siblings shift', () => {
    const only = [...a, ...['alpha', 'beta', 'gamma'].map((f) => ({ path: added, name: `${added.slice(0, -3)}:${f}`, line: 1, byte: 0 }))]
    const next = fitted(only)
    for (const f of ['alpha', 'beta', 'gamma']) {
      const mine = next.get(`${added}|${added.slice(0, -3)}:${f}|1`)!
      const nearest = a.map((x) => [x, dist(next.get(key(x))!, mine)] as const).sort((x, y) => x[1] - y[1])[0]![0]
      expect(dir(nearest.path)).toBe(dir(added))
    }
    const family = dir(dir(added))
    const shifted = a.filter((x) => !x.path.startsWith(`${family}/`) && dist(before.get(key(x))!, next.get(key(x))!) > 0.02)
    expect(shifted).toEqual([])
  })
})

/**
 * The Observatory benchmark's TypeORM sample as the layout sees it around src/util: src's children with their real symbol
 * counts, each directory but util as one file of that many symbols (what is inside a sibling cannot change util's cell), and
 * util's own files with theirs. Snapshot B is bench/observatory/snapshot-b.mjs's commit in src/util: Retry.ts with three
 * functions, and titleCase removed. Its method added to QueryBuilder.ts is in a directory this collapses into one file, so the
 * whole commit is checked on the real sample (e2e/time.spec.ts, the Observatory benchmark's stability step).
 */
function typeorm(): { a: Placed[]; b: Placed[] } {
  const src = 'cache 47, commands 97, common 8, connection 30, data-source 71, decorator 202, driver 3941, entity-manager 117, entity-schema 120, error 72, find-options 88, logger 40, metadata 399, metadata-args 177, metadata-builder 37, migration 38, naming-strategy 52, persistence 122, platform 23, query-builder 518, query-runner 132, repository 173, schema-builder 254, subscriber 125'
  const util = 'ApplyValueTransformers 3, DateUtils 17, DepGraph 15, DirectoryExportedClassesLoader 2, ImportUtils 2, InstanceChecker 31, ObjectUtils 5, OrmUtils 21, PathUtils 5, RandomGenerator 2, StringUtils 12, TreeRepositoryUtils 4, VersionUtils 4, escapeRegExp 2'
  const file = (path: string, names: string[]) => names.map((n, i) => ({ path, name: `${path.slice(0, -3)}:${n}`, line: 1 + i * 10, byte: i * 300 }))
  const many = (path: string, n: number) => file(path, Array.from({ length: n }, (_, i) => `s${i}`))
  const strings = ['camelCase', 'titleCase', 'abbreviate', 'IHashOptions.length', 'IShortenOptions.separator', 'IShortenOptions.termLength', 'IShortenOptions', 'IHashOptions', 'shorten', 'IShortenOptions.segmentLength', 'snakeCase', 'hash']
  const a = [
    ...src.split(', ').flatMap((s) => { const [d, n] = s.split(' '); return many(`src/${d}/index.ts`, +n!) }),
    ...util.split(', ').flatMap((s) => { const [f, n] = s.split(' '); return f === 'StringUtils' ? file('src/util/StringUtils.ts', strings) : many(`src/util/${f}.ts`, +n!) }),
    ...many('src/container.ts', 11), ...many('src/globals.ts', 14),
  ]
  const b = [
    ...a.filter((x) => x.name !== 'src/util/StringUtils:titleCase'),
    ...file('src/util/Retry.ts', ['withRetry', 'backoffDelay', 'isRetryable']),
  ]
  return { a, b }
}

describe('FR2620 a file added to a directory leaves the other files where they were (#275)', () => {
  it('on the benchmark\'s commit to src/util, no symbol present in both moves more than 2% of the map\'s width', () => {
    const { a, b } = typeorm()
    const before = fitted(a), after = fitted(b)
    const moved = a.filter((x) => after.has(key(x))).map((x) => [x.name, dist(before.get(key(x))!, after.get(key(x))!)] as const).sort((x, y) => y[1] - x[1])
    expect(moved.length).toBe(a.length - 1)
    expect(moved[0]![1], moved[0]![0]).toBeLessThanOrEqual(0.02)
  })

  it('FR2621 a cell\'s shape counts as the nearest power of two, by exact comparisons, so every machine picks the same strips', () => {
    expect([1, 1.41, 1.42, 0.71, 0.7, 42, 1 / 42].map(powerOfTwo)).toEqual([1, 1, 2, 1, 0.5, 32, 1 / 32])
    expect(powerOfTwo(Math.SQRT2)).toBe(2)
  })
})

describe('FR1401 the layout gives the cells it placed symbols in', () => {
  it('every directory and file is a cell named by its segment, its parent first, holding its symbols, and every symbol sits in its file\'s cell', () => {
    const items = repository()
    const cells: LayoutCell[] = []
    const p = layoutPositions(items, cells)
    // Asking for the cells changes no position.
    expect(Buffer.from(p.buffer).equals(Buffer.from(layoutPositions(items).buffer))).toBe(true)
    expect(cells[0]).toMatchObject({ parent: -1, name: '', count: items.length, x: 0, y: 0, w: 1, h: 1 })
    const pathOf = (i: number): string => { const c = cells[i]!; return c.parent < 0 ? '' : [pathOf(c.parent), c.name].filter(Boolean).join('/') }
    cells.forEach((c, i) => { if (i) expect(c.parent).toBeLessThan(i) })
    const leaves = cells.map((c, i) => [i, c] as const).filter(([i]) => !cells.some((d) => d.parent === i))
    const files = new Map(leaves.map(([i, c]) => [pathOf(i), c]))
    expect(new Set(files.keys())).toEqual(new Set(items.map((x) => x.path)))
    items.forEach((it, i) => {
      const c = files.get(it.path)!
      const x = p[i * 2]! / LAYOUT_SCALE, y = p[i * 2 + 1]! / LAYOUT_SCALE
      expect(x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h, it.name).toBe(true)
    })
    for (const [path, c] of files) expect(c.count).toBe(items.filter((x) => x.path === path).length)
  })
})
