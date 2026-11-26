import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { canonicalJson, derivedId, sha256, sha256File } from '../core/hash.js'
import { ProofmeshError, storedMessage } from '../core/errors.js'
import { log } from '../core/log.js'
import type { AnalyzeResponse, InitializeResponse } from '../core/generated.js'
import { Catalog, LEASE_OWNER } from '../meshstore/catalog.js'
import { createStagingStore, faultPoint, FORMAT_VERSION, openStagingStore, sealAndPublish, stagingDir } from '../meshstore/snapshot.js'
import { CAPS, computeSummary } from '../query/summary.js'
import { fillAggregates } from '../query/overview.js'
import { readSql } from '../core/schemas.js'
import { effectiveCodeowners, ownerRule, OWNERSHIP_VERSION, parseCodeowners, type OwnerRule } from './ownership.js'
import { EvidenceStore } from '../evidence/store.js'
import { manifestHash, unstable } from './freshness.js'
import { fillBodyHashes } from './body-hash.js'
import { adapterBudgetMb, AdapterBudgetError, AdapterProcess, AdapterProtocolError, PROTOCOL_VERSION } from './adapter-host.js'
import { assemble, FactCache, fileKeys, splitByFile, type FileFacts } from './fact-cache.js'
import { analysisConfig, checkoutCommit, discover, gitInfo, type Discovered } from './discovery.js'
import { registryFor, type AdapterSpec, type Registry } from './languages.js'
import { buildCensus } from './census.js'
import { constrain, RESOLUTION_VERSION, type Sym } from './constrained/index.js'
import { type EndpointSym, linkHttp, SEAMS_VERSION } from './seams-http.js'
import { moduleCycles } from './module-cycles.js'

export type IndexResult = {
  snapshotId: string
  status: 'published' | 'unchanged'
  analysisMode: Mode
  counts: { discovered: number; indexed: number; excluded_by_rule: number; unsupported: number; failed: number; pending: number }
  /** Set when the run continued an interrupted one: how many analysis batches its checkpoint already held. */
  resumed?: { done: number; total: number }
  /** Source files whose cached facts were replayed because nothing they depend on changed, and files the adapters analysed (A16). */
  reuse?: { reused: number; analysed: number }
  /** The commit indexed when one was named instead of the working tree. */
  commit?: string
  /** The largest resident set size each adapter process reached, in KiB, where it could be sampled. */
  adapterPeakRssKb: Record<string, number>
  /** Each time an adapter passed its memory budget and was started again, and what the host did about it. */
  memoryRestarts?: Array<{ adapter: string; budget_mb: number; peak_rss_mb: number | null; files: number; action: 'smaller_batches' | 'file_failed' | 'adapter_failed' }>
}
type Mode = 'no_execution' | 'trusted_build'
type Captured = Discovered & { hash: string }
type Rel = AnalyzeResponse['relationships'][number]
type AdapterRun = { spec: AdapterSpec; sources: Discovered[]; configs: Discovered[]; process?: AdapterProcess; manifest?: InitializeResponse['adapter']; inputs?: string[]; mode: Mode; units?: InitializeResponse['units']; keys?: Map<string, string>; entrySha256?: string; budgetMb?: number; config?: Record<string, unknown>; unstartable?: AdapterBudgetError; cap?: number }
type Producer = { id: string; version: string; mode: Mode }
/** Import kinds, strongest first: a file that imports another both for its values and for its types depends on it at run time. */
const IMPORT_KINDS = ['static', 're_export', 'type_only']

const BATCH = () => Number(process.env.PROOFMESH_INDEX_BATCH) || 200
const languagesOf = (run: AdapterRun) => [...run.spec.languages].join('+')

/**
 * Checkpoint bookkeeping inside the staging file, dropped before sealing. A batch is done when its row commits, in the same
 * transaction as its symbols; its full adapter response is journalled beside the file first, so a resumed run replays it.
 */
const RESUME_DDL = 'create table resume_meta (key text primary key, value text not null); create table resume_batch (adapter text not null, batch integer not null, primary key (adapter, batch));'

/** Facts written by one build of this writer are never continued by another. */
const writerBuild = () => sha256(fs.readFileSync(fileURLToPath(import.meta.url)))

function resumable(file: string): boolean {
  if (!fs.existsSync(file)) return false
  const db = openStagingStore(file)
  try {
    return (db.prepare("select value from resume_meta where key = 'writer'").get() as { value: string } | undefined)?.value === writerBuild()
  } catch {
    return false
  } finally {
    db.close()
  }
}
/** A failed adapter call as the index reports it: the adapter named once, and which adapters had finished, for the run report. */
const adapterFailure = (id: string, finished: string[], what: string, e: AdapterProtocolError, extra: Record<string, unknown> = {}) => {
  const say = (text: string) => (text.startsWith(`adapter ${id} `) ? text : `adapter ${id} ${what}: ${text}`)
  return new ProofmeshError('ADAPTER_UNSUPPORTED', say(e.message), { failed_adapter: id, completed_adapters: finished, stored_message: say(e.stored), ...extra })
}
const DISPOSITION: Record<Discovered['status'], string> = { capture: 'pending', excluded: 'excluded_by_rule', unsupported: 'unsupported', failed: 'failed' }
/** Every file row reports each capability separately (FR003): what its adapter reported, and `fill` for each it left out. */
const capabilities = (reported: Record<string, string>, fill: string) => canonicalJson({ ...Object.fromEntries(CAPS.map((k) => [k, fill])), ...reported })
const NOT_RUN = capabilities({}, 'not_run')

/** write is relationship resolution; initialize and analyze name the adapter. */
export type Progress = { phase: 'discover' | 'capture' | 'prepare' | 'initialize' | 'analyze' | 'write' | 'check' | 'seal'; adapter?: string; /** The languages the adapter analyses, during its own phases. */ language?: string; done: number; total: number; plan?: { mode: 'incremental' | 'full'; analyse: number; reuse: number } }

/**
 * registry: the conformance kit indexes with the adapter it checks first; everything else uses the data directory's own.
 * rev: a commit to index instead of the working tree. Its snapshot becomes current like any other, unless keepCurrent and the repository has one.
 */
