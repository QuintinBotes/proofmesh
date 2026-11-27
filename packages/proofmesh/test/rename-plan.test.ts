// A read-only rename plan, every site to change, seams included (#38): fixtures/rename-parity, fixtures/rename-seams, FR980 to FR987.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, ROOT, tmpDir, tool } from './helpers.js'
import { CAPABILITY, PROFILE } from '../src/query/tools.js'

type Site = { path: string; line: number; kind: string; basis: 'observed' | 'inferred'; key: string; seam?: string; rule?: string; text?: string }
type Member = { id: string; key: string; name: string; kind: string; path: string; line: number; relationship?: string }
type Plan = { subject: Member; new_name: string; sites: Site[]; must_rename_together: Member[]; possibly_affected: Array<{ path: string; line: number; callee: string; resolution: string }>; counts: Record<string, number> }

const plan = (dataDir: string, subject: { name: string; path: string }, newName = 'renamed') => {
  const env = tool(dataDir, 'plan_rename', { subject_id: subject, new_name: newName, limits: { max_rows: 5000 } })
  return { ...(env.data as Plan), limitations: env.limitations }
}
const observed = (p: Plan) => p.sites.filter((s) => s.basis === 'observed').map((s) => `${s.path}:${s.line}`).sort()

/** A copy of a fixture, so nothing the test does can touch the checkout. */
function copy(name: string): string {
  const dir = fs.realpathSync(tmpDir(`pm-${name}-`))
  fs.cpSync(fixtureRepo(name), dir, { recursive: true })
  return dir
}
/** The TypeScript language service's rename locations of the name at a line, as `path:line`: the truth code sites are scored on. */
function languageService(repo: string) {
  const cfg = ts.getParsedCommandLineOfConfigFile(path.join(repo, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(String(d.messageText)) } })!
  const ls = ts.createLanguageService({
    getScriptFileNames: () => cfg.fileNames, getScriptVersion: () => '1', getScriptSnapshot: (f) => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined),
    getCurrentDirectory: () => repo, getCompilationSettings: () => cfg.options, getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
  })
  return (file: string, line: number, name: string): string[] => {
    const sf = ls.getProgram()!.getSourceFile(path.join(repo, file))!
    const column = new RegExp(`(?<![\\w$])${name}(?![\\w$])`).exec(sf.text.split('\n')[line - 1]!)!.index
    const at = (l: ts.RenameLocation) => `${path.relative(repo, l.fileName)}:${ls.getProgram()!.getSourceFile(l.fileName)!.getLineAndCharacterOfPosition(l.textSpan.start).line + 1}`
    return [...new Set((ls.findRenameLocations(sf.fileName, sf.getPositionOfLineAndCharacter(line - 1, column), false, false) ?? []).map(at))].sort()
  }
}
const digest = (dir: string) => {
  const h = crypto.createHash('sha256')
  for (const f of (fs.readdirSync(dir, { recursive: true }) as string[]).sort()) if (fs.statSync(path.join(dir, f)).isFile()) h.update(`${f}\0`).update(fs.readFileSync(path.join(dir, f)))
  return h.digest('hex')
}

// The ten pinned symbols: functions, methods, an interface member, classes, an interface and a type alias.
const PINNED = [
  { path: 'src/globals.ts', name: 'getMetadataStorage' },
  { path: 'src/util/StringUtils.ts', name: 'camelCase' },
  { path: 'src/data-source/DataSource.ts', name: 'DataSource.getMetadata' },
  { path: 'src/data-source/DataSource.ts', name: 'DataSource.initialize' },
  { path: 'src/driver/Driver.ts', name: 'Driver.escape' },
  { path: 'src/error/AppError.ts', name: 'AppError' },
  { path: 'src/common/ObjectLiteral.ts', name: 'ObjectLiteral' },
  { path: 'src/common/ObjectType.ts', name: 'ObjectType' },
  { path: 'src/data-source/DataSource.ts', name: 'DataSource' },
  { path: 'src/util/OrmUtils.ts', name: 'OrmUtils.mergeDeep' },
]

