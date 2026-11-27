// The rename plan on the parity fixture (#38): for ten pinned TypeORM symbols, the code sites plan_rename lists over MCP are
// scored against the TypeScript language service's findRenameLocations (default options), at file:line.
//
//   sh bench/parity/run.sh            once, to build the fixture (or point PARITY_FIXTURE at it)
//   node bench/parity/rename.mjs      prints one row per symbol and exits 1 on any miss or extra
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(ROOT, 'packages/proofmesh/package.json'))
const ts = require(path.join(ROOT, 'node_modules/typescript'))
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'))
const CLI = path.join(ROOT, 'packages/proofmesh/bin/proofmesh.mjs')
const FIXTURE = fs.realpathSync(process.env.PARITY_FIXTURE ?? path.join(os.tmpdir(), 'parity-typeorm'))
const PINNED = [
  ['src/globals.ts', 'getMetadataArgsStorage'], ['src/util/StringUtils.ts', 'camelCase'], ['src/data-source/DataSource.ts', 'DataSource.getMetadata'],
  ['src/data-source/DataSource.ts', 'DataSource.initialize'], ['src/driver/Driver.ts', 'Driver.escape'], ['src/error/TypeORMError.ts', 'TypeORMError'],
  ['src/common/ObjectLiteral.ts', 'ObjectLiteral'], ['src/common/ObjectType.ts', 'ObjectType'], ['src/data-source/DataSource.ts', 'DataSource'], ['src/util/OrmUtils.ts', 'OrmUtils.mergeDeep'],
]

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-parity-rename-'))
for (const args of [['init'], ['repo', 'add', FIXTURE], ['index', FIXTURE]]) execFileSync(process.execPath, [CLI, '--data-dir', data, ...args], { stdio: ['ignore', 'ignore', 'inherit'] })
const cfg = ts.getParsedCommandLineOfConfigFile(path.join(FIXTURE, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
const ls = ts.createLanguageService({
  getScriptFileNames: () => cfg.fileNames, getScriptVersion: () => '1', getScriptSnapshot: (f) => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined),
  getCurrentDirectory: () => FIXTURE, getCompilationSettings: () => cfg.options, getDefaultLibFileName: ts.getDefaultLibFilePath,
  fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
})
const client = new Client({ name: 'parity-rename', version: '0' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, '--data-dir', data, 'mcp', '--tools', 'extra'], stderr: 'ignore' }))
let bad = 0
console.log('| symbol | language service | plan_rename observed | missed | extra | must_rename_together | possibly_affected |\n|---|---|---|---|---|---|---|')
for (const [file, name] of PINNED) {
  const r = await client.callTool({ name: 'plan_rename', arguments: { subject_id: { name, path: file }, new_name: 'renamed', envelope: 'full', limits: { max_rows: 5000, max_bytes: 4000000 } } })
  const d = JSON.parse(r.content[0].text).data
  const got = new Set(d.sites.filter((s) => s.basis === 'observed').map((s) => `${s.path}:${s.line}`))
  const sf = ls.getProgram().getSourceFile(path.join(FIXTURE, d.subject.path))
  const column = new RegExp(`(?<![\\w$])${name.split('.').pop()}(?![\\w$])`).exec(sf.text.split('\n')[d.subject.line - 1]).index
  const want = new Set((ls.findRenameLocations(sf.fileName, sf.getPositionOfLineAndCharacter(d.subject.line - 1, column), false, false) ?? [])
    .map((l) => `${path.relative(FIXTURE, l.fileName)}:${ls.getProgram().getSourceFile(l.fileName).getLineAndCharacterOfPosition(l.textSpan.start).line + 1}`))
  const missed = [...want].filter((x) => !got.has(x)), extra = [...got].filter((x) => !want.has(x))
  bad += missed.length + extra.length
  console.log(`| ${name} | ${want.size} | ${got.size} | ${missed.length ? missed.join(' ') : 0} | ${extra.length ? extra.join(' ') : 0} | ${d.counts.must_rename_together} | ${d.counts.possibly_affected} |`)
}
await client.close()
fs.rmSync(data, { recursive: true, force: true })
process.exit(bad ? 1 : 0)
