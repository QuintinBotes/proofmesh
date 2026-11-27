import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256 } from '../src/core/hash.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { runTool } from '../src/query/tools.js'
import { cli, FIXTURE, tmpDir, tool } from './helpers.js'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' }).trim()
const MAGIC = 'proofmesh-snapshot 0.1\n'

let shared: { origin: string; a: string; file: string } | undefined

/** The fixture as a git repository, indexed and exported from its own data directory; then a clone of it, registered in a fresh one. */
function exported(extra?: Record<string, string>, setup?: (dataDir: string) => void) {
  const source = extra || setup ? build(extra ?? {}, setup ?? (() => {})) : (shared ??= build({}, () => {}))
  const clone = path.join(fs.realpathSync(tmpDir('pm-xfer-clone-')), 'repo')
  execFileSync('git', ['clone', '-q', source.origin, clone])
  const b = tmpDir('pm-xfer-b-')
  expect(cli(['--data-dir', b, 'init']).status).toBe(0)
  expect(cli(['--data-dir', b, 'repo', 'add', clone]).status).toBe(0)
  return { ...source, clone, b }
}

function build(extra: Record<string, string>, setup: (dataDir: string) => void) {
  const origin = fs.realpathSync(tmpDir('pm-xfer-origin-'))
  fs.cpSync(FIXTURE, origin, { recursive: true })
  for (const [p, text] of Object.entries(extra)) fs.writeFileSync(path.join(origin, p), text)
  git(origin, 'init', '-q')
  git(origin, 'add', '-A')
  git(origin, 'commit', '-q', '-m', 'fixture')
  const a = tmpDir('pm-xfer-a-')
  expect(cli(['--data-dir', a, 'init']).status).toBe(0)
  setup(a)
  expect(cli(['--data-dir', a, 'repo', 'add', origin]).status).toBe(0)
  const indexed = cli(['--data-dir', a, 'index', origin])
  expect(indexed.status, indexed.stderr).toBe(0)
  const file = path.join(tmpDir('pm-xfer-file-'), 's.pms')
  const out = cli(['--data-dir', a, 'snapshot', 'export', origin, '--out', file])
  expect(out.status, out.stderr).toBe(0)
  return { origin, a, file }
}

/** The data directory's snapshots, sealed files and current pointers: what a refused import must leave as it was. */
function state(dataDir: string) {
  const c = Catalog.open(dataDir)
  try {
    return { snapshots: c.db.prepare('select id, state from snapshot order by id').all(), current: c.currentSnapshotIds(), sealed: fs.readdirSync(path.join(dataDir, 'snapshots')).sort(), staging: fs.readdirSync(path.join(dataDir, 'staging')) }
  } finally {
    c.close()
  }
}

/** Rewrites an export with its snapshot changed by `edit`, and every hash recomputed so the file is self-consistent: what a forger could write. */
function forge(file: string, edit: (db: Database.Database) => void, manifestEdit: (m: Record<string, any>) => void = () => {}): string {
  const bytes = fs.readFileSync(file)
  const nl = bytes.indexOf(0x0a, MAGIC.length)
  const manifest = JSON.parse(bytes.subarray(MAGIC.length, nl).toString('utf8'))
  const dir = tmpDir('pm-xfer-forge-'), db = path.join(dir, 'x.db')
  fs.writeFileSync(db, bytes.subarray(nl + 1))
  const h = new Database(db)
  edit(h)
  h.close()
  const store = fs.readFileSync(db)
  const { manifest_sha256: _, ...body } = manifest
  body.store = { sha256: sha256(store), bytes: store.length }
  manifestEdit(body)
  const out = path.join(dir, 'forged.pms')
  fs.writeFileSync(out, Buffer.concat([Buffer.from(MAGIC + JSON.stringify({ ...body, manifest_sha256: sha256(canonicalJson(body)) }) + '\n'), store]))
  return out
}

