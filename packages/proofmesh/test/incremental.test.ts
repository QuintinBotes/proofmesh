import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cli, fixtureRepo, tmpDir } from './helpers.js'

// The sentinel fixture's trusted build writes to $HOME, so every index runs with a private one.
const HOME = tmpDir('pm-home-')
const run = (args: string[]) => cli(args, { HOME })
const fresh = (repo: string) => {
  const d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo]]) expect(run(['--data-dir', d, ...args]).status).toBe(0)
  return d
}
const index = (d: string, repo: string) => {
  const r = run(['--data-dir', d, 'index', repo])
  expect(r.status, r.stderr).toBe(0)
  const id = /snapshot (snap_\w+) published/.exec(r.stdout)![1]!
  const reused = Number(/reused the facts of (\d+) of \d+ files/.exec(r.stdout)?.[1] ?? 0)
  return { id, reused }
}
const dump = (d: string, id: string) => run(['--data-dir', d, 'debug', 'dump', '--normalized', id]).stdout
const git = (cwd: string, ...args: string[]) => expect(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).status).toBe(0)
const write = (repo: string, file: string, change: (text: string) => string) => fs.writeFileSync(path.join(repo, file), change(fs.readFileSync(path.join(repo, file), 'utf8')))

type Transition = { name: string; fixture: string; reused: number; shows?: string; before?: (repo: string, d: string) => void; change: (repo: string, d: string) => void }