export async function indexRepository(dataDir: string, repoIdOrPath: string, onProgress?: (p: Progress) => void, registry?: Registry, rev?: string, keepCurrent = false): Promise<IndexResult> {
  const catalog = Catalog.open(dataDir)
  const owner = LEASE_OWNER
  catalog.acquireLease(owner)
  const progress = (p: Progress) => { catalog.renewLease(owner); onProgress?.(p) }
  let runs: AdapterRun[] = []
  const finished: string[] = []
  let jobDir: string | undefined
  let cache: FactCache | undefined
  try {
    const repo = catalog.repository(repoIdOrPath)
    jobDir = path.join(dataDir, 'staging', `job-${process.pid}-${Date.now()}`)
    // A commit is read from git objects into a private tree under jobDir; the registered working tree is never touched.
    const checkout = rev ? checkoutCommit(repo.root, rev, path.join(jobDir, 'commit')) : undefined
    const root = checkout?.tree ?? repo.root
    const store = new EvidenceStore(dataDir)
    const requestedMode: Mode = catalog.activeTrust(repo.id) ? 'trusted_build' : 'no_execution'
    progress({ phase: 'discover', done: 0, total: 0 })
    registry ??= registryFor(dataDir, repo.id)
    // A checked-out commit holds tracked files only, and git never ignores a tracked file (A19).
    const discovered = discover(root, registry, checkout ? () => false : undefined)

    // One adapter per file: the first in registry order that claims its language, unless a SCIP index takes it (A27).
    const owner = (language: string) => registry!.specs.find((s) => s.languages.has(language))
    runs = registry.specs.map((spec) => ({
      spec, mode: 'no_execution' as Mode,
      sources: discovered.filter((d) => d.status === 'capture' && d.role === 'source' && (d.adapter ? d.adapter === spec.id : owner(d.language!) === spec)),
      // Its configuration files, and any other adapter's sources it reads as configuration.
      configs: discovered.filter((d) => d.status === 'capture' && (d.role === 'config' ? d.language === `${spec.id}-config` : d.role === 'source' && spec.isConfig(path.posix.basename(d.path)))),
    }))
    for (const run of runs) {
      const unavailable = run.sources.length > 0 && !run.spec.entry(), own = run.configs.filter((c) => c.role === 'config')
      for (const d of unavailable ? [...run.sources, ...own] : run.sources.length ? [] : own) {
        d.status = 'unsupported'
        d.detail = unavailable ? run.spec.unavailable() : `no_adapter_run:${run.spec.id}`
      }
    }
    runs = runs.filter((r) => r.sources.length && r.spec.entry())
    // The budget is a setting of the host, not an input of the adapter's facts, so it stays out of the configuration the adapter and the cache keys see.
    for (const run of runs) {
      const { adapter_memory_mb: setting, ...config } = catalog.adapterConfig(repo.id, run.spec.id)
      run.config = config
      run.budgetMb = adapterBudgetMb({ adapter_memory_mb: setting })
    }

    progress({ phase: 'capture', done: 0, total: discovered.length })
    const captured: Captured[] = []
    for (const [i, d] of discovered.entries()) {
      if (i && i % 1000 === 0) progress({ phase: 'capture', done: i, total: discovered.length })
      if (d.status !== 'capture') continue
      captured.push({ ...d, hash: store.put(fs.readFileSync(path.join(root, d.path))) })
    }
    progress({ phase: 'capture', done: discovered.length, total: discovered.length })
    // What follows capture has its own stage line: a crash must show where it stopped, not only that capture had ended.
    progress({ phase: 'prepare', done: 0, total: 0 })
    const hashOf = new Map(captured.map((c) => [c.path, c.hash]))
    // A build manifest is a source of the build adapter, and still configuration as evidence (FR129).
    const configPaths = new Set(captured.filter((c) => c.role === 'config' || (c.role === 'source' && registry!.manifestLanguage(path.posix.basename(c.path)))).map((c) => c.path))
    const manifest = manifestHash(discovered, (p) => hashOf.get(p))

    const workspace = path.join(jobDir, 'workspace')
    for (const c of captured) {
      const target = path.join(workspace, c.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, store.read(c.hash)!)
    }
    for (const run of runs) {
      catalog.verifyExtensions(run.spec.id)
      run.process = new AdapterProcess(run.spec.entry()!, undefined, Number(process.env.PROOFMESH_ADAPTER_RSS_SAMPLE_MS) || undefined, run.spec.id, undefined, run.budgetMb)
      progress({ phase: 'initialize', adapter: run.spec.id, language: languagesOf(run), done: 0, total: run.sources.length + run.configs.length })
      const init = await run.process.initialize({
        // External inputs such as installed packages are read from the registered working tree, also for a commit.
        protocol_version: PROTOCOL_VERSION, workspace, repository_root: repo.root, analysis_mode: requestedMode,
        files: [...run.sources, ...run.configs].map((c) => ({ path: c.path, content_hash: hashOf.get(c.path)!, language: c.language! })),
        config: { ...run.config, ...run.spec.config?.() },
      }).catch((e) => {
        // An adapter that cannot even start within its budget fails its own files, rather than the index; asking it again would pass the same budget.
        if (e instanceof AdapterBudgetError) { run.unstartable = e; return undefined }
        throw e instanceof AdapterProtocolError ? adapterFailure(run.spec.id, finished, 'failed to initialize', e) : e
      })
      if (!init) { run.manifest = { id: run.spec.id, version: 'not_started', protocol_version: PROTOCOL_VERSION, languages: [...run.spec.languages], toolchain: {} }; run.inputs = []; continue }
      run.manifest = init.adapter
      run.inputs = [...(init.external_inputs ?? [])].sort()
      run.mode = init.analysis_mode ?? 'no_execution'
      run.units = init.units
      if (run.mode === 'trusted_build' && requestedMode !== 'trusted_build') throw new ProofmeshError('TRUST_REQUIRED', `adapter ${run.spec.id} asked to evaluate builds without a trust grant`)
    }
    // The external inputs an adapter read (packages, reference packs, type declarations) are part of identity (A2).
    // The adapter's own code is part of identity too: a rebuilt adapter that kept its version must not reuse facts or a snapshot (NFR004).
    for (const r of runs) r.entrySha256 = r.spec.sha256 ?? sha256File(r.spec.entry()!)
    const adapters = runs.map((r) => ({ ...r.manifest!, analysis_mode: r.mode, external_inputs: r.inputs ?? [], entry_sha256: r.entrySha256! })).sort((a, b) => (a.id < b.id ? -1 : 1))
    const analysisMode: Mode = adapters.some((a) => a.analysis_mode === 'trusted_build') ? 'trusted_build' : 'no_execution'
    const configs = Object.fromEntries(runs.map((r) => [r.spec.id, r.config!]))
    // Raising a budget must index again: a file the old budget failed is not the answer under the new one. Facts do not change with it.
    const budgets = Object.fromEntries(runs.map((r) => [r.spec.id, r.budgetMb!]))
    const identity = { repository_id: repo.id, manifest_hash: manifest, config_hash: sha256(canonicalJson({ ...analysisConfig(), adapters: configs, adapter_memory_mb: budgets })), analysis_mode: analysisMode, adapters, format_version: FORMAT_VERSION, format_ddl: sha256(readSql(`snapshot-format/${FORMAT_VERSION}.sql`)), ownership: OWNERSHIP_VERSION, resolution: RESOLUTION_VERSION, seams: SEAMS_VERSION }
    const identityJson = canonicalJson(identity)
    const snapshotId = `snap_${sha256(identityJson).slice(0, 24)}`
    const peaks = async () => {
      await Promise.all(runs.map((r) => r.process?.sampleRss()))
      return Object.fromEntries(runs.flatMap((r) => (r.process?.peakRssKb ? [[r.spec.id, r.process.peakRssKb]] : [])))
    }

    const existing = catalog.snapshot(snapshotId)
    if (existing?.state === 'published') {
      if (catalog.currentSnapshot(repo.id)?.id !== snapshotId) catalog.publish(snapshotId, repo.id, existing.store_digest!, keepCurrent)
      return { snapshotId, status: 'unchanged', analysisMode, counts: countDispositions(discovered.map((d) => (d.status === 'capture' ? 'indexed' : DISPOSITION[d.status]))), commit: checkout?.git.commit, adapterPeakRssKb: await peaks() }
    }
    for (const run of runs) {
      run.keys = fileKeys({
        repository: repo.id, adapter: { ...run.manifest, entry_sha256: run.entrySha256 }, analysisMode: run.mode, config: configs[run.spec.id], externalInputs: run.inputs ?? [],
        configs: run.configs.map((c) => ({ path: c.path, hash: hashOf.get(c.path)! })), sources: run.sources.map((s) => s.path), units: run.units, hashOf: (p) => hashOf.get(p),
      })
    }
    cache = new FactCache(dataDir)
    catalog.beginStaging(snapshotId, repo.id, sha256(identityJson), analysisMode)
    const stagingFile = path.join(stagingDir(dataDir, snapshotId), 'snapshot.db')
    const resume = resumable(stagingFile)
    const db = resume ? openStagingStore(stagingFile) : createStagingStore(stagingFile)
    let analysed = false
    try {
      // Memoised: the writer asks for a file's id and size once per fact, millions of times on a large repository.
      const fileIds = new Map<string, string>()
      const fileId = (p: string) => fileIds.get(p) ?? fileIds.set(p, derivedId('file', 24, snapshotId, p)).get(p)!
      if (!resume) {
        db.exec(RESUME_DDL)
        db.prepare("insert into resume_meta (key, value) values ('writer', ?)").run(writerBuild())
        const insertMeta = db.prepare('insert into meta (key, value) values (?, ?)')
        for (const [k, v] of Object.entries({ format_version: FORMAT_VERSION, snapshot_id: snapshotId, repository_id: repo.id, identity: identityJson, analysis_mode: analysisMode, adapters: canonicalJson(adapters), git: canonicalJson(checkout?.git ?? gitInfo(repo.root)), analysis_config: canonicalJson(analysisConfig()) })) insertMeta.run(k, v)
        const insertFile = db.prepare('insert into file (id, path, content_hash, size, language, disposition, disposition_detail, capabilities) values (?, ?, ?, ?, ?, ?, ?, ?)')
        db.transaction(() => {
          for (const d of discovered) insertFile.run(fileId(d.path), d.path, null, d.size, d.language, DISPOSITION[d.status], d.detail, NOT_RUN)
        })()
      }

      const fileResults = new Map<string, { status: string; detail?: string; capabilities: Record<string, string> }>()
      const writer = new FactWriter(db, store, snapshotId, fileId, hashOf, configPaths)
      const pending: Array<{ rel: Rel; producer: Producer }> = []
      // Every symbol the adapters declared, for the pass that binds names (FR171).
      const declared: Sym[] = []
      // The endpoints, with their ranges, for the pass that links HTTP clients to handlers (FR255).
      const endpoints: EndpointSym[] = []
      const note = (symbols: AnalyzeResponse['symbols'], p: Producer) => { for (const s of symbols) { declared.push({ producer: p.id, local_id: s.local_id, path: s.path, kind: s.kind, name: s.name, qualified_name: s.qualified_name, start: s.range.start_byte, end: s.range.end_byte }); if (s.kind === 'endpoint') endpoints.push({ producer: p.id, local_id: s.local_id, path: s.path, name: s.name, qualified_name: s.qualified_name, range: s.range, signature: s.signature }) } }
      const done = new Set((db.prepare('select adapter, batch from resume_batch').all() as Array<{ adapter: string; batch: number }>).map((r) => `${r.adapter}#${r.batch}`))
      const markDone = db.prepare('insert into resume_batch (adapter, batch) values (?, ?)')
      const batches = { done: 0, total: 0 }
      const reuse = { reused: 0, analysed: 0 }
      const batchSize = BATCH()
      const memoryRestarts: NonNullable<IndexResult['memoryRestarts']> = []
      for (const run of runs) {
        for (const c of run.configs) if (c.role === 'config') fileResults.set(c.path, { status: 'ok', capabilities: { text: 'complete' } })
        const producer: Producer = { id: run.manifest!.id, version: run.manifest!.version, mode: run.mode }
        // Workspace facts span files, so they are asked for on every index and never cached; checkpointed as batch -1.
        // The plan says up front how many files this adapter re-analyses and how many replay cached facts.
        const reusable = run.sources.filter((s) => cache!.has(run.keys!.get(s.path)!)).length
        progress({ phase: 'analyze', adapter: run.spec.id, language: languagesOf(run), done: 0, total: run.sources.length, plan: { mode: reusable ? 'incremental' : 'full', analyse: run.sources.length - reusable, reuse: reusable } })
        const wsJournal = path.join(stagingDir(dataDir, snapshotId), `batch-${run.spec.id}-workspace.json`)
        let ws: AnalyzeResponse
        if (done.has(`${run.spec.id}#-1`)) {
          ws = JSON.parse(fs.readFileSync(wsJournal, 'utf8')) as AnalyzeResponse
          writer.remember(ws.symbols, producer)
        } else {
          try {
            ws = run.unstartable ? { symbols: [], relationships: [], file_results: [], diagnostics: [] } : await run.process!.workspace()
          } catch (e) {
            if (!(e instanceof AdapterProtocolError)) throw e
            if (!(e instanceof AdapterBudgetError)) throw adapterFailure(run.spec.id, finished, 'failed to answer workspace', e)
            // Facts that span files are not retried in pieces; the adapter's files fail with the budget as the reason.
            run.unstartable = e
            ws = { symbols: [], relationships: [], file_results: [], diagnostics: [] }
          }
          fs.writeFileSync(wsJournal, JSON.stringify(ws))
          db.transaction(() => { writer.symbols(ws.symbols, producer); markDone.run(run.spec.id, -1) })()
        }
        note(ws.symbols, producer)
        for (const r of ws.relationships) pending.push({ rel: r, producer })
        for (const fr of ws.file_results) fileResults.set(fr.path, { status: fr.status, ...(fr.detail ? { detail: fr.detail } : {}), capabilities: fr.capabilities as Record<string, string> })
        /** Replays the cached facts of files whose key is unchanged and analyses only the rest, assembled in file order. */
        const failedByBudget = (paths: string[]): Map<string, FileFacts> => new Map(paths.map((p) => [p, { symbols: [], relationships: [], file_result: { path: p, status: 'failed', detail: 'memory_budget', capabilities: {} } } as FileFacts]))
        const overran = (e: AdapterBudgetError, files: number, action: 'smaller_batches' | 'file_failed' | 'adapter_failed') => {
          memoryRestarts.push({ adapter: run.spec.id, budget_mb: e.budgetMb, peak_rss_mb: e.peakRssKb ? Math.round(e.peakRssKb / 1024) : null, files, action })
          log('warning', 'adapter passed its memory budget', { adapter: run.spec.id, budget_mb: e.budgetMb, files, action })
        }
        /**
         * Analyses files within the adapter's budget. An adapter that passes it is started again with half the files, and with batches
         * of that size from then on; a file that alone passes it fails with `memory_budget` and the others go on.
         */
        const withinBudget = async (paths: string[]): Promise<Map<string, FileFacts>> => {
          if (run.unstartable) return failedByBudget(paths)
          const cap = run.cap ?? paths.length
          if (paths.length > cap) {
            const parts: Array<Map<string, FileFacts>> = []
            for (let at = 0; at < paths.length; at += cap) parts.push(await withinBudget(paths.slice(at, at + cap)))
            return new Map(parts.flatMap((m) => [...m]))
          }
          try {
            return splitByFile(await run.process!.analyze(paths), paths)
          } catch (e) {
            if (!(e instanceof AdapterBudgetError)) throw e
            overran(e, paths.length, paths.length === 1 ? 'file_failed' : 'smaller_batches')
            try {
              await run.process!.restart()
            } catch (again) {
              if (!(again instanceof AdapterBudgetError)) throw again
              run.unstartable = again
              overran(again, paths.length, 'adapter_failed')
              return failedByBudget(paths)
            }
            if (paths.length === 1) return failedByBudget(paths)
            run.cap = Math.max(1, Math.floor(paths.length / 2))
            return withinBudget(paths)
          }
        }
        const analyse = async (batch: string[]): Promise<AnalyzeResponse> => {
          const keys = run.keys!
          const cached = new Map(batch.flatMap((p) => { const hit = cache!.get(keys.get(p)!); return hit ? [[p, hit] as const] : [] }))
          const missing = batch.filter((p) => !cached.has(p))
          const fresh = missing.length ? await withinBudget(missing) : new Map<string, FileFacts>()
          // A file the budget failed is not cached: under a larger budget it would be analysed.
          cache!.put(repo.id, run.spec.id, missing.filter((p) => fresh.get(p)!.file_result?.detail !== 'memory_budget').map((p) => [keys.get(p)!, fresh.get(p)!]))
          reuse.reused += cached.size
          reuse.analysed += missing.length
          return assemble(batch.map((p) => cached.get(p) ?? fresh.get(p)!))
        }
        for (let i = 0; i < run.sources.length; i += batchSize) {
          const batch = run.sources.slice(i, i + batchSize).map((s) => s.path)
          const number = i / batchSize, journal = path.join(stagingDir(dataDir, snapshotId), `batch-${run.spec.id}-${number}.json`)
          batches.total++
          progress({ phase: 'analyze', adapter: run.spec.id, language: languagesOf(run), done: i, total: run.sources.length })
          let response: AnalyzeResponse
          if (done.has(`${run.spec.id}#${number}`)) {
            response = JSON.parse(fs.readFileSync(journal, 'utf8')) as AnalyzeResponse
            writer.remember(response.symbols, producer)
            batches.done++
          } else {
            try {
              response = await analyse(batch)
            } catch (e) {
              if (!(e instanceof AdapterProtocolError)) throw e
              throw adapterFailure(run.spec.id, finished, 'failed on a batch', e, { paths: batch.length })
            }
            fs.writeFileSync(journal, JSON.stringify(response))
            db.transaction(() => { writer.symbols(response.symbols, producer); markDone.run(run.spec.id, number) })()
            faultPoint('after_batch')
          }
          note(response.symbols, producer)
          for (const r of response.relationships) pending.push({ rel: r, producer })
          for (const fr of response.file_results) fileResults.set(fr.path, { status: fr.status, ...(fr.detail ? { detail: fr.detail } : {}), capabilities: fr.capabilities as Record<string, string> })
        }
        finished.push(run.spec.id)
      }
      analysed = true
      // A file edited after capture would make the snapshot a mix of two trees, so it is not published (FR013).
      const moved = unstable(root, captured)
      if (moved.length) throw new ProofmeshError('UNSTABLE_WORKTREE', `${moved.length} file${moved.length === 1 ? '' : 's'} changed while indexing (${moved.slice(0, 3).join(', ')}); index again when the tree is quiet`, { detail: 'changed_during_capture', paths: moved.slice(0, 20) })
      progress({ phase: 'write', done: 0, total: pending.length })
      // The names the language's rules can bind are bound before anything is written, from the whole workspace's facts (FR171).
      const bound = constrain(declared, pending, (p) => { const h = hashOf.get(p); return h ? store.read(h) : undefined })
      // Millions of relationships take minutes to write: progress inside the transaction keeps the job and the index lease alive.
      // Each HTTP client is then linked to the handler of the endpoint it names, whatever language either is in (FR255).
      const linked = [...bound, ...linkHttp(declared, endpoints, bound, { id: 'seams-http', version: SEAMS_VERSION, mode: analysisMode })]
      db.transaction(() => writer.relationships(linked, (done) => progress({ phase: 'write', done, total: linked.length })))()
      const ownershipFiles = captured.filter((c) => c.role === 'ownership')
      const ownersFile = effectiveCodeowners(ownershipFiles.map((c) => c.path))
      if (ownersFile) {
        const rules = parseCodeowners(store.read(hashOf.get(ownersFile)!)!.toString('utf8'))
        db.transaction(() => writer.ownership(ownersFile, rules, { id: 'codeowners', version: OWNERSHIP_VERSION, mode: 'no_execution' }))()
      }
      for (const c of ownershipFiles) fileResults.set(c.path, { status: 'ok', capabilities: { text: 'complete', syntax: 'complete', symbols: 'complete', imports: 'unsupported', references: 'unsupported', resolved_calls: 'unsupported', framework: 'unsupported' } })
      for (const c of captured) if (c.role === 'registry') fileResults.set(c.path, { status: 'ok', capabilities: { text: 'complete' } })

      const updateFile = db.prepare('update file set disposition = ?, disposition_detail = ?, content_hash = ?, capabilities = ? where path = ?')
      // The tier that produced a source file's facts rides beside its capabilities (FR137); capture-only files have none.
      const tierOf = (c: Captured): { tier: string } | {} => {
        if (c.role !== 'source') return {}
        if (c.adapter === 'scip') return { tier: `scip:${c.scip}` }
        const id = owner(c.language!)?.id
        return id ? { tier: id === 'syntax' ? 'syntax' : `precise:${id}` } : {}
      }
      db.transaction(() => {
        for (const c of captured) {
          const fr = fileResults.get(c.path)
          if (!fr) updateFile.run('failed', 'not_analysed', null, capabilities({}, 'failed'), c.path)
          // Discovery's detail stays: a file a stale SCIP index covers is indexed by its usual adapter and says why (A27).
          else if (fr.status === 'ok') updateFile.run('indexed', c.detail, c.hash, capabilities({ ...fr.capabilities, ...tierOf(c) }, 'unsupported'), c.path)
          else updateFile.run('failed', fr.detail ?? 'adapter_failure', null, capabilities(fr.capabilities, 'failed'), c.path)
        }
      })()
      // Hashing needs each file's captured text and the declared spans, so it follows the last write and costs adapters nothing (FR130).
      fillSites(db)
      const unreadable = fillBodyHashes(db, store)
      if (unreadable.length) db.prepare("insert into meta (key, value) values ('body_hash_missing', ?)").run(canonicalJson({ count: unreadable.length, paths: unreadable.slice(0, 20) }))
      // A key the core had to disambiguate means an adapter named two declarations alike: recorded, never silent (FR147).
      if (writer.disambiguated.length) db.prepare("insert into meta (key, value) values ('key_disambiguated', ?)").run(canonicalJson({ count: writer.disambiguated.length, truncated: false, keys: writer.disambiguated }))
      // Build modules a syntax-tier edge ties into a cycle, in an ecosystem whose builds forbid one (FR178).
      const cycles = moduleCycles(db)
      if (cycles.length) db.prepare("insert into meta (key, value) values ('module_cycles', ?)").run(canonicalJson(cycles))
      progress({ phase: 'check', done: 0, total: 0 })
      validate(db, store)
      // Planner statistics are part of the sealed file, so queries on large snapshots choose the selective index.
      db.exec('drop table resume_batch; drop table resume_meta')
      fillAggregates(db)
      db.exec('ANALYZE')
      db.prepare("insert into meta (key, value) values ('summary', ?)").run(canonicalJson(computeSummary(db)))
      // The language census (FR136): every discovered file in exactly one row, from the final disposition of each.
      const labels = new Map(discovered.map((d) => [d.path, d.census!]))
      const censusFiles = (db.prepare('select path, disposition, disposition_detail as detail, capabilities from file').all() as Array<{ path: string; disposition: string; detail: string | null; capabilities: string }>)
        .map((f) => ({ label: labels.get(f.path)!, disposition: f.disposition, detail: f.detail, capabilities: JSON.parse(f.capabilities) as Record<string, string> }))
      db.prepare("insert into meta (key, value) values ('census', ?)").run(JSON.stringify(buildCensus(censusFiles, { overrides: process.env.PROOFMESH_CS_ADAPTER ? { csharp: process.env.PROOFMESH_CS_ADAPTER } : {} })))
      const counts = countDispositions((db.prepare('select disposition from file').all() as Array<{ disposition: string }>).map((r) => r.disposition))
      progress({ phase: 'seal', done: 0, total: 0 })
      sealAndPublish(catalog, db, stagingFile, snapshotId, repo.id, keepCurrent)
      fs.rmSync(stagingDir(dataDir, snapshotId), { recursive: true, force: true })
      for (const run of runs) cache.prune(repo.id, run.spec.id, run.keys!.values())
      return { snapshotId, status: 'published', analysisMode, counts, reuse, commit: checkout?.git.commit, adapterPeakRssKb: await peaks(), ...(memoryRestarts.length ? { memoryRestarts } : {}), ...(batches.done ? { resumed: batches } : {}) }
    } catch (e) {
      if (db.open) db.close()
      catalog.markFailed(snapshotId, storedMessage(e))
      // Only an interruption during analysis is resumable; a run that failed after it starts clean next time.
      if (analysed) fs.rmSync(stagingDir(dataDir, snapshotId), { recursive: true, force: true })
      throw e
    }
  } finally {
    cache?.close()
    for (const r of runs) await r.process?.shutdown()
    if (jobDir) fs.rmSync(jobDir, { recursive: true, force: true })
    catalog.releaseLease(owner)
    catalog.close()
  }
}

