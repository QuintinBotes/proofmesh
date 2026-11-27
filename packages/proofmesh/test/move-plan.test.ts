// A read-only move plan, every site a move of a file or a symbol must change, seams included (#38): fixtures/move-plan, FR1280 to FR1285.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { fixtureRepo, indexedDataDir, tmpDir, tool, withSnapshot } from './helpers.js'
import { CAPABILITY, PROFILE } from '../src/query/tools.js'

type Site = { path: string; line: number; kind: string; basis: 'observed' | 'inferred'; specifier?: string; new_specifier?: string; name?: string; split?: boolean; seam?: string; rule?: string }
type Plan = { subject: { kind: string; path: string; name?: string }; to_path: string; sites: Site[]; counts: Record<string, number> }

const plan = (dataDir: string, input: Record<string, unknown>) => {
  const env = tool(dataDir, 'plan_move', input)
  return { ...(env.data as Plan), limitations: env.limitations }
}
const rows = (p: Plan) => p.sites.map((s) => [`${s.path}:${s.line}`, s.kind, s.basis, s.specifier, s.new_specifier])

function copy(): string {
  const dir = fs.realpathSync(tmpDir('pm-move-'))
  fs.cpSync(fixtureRepo('move-plan'), dir, { recursive: true })
  return dir
}
const digest = (dir: string) => {
  const h = crypto.createHash('sha256')
  for (const f of (fs.readdirSync(dir, { recursive: true }) as string[]).sort()) if (fs.statSync(path.join(dir, f)).isFile()) h.update(`${f}\0`).update(fs.readFileSync(path.join(dir, f)))
  return h.digest('hex')
}
/** The TypeScript errors of a copy, as `path:line message`. */
function compileErrors(repo: string): string[] {
  const cfg = ts.getParsedCommandLineOfConfigFile(path.join(repo, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(String(d.messageText)) } })!
  const program = ts.createProgram(cfg.fileNames, cfg.options)
  return ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? path.relative(repo, d.file.fileName) : ''}:${d.file ? d.file.getLineAndCharacterOfPosition(d.start!).line + 1 : 0} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
}
/** Applies a plan by hand, as an agent would: each listed specifier becomes its new one at its line, then the file moves. */
function apply(repo: string, p: Plan, move: () => void): void {
  for (const s of p.sites.filter((x) => x.specifier !== undefined && x.new_specifier !== undefined && ['import', 'export', 'string', 'mention'].includes(x.kind))) {
    const file = path.join(repo, s.path), lines = fs.readFileSync(file, 'utf8').split('\n')
    expect(lines[s.line - 1], `${s.path}:${s.line}`).toContain(s.specifier!)
    lines[s.line - 1] = lines[s.line - 1]!.replace(s.specifier!, s.new_specifier!)
    fs.writeFileSync(file, lines.join('\n'))
  }
  move()
}

const FILE_MOVE = { path: 'src/mail/mailer.ts', to_path: 'src/mailer.ts' }

