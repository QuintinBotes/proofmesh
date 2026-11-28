import fs from 'node:fs'
import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { normaliseDeclaration } from '../src/indexer/body-hash.js'
import { fileKeys } from '../src/indexer/fact-cache.js'
import { cli, fixtureRepo, tmpDir } from './helpers.js'

// #31: an edit inside a TypeScript body reanalyses that file alone, and the snapshot still equals a clean index of the same tree.
// The work an index does is counted by the files it reanalyses, which load does not change, so nothing here times a wall clock.
const fresh = (repo: string) => {
  const d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  return d
}
const index = (d: string, repo: string) => {
  const r = cli(['--data-dir', d, 'index', repo])
  expect(r.status, r.stderr).toBe(0)
  const [, id, status] = /snapshot (snap_\w+) (published|unchanged)/.exec(r.stdout)!
  const [, reused, of] = /reused the facts of (\d+) of (\d+) files/.exec(r.stdout) ?? []
  return { id: id!, status: status!, reused: Number(reused ?? 0), of: Number(of ?? 0) }
}
const dump = (d: string, id: string) => cli(['--data-dir', d, 'debug', 'dump', '--normalized', id]).stdout
const write = (repo: string, file: string, change: (text: string) => string) => {
  const before = fs.readFileSync(path.join(repo, file), 'utf8'), after = change(before)
  expect(after, `${file} did not change`).not.toBe(before)
  fs.writeFileSync(path.join(repo, file), after)
}

// ts-invoicing: handler.ts calls invoiceTotal (billing), which calls formatAmount (format). Its index reuses one file on any change the
// TypeScript adapter must reanalyse whole (the existing A16 edit case).
const WHOLE = 1
const CURRENCY = 'packages/format/src/currency.ts'
// A second function after formatAmount, which billing calls, so an edit inside formatAmount's body moves a declaration another file uses.
const withLaterFunction = (repo: string) => {
  write(repo, CURRENCY, (t) => `${t}\nexport function formatCents(cents: number): string {\n  return formatAmount(cents, "EUR");\n}\n`)
  write(repo, 'packages/format/src/index.ts', (t) => t.replace('formatAmount', 'formatAmount, formatCents'))
  write(repo, 'packages/billing/src/invoice.ts', (t) => t.replace('import { formatAmount }', 'import { formatAmount, formatCents }').replace('return formatAmount(cents, currency);', 'return formatCents(cents) + formatAmount(cents, currency);'))
}

type Case = { name: string; before?: (repo: string) => void; change: (repo: string) => void; only?: true }
const cases: Case[] = [
  // FR1120, FR1121: the body edit of scenario 1, and one that moves a later declaration billing calls.
  { name: 'FR1120 a statement added inside a typed function body', before: withLaterFunction, only: true, change: (r) => write(r, CURRENCY, (t) => t.replace('  return `${', '  const unused = 1;\n  return `${')) },
  { name: 'FR1121 a body edit that moves a later declaration another file calls', before: withLaterFunction, only: true, change: (r) => write(r, CURRENCY, (t) => t.replace('  return `${', '  // a longer body moves formatCents, which billing calls\n  const unused = "' + 'x'.repeat(200) + '";\n  return `${')) },
  { name: 'FR1121 a constructor body of a class whose properties are all typed', before: (r) => fs.writeFileSync(path.join(r, 'packages/format/src/money.ts'), 'export class Money {\n  cents: number;\n  constructor(cents: number) {\n    this.cents = cents;\n  }\n}\n'), only: true, change: (r) => write(r, 'packages/format/src/money.ts', (t) => t.replace('this.cents = cents;', 'this.cents = Math.round(cents);')) },
  // An inline GraphQL resolver another file calls, after a body that grows: its id names no position either.
  {
    name: 'FR1121 a body edit that moves an inline resolver another file calls', only: true,
    before: (r) => {
      fs.writeFileSync(path.join(r, 'packages/format/src/resolvers.ts'), 'export function helper(): number {\n  return 1;\n}\nexport const resolvers = { Query: { user() { return { id: 1 }; } } };\n')
      fs.writeFileSync(path.join(r, 'packages/format/src/user.ts'), 'import { resolvers } from "./resolvers";\nexport function f() {\n  return resolvers.Query.user();\n}\n')
    },
    change: (r) => write(r, 'packages/format/src/resolvers.ts', (t) => t.replace('return 1;', 'return 1 + 2;')),
  },
  // A body the outline leaves out is never typed while signatures are printed: the literal types it makes would reorder a later union.
  {
    name: 'FR1121 a body edit that makes other literal types leaves later signatures as a clean index prints them', only: true,
    before: (r) => {
      fs.writeFileSync(path.join(r, 'packages/format/src/a-setup.ts'), 'export function setup(): void {\n  const cfg = { opts: { level: "high" } };\n  cfg.opts.level.toUpperCase();\n}\n')
      fs.writeFileSync(path.join(r, 'packages/format/src/b-level.ts'), 'export function level(x: "low" | "high"): void {}\n')
    },
    change: (r) => write(r, 'packages/format/src/a-setup.ts', (t) => t.replace('"high"', '"medium"')),
  },
  // FR1122: what another file can observe of a body changes every file's key.
  { name: 'FR1122 a parameter added to a function another file calls (scenario 3)', change: (r) => write(r, CURRENCY, (t) => t.replace('currency: string)', 'currency: string, digits = 2)')) },
  { name: 'FR1122 a body edit of a function whose return type is inferred', before: (r) => write(r, CURRENCY, (t) => `${t}\nexport function zero() {\n  return 0;\n}\n`), change: (r) => write(r, CURRENCY, (t) => t.replace('return 0;', 'return "0";')) },
  { name: 'FR1122 a constructor body of a class with a property it infers', before: (r) => fs.writeFileSync(path.join(r, 'packages/format/src/money.ts'), 'export class Money {\n  cents;\n  constructor(cents: number) {\n    this.cents = cents;\n  }\n}\n'), change: (r) => write(r, 'packages/format/src/money.ts', (t) => t.replace('this.cents = cents;', 'this.cents = String(cents);')) },
  // JavaScript bodies declare types (`this.x = ...` in a constructor), so a JavaScript file's whole text counts.
  { name: 'FR1122 a body edit in a JavaScript file', before: (r) => fs.writeFileSync(path.join(r, 'packages/format/src/legacy.js'), 'export function pad(text) {\n  return text;\n}\n'), change: (r) => write(r, 'packages/format/src/legacy.js', (t) => t.replace('return text;', 'return ` ${text}`;')) },
  { name: 'FR1122 a body that adds a dynamic import', before: withLaterFunction, change: (r) => write(r, CURRENCY, (t) => t.replace('  return `${', '  void import("./index");\n  return `${')) },
]