describe('FR980 to FR987 the rename plan on fixtures/rename-parity', () => {
  let dataDir = '', repo = '', truth: ReturnType<typeof languageService>
  beforeAll(async () => {
    repo = copy('rename-parity')
    dataDir = (await indexedDataDir(repo)).dataDir
    truth = languageService(repo)
  }, 180000)

  it('FR980 FR981 FR986 scenario 1: for each of the ten pinned symbols the observed code sites equal the language service\'s findRenameLocations, 100% recall and precision', () => {
    for (const s of PINNED) {
      const p = plan(dataDir, s)
      const want = truth(p.subject.path, p.subject.line, s.name.split('.').pop()!)
      expect(want.length, s.name).toBeGreaterThan(1)
      expect(observed(p), s.name).toEqual(want)
    }
  })

  it('FR981 FR988 edge cases: a shorthand destructuring and the later use of its local, an import alias, an export under another name and a recursive call are listed as the language service lists them', () => {
    // const { escape } = this.driver, then escape.call(...): both lines; Repository's `camelCase as toCamel` names it once, and toCamel(...) is no site.
    expect(observed(plan(dataDir, PINNED[4]!))).toEqual(expect.arrayContaining(['src/data-source/DataSource.ts:32', 'src/data-source/DataSource.ts:33']))
    expect(observed(plan(dataDir, PINNED[1]!))).toEqual(expect.arrayContaining(['src/repository/Repository.ts:2', 'src/util/StringUtils.ts:13']))
    expect(observed(plan(dataDir, PINNED[1]!))).not.toContain('src/repository/Repository.ts:17')
    // export { getMetadataStorage as metadataStorage }: the language service renames the alias with it, so its import and call are sites too.
    expect(observed(plan(dataDir, PINNED[0]!))).toEqual(expect.arrayContaining(['src/globals.ts:10', 'src/connect.ts:6', 'src/connect.ts:11']))
    expect(observed(plan(dataDir, PINNED[9]!))).toContain('src/util/OrmUtils.ts:10')
  })

  it('FR980 FR981 a function called above its declaration is placed at its declaration; a recursive call inside a template is a site, an option and a key of its name are not', () => {
    const p = plan(dataDir, { path: 'src/util/StringUtils.ts', name: 'nest' })
    expect(p.subject.line).toBe(21)
    expect(observed(p)).toEqual(['src/util/StringUtils.ts:17', 'src/util/StringUtils.ts:21', 'src/util/StringUtils.ts:28'])
    expect(observed(p)).toEqual(truth(p.subject.path, 21, 'nest'))
  })

  it('FR982 scenario 2: Driver.escape lists every member that implements or overrides it as must_rename_together with its file and line, and not AuroraDriver, which only inherits one', () => {
    const p = plan(dataDir, PINNED[4]!)
    expect(p.must_rename_together.map((m) => [`${m.path}:${m.line}`, m.name, m.relationship])).toEqual([
      ['src/driver/mysql/MysqlDriver.ts:7', 'escape', 'implements'],
      ['src/driver/mysql/MysqlDriver.ts:18', 'escape', 'implements'],
      ['src/driver/postgres/PostgresDriver.ts:8', 'escape', 'implements'],
      ['src/driver/sqlite/SqliteDriver.ts:10', 'escape', 'implements'],
    ])
    expect(p.counts.must_rename_together).toBe(4)
    for (const m of p.must_rename_together) expect(p.sites).toContainEqual(expect.objectContaining({ path: m.path, line: m.line, kind: 'implementation', basis: 'observed', key: m.key }))
    expect(p.sites.some((s) => s.path.includes('aurora'))).toBe(false)
  })

  it('FR983 an untyped call of the same name is listed apart under possibly_affected with its count, never as a site', () => {
    const p = plan(dataDir, PINNED[4]!)
    expect(p.possibly_affected).toEqual([{ path: 'src/connect.ts', line: 18, callee: 'escape', resolution: 'unresolved' }])
    expect(p.counts.possibly_affected).toBe(1)
    expect(observed(p)).not.toContain('src/connect.ts:18')
    expect(p.limitations).toContain('1 call that did not resolve, or resolved to several candidates, might reach escape; they are listed under possibly_affected, not as sites.')
  })

  it('FR985 scenario 4: a symbol exported from the package\'s public entry carries the public export limitation, and one the entry does not export does not', () => {
    const LIMIT = 'public export: consumers outside this repository are not listed'
    for (const s of [PINNED[8]!, PINNED[2]!, PINNED[4]!, PINNED[1]!]) expect(plan(dataDir, s).limitations, s.name).toContain(LIMIT)
    // packageName is declared in the entry itself, but the entry does not export it.
    for (const s of [PINNED[0]!, PINNED[9]!, { path: 'src/index.ts', name: 'packageName' }]) expect(plan(dataDir, s).limitations, s.name).not.toContain(LIMIT)
  })

  it('FR985 a new name that a symbol of the same scope already has is said, in the scope of every member renamed together too', () => {
    expect(plan(dataDir, PINNED[2]!, 'hasMetadata').limitations).toContain('hasMetadata already names a method at src/data-source/DataSource.ts:27 in the same scope.')
    expect(plan(dataDir, PINNED[4]!, 'quoteName').limitations).toContain('quoteName already names a method at src/driver/mysql/MysqlDriver.ts:22 in the same scope.')
  })

  it('FR987 the plan changes nothing: the repository is byte for byte the same after every plan, and the tool is a read tool outside core', () => {
    const before = digest(repo)
    for (const s of PINNED) plan(dataDir, s)
    expect(digest(repo)).toBe(before)
    expect(CAPABILITY.plan_rename).toBe('read')
    expect(PROFILE.plan_rename).toBe('extra')
  })
})