// cs-orders: Orders.Core (4 files) references Orders.Pricing (2 files); only Pricing's facts survive a change confined to Core.
const transitions: Transition[] = [
  { name: 'edit', fixture: 'cs-orders', reused: 2, change: (r) => write(r, 'src/Orders.Core/OrderService.cs', (t) => t.replace('return total;', 'return total + 0;')) },
  { name: 'edit in a referenced project', fixture: 'cs-orders', reused: 0, change: (r) => write(r, 'src/Orders.Pricing/Pricing.cs', (t) => t.replace('Math.Round(amount * quantity, 2)', 'Math.Round(amount * quantity, 3)')) },
  { name: 'rename', fixture: 'cs-orders', reused: 2, change: (r) => fs.renameSync(path.join(r, 'src/Orders.Core/Decoy.cs'), path.join(r, 'src/Orders.Core/Lookalike.cs')) },
  { name: 'delete', fixture: 'cs-orders', reused: 2, change: (r) => fs.rmSync(path.join(r, 'src/Orders.Core/Decoy.cs')) },
  {
    name: 'branch', fixture: 'cs-orders', reused: 2,
    before: (r) => {
      git(r, 'init', '-q', '-b', 'main'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'main')
      git(r, 'checkout', '-q', '-b', 'feature')
      write(r, 'src/Orders.Core/Checkout.cs', (t) => t.replace('orders.PlaceOrder(price, 1)', 'orders.PlaceOrder(price, 2)'))
      fs.writeFileSync(path.join(r, 'src/Orders.Core/Refund.cs'), 'namespace Orders.Core;\n\npublic static class Refund\n{\n    public static decimal Back(IOrderService orders, decimal price) => -orders.PlaceOrder(price, 1);\n}\n')
      git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'feature'); git(r, 'checkout', '-q', 'main')
    },
    change: (r) => git(r, 'checkout', '-q', 'feature'),
  },
  { name: 'configuration', fixture: 'cs-orders', reused: 0, change: (r) => write(r, 'Directory.Build.props', (t) => t.replace('</Project>', '  <PropertyGroup><LangVersion>latest</LangVersion></PropertyGroup>\n</Project>')) },
  { name: 'dependency', fixture: 'cs-orders', reused: 0, change: (r) => write(r, 'src/Orders.Core/Orders.Core.csproj', (t) => t.replace('Version="1.0.0"', 'Version="2.0.0"')) },
  { name: 'analysis mode', fixture: 'cs-sentinel', reused: 0, change: (r, d) => expect(run(['--data-dir', d, 'repo', 'trust', r, '--build-evaluation']).status).toBe(0) },
  // A file linked into two projects is keyed by both, so an edit to either project reanalyses it.
  { name: 'edit beside a linked file', fixture: 'cs-linked', reused: 0, change: (r) => write(r, 'src/B/Use.cs', (t) => `${t}\n// changed\n`) },
  // The TypeScript adapter declares no units: any change reanalyses every file.
  // The unchanged package.json is a build adapter source whose cached file result is replayed (FR129), so one file is reused (here and for the tsconfig.json of ts-prisma below).
  { name: 'edit', fixture: 'ts-invoicing', reused: 1, change: (r) => write(r, 'packages/format/src/currency.ts', (t) => `${t}\n// changed\n`) },
  // py-shop: app imports shop, whose __init__ and cart import each other, and cart imports pricing and discounts; legacy stands alone.
  { name: 'edit a module nothing imports', fixture: 'py-shop', reused: 5, change: (r) => write(r, 'legacy.py', (t) => t.replace('return 0', 'return 1')) },
  { name: 'rename a function its importers call', fixture: 'py-shop', reused: 2, change: (r) => write(r, 'shop/pricing.py', (t) => t.replace('def total(', 'def subtotal(')) },
  // A new module can change what an import resolves to anywhere, here `import requests` in shop/discounts.py.
  { name: 'add a module', fixture: 'py-shop', reused: 0, change: (r) => fs.writeFileSync(path.join(r, 'requests.py'), 'def get(url):\n    return url\n') },
  // py-django: table mappings and routes are workspace facts, asked for on every index; only shop/models.py, shop/views.py, which imports it,
  // and shop/urls.py, which imports views, are reanalysed of its ten files.
  { name: 'A9 rename a mapped table', fixture: 'py-django', reused: 7, change: (r) => write(r, 'shop/models.py', (t) => t.replace('db_table = "sales_orders"', 'db_table = "orders"')) },
  // ts-prisma: the TypeScript adapter reads the Prisma schema as configuration (A36), so renaming a model's table reanalyses every
  // TypeScript file, whose model accesses now reference the new table, as well as the schema itself.
  { name: 'A36 rename the table a Prisma model maps to', fixture: 'ts-prisma', reused: 1, change: (r) => write(r, 'prisma/schema.prisma', (t) => t.replace('@@map("users")', '@@map("accounts")')) },
  // build-graph: the build adapter answers every fact in `workspace`, which is asked on each index and never cached, so a build fact never
  // goes stale. A manifest edit reanalyses the seven manifests (cheap file results) and, for package.json, which the TypeScript adapter also
  // reads as configuration, the four TypeScript files; a new Go file changes no adapter's inputs, so all 13 files keep their facts (FR129).
  { name: 'FR129 edit a go.mod', fixture: 'build-graph', reused: 13, change: (r) => write(r, 'svc/go.mod', (t) => t.replace('v1.8.1', 'v1.9.0')) },
  { name: 'FR129 add a Go file under a project', fixture: 'build-graph', reused: 27, change: (r) => fs.writeFileSync(path.join(r, 'lib/extra.go'), 'package lib\n\nfunc Extra() int {\n\treturn 1\n}\n') },
  { name: 'FR129 rename a package', fixture: 'build-graph', reused: 9, change: (r) => write(r, 'packages/core/package.json', (t) => t.replace('@acme/core', '@acme/kernel')) },
  // build-graph-jvm: pom and Gradle facts are answered in `workspace` too, so an edited version never leaves a stale fact (FR160).
  { name: 'FR160 edit a pom dependency version', fixture: 'build-graph-jvm', reused: 9, change: (r) => write(r, 'maven/web/pom.xml', (t) => t.replace('33.0.0-jre', '33.1.0-jre')) },
  { name: 'FR160 edit a Gradle script dependency version', fixture: 'build-graph-jvm', reused: 9, change: (r) => write(r, 'gradle/app/build.gradle.kts', (t) => t.replace('3.9.0', '3.9.1')) },
  // FR245: Cargo and Bazel facts are answered in `workspace` as well, so an edited version or dependency never leaves a stale fact.
  { name: 'FR245 edit a Cargo.toml dependency version', fixture: 'build-graph', reused: 13, shows: '1.0.200', change: (r) => write(r, 'crates/app/Cargo.toml', (t) => t.replace('serde = "1"', 'serde = "1.0.200"')) },
  { name: 'FR245 edit a BUILD.bazel dep', fixture: 'build-graph-jvm', reused: 9, shows: 'com_google_guava_failureaccess', change: (r) => write(r, 'bazel/BUILD.bazel', (t) => t.replace('com_google_guava_guava', 'com_google_guava_failureaccess')) },
]