describe('FR1280 to FR1284 the move plan on fixtures/move-plan', () => {
  let dataDir = '', repo = ''
  beforeAll(async () => {
    repo = copy()
    dataDir = (await indexedDataDir(repo)).dataDir
  }, 180000)

  it('FR1280 FR1281 a file move lists every import and re-export of the file, with the specifier as written and as it must be, and the file\'s own imports that its new place changes', () => {
    const p = plan(dataDir, FILE_MOVE)
    expect(p.subject).toEqual({ kind: 'file', path: 'src/mail/mailer.ts' })
    expect(p.to_path).toBe('src/mailer.ts')
    expect(rows(p).filter((r) => r[2] === 'observed')).toEqual([
      ['src/alerts.ts:1', 'import', 'observed', './mail/mailer.js', './mailer.js'],
      ['src/index.ts:1', 'export', 'observed', './mail/mailer', './mailer'],
      ['src/mail/mailer.ts:1', 'import', 'observed', '../util/text', './util/text'],
      ['src/orders.ts:1', 'import', 'observed', './mail/mailer', './mailer'],
      ['test/mailer.test.ts:7', 'import', 'observed', '../src/mail/mailer', '../src/mailer'],
    ])
  })

  it('FR1283 a file move lists the strings that name the file\'s path and the doc mentions of it as inferred seams, and no log message or other path', () => {
    const p = plan(dataDir, FILE_MOVE)
    expect(p.sites.filter((s) => s.basis === 'inferred').map((s) => [`${s.path}:${s.line}`, s.kind, s.seam, s.rule, s.specifier, s.new_specifier])).toEqual([
      ['docs/mail.md:3', 'mention', 'doc_mention', 'doc_mention', '../src/mail/mailer.ts', '../src/mailer.ts'],
      ['docs/mail.md:5', 'mention', 'doc_mention', 'doc_mention', 'src/mail/mailer.ts', 'src/mailer.ts'],
      ['package.json:8', 'string', 'path', 'path_string', './src/mail/mailer.ts', './src/mailer.ts'],
      ['test/mailer.test.ts:4', 'string', 'path', 'path_string', '../src/mail/mailer', '../src/mailer'],
    ])
    expect(p.counts).toEqual({ observed: 5, inferred: 4 })
    // The package's main re-exports the file, so consumers outside the repository may import it by a deep path too.
    expect(p.limitations).toContain('public export: consumers outside this repository are not listed')
  })

  it('FR1280 FR1282 a symbol move lists the imports and re-exports that name it, the old file\'s uses that will need an import, and what the symbol uses that its new file must import', () => {
    const p = plan(dataDir, { subject_id: { name: 'Mailer', path: 'src/mail/mailer.ts' }, to_path: 'src/notify/postman.ts' })
    expect(p.subject).toMatchObject({ kind: 'class', name: 'Mailer', path: 'src/mail/mailer.ts' })
    expect(p.sites.map((s) => [`${s.path}:${s.line}`, s.kind, s.basis, s.specifier, s.new_specifier, s.name, s.split])).toEqual([
      ['src/alerts.ts:1', 'import', 'observed', './mail/mailer.js', './notify/postman.js', undefined, undefined],
      ['src/index.ts:1', 'export', 'observed', './mail/mailer', './notify/postman', undefined, true],
      ['src/mail/mailer.ts:11', 'dependency', 'observed', undefined, '../mail/mailer', 'formatSubject', undefined],
      ['src/mail/mailer.ts:16', 'add_import', 'observed', undefined, '../notify/postman', 'Mailer', undefined],
      ['src/orders.ts:1', 'import', 'observed', './mail/mailer', './notify/postman', undefined, true],
    ])
  })

  it('FR1280 a move needs a subject and a destination inside the repository', () => {
    expect(() => tool(dataDir, 'plan_move', { path: 'src/nothing.ts', to_path: 'src/x.ts' })).toThrow(/src\/nothing\.ts/)
    expect(() => tool(dataDir, 'plan_move', { ...FILE_MOVE, to_path: '../outside.ts' })).toThrow(/to_path/)
    expect(() => tool(dataDir, 'plan_move', { ...FILE_MOVE, to_path: 'src/orders.ts' })).toThrow(/src\/orders\.ts already exists/)
  })

  it('FR1284 the plan changes nothing: the repository is byte for byte the same, and the tool is a read tool outside core', () => {
    const before = digest(repo)
    plan(dataDir, FILE_MOVE)
    plan(dataDir, { subject_id: { name: 'Mailer', path: 'src/mail/mailer.ts' }, to_path: 'src/notify/postman.ts' })
    expect(digest(repo)).toBe(before)
    expect(CAPABILITY.plan_move).toBe('read')
    expect(PROFILE.plan_move).toBe('extra')
  })
})

describe('FR1285 a move applied as planned leaves no unresolved import and no stale mention', () => {
  const unresolved = (dataDir: string) => withSnapshot(dataDir, (db) => (db.prepare("select f.path, e.start_line as line from assertion a join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where a.type = 'imports' and a.resolution <> 'resolved' order by f.path, e.start_line").all() as Array<{ path: string; line: number }>).map((r) => `${r.path}:${r.line}`))
  const reindex = async (dataDir: string) => {
    const catalog = Catalog.open(dataDir)
    const id = catalog.repositories()[0]!.id
    catalog.close()
    await indexRepository(dataDir, id)
  }

  it('the file moved and every listed specifier rewritten: TypeScript compiles, every import resolves and no doc mention is stale; moved without the plan, neither holds', async () => {
    for (const planned of [true, false]) {
      const repo = copy(), { dataDir } = await indexedDataDir(repo)
      const p = plan(dataDir, FILE_MOVE)
      const move = () => fs.renameSync(path.join(repo, FILE_MOVE.path), path.join(repo, FILE_MOVE.to_path))
      if (planned) apply(repo, p, move)
      else move()
      await reindex(dataDir)
      const stale = (tool(dataDir, 'find_stale_mentions', {}).data as { total: number }).total
      if (planned) {
        expect(compileErrors(repo)).toEqual([])
        expect(unresolved(dataDir)).toEqual([])
        expect(stale).toBe(0)
      } else {
        expect(unresolved(dataDir).length).toBeGreaterThan(0)
        expect(stale).toBeGreaterThan(0)
      }
    }
  }, 240000)
})