describe('FR984 scenario 3: the seams of fixtures/rename-seams are inferred rows with their kind, and no code site is', () => {
  type Expected = { path: string; name: string; seams: Array<{ path: string; line: number; seam: string }>; code: string[]; not_seams?: Array<{ path: string; line: number }> }
  const EXPECTED = (JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'rename-seams', 'expected.json'), 'utf8')) as { subjects: Expected[] }).subjects
  let dataDir = '', repo = ''
  beforeAll(async () => {
    repo = copy('rename-seams')
    dataDir = (await indexedDataDir(repo)).dataDir
  }, 180000)

  for (const e of EXPECTED) {
    it(`${e.name}: every seam the fixture lists is inferred with its kind, and every code site is observed`, () => {
      const p = plan(dataDir, { name: e.name, path: e.path })
      const inferred = p.sites.filter((s) => s.basis === 'inferred')
      expect(inferred.map((s) => ({ path: s.path, line: s.line, seam: s.seam }))).toEqual(e.seams)
      expect(observed(p)).toEqual([...e.code].sort())
      // A seam row names its rule; a code row names none and is never inferred.
      for (const s of inferred) expect(s.rule, `${s.path}:${s.line}`).toBeTruthy()
      for (const s of p.sites.filter((x) => ['declaration', 'call', 'reference', 'import', 'export', 'implementation', 'override'].includes(x.kind))) expect(s.basis).toBe('observed')
      for (const n of e.not_seams ?? []) expect(inferred.some((s) => s.path === n.path && s.line === n.line), `${n.path}:${n.line}`).toBe(false)
    })
  }

  it('no code site of a TypeScript subject is inferred: the observed sites are the language service\'s', () => {
    const truth = languageService(repo)
    for (const e of EXPECTED.filter((x) => x.path.endsWith('.ts'))) {
      const p = plan(dataDir, { name: e.name, path: e.path })
      expect(observed(p), e.name).toEqual(truth(p.subject.path, p.subject.line, e.name))
    }
  })
})

describe('FR984 the seams of the schema and FFI rules', () => {
  it('a gRPC server method names its RPC in the proto, a GraphQL resolver its field, each an inferred seam', async () => {
    const { dataDir } = await indexedDataDir(fixtureRepo('seams-schema'))
    const rows = (p: Plan) => p.sites.filter((s) => s.basis === 'inferred').map((s) => [`${s.path}:${s.line}`, s.seam, s.rule])
    expect(rows(plan(dataDir, { name: 'GetOrder', path: 'server/orders.go' }))).toEqual([['proto/orders.proto:8', 'rpc', 'grpc_server']])
    expect(rows(plan(dataDir, { name: 'resolvers.Query.order', path: 'api/resolvers.ts' }))).toContainEqual(['schema.graphql:2', 'graphql', 'graphql_resolver_map'])
  }, 120000)

  it('a JNI native method names the C function on the other side, and a C function every caller across the interface, each an inferred ffi seam', async () => {
    const { dataDir } = await indexedDataDir(fixtureRepo('seams-ffi'))
    const rows = (p: Plan) => p.sites.filter((s) => s.basis === 'inferred').map((s) => [`${s.path}:${s.line}`, s.seam, s.rule])
    expect(rows(plan(dataDir, { name: 'add', path: 'java/src/main/java/com/acme/Native.java' }))).toEqual([['c/jni.c:3', 'ffi', 'jni']])
    expect(rows(plan(dataDir, { name: 'calc_add', path: 'c/calc.c' }))).toEqual([['cs/Calc.cs:6', 'ffi', 'pinvoke'], ['go/calc.go:7', 'ffi', 'cgo'], ['rust/lib.rs:6', 'ffi', 'rust_extern_c']])
  }, 120000)
})