describe('#31 a TypeScript body edit reanalyses one file, and the snapshot equals a clean index', () => {
  for (const c of cases) {
    it(c.name, () => {
      const repo = tmpDir('pm-fast-')
      fs.cpSync(fixtureRepo('ts-invoicing'), repo, { recursive: true })
      c.before?.(repo)
      const d = fresh(repo)
      const base = index(d, repo)
      c.change(repo)
      const incremental = index(d, repo)
      expect(incremental.id).not.toBe(base.id)
      if (c.only) expect(incremental.reused).toBe(incremental.of - 1)
      else expect(incremental.reused).toBe(WHOLE)

      // FR1123: the facts, symbols, assertions and edges equal a clean index of the same tree in a new data directory.
      const clean = fresh(repo)
      const cleanRun = index(clean, repo)
      expect(cleanRun.id).toBe(incremental.id)
      expect(dump(d, incremental.id)).toBe(dump(clean, incremental.id))
    }, 300000)
  }

  it('FR1124 two edits in a row, then a revert to sealed content, answer from the first snapshot and then unchanged', () => {
    const repo = tmpDir('pm-fast-')
    fs.cpSync(fixtureRepo('ts-invoicing'), repo, { recursive: true })
    withLaterFunction(repo)
    const d = fresh(repo)
    const base = index(d, repo)
    expect(index(d, repo)).toMatchObject({ id: base.id, status: 'unchanged' })
    const original = fs.readFileSync(path.join(repo, CURRENCY), 'utf8')
    write(repo, CURRENCY, (t) => t.replace('  return `${', '  const a = 1;\n  return `${'))
    const first = index(d, repo)
    write(repo, CURRENCY, (t) => t.replace('const a = 1;', 'const a = 2;'))
    const second = index(d, repo)
    expect(second.reused).toBe(second.of - 1)
    const clean = fresh(repo)
    expect(dump(d, second.id)).toBe(dump(clean, index(clean, repo).id))
    fs.writeFileSync(path.join(repo, CURRENCY), original)
    expect(index(d, repo)).toMatchObject({ id: base.id, status: 'unchanged' })
    expect(first.id).not.toBe(second.id)
  }, 300000)
})

describe('#31 the core and the seal', () => {
  it('FR1125 two units with one id are a protocol error, not one key shared by their files', () => {
    const units = [{ id: 'same', files: ['a.ts'] }, { id: 'same', files: ['b.ts'] }]
    expect(() => fileKeys({ repository: 'r', adapter: {}, analysisMode: 'no_execution', config: {}, externalInputs: [], configs: [], sources: ['a.ts', 'b.ts'], units, hashOf: (p) => p })).toThrow('two units have the same id')
  })

  it("FR1126 a declaration's body hash replaces its name exactly as the Unicode expression did", () => {
    const WORD = '[\\p{L}\\p{N}_$]'
    const byExpression = (out: string, name: string) => out.replace(new RegExp(`(?<![.${WORD.slice(1, -1)}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!${WORD})`, 'gu'), '\u0001')
    const piece = fc.constantFrom('a', 'b', 'ab', '.', ' ', '\n', '$', '_', '1', 'é', '\u{1D400}', '\uD835', '\uDC00', '(', '名', '\t', '٣', '*')
    const text = fc.array(piece, { maxLength: 16 }).map((p) => p.join(''))
    const name = fc.array(piece, { minLength: 1, maxLength: 3 }).map((p) => p.join(''))
    // FR1680: the scan alone first, so a regular expression per name it built is compiled here and not cached by the oracle's.
    const cpu = () => { const c = process.cpuUsage(); return c.user + c.system }
    const pairs = fc.sample(fc.tuple(text, name), 20000)
    let start = cpu()
    for (const [t, n] of pairs) { normaliseDeclaration(t, n, 'module'); normaliseDeclaration(t, n, 'method') }
    const scan = cpu() - start
    start = cpu()
    fc.assert(fc.property(text, name, (t, n) => {
      // A module's text is normalised alike but keeps every name.
      const kept = normaliseDeclaration(t, n, 'module')
      expect(normaliseDeclaration(t, n, 'method')).toBe(kept === null || kept.trim() === n ? null : byExpression(kept, n))
    }), { numRuns: 20000 })
    const oracle = cpu() - start
    expect(scan, `the scan took ${scan / 1000} ms of CPU, the expression per name ${oracle / 1000} ms`).toBeLessThan(oracle / 10)
  }, 300000)
})