const refusal = (r: { status: number | null; stderr: string }) => { expect(r.status).toBe(1); return r.stderr }

describe('FR1080 to FR1085 start from a snapshot built elsewhere for the same commit (#39)', () => {
  it('FR1080 FR1081 FR1083 FR1084 a clone at the same commit imports the snapshot, answers at once, and every answer says imported with its origin', () => {
    const { origin, a, file, clone, b } = exported()
    const started = Date.now()
    const r = cli(['--data-dir', b, 'snapshot', 'import', clone, file])
    const seconds = (Date.now() - started) / 1000
    expect(r.status, r.stderr).toBe(0)
    expect(seconds).toBeLessThanOrEqual(3)
    expect(r.stdout).toMatch(/all \d+ files match the working tree/)
    const here = tool(b, 'find_symbols', { text: 'invoiceTotal' }), there = tool(a, 'find_symbols', { text: 'invoiceTotal' })
    expect((here.data.symbols as unknown[]).length).toBeGreaterThan(0)
    expect(here.data).toEqual(there.data)
    expect(here.snapshot!.id).toBe(there.snapshot!.id)
    expect((here.snapshot as any).imported).toMatchObject({ origin: { repository_id: there.snapshot!.repository_id, repository_name: path.basename(origin), writer: expect.stringMatching(/^proofmesh by /) }, stale_count: 0 })
    expect((there.snapshot as any).imported).toBeUndefined()
    expect(here.limitations[0]).toMatch(/^imported: snapshot snap_[0-9a-f]+ was built elsewhere \(proofmesh by [^,]+, repository pm-xfer-origin-[^,]+, exported [^)]+\) and imported [^;]+; its facts are only as honest as the data directory that built it\. Every file it read matched the working tree on import\.$/)
    // Evidence comes from the clone's own bytes, so a symbol's source reads and verifies without a re-index.
    const sym = (tool(b, 'get_symbol', { symbol_id: (here.data.symbols as Array<{ id: string }>)[0]!.id }).data as { symbol: { evidence_id: string } }).symbol
    expect((tool(b, 'read_evidence', { evidence_ids: [sym.evidence_id] }).data.evidence as any[])[0]).toMatchObject({ integrity: { status: 'verified' }, text: expect.stringContaining('invoiceTotal') })
    const lean = runTool(b, 'find_symbols', { text: 'invoiceTotal', envelope: 'lean' }).text!
    expect(lean.split('\n')[0]).toMatch(/ current imported$/)
    expect(lean).toContain('# imported: snapshot')
    // An imported snapshot is not exported again under this data directory's name.
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'export', clone, '--out', path.join(tmpDir(), 'again.pms')]))).toMatch(/was imported; export it from the data directory that built it/)
  })

  it('FR1081 FR1083 a file edited before import is published stale and named in every answer; the next index seals a snapshot built here', () => {
    const { file, clone, b } = exported()
    fs.appendFileSync(path.join(clone, 'packages', 'billing', 'src', 'invoice.ts'), '\nexport const edited = 1\n')
    const r = cli(['--data-dir', b, 'snapshot', 'import', clone, file])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/1 of \d+ files differ from the working tree and are stale: packages\/billing\/src\/invoice\.ts;/)
    const env = tool(b, 'find_symbols', { text: 'invoiceTotal' })
    expect((env.snapshot as any).imported.stale_count).toBe(1)
    expect(env.limitations[0]).toMatch(/1 file differed from the working tree on import, so answers about it are stale: packages\/billing\/src\/invoice\.ts\. Index the repository/)
    const imported = env.snapshot!.id
    // Its source is never shown from the snapshot: the clone's bytes differ, so no object was written for the snapshot's hash.
    const stale = (tool(b, 'get_symbol', { symbol_id: (env.data.symbols as Array<{ id: string }>)[0]!.id }).data as { symbol: { evidence_id: string } }).symbol
    expect((tool(b, 'read_evidence', { evidence_ids: [stale.evidence_id] }).data.evidence as any[])[0]).toMatchObject({ integrity: { status: 'unavailable' }, text: null })
    const indexed = cli(['--data-dir', b, 'index', clone])
    expect(indexed.status, indexed.stderr).toBe(0)
    const after = tool(b, 'find_symbols', { text: 'edited' })
    expect(after.snapshot!.id).not.toBe(imported)
    expect((after.snapshot as any).imported).toBeUndefined()
    expect(after.limitations.some((l) => l.startsWith('imported:'))).toBe(false)
    expect((after.data.symbols as Array<{ name: string }>).map((s) => s.name)).toContain('edited')
  })

  it('FR1082 a snapshot of another commit is refused with both commits, and nothing changes', () => {
    const { file, clone, b } = exported()
    fs.writeFileSync(path.join(clone, 'NOTE.md'), 'later\n')
    git(clone, 'add', '-A')
    git(clone, 'commit', '-q', '-m', 'later')
    const before = state(b)
    const err = refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, file]))
    expect(err).toMatch(/snapshot import refused: the snapshot is of commit [0-9a-f]{40}, and .* is at commit [0-9a-f]{40}; nothing changed/)
    expect(state(b)).toEqual(before)
  })

  it('FR1082 a snapshot built by an adapter whose code differs from the one installed here, or that is not installed here, is refused', () => {
    const linelang = path.join(import.meta.dirname, 'fake-adapters', 'linelang.mjs')
    const install = (d: string, entry: string) => expect(cli(['--data-dir', d, 'adapter', 'add', entry, '--id', 'linelang', '--extension', '.fake=linelang']).status).toBe(0)
    const { file, clone, b } = exported({ 'notes.fake': 'alpha\nbeta\n' }, (a) => install(a, linelang))
    const before = state(b)
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, file]))).toMatch(/built by adapters that differ from those here: linelang .*\(not installed here\); nothing changed/)
    expect(state(b)).toEqual(before)
    // The same id and version, one byte of code apart.
    const other = path.join(tmpDir('pm-xfer-adapter-'), 'linelang.mjs')
    fs.writeFileSync(other, fs.readFileSync(linelang, 'utf8') + '\n// rebuilt\n')
    install(b, other)
    const again = state(b)
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, file]))).toMatch(/linelang .*\(its code differs from the one installed here\); nothing changed/)
    expect(state(b)).toEqual(again)
  })

  it('FR1081 a file whose manifest or snapshot bytes do not match its hashes is refused as corrupt, and nothing changes', () => {
    const { file, clone, b } = exported()
    const before = state(b)
    const bytes = fs.readFileSync(file)
    const nl = bytes.indexOf(0x0a, MAGIC.length)
    // One byte of the manifest: a hash inside it, so it stays valid JSON of the right shape.
    const inManifest = Buffer.from(bytes)
    const at = inManifest.indexOf('"manifest_sha256":"') - 3
    inManifest[at] = inManifest[at] === 0x61 ? 0x62 : 0x61
    const m1 = path.join(tmpDir(), 'm.pms')
    fs.writeFileSync(m1, inManifest)
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, m1]))).toMatch(/the file is corrupt: .*; nothing changed/)
    // One byte of the snapshot after the manifest.
    const inStore = Buffer.from(bytes)
    inStore[nl + 5000] = inStore[nl + 5000]! ^ 0xff
    const m2 = path.join(tmpDir(), 's.pms')
    fs.writeFileSync(m2, inStore)
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, m2]))).toMatch(/the file is corrupt: the snapshot bytes do not match the hash in its manifest; nothing changed/)
    // Not an export at all.
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, path.join(clone, 'README.md')]))).toMatch(/is not a proofmesh snapshot export of format 0\.1/)
    expect(state(b)).toEqual(before)
  })

  it('FR1081 a self-consistent forgery is still refused: a trigger or view it adds, or an identity it edits, does not pass', () => {
    const { file, clone, b } = exported()
    const before = state(b)
    const trigger = forge(file, (db) => db.exec("create trigger t after insert on meta begin select 1; end"))
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, trigger]))).toMatch(/the snapshot's tables are not those of format 0\.13; nothing changed/)
    const view = forge(file, (db) => db.exec('drop table external_symbol; create view external_symbol as select 1 as id, 2 as module, 3 as name'))
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, view]))).toMatch(/not those of format 0\.13/)
    // An identity edited to claim another adapter no longer hashes to the snapshot's id.
    const identity = forge(file, (db) => {
      const v = JSON.parse((db.prepare("select value from meta where key = 'identity'").get() as { value: string }).value)
      v.resolution = 'forged'
      db.prepare("update meta set value = ? where key = 'identity'").run(JSON.stringify(v))
    })
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, identity]))).toMatch(/the snapshot id does not match its identity/)
    // The manifest's file list must be the snapshot's own.
    const files = forge(file, () => {}, (m) => { m.files['packages/extra.ts'] = 'a'.repeat(64) })
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, files]))).toMatch(/the manifest does not match the snapshot it carries/)
    expect(state(b)).toEqual(before)
  })

  it('FR1081 FR1085 a path or object hash that leaves the repository or the evidence store is refused, and no file it names is read', () => {
    const { file, clone, b } = exported()
    const before = state(b)
    // A secret beside the clone, and a forged file row that names it with its true hash, the manifest rewritten to agree: a later
    // verification run would write it outside its copy of the tree.
    const secret = 'do not read\n', hash = sha256(secret)
    fs.writeFileSync(path.join(path.dirname(clone), 'secret.txt'), secret)
    const escape = forge(file, (db) => {
      db.prepare("insert into file (id, path, content_hash, size, language, disposition, disposition_detail, capabilities) values ('file_escape', '../secret.txt', ?, ?, 'typescript', 'indexed', null, '{}')").run(hash, secret.length)
    }, (m) => { m.files['../secret.txt'] = hash })
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, escape]))).toMatch(/the file is corrupt: it names a file outside the repository: "\.\.\/secret\.txt"; nothing changed/)
    expect(fs.existsSync(path.join(b, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash))).toBe(false)
    // A content hash that is a path out of the evidence store, hidden behind a doc entry that gives the checks the file's true hash.
    const hidden = forge(file, (db) => {
      const f = db.prepare("select path, content_hash from file where content_hash is not null order by path limit 1").get() as { path: string; content_hash: string }
      db.prepare('update file set content_hash = ? where path = ?').run('../../../../../../secret.txt', f.path)
      const docs = JSON.parse((db.prepare("select value from meta where key = 'doc_links'").get() as { value: string } | undefined)?.value ?? '{"docs":{}}')
      docs.docs[f.path] = f.content_hash
      db.prepare("insert or replace into meta (key, value) values ('doc_links', ?)").run(JSON.stringify(docs))
    })
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, hidden]))).toMatch(/the file is corrupt: .*(is not a sha256|two content hashes); nothing changed/)
    const evidence = forge(file, (db) => { db.prepare("update evidence set object_hash = '../../secret' where rowid = (select min(rowid) from evidence)").run() })
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, evidence]))).toMatch(/an evidence object hash is not a sha256; nothing changed/)
    expect(state(b)).toEqual(before)
  })

  it('FR1083 an import never replaces a snapshot the repository already has', () => {
    const { file, clone, b } = exported()
    expect(cli(['--data-dir', b, 'index', clone]).status).toBe(0)
    const before = state(b)
    expect(refusal(cli(['--data-dir', b, 'snapshot', 'import', clone, file]))).toMatch(/already has snapshot snap_[0-9a-f]+, and an import never replaces a local snapshot; nothing changed/)
    expect(state(b)).toEqual(before)
  })
})
