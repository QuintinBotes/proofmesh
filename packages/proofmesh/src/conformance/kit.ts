import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sha256 } from '../core/hash.js'
import type { InitializeRequest } from '../core/generated.js'
import { EvidenceStore } from '../evidence/store.js'
import { AdapterProcess, PROTOCOL_VERSION } from '../indexer/adapter-host.js'
import { indexRepository } from '../indexer/coordinator.js'
import { discover } from '../indexer/discovery.js'
import { splitByFile } from '../indexer/fact-cache.js'
import { BUILT_IN, Registry, registryFor, type AdapterSpec } from '../indexer/languages.js'
import { Catalog, initDataDir } from '../meshstore/catalog.js'
import { normalizedDump, openSnapshot } from '../meshstore/snapshot.js'
import { actualFacts, compare, type Expected } from './golden.js'

/** The adapter under test: a built-in one by its id, or any adapter by its entry file and the files it analyses. */
export type KitSubject = { id: string; entry: string; extensions: Record<string, string>; configNames: string[] }
export type KitCheck = { id: string; passed: boolean; detail: string }
export type KitResult = { adapter: { id: string; version: string; protocol_version: string } | null; checks: KitCheck[]; passed: boolean }

const PROBE = 'a field a later 1.x version might add, which an adapter must ignore'

const builtInOf = (s: KitSubject) => BUILT_IN.find((b) => b.id === s.id && b.entry() === s.entry)
/** The adapter as the kit runs it: a built-in keeps its own configuration rules, and every adapter takes the files the subject names. */
const specOf = (s: KitSubject): AdapterSpec => {
  const b = builtInOf(s)
  return b ? { ...b, extensions: s.extensions, languages: Object.keys(s.extensions).length ? new Set(Object.values(s.extensions)) : b.languages } : {
    id: s.id, languages: new Set(Object.values(s.extensions)), extensions: s.extensions, isConfig: (name) => s.configNames.includes(name),
    entry: () => s.entry, unavailable: () => `adapter_unavailable:${s.id}`,
  }
}

/**
 * The public conformance kit (FR071, FR072, SC014): runs an adapter over a fixture through the protocol and through the core's
 * own indexing, which applies every rule the core enforces, then checks determinism and, with reviewed expected facts, the
 * facts themselves. A capability is supported only when every check passes.
 */
export async function runKit(subject: KitSubject, fixture: string, expected?: Expected): Promise<KitResult> {
  const checks: KitCheck[] = []
  const check = async (id: string, run: () => Promise<string>) => {
    try { checks.push({ id, passed: true, detail: await run() }) } catch (e) { checks.push({ id, passed: false, detail: (e as Error).message }) }
  }
  const spec = specOf(subject)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-kit-'))
  const repo = path.join(work, 'repo')
  fs.cpSync(fixture, repo, { recursive: true })
  let adapter: KitResult['adapter'] = null

  const files = discover(repo, new Registry([spec])).filter((d) => d.status === 'capture' && ((d.role === 'source' && spec.languages.has(d.language!)) || (d.role === 'config' && d.language === `${spec.id}-config`)))
  const sources = files.filter((f) => f.role === 'source').map((f) => f.path)
  const adapterProcess = new AdapterProcess(subject.entry)
  let initialized = false
  await check('protocol.initialize', async () => {
    const request = {
      protocol_version: PROTOCOL_VERSION, workspace: repo, repository_root: repo, analysis_mode: 'no_execution', conformance_probe: PROBE,
      files: files.map((f) => ({ path: f.path, content_hash: sha256(fs.readFileSync(path.join(repo, f.path))), language: f.language! })),
    } as InitializeRequest
    const r = await adapterProcess.initialize(request)
    adapter = { id: r.adapter.id, version: r.adapter.version, protocol_version: r.adapter.protocol_version }
    initialized = true
    return `${r.adapter.id} ${r.adapter.version} speaks protocol ${r.adapter.protocol_version} and accepted a field it does not know`
  })
  await check('protocol.workspace', async () => {
    if (!initialized) throw new Error('not run: initialize failed')
    const r = await adapterProcess.workspace()
    return `${r.symbols.length} workspace symbols, ${r.relationships.length} relationships`
  })
  await check('protocol.analyze', async () => {
    if (!initialized) throw new Error('not run: initialize failed')
    const r = await adapterProcess.analyze(sources)
    splitByFile(r, sources)
    const answered = new Set(r.file_results.map((f) => f.path))
    const silent = sources.filter((p) => !answered.has(p))
    if (silent.length) throw new Error(`no file result for ${silent.slice(0, 3).join(', ')}${silent.length > 3 ? ` and ${silent.length - 3} more` : ''}`)
    return `${sources.length} files analysed, facts only for the files asked`
  })
  await check('protocol.shutdown', async () => {
    if (!(await adapterProcess.shutdownCleanly())) throw new Error('the adapter did not answer shutdown and exit by itself within 5 s')
    return 'answered and exited'
  })

  // The core's own indexing applies every rule it enforces: ranges, references, resolutions, reasons, and evidence.
  const index = async (dataDir: string) => {
    initDataDir(dataDir)
    const catalog = Catalog.open(dataDir)
    try {
      if (!builtInOf(subject)) catalog.installAdapter({ id: subject.id, entry: subject.entry, extensions: subject.extensions, configNames: subject.configNames }, 'conformance-kit')
      catalog.addRepository(repo)
    } finally { catalog.close() }
    // The adapter under check comes first, so it analyses its own files even where a built-in adapter would by default.
    return indexRepository(dataDir, repo, undefined, new Registry([spec, ...registryFor(dataDir).specs.filter((s) => s.id !== spec.id)]))
  }
  const first = path.join(work, 'data-1'), second = path.join(work, 'data-2')
  const dump = (dataDir: string) => {
    const catalog = Catalog.open(dataDir)
    try {
      const snap = catalog.currentSnapshot(catalog.repositories()[0]!.id)!
      const db = openSnapshot(catalog, snap)
      try { return { dump: normalizedDump(db), facts: expected ? actualFacts(db, new EvidenceStore(dataDir)) : null } } finally { db.close() }
    } finally { catalog.close() }
  }
  let published: ReturnType<typeof dump> | null = null
  await check('index.publishes', async () => {
    const r = await index(first)
    published = dump(first)
    return `snapshot ${r.snapshotId} ${r.status}: ${r.counts.indexed} files indexed`
  })
  await check('index.deterministic', async () => {
    if (!published) throw new Error('not run: the first index did not publish')
    await index(second)
    if (dump(second).dump !== published.dump) throw new Error('two indexes of the same tree sealed different facts')
    return 'two indexes of the same tree sealed the same facts'
  })
  for (const section of ['dispositions', 'symbols', 'calls', 'imports', 'structure'] as const) {
    if (!expected?.[section]) continue
    await check(`golden.${section}`, async () => {
      if (!published?.facts) throw new Error('not run: the first index did not publish')
      const diff = compare({ [section]: expected[section] }, published.facts)[0]
      if (diff) throw new Error(`${diff.missing.length} expected and missing, ${diff.unexpected.length} unexpected; first: ${(diff.missing[0] ?? diff.unexpected[0])!.slice(0, 200)}`)
      return `${(Array.isArray(expected[section]) ? (expected[section] as unknown[]).length : Object.keys(expected[section]!).length)} expected facts, all present, nothing else`
    })
  }
  fs.rmSync(work, { recursive: true, force: true })
  return { adapter, checks, passed: checks.every((c) => c.passed) }
}