describe('SC004 FR008 FR014 A16 an incremental index seals exactly what a clean index of the same tree seals', () => {
  for (const t of transitions) {
    it(`${t.fixture}: ${t.name}`, () => {
      const repo = tmpDir('pm-inc-')
      fs.cpSync(fixtureRepo(t.fixture), repo, { recursive: true })
      const d = fresh(repo)
      t.before?.(repo, d)
      const base = index(d, repo)
      t.change(repo, d)
      const incremental = index(d, repo)
      expect(incremental.id).not.toBe(base.id)
      expect(incremental.reused).toBe(t.reused)

      const clean = fresh(repo)
      if (t.name === 'analysis mode') expect(run(['--data-dir', clean, 'repo', 'trust', repo, '--build-evaluation']).status).toBe(0)
      const cleanRun = index(clean, repo)
      expect(cleanRun.id).toBe(incremental.id)
      expect(cleanRun.reused).toBe(0)
      expect(dump(d, incremental.id)).toBe(dump(clean, incremental.id))
      if (t.shows) {
        expect(dump(d, base.id)).not.toContain(t.shows)
        expect(dump(d, incremental.id)).toContain(t.shows)
      }
    }, 300000)
  }

  it('an unchanged tree reuses every file when a new snapshot is needed for another reason', () => {
    const repo = tmpDir('pm-inc-')
    fs.cpSync(fixtureRepo('cs-orders'), repo, { recursive: true })
    const d = fresh(repo)
    index(d, repo)
    // An ownership file changes the snapshot but no input of the C# adapter, so every C# file keeps its facts.
    fs.writeFileSync(path.join(repo, 'CODEOWNERS'), '* @example/orders\n')
    expect(index(d, repo).reused).toBe(6)
  }, 300000)
})

describe('NFR004 an adapter is identified by its code, not only by the version it reports', () => {
  it('a built-in adapter rebuilt without a version change gets a new snapshot and reuses none of its old facts', async () => {
    const { indexRepository } = await import('../src/indexer/coordinator.js')
    const { Registry } = await import('../src/indexer/languages.js')
    const { Catalog, initDataDir } = await import('../src/meshstore/catalog.js')
    const entry = path.join(tmpDir('pm-entry-'), 'linelang.mjs')
    fs.copyFileSync(path.join(import.meta.dirname, 'fake-adapters', 'linelang.mjs'), entry)
    // No sha256 on the spec: the core treats it as it treats a built-in adapter.
    const registry = new Registry([{ id: 'linelang', languages: new Set(['linelang']), extensions: { '.fake': 'linelang' }, isConfig: () => false, entry: () => entry, unavailable: () => 'adapter_unavailable:linelang' }])
    const d = tmpDir(), repo = tmpDir('pm-rebuilt-')
    fs.cpSync(fixtureRepo('linelang'), repo, { recursive: true })
    initDataDir(d)
    const c = Catalog.open(d); c.addRepository(repo); c.close()
    const before = await indexRepository(d, repo, undefined, registry)
    fs.appendFileSync(entry, '\n// rebuilt\n')
    const after = await indexRepository(d, repo, undefined, registry)
    expect(after.snapshotId).not.toBe(before.snapshotId)
    expect(after.reuse).toEqual({ reused: 0, analysed: 2 })
  }, 120000)
})