function countDispositions(dispositions: string[]): IndexResult['counts'] {
  const counts = { discovered: dispositions.length, indexed: 0, excluded_by_rule: 0, unsupported: 0, failed: 0, pending: 0 }
  for (const d of dispositions) counts[d as keyof Omit<IndexResult['counts'], 'discovered'>]++
  return counts
}

/** Turns adapter facts into snapshot rows: IDs, evidence slices, assertions, and traversal edges. */
class FactWriter {
  private localToSymbol = new Map<string, string>()
  private seenEvidence = new Set<string>()
  private seenAssertion = new Set<string>()
  private seenExternal = new Set<string>()
  /** Every stable key written so far, so no two symbols of a snapshot share one (FR147). */
  private keys = new Set<string>()
  /** Keys that took a `~n` because an adapter gave two symbols the same one, for the snapshot's meta. */
  readonly disambiguated: Array<[string, string]> = []
  private sizes = new Map<string, number | undefined>()
  private stmt: Record<string, Database.Statement>

  constructor(
    private readonly db: Database.Database,
    private readonly store: EvidenceStore,
    private readonly snapshotId: string,
    private readonly fileId: (p: string) => string,
    private readonly hashOf: Map<string, string>,
    private readonly configPaths: Set<string>,
  ) {
    this.stmt = {
      evidence: db.prepare('insert or ignore into evidence (id, file_id, object_hash, start_byte, end_byte, start_line, end_line, source_kind, extractor, extractor_version, analysis_mode) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      symbol: db.prepare('insert into symbol (id, file_id, kind, name, qualified_name, start_byte, end_byte, start_line, end_line, signature, stable_key, evidence_id, roles) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      fts: db.prepare('insert into symbol_fts (symbol_id, name, qualified_name) values (?, ?, ?)'),
      assertion: db.prepare('insert into assertion (id, type, origin, resolution, source_kind, source_id, target_kind, target_id, reason, detail, adapter, adapter_version, analysis_mode) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      assertionEvidence: db.prepare('insert or ignore into assertion_evidence (assertion_id, evidence_id) values (?, ?)'),
      edge: db.prepare('insert into edge (src, type, dst, resolution, assertion_id) values (?, ?, ?, ?, ?)'),
      external: db.prepare('insert or ignore into external_symbol (id, module, name) values (?, ?, ?)'),
      candidate: db.prepare('insert or ignore into assertion_candidate (assertion_id, symbol_id, rank, reason) values (?, ?, ?, ?)'),
      moduleOf: db.prepare("select s.id from symbol s where s.file_id = ? and s.kind = 'module' order by s.id limit 1"),
    }
  }

  private evidence(filePath: string, range: { start_byte: number; end_byte: number; start_line: number; end_line: number }, kind: string, p: Producer): string {
    const hash = this.hashOf.get(filePath)
    if (!hash) throw new AdapterProtocolError(`adapter referenced ${filePath}, which was not captured`)
    const size = this.sizes.has(hash) ? this.sizes.get(hash) : this.sizes.set(hash, this.store.size(hash)).get(hash)
    if (size === undefined || range.end_byte > size || range.start_byte < 0 || range.end_byte <= range.start_byte) {
      throw new AdapterProtocolError(`range ${range.start_byte}-${range.end_byte} does not fit ${filePath}`)
    }
    const id = derivedId('ev', 24, hash, range.start_byte, range.end_byte, p.id)
    if (!this.seenEvidence.has(id)) {
      this.stmt.evidence!.run(id, this.fileId(filePath), hash, range.start_byte, range.end_byte, range.start_line, range.end_line, kind, p.id, p.version, p.mode)
      this.seenEvidence.add(id)
    }
    return id
  }

  private symbolId(s: AnalyzeResponse['symbols'][number]): string {
    return derivedId('sym', 24, this.snapshotId, s.path, s.kind, s.qualified_name, s.range.start_byte)
  }

  /** Symbols of a batch an earlier run already wrote: only their local IDs are needed again. */
  remember(symbols: AnalyzeResponse['symbols'], p: Producer): void {
    for (const s of symbols) this.localToSymbol.set(`${p.id}:${s.local_id}`, this.symbolId(s))
  }

  /**
   * The stable key of each new symbol. Symbols that share one, whatever adapter made them, are told apart by a hash of their declaration
   * text, `~<8 hex>`, so a duplicate inserted above them renames none (FR147); identical text, or a key an earlier batch already wrote,
   * takes `.2`, `.3` and so on in source order. Adapters avoid this with parameter types, so it is a last resort.
   */
  private stableKeys(symbols: AnalyzeResponse['symbols']): Map<AnalyzeResponse['symbols'][number], string> {
    const base = (s: AnalyzeResponse['symbols'][number]) => `${s.path}#${s.qualified_name}#${s.kind}`
    const groups = new Map<string, Array<AnalyzeResponse['symbols'][number]>>()
    for (const s of symbols) groups.set(base(s), [...(groups.get(base(s)) ?? []), s])
    const text = new Map<string, Buffer | undefined>()
    const digest = (s: AnalyzeResponse['symbols'][number]) => {
      const h = this.hashOf.get(s.path)
      if (!text.has(s.path)) text.set(s.path, h ? this.store.read(h) : undefined)
      return sha256(text.get(s.path)?.subarray(s.range.start_byte, s.range.end_byte) ?? `${s.range.start_byte}`).slice(0, 8)
    }
    const out = new Map<AnalyzeResponse['symbols'][number], string>()
    for (const [key, group] of groups) {
      group.sort((a, b) => a.range.start_byte - b.range.start_byte)
      for (const s of group) {
        let k = key
        if (group.length > 1 || this.keys.has(key)) {
          const h = digest(s)
          k = `${key}~${h}`
          for (let n = 2; this.keys.has(k); n++) k = `${key}~${h}.${n}`
          this.disambiguated.push([key, k])
        }
        this.keys.add(k)
        out.set(s, k)
      }
    }
    return out
  }

  symbols(symbols: AnalyzeResponse['symbols'], p: Producer): void {
    // A resumed adapter sends symbols again that are already written; they take no key.
    const stableKeys = this.stableKeys(symbols.filter((s) => !this.localToSymbol.has(`${p.id}:${s.local_id}`)))
    for (const s of symbols) {
      const key = `${p.id}:${s.local_id}`
      const id = this.symbolId(s)
      // A resumed adapter sends its workspace-wide symbols again; the same symbol twice is that, a different one is a protocol error.
      if (this.localToSymbol.has(key)) {
        if (this.localToSymbol.get(key) === id) continue
        throw new AdapterProtocolError(`duplicate symbol ${s.local_id}`)
      }
      const ev = this.evidence(s.path, s.range, this.configPaths.has(s.path) ? 'configuration' : 'declaration', p)
      this.stmt.symbol!.run(id, this.fileId(s.path), s.kind, s.name, s.qualified_name, s.range.start_byte, s.range.end_byte, s.range.start_line, s.range.end_line, s.signature, stableKeys.get(s)!, ev, s.roles?.length ? JSON.stringify([...new Set(s.roles)].sort()) : null)
      this.stmt.fts!.run(id, s.name, s.qualified_name)
      this.localToSymbol.set(key, id)
    }
  }

  /** Set while the relationships of a cross-adapter pass are written. */
  private qualified = false

  private symbol(p: Producer, local: string): string {
    // `qualified` rows come from a pass that spans adapters: their ids are already `<adapter>:<local id>`. An adapter's own ids never are decoded.
    const id = this.localToSymbol.get(this.qualified ? local : `${p.id}:${local}`)
    if (!id) throw new AdapterProtocolError(`relationship references unknown symbol ${local}`)
    return id
  }

  private ref(p: Producer, r: Rel['source'] | undefined): { kind: string | null; id: string | null } {
    if (!r) return { kind: null, id: null }
    if (r.symbol) return { kind: 'symbol', id: this.symbol(p, r.symbol) }
    if (r.file) return { kind: 'file', id: this.fileId(r.file) }
    if (r.external) {
      const id = derivedId('ext', 24, r.external.module, r.external.name)
      if (!this.seenExternal.has(id)) { this.stmt.external!.run(id, r.external.module, r.external.name); this.seenExternal.add(id) }
      return { kind: 'external', id }
    }
    return { kind: null, id: null }
  }

  /** Teams from CODEOWNERS, and owned_by from every file module and project to the owners of the last matching rule. */
  ownership(file: string, rules: OwnerRule[], p: Producer): void {
    const teams = new Map<string, string>()
    const lineOf = (r: OwnerRule) => ({ start_byte: r.startByte, end_byte: r.endByte, start_line: r.line, end_line: r.line })
    const team = (owner: string, rule: OwnerRule) => {
      const known = teams.get(owner)
      if (known) return known
      const id = derivedId('sym', 24, this.snapshotId, file, 'team', owner, rule.startByte)
      const range = lineOf(rule)
      this.keys.add(`${file}#${owner}#team`)
      this.stmt.symbol!.run(id, this.fileId(file), 'team', owner, owner, range.start_byte, range.end_byte, range.start_line, range.end_line, null, `${file}#${owner}#team`, this.evidence(file, range, 'configuration', p), null)
      this.stmt.fts!.run(id, owner, owner)
      teams.set(owner, id)
      return id
    }
    for (const s of this.db.prepare("select s.id, f.path from symbol s join file f on f.id = s.file_id where s.kind in ('module', 'project') order by s.id").all() as Array<{ id: string; path: string }>) {
      const rule = ownerRule(rules, s.path)
      if (!rule || !rule.owners.length) continue
      const ev = this.evidence(file, lineOf(rule), 'configuration', p)
      for (const owner of rule.owners) {
        const target = team(owner, rule)
        const id = derivedId('as', 24, this.snapshotId, 'owned_by', s.id, file, rule.startByte, target)
        this.stmt.assertion!.run(id, 'owned_by', 'configuration_adapter', 'resolved', 'symbol', s.id, 'symbol', target, null, canonicalJson({ pattern: rule.pattern }), p.id, p.version, p.mode)
        this.stmt.edge!.run(s.id, 'owned_by', target, 'resolved', id)
        this.stmt.assertionEvidence!.run(id, ev)
      }
    }
  }

  relationships(items: Array<{ rel: Rel; producer: Producer; qualified?: boolean }>, onProgress?: (done: number) => void): void {
    const imports = new Map<string, { source: string; target: string | null; targetKind: string | null; resolution: string; reason: string | null; group: string; kind: string; detail?: Record<string, unknown>; evidence: string[]; origin: string; p: Producer }>()
    let written = 0
    for (const { rel: r, producer: p, qualified } of items) {
      this.qualified = qualified === true
      if (++written % 25000 === 0) onProgress?.(written)
      // A `contains` that targets a file means that file's module symbol, which another adapter declared; a file with none is not contained (FR125).
      const module = r.type === 'contains' && r.target?.file ? (this.stmt.moduleOf!.get(this.fileId(r.target.file)) as { id: string } | undefined)?.id : undefined
      if (r.type === 'contains' && r.target?.file && !module) continue
      const kind = r.type === 'calls' ? 'call_site' : r.type === 'imports' ? 'import_statement' : this.configPaths.has(r.site.path) ? 'configuration' : 'reference_site'
      const ev = this.evidence(r.site.path, r.site.range, kind, p)
      const source = this.ref(p, r.source)
      if (!source.id) throw new AdapterProtocolError(`a ${r.type} relationship must name its source`)
      const resolved = r.resolution === 'resolved' || r.resolution === 'resolved_external'
      const target = module ? { kind: 'symbol', id: module } : resolved ? this.ref(p, r.target) : { kind: null, id: null }
      if (resolved && !target.id) throw new AdapterProtocolError(`a ${r.resolution} ${r.type} relationship must name its target`)
      if (r.resolution === 'resolved_external' && target.kind !== 'external') throw new AdapterProtocolError('resolved_external must target an external symbol')
      if (r.resolution === 'resolved' && target.kind === 'external') throw new AdapterProtocolError('resolved must target a symbol or file in the snapshot')
      if (!resolved && !r.reason && r.resolution === 'unresolved') throw new AdapterProtocolError(`an unresolved ${r.type} relationship must carry a reason`)
      if (r.type === 'imports' && r.resolution !== 'candidate' && r.resolution !== 'ambiguous') {
        // Statements between the same two files are one assertion (AC05) of the strongest kind among them; an import() is its own (FR092).
        const kind = r.detail?.kind ?? '', group = kind === 'dynamic' ? kind : ''
        const key = `${source.id}\n${group}\n${target.id ?? `unresolved:${r.site.path}:${r.site.range.start_byte}`}`
        // An unresolved statement is its own assertion, so it keeps the adapter's detail: the module it names (FR115).
        const entry = imports.get(key) ?? { source: source.id, target: target.id, targetKind: target.kind, resolution: r.resolution, reason: r.reason ?? null, group, kind, ...(!r.detail || (target.id && !r.detail.rule) ? {} : { detail: r.detail }), evidence: [], origin: r.origin, p }
        if (IMPORT_KINDS.indexOf(kind) < IMPORT_KINDS.indexOf(entry.kind)) entry.kind = kind
        entry.evidence.push(ev)
        imports.set(key, entry)
        continue
      }
      const id = derivedId('as', 24, this.snapshotId, r.type, source.id, r.site.path, r.site.range.start_byte, target.id ?? '')
      if (!this.seenAssertion.has(id)) {
        const reason = resolved ? null : (r.reason ?? r.resolution)
        this.stmt.assertion!.run(id, r.type, r.origin, r.resolution, source.kind, source.id, target.kind, target.id, reason, r.detail ? canonicalJson(r.detail) : null, p.id, p.version, p.mode)
        if (target.id) this.stmt.edge!.run(source.id, r.type, target.id, r.resolution, id)
        ;(r.candidates ?? []).forEach((c, rank) => this.stmt.candidate!.run(id, this.symbol(p, c), rank, r.resolution))
        this.seenAssertion.add(id)
      }
      this.stmt.assertionEvidence!.run(id, ev)
    }
    this.qualified = false
    for (const imp of imports.values()) {
      const id = derivedId('as', 24, this.snapshotId, 'imports', imp.source, imp.group, imp.target ?? `unresolved:${imp.evidence[0]}`)
      const reason = imp.target ? null : (imp.reason ?? 'import_unresolved')
      this.stmt.assertion!.run(id, 'imports', imp.origin, imp.target ? imp.resolution : 'unresolved', 'file', imp.source, imp.targetKind, imp.target, reason, imp.detail ? canonicalJson(imp.detail) : imp.kind ? canonicalJson({ kind: imp.kind }) : null, imp.p.id, imp.p.version, imp.p.mode)
      for (const ev of imp.evidence) this.stmt.assertionEvidence!.run(id, ev)
      if (imp.target) this.stmt.edge!.run(imp.source, 'imports', imp.target, imp.resolution, id)
    }
  }
}

/** Publication contract: every check must pass before a snapshot can be sealed. */
/** The site rows are ordered by, from each assertion's first evidence by path then position, so a page of rows is read in that order without sorting them all (FR234). */
function fillSites(db: Database.Database): void {
  const first = (col: string) => `(select ${col} from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = assertion.id order by f.path, e.start_byte limit 1)`
  db.exec(`update assertion set site_path = coalesce(${first('f.path')}, ''), site_byte = coalesce(${first('e.start_byte')}, 0)`)
  db.exec('update assertion_candidate set type = a.type, site_path = a.site_path, site_byte = a.site_byte from assertion a where a.id = assertion_candidate.assertion_id')
}

function validate(db: Database.Database, store: EvidenceStore): void {
  const fail = (what: string) => { throw new ProofmeshError('INTERNAL_ERROR', `snapshot validation failed: ${what}`) }
  const one = <T>(sql: string) => db.prepare(sql).get() as T
  if (one<{ n: number }>("select count(*) n from file where disposition = 'pending'").n) fail('files still pending')
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>
  if (integrity[0]?.integrity_check !== 'ok') fail('integrity_check')
  if ((db.pragma('foreign_key_check') as unknown[]).length) fail('foreign_key_check')
  for (const ev of db.prepare('select distinct object_hash, max(end_byte) end_byte from evidence group by object_hash').iterate() as Iterable<{ object_hash: string; end_byte: number }>) {
    const size = store.size(ev.object_hash)
    if (size === undefined || ev.end_byte > size) fail(`evidence object ${ev.object_hash} missing or too short`)
  }
  const edges = one<{ n: number }>('select count(*) n from edge').n
  const resolvedAssertions = one<{ n: number }>("select count(*) n from assertion where resolution in ('resolved','resolved_external')").n
  const matched = one<{ n: number }>('select count(*) n from edge e join assertion a on a.id = e.assertion_id and a.source_id = e.src and a.target_id = e.dst and a.resolution = e.resolution and a.type = e.type').n
  if (edges !== resolvedAssertions || matched !== edges) fail('edge and assertion correspondence')
  if (one<{ n: number }>('select count(*) n from symbol').n !== one<{ n: number }>('select count(*) n from symbol_fts').n) fail('full-text index size')
  const danglingSource = one<{ n: number }>("select count(*) n from assertion a where (a.source_kind = 'symbol' and not exists (select 1 from symbol s where s.id = a.source_id)) or (a.source_kind = 'file' and not exists (select 1 from file f where f.id = a.source_id))").n
  const danglingTarget = one<{ n: number }>("select count(*) n from assertion a where (a.target_kind = 'symbol' and not exists (select 1 from symbol s where s.id = a.target_id)) or (a.target_kind = 'file' and not exists (select 1 from file f where f.id = a.target_id)) or (a.target_kind = 'external' and not exists (select 1 from external_symbol x where x.id = a.target_id))").n
  if (danglingSource || danglingTarget) fail('assertion references')
  log('debug', 'snapshot validated', { edges })
}
