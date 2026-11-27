import type Database from 'better-sqlite3'
import { ProofmeshError } from '../core/errors.js'
import { queryId } from '../core/hash.js'
import { applyLimits, type AppliedLimits } from '../core/limits.js'
import { BUNDLE_FORMAT_VERSION, check, ENVELOPE_VERSION, SNAPSHOT_EXPORT_VERSION } from '../core/schemas.js'
import type { Envelope, Limits, ListQueriesData } from '../core/generated.js'
import { CATALOG_VERSION, Catalog, LEASE_OWNER, lastIndexFailure, noSnapshot, type ImportedSnapshot, type PropertyRead, type SnapshotRow } from '../meshstore/catalog.js'
import { FORMAT_VERSION, openSnapshot } from '../meshstore/snapshot.js'
import { PROTOCOL_VERSION } from '../indexer/adapter-host.js'
import { LINK_FORMAT_VERSION } from '../links/index.js'
import { DISPATCH_TYPES, SqliteEdges, trace } from '../meshstore/traversal.js'
import { assertionKey, bySite, byKey, cmp, evidenceKey, hasSites, nodeKey, siteCols, siteOrder, type Sited } from '../meshstore/order.js'
import { staticPropertyReads } from './static-reads.js'
import { externalUsage, type UsageGroup } from './external-usage.js'
import { findQuerySource, WEIGHED } from './query-source.js'
import { EvidenceStore } from '../evidence/store.js'
import { hubsOf, partialLimitations, snapshotSummary, UNRESOLVED_REASONS } from './summary.js'
import type { ModuleCycle } from '../indexer/module-cycles.js'
import { overview } from './overview.js'
import { getEcosystem } from './ecosystem.js'
import { type Basis, basisOf, byBasis, inferredSql } from './basis.js'
import { analyzeImpact, IMPACT_TYPES, structure, type Impact } from './impact.js'
import { mismatchNotes, repoTag, withWorkspace, workspaceDependents, type Inbound, type Side, type Workspace, type WorkspaceDependent } from './workspace.js'
import { CANDIDATE_TYPES, candidatesFrom, inferredNotes, resolveFollow, sitesNaming } from './inferred.js'
import { ADAPTER_LANGUAGE_NAMES } from '../indexer/language-detect.js'
import { hasRoles, isTestCode, isTestPath, parseRoles, roleTest, rolesSql } from './tests.js'
import { EXECUTING, testReach, type TestRow } from './test-reach.js'
import { changedSymbols, complete, touched, completenessRows, diffLines, inTestCode, summaryLine, type Changed } from './completeness.js'
import { gitInfo } from '../indexer/discovery.js'
import { findTables, tableReach } from './table-reach.js'
import { searchSources } from './sources.js'
import { planRename, publicEntry } from './rename.js'
import { MAX_TERMS, searchConcepts } from './concepts.js'
import { NOTE_KINDS, notesMatching, resolveRef, resolveRefs, staleness } from './notes.js'
import { verify, type Proposition } from './claims.js'
import { openCursor, queryHash, sealCursor } from './cursor.js'
import { addKeys } from './keys.js'
import { leanName, leanRow, leanText, quote } from './lean.js'
import { generatedLeftOut, generatedPaths, markGenerated, withGeneratedPaths } from './generated-policy.js'
import { innermost } from './symbol-at.js'
import { findCycles, findEntryPoints, findHubs, findUnused, type CycleEdge, type EntryPoint, type Hub, type UnusedRow } from './structure.js'
import { contextMap } from './context-map.js'
import { compare, hasBodyHash, unreadableFiles } from './compare.js'
import { importersOf, MAX_FILE_BYTES, MAX_SOURCE_BYTES, reachSet, searchStructure, type StructureMatch } from './structure-search.js'
import { loadSchema } from '../core/schemas.js'
import { changes, workingTree } from '../indexer/freshness.js'
import { registryFor } from '../indexer/languages.js'
import { prepare, requireEnabled } from '../verification/prepare.js'
import { verifyRecord, type RunRecord } from '../verification/binding.js'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const TOOLS = ['workspace_status', 'list_repositories', 'list_snapshots', 'list_workspaces', 'find_symbols', 'get_symbol', 'get_relationships', 'trace_paths', 'read_evidence', 'get_overview', 'analyze_impact', 'find_tests', 'search_sources', 'get_memory', 'verify_claim', 'request_index', 'get_job', 'get_claims', 'save_memory', 'get_table_reach', 'get_property_reads', 'get_external_usage', 'find_query_source', 'compare_snapshots', 'list_queries', 'get_ecosystem', 'prepare_verification', 'get_verification', 'impact_completeness', 'get_symbols_at', 'get_session_trail', 'find_stale_mentions', 'find_unused', 'find_cycles', 'find_entry_points', 'find_hubs', 'get_context_map', 'plan_rename', 'search_structure', 'search_concepts', 'get_symbol_card'] as const
export type ToolName = (typeof TOOLS)[number]
/** The query tools whose results are code locations: they answer in the lean envelope on request, and by default over MCP (FR099). */
export const LEAN = new Set<string>(['find_symbols', 'search_concepts', 'get_symbol', 'get_symbols_at', 'get_relationships', 'trace_paths', 'analyze_impact', 'find_tests', 'get_session_trail', 'find_unused', 'find_cycles', 'find_entry_points', 'find_hubs', 'get_context_map', 'search_structure'])
/** A lean answer is its text; the envelope beside it is what the text was rendered from, for in-process callers. */
export type Answer = Envelope & { text?: string }

/**
 * What each tool may do (FR036). Read tools answer from snapshots and the catalog. Management tools ask the workspace to start or
 * keep something: an index job, a note proposal, a prepared verification. No tool executes repository code: a person approves and
 * runs a verification with the CLI, which is the only importer of the launcher.
 */
export const CAPABILITY: Record<ToolName, ListQueriesData['tools'][number]['capability']> = {
  workspace_status: 'read', list_repositories: 'read', list_snapshots: 'read', list_workspaces: 'read', find_symbols: 'read', get_symbol: 'read', get_relationships: 'read', trace_paths: 'read',
  read_evidence: 'read', get_overview: 'read', analyze_impact: 'read', find_tests: 'read', search_sources: 'read', get_memory: 'read',
  verify_claim: 'read', request_index: 'management', get_job: 'read', get_claims: 'read', save_memory: 'management', get_table_reach: 'read',
  get_property_reads: 'read', get_external_usage: 'read', find_query_source: 'read', compare_snapshots: 'read', list_queries: 'read',
  get_ecosystem: 'read', prepare_verification: 'management', get_verification: 'read', impact_completeness: 'management', get_symbols_at: 'read', get_session_trail: 'read', find_stale_mentions: 'read',
  find_unused: 'read', find_cycles: 'read', find_entry_points: 'read', find_hubs: 'read', get_context_map: 'read', plan_rename: 'read', search_structure: 'read', search_concepts: 'read', get_symbol_card: 'read',
}

/**
 * The MCP tool profile that lists each tool (FR420 to FR423). `proofmesh mcp` lists core, the tools most code questions need, so a
 * session starts with a small tool list; `--tools <profile[,profile]>` or `--tools all` lists the others.
 */
export const PROFILE: Record<ToolName, ListQueriesData['tools'][number]['profile']> = {
  workspace_status: 'core', list_repositories: 'core', find_symbols: 'core', get_symbol: 'core', get_symbols_at: 'core', get_relationships: 'core', trace_paths: 'core',
  read_evidence: 'core', get_overview: 'core', analyze_impact: 'core', find_tests: 'core', search_sources: 'core', search_concepts: 'core', list_queries: 'core',
  get_table_reach: 'data', get_property_reads: 'data', get_external_usage: 'data', find_query_source: 'data', get_session_trail: 'data', get_context_map: 'data',
  verify_claim: 'claims', get_claims: 'claims', prepare_verification: 'claims', get_verification: 'claims',
  list_snapshots: 'extra', list_workspaces: 'extra', get_ecosystem: 'extra', compare_snapshots: 'extra', impact_completeness: 'extra', request_index: 'extra',
  // A maintainer's question after a refactor, like compare_snapshots; workspace_status (core) counts the stale mentions and says how to list them.
  get_job: 'extra', get_memory: 'extra', save_memory: 'extra', find_stale_mentions: 'extra',
  find_unused: 'extra', find_cycles: 'extra', find_entry_points: 'extra', find_hubs: 'extra',
  // Asked before a rename, not for most questions: core's tools/list has little room left, and analyze_impact (core) covers what a change reaches.
  plan_rename: 'extra',
  // Structural search runs a matcher process over captured source: a question for a pattern, not most questions (#37).
  search_structure: 'extra',
  // What Observatory opens a symbol with (FR1180); an assistant asks get_symbol and get_relationships, so core's list stays as it is.
  get_symbol_card: 'extra',
}
/** How a client loads the tools of another profile, said by list_queries, which lists them all (FR422). */
const PROFILES_NOTE = 'Over MCP, proofmesh mcp lists the core profile; start it with --tools <profile[,profile]> (core, data, claims, extra) or --tools all to list the others. A tool outside the profiles it was started with answers INVALID_ARGUMENT naming its profile.'

/** The version of every public contract this build speaks (FR037, FR076); COMPATIBILITY.md states the same versions and their policy. */
export const CONTRACT: ListQueriesData['contract'] = {
  envelope: ENVELOPE_VERSION, snapshot_format: FORMAT_VERSION, link_format: LINK_FORMAT_VERSION, adapter_protocol: PROTOCOL_VERSION,
  bundle_format: BUNDLE_FORMAT_VERSION, snapshot_export: SNAPSHOT_EXPORT_VERSION, catalog_migration: CATALOG_VERSION,
}

/** What a snapshot's references capability means for an answer, said once per snapshot. */
const referencesNote = (capability: string): string | null =>
  capability === 'complete' ? null
  : capability === 'partial' ? 'References other than calls and imports are recorded only where an adapter supports them (C# uses of repository declarations, TypeScript uses of repository types); elsewhere a missing reference is not evidence of no use.'
  : 'References other than calls and imports are not analysed for this snapshot.'
const TRUNCATED = 'Results were truncated and this tool does not page; narrow the query or raise the limits.'
/** A paged tool cut short by something other than its rows (a depth or a timeout) has no next page to offer. */
const NARROW = 'Results were truncated; narrow the query or raise the limits.'
const CONTINUED = 'Results were truncated; pass completion.next_cursor as cursor to get the next page.'

type Ctx = { dataDir: string; db: Database.Database; catalog: Catalog; snapshot: SnapshotRow; limits: AppliedLimits; started: number; store: EvidenceStore; repo: { id: string; name: string; root: string }; page: { offset: number; query: string }; compact: boolean; lean: boolean }
/** Lean leaves out the standing notes, so a lean answer that asks for references says what the snapshot records of them. */
const leanReferencesNote = (ctx: Ctx, types: readonly string[]): string[] => {
  const note = ctx.lean && types.includes('references') ? referencesNote(snapshotSummary(ctx.db, ctx.snapshot.id).capabilities.references) : null
  return note ? [note] : []
}
type Boundary = { assertion_id: string; type: string; reason: string; path: string; line: number; from_id: string; calls_name?: boolean }
type Partial = {
  data: Record<string, unknown>
  evidence_ids?: string[]
  /** count and by_reason cover every matching site when items is only a sample. */
  unresolved?: { scope: 'query'; items: Boundary[]; count?: number; by_reason?: Record<string, number> }
  stop_reasons?: Array<'max_rows' | 'max_depth' | 'max_bytes' | 'timeout'>
  limitations?: string[]
  /** The arrays in `data` (dotted paths, in order) that may be shortened to fit the byte budget; the last keeps at least `keep` items. */
  shrink?: string | string[]
  keep?: number
  /** Called after each cut, so fields derived from the shortened lists follow them. */
  prune?: (data: Record<string, unknown>) => void
  /** True when the shrink list was cut at max_rows: a tool in PAGED then gets a cursor to the rest. */
  more?: boolean
  /** A continuation the tool computed itself, in its own units (search_sources: whole files scanned); null when the scan finished. */
  next_offset?: number | null
  /** The rows the shrink list holds uncut, sent as completion.total. */
  total?: number
  /** The lean rows of `data` as it stands after any cut, one per item of the first shrink list (FR096). */
  lean?: (data: Record<string, unknown>) => string[]
}

/** Tools whose shrink list has a total order and honours ctx.page.offset, so a cursor continues it with no omission or duplicate. */
const PAGED = new Set<ToolName>(['get_symbols_at', 'find_symbols', 'get_relationships', 'search_sources', 'workspace_status', 'find_tests', 'impact_completeness', 'find_unused', 'find_cycles', 'find_entry_points', 'get_context_map', 'search_structure'])
/** Tools that answer over a workspace's link file rather than one repository snapshot (A28). None yet in this file; get_ecosystem joins at integration. */
const WORKSPACE_SCOPED = new Set<ToolName>([])

/** Options a long-lived caller passes: the snapshots it already sent a full envelope for, which later answers send compact. */
export type ToolSession = { fullSent: Set<string> }

export function runTool(dataDir: string, tool: string, input: Record<string, unknown>, session?: ToolSession, signal?: AbortSignal): Answer {
  // shortcut: cancellation is honoured only before a query starts; a query runs synchronously to its answer or its deadline
  // (timeout_ms), so a cancellation that arrives meanwhile is seen after it ends. Run queries off the event loop if that proves too coarse.
  if (signal?.aborted) throw new ProofmeshError('CANCELLED', `the ${tool} request was cancelled before it ran`)
  if (!(TOOLS as readonly string[]).includes(tool)) throw new ProofmeshError('NOT_FOUND', `unknown tool ${tool}`)
  const problem = check(`tools/${tool}.input.schema.json`, input ?? {})
  if (problem) throw new ProofmeshError('INVALID_ARGUMENT', `invalid input: ${problem}; ${tool} accepts ${Object.keys((loadSchema(`tools/${tool}.input.schema.json`) as { properties?: Record<string, unknown> }).properties ?? {}).join(', ')}`)
  // get_context_map's budget_bytes is its answer's max_bytes, so the cut that holds every answer to max_bytes holds it (FR922).
  const out = answer(dataDir, tool as ToolName, tool === 'get_context_map' ? { ...input, limits: { ...(input.limits as object | undefined), max_bytes: input.budget_bytes ?? CONTEXT_BUDGET } } : input, session)
  // An answer that breaks its own schema is a defect: refused as one rather than sent as if it were right (FR037). A lean answer's
  // text is rendered from the envelope checked here.
  const { text: _text, ...env } = out
  const wrong = check('envelope.schema.json', env) ?? check(`tools/${tool}.data.schema.json`, out.data)
  if (wrong) throw new ProofmeshError('INTERNAL_ERROR', `the ${tool} answer does not match its schema: ${wrong}`)
  // Only an answer that was sent counts as the snapshot's full envelope for this session.
  if (out.envelope === undefined && out.snapshot) session?.fullSent.add(out.snapshot.id)
  return out
}

function answer(dataDir: string, tool: ToolName, input: Record<string, unknown>, session?: ToolSession): Answer {
  // A workspace tool answers from a sealed link file and its member snapshots, not from one repository (A28).
  if (tool === 'get_ecosystem') return getEcosystem(dataDir, input)
  // Catalog tools need no repository: they are how a caller finds one.
  if (tool === 'list_repositories' || tool === 'list_snapshots' || tool === 'list_workspaces' || tool === 'get_job' || (tool === 'list_queries' && !input.repository_id && !input.cursor)) {
    const catalog = Catalog.open(dataDir)
    try {
      if (tool === 'list_queries' && catalog.repositories().length === 1) return runRepositoryTool(dataDir, tool, input)
      return catalogTool(catalog, tool, input)
    } finally {
      catalog.close()
    }
  }
  return runRepositoryTool(dataDir, tool, input, session)
}

function catalogTool(catalog: Catalog, tool: ToolName, input: Record<string, unknown>): Envelope {
  const started = Date.now()
  const { applied, limitations: clampNotes } = applyLimits(input.limits as Limits | undefined)
  let data: Record<string, unknown>, limitations: string[]
  if (tool === 'get_job') {
    // A job is read from the catalog, so a first index, which has no snapshot yet, can be followed.
    const job = catalog.job(String(input.job_id))
    const repo = input.repository_id ? catalog.repository(String(input.repository_id)) : null
    if (!job || (repo && job.repository_id !== repo.id)) throw new ProofmeshError('NOT_FOUND', `no index job ${String(input.job_id)} for this repository`)
    data = { job }
    limitations = job.state === 'interrupted' ? ['The process running this job stopped before finishing; request a new index.'] : job.state === 'running' ? ['A running job refreshes progress_at every 5 seconds; if it stops moving for a minute, the run is stuck rather than slow.'] : []
  } else if (tool === 'list_snapshots') {
    // The snapshots a query can pin: what the Observatory's snapshot picker shows, for any client (FR055).
    const repo = catalog.resolveRepository(input.repository_id as string | undefined), current = catalog.currentSnapshot(repo.id)?.id
    data = { repository_id: repo.id, snapshots: catalog.publishedSnapshots(repo.id).map((s) => ({ id: s.id, published_at: s.published_at, analysis_mode: s.analysis_mode, current: s.id === current, git: gitOfSnapshot(catalog, s) })) }
    limitations = ['Pass a snapshot id as snapshot_id to answer from that snapshot; retired snapshots are not listed.']
  } else if (tool === 'list_workspaces') {
    data = { workspaces: catalog.workspaces().map((w) => ({ name: w.name, members: w.members.map((id) => ({ repository_id: id, name: catalog.repository(id).name })) })) }
    limitations = ['Pass a workspace name to get_ecosystem for its members, links and boundaries.']
  } else if (tool === 'list_repositories') {
    data = {
      repositories: catalog.repositories().map((r) => {
        const snap = catalog.currentSnapshot(r.id)
        const git = snap ? gitOfSnapshot(catalog, snap) : null
        return { id: r.id, name: r.name, root: r.root, root_exists: fs.existsSync(r.root), snapshot: snap ? { id: snap.id, published_at: snap.published_at!, commit: git?.commit ?? null, ref: git?.ref ?? null } : null }
      }),
    }
    limitations = ['Pass a repository id as repository_id to every other tool.']
  } else {
    const limit = Math.min(Number(input.limit ?? 50), applied.max_rows)
    const records = catalog.queryRecords({ tool: input.tool as string | undefined, limit })
    data = { tools: toolCatalog(), contract: CONTRACT, records }
    limitations = ['Records of every registered repository, newest first; pass repository_id for one. Records hold the hash of each query input, never its text or its result.', PROFILES_NOTE]
  }
  return {
    schema_version: ENVELOPE_VERSION, query_id: queryId(), tool, snapshot: null, freshness: { mode: 'snapshot', status: 'catalog' }, coverage: null, data, evidence_ids: [],
    unresolved: { count: 0, scope: 'query', sample: [], by_reason: {} },
    completion: { truncated: false, stop_reasons: Date.now() - started > applied.timeout_ms ? ['timeout'] : [], timed_out: false, next_cursor: null },
    limits: { requested: (input.limits as Limits | undefined) ?? {}, applied }, limitations: [...clampNotes, ...limitations],
    ...(input.envelope === 'compact' ? { envelope: 'compact' as const } : {}),
  }
}

function gitOfSnapshot(catalog: Catalog, snap: SnapshotRow): { commit?: string; ref?: string } | null {
  try {
    const db = openSnapshot(catalog, snap)
    try { return JSON.parse((db.prepare("select value from meta where key = 'git'").get() as { value: string } | undefined)?.value ?? '{}') } finally { db.close() }
  } catch {
    return null
  }
}

const toolCatalog = () => TOOLS.map((name) => ({
  name, description: String(loadSchema(`tools/${name}.input.schema.json`).description ?? name),
  input_schema: `tools/${name}.input.schema.json`, data_schema: `tools/${name}.data.schema.json`, paged: PAGED.has(name), workspace_scoped: WORKSPACE_SCOPED.has(name), capability: CAPABILITY[name], profile: PROFILE[name],
}))

function runRepositoryTool(dataDir: string, tool: string, input: Record<string, unknown>, session?: ToolSession): Answer {
  const catalog = Catalog.open(dataDir)
  try {
    const repo = catalog.resolveRepository(input.repository_id as string | undefined)
    const strict = input.freshness === 'strict'
    if (strict && (input.snapshot_id || input.cursor)) {
      throw new ProofmeshError('INVALID_ARGUMENT', 'strict freshness answers from the working tree; it cannot be combined with snapshot_id or cursor', { detail: 'strict_with_pinned_snapshot' })
    }
    const query = queryHash(tool, input)
    const cursor = typeof input.cursor === 'string' ? openCursor(dataDir, input.cursor, { tool, repo: repo.id, query, snapshot: input.snapshot_id as string | undefined }) : null
    const pinned = cursor?.snap ?? (input.snapshot_id as string | undefined)
    const snapshot = pinned ? catalog.snapshot(pinned) : catalog.currentSnapshot(repo.id)
    // A snapshot of another repository is refused, naming its owner, rather than answered as if it were this repository's (FR015).
    if (snapshot && snapshot.repository_id !== repo.id) {
      const owner = catalog.repositories().find((r) => r.id === snapshot.repository_id)
      throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `snapshot ${snapshot.id} belongs to repository ${snapshot.repository_id}${owner ? ` (${owner.name})` : ''}, not ${repo.id} (${repo.name}); pass that repository_id, or a snapshot of ${repo.name}`, { detail: 'other_repository', repository_id: snapshot.repository_id })
    }
    if (!snapshot) throw noSnapshot(catalog, repo.id)
    const db = openSnapshot(catalog, snapshot)
    try {
      const { applied, limitations } = applyLimits(input.limits as Limits | undefined)
      // Test code is recognised by path and by a symbol's roles in SQL, so a filter keeps the paging order intact; a call with the path alone judges the file.
      db.function('pm_is_test', { deterministic: true, varargs: true }, (p: unknown, roles?: unknown) => (p !== null && (isTestPath(String(p)) || (typeof roles === 'string' && roleTest(parseRoles(roles)))) ? 1 : 0))
      // Lean leaves out what compact leaves out: it states only this answer's limitations.
      const lean = input.envelope === 'lean'
      const ctx: Ctx = { dataDir, db, catalog, snapshot, limits: applied, started: Date.now(), store: new EvidenceStore(dataDir), repo: { id: repo.id, name: repo.name, root: repo.root }, page: { offset: cursor?.offset ?? 0, query }, compact: lean || input.envelope === 'compact' || (input.envelope === undefined && !!session?.fullSent.has(snapshot.id)), lean }
      const freshness = strict ? strictFreshness(ctx, repo.root) : SNAPSHOT_FRESHNESS
      // Every row that names a file the policy flags generated says so, in the data and in a lean row (FR292).
      const generated = generatedPaths(db)
      const out = withGeneratedPaths(generated, () => {
        const result = IMPL[tool as ToolName](ctx, withNamedIds(db, tool, input))
        // A comparison tags each side from its own snapshot, inside the tool.
        if (tool !== 'compare_snapshots') markGenerated(result.data, generated)
        const env = envelope(ctx, tool as ToolName, input.limits as Limits | undefined, result, limitations, freshness)
        // An unresolved sample names a file too (FR292).
        for (const s of env.unresolved.sample) if (generated.has(s.file)) s.generated = true
        return env
      })
      // Only what list_queries reports: never the input or the result (NFR008).
      catalog.recordQuery({ query_id: out.query_id, tool, repository_id: repo.id, snapshot_id: snapshot.id, duration_ms: Date.now() - ctx.started, truncated: out.completion.truncated, input_hash: query })
      return out
    } finally {
      db.close()
    }
  } finally {
    catalog.close()
  }
}

/** What every answer from an imported snapshot says: where it came from, that it is only as honest as its producer, and which files were stale. */
function importedLimitation(id: string, i: ImportedSnapshot): string {
  const o = i.origin, shown = i.stale.slice(0, 10)
  return `imported: snapshot ${id} was built elsewhere (${o.writer}, repository ${o.repository_name}, exported ${o.exported_at}) and imported ${i.imported_at}; its facts are only as honest as the data directory that built it. `
    + (i.stale.length ? `${i.stale.length} file${i.stale.length === 1 ? '' : 's'} differed from the working tree on import, so answers about ${i.stale.length === 1 ? 'it' : 'them'} are stale: ${shown.join(', ')}${i.stale.length > shown.length ? `, and ${i.stale.length - shown.length} more` : ''}. Index the repository to replace it with a snapshot built here.` : 'Every file it read matched the working tree on import.')
}

const SNAPSHOT_FRESHNESS: Envelope['freshness'] = { mode: 'snapshot', status: 'as_of_snapshot' }

/** Doc mentions by resolution: one target, or several candidates (FR820). */
const mentionCounts = (db: Database.Database): { resolved: number; ambiguous: number } => {
  const c = { resolved: 0, ambiguous: 0 }
  for (const r of db.prepare("select resolution, count(*) as n from assertion where type = 'mentions' group by resolution").all() as Array<{ resolution: 'resolved' | 'ambiguous'; n: number }>) c[r.resolution] = r.n
  return c
}

/**
 * Strict freshness: the snapshot answers only if the working tree, read now, is exactly what it was built from. Otherwise an index
 * job starts (or the open one is reused) and the call is refused with the changed files, so no answer passes for current when it is not.
 */
/** Whether the working tree, read now, is exactly what a snapshot was built from, and if not which files changed. Reads files; starts nothing. */
/** repositoryId: the catalog's, which for an imported snapshot is not the one its sealed meta names (FR1083). */
export function treeFreshness(db: Database.Database, dataDir: string, root: string, repositoryId = (db.prepare("select value from meta where key = 'repository_id'").get() as { value: string }).value): { current: boolean; changed: ReturnType<typeof changes> } {
  const tree = workingTree(root, registryFor(dataDir, repositoryId))
  const identity = JSON.parse((db.prepare("select value from meta where key = 'identity'").get() as { value: string }).value) as { manifest_hash: string }
  if (tree.manifest === identity.manifest_hash) return { current: true, changed: [] }
  const captured = new Map((db.prepare("select path, content_hash from file where disposition in ('indexed', 'failed')").all() as Array<{ path: string; content_hash: string | null }>).map((f) => [f.path, f.content_hash]))
  // The docs whose text the snapshot kept for their mentions (FR826) are files the tree is compared on too.
  const docs = db.prepare("select value from meta where key = 'doc_links'").get() as { value: string } | undefined
  for (const [p, h] of Object.entries(docs ? (JSON.parse(docs.value) as { docs: Record<string, string> }).docs : {})) captured.set(p, h)
  return { current: false, changed: changes(captured, tree.hashes) }
}

function strictFreshness(ctx: Ctx, root: string): Envelope['freshness'] {
  const { current, changed } = treeFreshness(ctx.db, ctx.dataDir, root, ctx.repo.id)
  if (current) {
    return { mode: 'strict', status: 'current', checked_at: new Date().toISOString(), boundary: 'Repository files as discovered now; packages and other external inputs as recorded when the snapshot was built.' }
  }
  const stale = `the working tree differs from snapshot ${ctx.snapshot.id} (${changed.length || 'its file inventory'} changed)`
  const found = { detail: 'working_tree_changed', snapshot_id: ctx.snapshot.id, changed_count: changed.length, changed: changed.slice(0, 20) }
  // Another process, such as a watcher, is indexing: a job started now could only fail on its lease, so the refusal names that index.
  const holder = ctx.catalog.leaseHolder(ctx.repo.id)
  if (holder && holder.owner !== LEASE_OWNER) {
    throw new ProofmeshError('STALE_INPUT', `${stale}; the index already running in ${holder.owner} will publish a current snapshot`, { ...found, indexing_by: holder.owner })
  }
  const job = (IMPL.request_index(ctx, {}).data as { job: { id: string } }).job
  throw new ProofmeshError('STALE_INPUT', `${stale}; index job ${job.id} will publish a current snapshot`, { ...found, job_id: job.id })
}

function envelope(ctx: Ctx, tool: ToolName, requested: Limits | undefined, r: Partial, clampNotes: string[], freshness: Envelope['freshness']): Answer {
  const { db } = ctx
  // The cut shortens lists of the answer, which a tool may have taken from a cached object: work on a copy (FR365).
  r.data = structuredClone(r.data)
  addKeys(db, tool, r.data)
  const stop = new Set(r.stop_reasons ?? [])
  if (Date.now() - ctx.started > ctx.limits.timeout_ms) stop.add('timeout')
  let cut = r.more ?? false
  const keys = typeof r.shrink === 'string' ? [r.shrink] : (r.shrink ?? [])
  const listAt = (key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], r.data) as unknown[] | undefined
  const summary = snapshotSummary(db, ctx.snapshot.id)

  let unresolved: Envelope['unresolved']
  if (r.unresolved) {
    const items = r.unresolved.items
    unresolved = { count: r.unresolved.count ?? items.length, scope: 'query', sample: [], by_reason: r.unresolved.by_reason ? { ...r.unresolved.by_reason } : {} }
    for (const b of items.filter((b) => UNRESOLVED_REASONS.has(b.reason))) {
      if (unresolved.sample.length < 20) unresolved.sample.push({ assertion_id: b.assertion_id, reason: b.reason as Envelope['unresolved']['sample'][number]['reason'], file: b.path, line: b.line })
      if (!r.unresolved.by_reason) unresolved.by_reason[b.reason] = (unresolved.by_reason[b.reason] ?? 0) + 1
    }
  } else {
    // Snapshot scope: the counts and reasons, not a sample of sites from files the query never touched; compact keeps the count.
    unresolved = { count: summary.unresolved.count, scope: 'snapshot', sample: [], by_reason: ctx.compact ? {} : summary.unresolved.by_reason }
  }
  const missing = summary.missing_inputs
  const blamed = summary.unresolved.by_reason.dependency_missing ?? 0
  const git = JSON.parse((db.prepare("select value from meta where key = 'git'").get() as { value: string } | undefined)?.value ?? '{}') as { commit?: string; ref?: string; behind_remote?: number | null; behind_ref?: string | null; fetched_at?: string | null }
  // Standing limitations hold for every answer from the snapshot; a compact envelope leaves them to the first answer.
  const standing = [
    referencesNote(summary.capabilities.references),
    // A detached head has no branch of its own to be behind, and every count is only as fresh as the last fetch.
    git.ref === 'detached' || (git.behind_remote != null && git.fetched_at && Date.now() - Date.parse(git.fetched_at) > 86_400_000)
      ? `The snapshot is of ${git.ref === 'detached' ? 'a detached head' : `branch ${git.ref}`}; behind_remote counts the commits of ${git.behind_ref ?? 'no remote branch'} it lacks, as of the last fetch${git.fetched_at ? ` at ${git.fetched_at}` : ''}, without fetching, so it can understate how stale it is.`
      : null,
    missing.length ? `${missing.length} external input${missing.length === 1 ? ' was' : 's were'} missing when this snapshot was built; ${blamed} unresolved site${blamed === 1 ? ' is' : 's are'} blamed on them as dependency_missing, and workspace_status counts them by package.` : null,
  ].filter((x): x is string => !!x)
  // A snapshot published with files missing says so in every answer, compact and lean included (FR343).
  const partialNote = partialLimitations(db, ctx.snapshot.id)
  // An imported snapshot says so in every answer, compact and lean included, with its origin and the files that were stale on import (FR1084).
  const imported = ctx.catalog.imported(ctx.snapshot.id)
  const importNote = imported ? [importedLimitation(ctx.snapshot.id, imported)] : []
  const limitations = [...importNote, ...partialNote, ...clampNotes, ...(r.limitations ?? []), ...(ctx.compact ? [] : standing)]
  const order = ['max_rows', 'max_depth', 'max_bytes', 'timeout'] as const
  const env: Envelope = {
    schema_version: ENVELOPE_VERSION,
    query_id: queryId(),
    tool,
    snapshot: { id: ctx.snapshot.id, repository_id: ctx.snapshot.repository_id, analysis_mode: ctx.snapshot.analysis_mode, published_at: ctx.snapshot.published_at!, commit: git.commit ?? null, ref: git.ref ?? null, behind_remote: git.behind_remote ?? null, behind_ref: git.behind_ref ?? null, fetched_at: git.fetched_at ?? null, ...(imported ? { imported: { origin: imported.origin, imported_at: imported.imported_at, stale_count: imported.stale.length } } : {}) },
    freshness,
    // Compact: coverage, like the standing limitations, came with the first answer from this snapshot.
    coverage: ctx.compact ? null : { inventory_complete: true, files_discovered: summary.files_discovered, dispositions: summary.dispositions, capabilities: summary.capabilities },
    data: r.data,
    evidence_ids: r.evidence_ids ?? [],
    unresolved,
    completion: { truncated: false, stop_reasons: [], timed_out: false, next_cursor: null },
    limits: { requested: ctx.compact ? {} : requested ?? {}, applied: ctx.limits },
    limitations,
    ...(ctx.compact ? { envelope: 'compact' as const } : {}),
  }
  // Lean: the header says current or stale, and a stale answer names the snapshot that replaced it (FR095).
  const current = ctx.lean ? ctx.catalog.currentSnapshot(ctx.repo.id)?.id : undefined
  if (ctx.lean && current !== ctx.snapshot.id) limitations.push(`Snapshot ${ctx.snapshot.id} is older than the repository's current snapshot ${current ?? '(none)'}.`)
  if (ctx.lean && !r.lean) throw new ProofmeshError('INTERNAL_ERROR', `${tool} has no lean rows`)
  // The byte budget is the whole answer's, measured on the answer as it will be sent: with its truncation note or cursor line,
  // `truncated`, `stop_reasons` and every other field the cut adds. `finish` builds that answer from the current state.
  const finish = (): Answer => {
    // A page continues only from a whole, ordered prefix: never after a timeout, and never from an empty page, unless the
    // tool computed the continuation itself from whole units.
    const shown = keys.length ? (listAt(keys[0]!)?.length ?? 0) : 0
    const next_cursor = PAGED.has(tool) && (r.next_offset != null || (r.next_offset === undefined && cut && shown > 0 && !stop.has('timeout')))
      ? sealCursor(ctx.dataDir, { tool, repo: ctx.snapshot.repository_id, snap: ctx.snapshot.id, query: ctx.page.query, offset: r.next_offset ?? ctx.page.offset + shown })
      : null
    // A lean answer's last line carries the cursor, in place of the note pointing at completion.next_cursor.
    const notes = stop.size && !(ctx.lean && next_cursor) ? [...limitations, next_cursor ? CONTINUED : PAGED.has(tool) ? NARROW : TRUNCATED] : limitations
    const done: Envelope = { ...env, limitations: notes, completion: { truncated: stop.size > 0, stop_reasons: order.filter((o) => stop.has(o)), timed_out: stop.has('timeout'), next_cursor, ...(r.total === undefined ? {} : { total: r.total }) } }
    return ctx.lean ? { ...done, envelope: 'lean', text: leanText(tool, ctx.snapshot.id, current === ctx.snapshot.id, r.lean!(r.data), notes, next_cursor, !!imported) } : done
  }
  const size = (a: Answer) => Buffer.byteLength(ctx.lean ? a.text! : JSON.stringify(a))
  // A key `a[].b` is the list b of every item of a, shortened from the last item's: a nested list the answer holds per table or per row.
  const listsAt = (key: string): unknown[][] => {
    const [head, tail] = key.split('[].')
    if (tail === undefined) return [listAt(key) ?? []]
    return (listAt(head!) ?? []).flatMap((item) => { const l = tail.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], item); return Array.isArray(l) ? [l] : [] })
  }
  let out = finish()
  for (const [i, key] of keys.entries()) {
    const floor = i === keys.length - 1 ? (r.keep ?? 0) : 0
    for (;;) {
      const lists = listsAt(key), total = lists.reduce((n, l) => n + l.length, 0)
      if (total <= floor || size(out) <= ctx.limits.max_bytes) break
      lists.filter((l) => l.length).at(-1)!.pop()
      r.prune?.(r.data); stop.add('max_bytes'); cut = true
      out = finish()
    }
  }
  // An envelope that alone overflows the byte budget is compacted rather than sent over it.
  if (!ctx.compact && size(out) > ctx.limits.max_bytes) {
    for (const note of standing) limitations.splice(limitations.indexOf(note), 1)
    limitations.push(`Envelope compacted to fit max_bytes ${ctx.limits.max_bytes}.`)
    env.unresolved.by_reason = env.unresolved.scope === 'snapshot' ? {} : env.unresolved.by_reason
    env.limits.requested = {}
    env.coverage = null
    env.envelope = 'compact'
    out = finish()
  }
  // No answer leaves over the budget: one that cannot hold even its envelope and note is refused.
  if (size(out) > ctx.limits.max_bytes) throw new ProofmeshError('INVALID_ARGUMENT', `max_bytes ${ctx.limits.max_bytes} is too small for a ${tool} answer; its envelope alone takes ${size(out)} bytes`, { detail: 'max_bytes_too_small', max_bytes: ctx.limits.max_bytes, needed: size(out) })
  return out
}

const PROPERTY_READS_NOTE = 'observed property reads come from an instrumented run a person imported; a property absent from them was not seen read in that window, which is not evidence that nothing reads it.'
const propertyReadRow = (r: PropertyRead, propertyOf: Database.Statement) => ({
  source: r.source, window: { from: r.window_from, to: r.window_to }, endpoint: r.endpoint, entity: r.entity, declaring_type: r.declaring_type, property: r.property, read_kind: r.read_kind, reads: r.reads, calls: r.calls,
  callers: r.callers ? (JSON.parse(r.callers) as string[]) : [], symbol_id: (propertyOf.get(`${r.declaring_type ?? r.entity}.${r.property}`) as { id: string } | undefined)?.id ?? (propertyOf.get(`${r.entity}.${r.property}`) as { id: string } | undefined)?.id ?? null,
})

type SymbolRow = { id: string; kind: string; name: string; qualified_name: string; path: string; start_line: number; end_line: number; signature: string | null; evidence_id: string }
/** Most locations one get_symbols_at call answers (FR119). */
const MAX_LOCATIONS = 100
const SYMBOL_SQL = 'select s.id, s.kind, s.name, s.qualified_name, f.path, s.start_line, s.end_line, s.signature, s.evidence_id from symbol s join file f on f.id = s.file_id'
const publicSymbol = ({ evidence_id: _e, ...s }: SymbolRow) => s
const TEST_RECOGNISED = 'by file convention and project naming, and by the roles an adapter gave each symbol (a test entry point, or code in a test-only scope)'
const TEST_FILTER_NOTE = `Test code was left out, recognised ${TEST_RECOGNISED}.`
/** The roles an adapter gave each symbol, where the snapshot holds them; a symbol with none has no roles field. */
function withRoles<T extends { id: string }>(db: Database.Database, symbols: T[]): Array<T & { roles?: string[] }> {
  if (!symbols.length || !hasRoles(db)) return symbols
  const stored = new Map((db.prepare(`select id, roles from symbol where id in (${symbols.map(() => '?').join(',')}) and roles is not null`).all(...symbols.map((s) => s.id)) as Array<{ id: string; roles: string }>).map((r) => [r.id, parseRoles(r.roles)!]))
  return symbols.map((s) => (stored.has(s.id) ? { ...s, roles: stored.get(s.id)! } : s))
}
/** A symbol as a lean row: at its declaration, with its kind, and its id when asked (FR096, FR100). */
const symbolRow = (s: Pick<SymbolRow, 'id' | 'kind' | 'name' | 'qualified_name' | 'path' | 'start_line'>, ids = false) =>
  leanRow(leanName(s), s.path, s.start_line, [s.kind, ...(ids ? [`id=${s.id}`] : [])])

/** The symbol a `{ name, path }` names: its lean name, else its plain name, unique in that file (FR100). */
function symbolNamed(db: Database.Database, named: { name: string; path: string }): string {
  const inFile = db.prepare(`${SYMBOL_SQL} where f.path = ? order by s.start_line, s.start_byte, s.qualified_name, s.kind, s.id`).all(named.path) as SymbolRow[]
  const exact = inFile.filter((s) => leanName(s) === named.name)
  const hits = exact.length ? exact : inFile.filter((s) => s.name === named.name)
  if (hits.length === 1) return hits[0]!.id
  if (!hits.length) throw new ProofmeshError('NOT_FOUND', `no symbol named ${named.name} in ${named.path}${inFile.length ? '' : ' (no symbols in that file)'}`)
  const candidates = hits.map((s) => symbolRow(s, true))
  throw new ProofmeshError('INVALID_ARGUMENT', `${named.name} names ${hits.length} symbols in ${named.path}; pass one by id:\n${candidates.join('\n')}`, { detail: 'ambiguous_name', candidates })
}

/** Source text in a lean row, control and bidirectional characters escaped, so the code cannot reorder or hide what the row shows. */
const visible = (t: string) => t.replace(/[\u0000-\u001f\u007f-\u009f\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
/** The one symbol a name names in the whole snapshot: its lean name (`DataSource.initialize`), else its plain name. */
function symbolByName(db: Database.Database, name: string): string {
  const rows = db.prepare(`${SYMBOL_SQL} where s.name = ? and s.kind <> 'module' order by f.path, s.start_line, s.id`).all(name.slice(name.lastIndexOf('.') + 1)) as SymbolRow[]
  const exact = rows.filter((s) => leanName(s) === name)
  const hits = exact.length ? exact : rows.filter((s) => s.name === name)
  if (hits.length === 1) return hits[0]!.id
  if (!hits.length) throw new ProofmeshError('NOT_FOUND', `no symbol named ${name} in this snapshot`)
  const candidates = hits.slice(0, 10).map((s) => symbolRow(s, true))
  throw new ProofmeshError('INVALID_ARGUMENT', `${name} names ${hits.length} symbols; pass one by id or as { name, path }:\n${candidates.join('\n')}`, { detail: 'ambiguous_name', candidates })
}

/** The input with every `{ name, path }` given in place of a symbol id replaced by that id. */
function withNamedIds(db: Database.Database, tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const id = (v: unknown) => (v !== null && typeof v === 'object' ? symbolNamed(db, v as { name: string; path: string }) : v)
  const out = { ...input }
  // A `key` is a stable_key, the same in every tier (FR149): it stands in for the id the tool takes.
  const ids: Record<string, [string, string]> = { get_symbol: ['key', 'symbol_id'], get_memory: ['key', 'symbol_id'], get_relationships: ['key', 'subject_id'], analyze_impact: ['key', 'subject_ids'], find_tests: ['key', 'subject_ids'], plan_rename: ['key', 'subject_id'], get_symbol_card: ['key', 'symbol_id'] }
  const keyed = (name: string, into: string) => {
    if (!(name in out)) return
    // A key is one way to name the subject: with an id or a path as well, the call does not say which it means.
    const others = name === 'source_key' ? ['source_id', 'source_path'] : name === 'target_key' ? ['target_id', 'target_path'] : [into, 'path', 'paths']
    const given = others.filter((o) => input[o] !== undefined)
    if (given.length) throw new ProofmeshError('INVALID_ARGUMENT', `give one of ${name}, ${others.join(' or ')}: got ${name} and ${given.join(', ')}`)
    const key = String(out[name])
    delete out[name]
    const rows = db.prepare('select id from symbol where stable_key = ?').all(key) as Array<{ id: string }>
    if (!rows.length) throw new ProofmeshError('NOT_FOUND', `no symbol has the key ${key} in this snapshot`)
    // A snapshot sealed before keys were unique may hold two; it answers none by guessing.
    if (rows.length > 1) throw new ProofmeshError('INVALID_ARGUMENT', `the key ${key} names ${rows.length} symbols in this snapshot, which was sealed before keys were unique; index again`, { detail: 'ambiguous_key' })
    out[into] = into === 'subject_ids' ? [rows[0]!.id] : rows[0]!.id
  }
  if (ids[tool]) keyed(...ids[tool]!)
  if (tool === 'trace_paths') { keyed('source_key', 'source_id'); keyed('target_key', 'target_id') }
  for (const k of ['subject_id', 'source_id', 'target_id', 'symbol_id']) if (k in out) out[k] = id(out[k])
  if (Array.isArray(out.subject_ids)) out.subject_ids = out.subject_ids.map(id)
  // A claim keeps a symbol as kind:qualified name, which resolves in any snapshot, not as an id of this one.
  const claim = out.claim as { proposition?: Record<string, unknown> } | undefined
  if (claim?.proposition) {
    const ref = (v: unknown) => {
      if (v === null || typeof v !== 'object') return v
      const s = db.prepare('select kind, qualified_name from symbol where id = ?').get(id(v)) as { kind: string; qualified_name: string }
      return `${s.kind}:${s.qualified_name}`
    }
    out.claim = { ...claim, proposition: { ...claim.proposition, source: ref(claim.proposition.source), target: ref(claim.proposition.target) } }
  }
  return out
}

function siteOf(db: Database.Database, assertionId: string): { path: string; start_line: number; end_line: number; evidence: string[] } {
  const rows = db.prepare('select e.id, f.path, e.start_line, e.end_line from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by f.path, e.start_byte').all(assertionId) as Array<{ id: string; path: string; start_line: number; end_line: number }>
  const first = rows[0]!
  return { path: first.path, start_line: first.start_line, end_line: first.end_line, evidence: rows.map((r) => r.id) }
}

/**
 * Each dependent at the site of the edge that first reached it, or at its declaration when dispatch reached it (FR097, FR860): the
 * row's line in its own file and the relationship, and `site` when that edge is recorded in another file (a registration, say).
 */
const impactRows = (ctx: Ctx, dependents: Array<Impact['dependents'][number] & { repository?: WorkspaceDependent['repository'] }>, reached: Impact['reached_by']) => dependents.map((x) => {
  // A dependent in another repository already holds its line, relationship and site, read from its own snapshot.
  if (x.repository) return x as WorkspaceDependent
  const via = reached.get(x.id), site = via ? siteOf(ctx.db, via) : null
  const line = site?.path === x.path ? site.start_line : (ctx.db.prepare('select start_line from symbol where id = ?').get(x.id) as { start_line: number }).start_line
  const relationship = via ? (ctx.db.prepare('select type from assertion where id = ?').get(via) as { type: string }).type : 'dispatch'
  return { ...x, line, relationship, ...(site && site.path !== x.path ? { site: { path: site.path, start_line: site.start_line } } : {}) }
})

type Boundaries = { items: Boundary[]; count: number; by_reason: Record<string, number> }
const NO_BOUNDARIES: Boundaries & { name_matched: number } = { items: [], count: 0, by_reason: {}, name_matched: 0 }

/** The parameters a signature lists, counting only top-level commas, so `Map<string, int> m` is one; null without a parameter list. */
export function parameterCount(signature: string | null): number | null {
  const close = signature?.lastIndexOf(')') ?? -1
  if (!signature || close < 0) return null
  // The parameter list is the parenthesis the last ')' closes; a tuple return type opens an earlier one.
  let open = close, nest = 0
  for (; open >= 0; open--) { if (signature[open] === ')') nest++; else if (signature[open] === '(' && --nest === 0) break }
  if (open < 0) return null
  const inner = signature.slice(open + 1, close).trim()
  if (!inner) return 0
  let depth = 0, count = 1
  for (const c of inner) {
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) count++
  }
  return count
}

/** How many of a snapshot's unresolved call sites, beyond those calling the subject's name, an inbound query lists as possible callers. */
const UNRESOLVED_SHOWN = 10

/**
 * The members a symbol implements or overrides, transitively: a call or reference to one of them may dispatch to the symbol, so an
 * inbound query on an implementation includes them, each row saying which member it went through.
 */
export function dispatchedFrom(db: Database.Database, subject: string): Map<string, string> {
  const via = new Map<string, string>()
  let frontier = [subject]
  // No depth cap: the visited set ends a cycle, and an override chain is as deep as the class hierarchy.
  while (frontier.length) {
    const rows = db.prepare(`select target_id from assertion where source_id in (${frontier.map(() => '?').join(',')}) and type in ('implements', 'overrides') and resolution = 'resolved' and target_kind = 'symbol'`).all(...frontier) as Array<{ target_id: string }>
    frontier = [...new Set(rows.map((r) => r.target_id))].filter((id) => id !== subject && !via.has(id))
    for (const id of frontier) via.set(id, id)
  }
  return via
}

/**
 * Call sites that could reach a symbol without a resolved edge: candidate or ambiguous calls naming it or a member it implements, and
 * unresolved calls. Unresolved calls that call the subject's name come first, those with its parameter count before the rest, then
 * the nearest others by path; a site inside the subject itself is listed only when it calls the subject's name (possible recursion).
 */
function incomingBoundaries(ctx: Ctx, subject: string, via: Map<string, string>): Boundaries & { name_matched: number } {
  const { db } = ctx, limit = ctx.limits.max_rows
  type Row = { id: string; type: string; resolution: string; reason: string; source_id: string }
  const named = [subject, ...via.keys()]
  const candidates = `from assertion_candidate c join assertion a on a.id = c.assertion_id where c.symbol_id in (${named.map(() => '?').join(',')}) and a.type = 'calls' and a.resolution in ('candidate', 'ambiguous')`
  const candidateCount = (db.prepare(`select count(distinct a.id) as n ${candidates}`).get(...named) as { n: number }).n
  const subj = db.prepare('select s.name, s.kind, s.signature, f.path from symbol s join file f on f.id = s.file_id where s.id = ?').get(subject) as { name: string; kind: string; signature: string | null; path: string }
  // A constructor is called by its type's name, which is also its own.
  const arity = parameterCount(subj.signature)
  const byName = `from assertion a where a.type = 'calls' and a.resolution = 'unresolved' and json_extract(a.detail, '$.callee') = ?`
  const nameMatched = (db.prepare(`select count(*) as n ${byName}`).get(subj.name) as { n: number }).n
  const matched = db.prepare(`select a.id, a.type, a.resolution, a.reason, a.source_id, (json_extract(a.detail, '$.arity') = ?) as _arity, ${siteCols(db)} ${byName} order by _arity desc, ${siteOrder(db)} limit ?`).all(arity === null ? null : String(arity), subj.name, limit) as Row[]
  const dir = subj.path.slice(0, subj.path.lastIndexOf('/') + 1)
  const nearest = (prefix: string, n: number, exclude: string[]): Row[] => n <= 0 ? [] : db.prepare(`select a.id, a.type, a.resolution, a.reason, a.source_id from assertion a join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id
    where a.resolution = 'unresolved' and a.type = 'calls' and a.source_id <> ? and coalesce(json_extract(a.detail, '$.callee'), '') <> ? and f.path like ? escape '\\'${exclude.length ? ` and a.id not in (${exclude.map(() => '?').join(',')})` : ''} group by a.id order by min(f.path), min(e.start_byte), (select s.qualified_name from symbol s where s.id = a.source_id), a.id limit ?`).all(subject, subj.name, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, ...exclude, n) as Row[]
  const callers = new Set(matched.map((r) => r.id))
  const others = Math.min(UNRESOLVED_SHOWN, limit - matched.length)
  const near = nearest(dir, others, [])
  const rows = [
    ...(db.prepare(`select distinct a.id, a.type, a.resolution, a.reason, a.source_id, ${siteCols(db)} ${candidates} order by ${siteOrder(db)} limit ?`).all(...named, limit) as Row[]),
    ...matched,
    ...near,
    ...nearest('', others - near.length, near.map((r) => r.id)),
  ].slice(0, limit)
  const calls = snapshotSummary(db, ctx.snapshot.id).unresolved_calls
  return {
    count: calls.count + candidateCount,
    name_matched: nameMatched,
    by_reason: { ...calls.by_reason },
    items: rows.map((r) => {
      const site = siteOf(db, r.id)
      return { assertion_id: r.id, type: r.type, reason: r.resolution === 'unresolved' ? r.reason : r.resolution, path: site.path, line: site.start_line, from_id: r.source_id, ...(callers.has(r.id) ? { calls_name: true } : {}) }
    }),
  }
}

/** Every matching unresolved, candidate or ambiguous site is counted; evidence is read only for the first `limit`. */
function boundariesFrom(db: Database.Database, types: string[], where: string, limit: number, ...params: unknown[]): Boundaries {
  const from = `from assertion a where a.type in (${types.map(() => '?').join(',')}) and a.resolution in ('unresolved','candidate','ambiguous') and ${where}`
  const groups = db.prepare(`select a.resolution, a.reason, count(*) as n ${from} group by a.resolution, a.reason`).all(...types, ...params) as Array<{ resolution: string; reason: string | null; n: number }>
  const rows = db.prepare(`select a.id, a.type, a.resolution, a.reason, a.source_id, ${siteCols(db)} ${from} order by ${siteOrder(db)} limit ?`).all(...types, ...params, limit) as Array<{ id: string; type: string; resolution: string; reason: string; source_id: string }>
  return {
    count: groups.reduce((n, g) => n + g.n, 0),
    by_reason: Object.fromEntries(groups.filter((g) => g.resolution === 'unresolved' && g.reason).map((g) => [g.reason!, g.n])),
    items: rows.map((r) => {
      const site = siteOf(db, r.id)
      return { assertion_id: r.id, type: r.type, reason: r.resolution === 'unresolved' ? r.reason : r.resolution, path: site.path, line: site.start_line, from_id: r.source_id }
    }),
  }
}

/**
 * A file named by its repository-relative path (FR089, FR094). `..`, an absolute path inside the repository and backslashes are
 * normalised; a path outside the repository, or one the snapshot does not index, is refused naming its disposition, never answered empty.
 */
function fileAt(ctx: Ctx, raw: string): { id: string; path: string } {
  const abs = path.resolve(ctx.repo.root, raw.replaceAll('\\', '/'))
  const inside = (p: string) => { const r = path.relative(ctx.repo.root, p).split(path.sep).join('/'); return r && r !== '..' && !r.startsWith('../') && !path.isAbsolute(r) ? r : null }
  // The registered root is a real path, so an absolute path through a symlink to it is read as its real path.
  let rel = inside(abs)
  if (!rel) try { rel = inside(fs.realpathSync(abs)) } catch { /* not on disk: outside */ }
  if (!rel) throw new ProofmeshError('INVALID_ARGUMENT', `path ${raw} is outside the repository ${ctx.repo.name} (${ctx.repo.root})`, { detail: 'path_outside_repository', path: raw })
  const f = ctx.db.prepare('select id, disposition from file where path = ?').get(rel) as { id: string; disposition: string } | undefined
  if (!f || f.disposition !== 'indexed') {
    const disposition = !f ? 'not found' : f.disposition === 'excluded_by_rule' ? 'excluded' : f.disposition
    throw new ProofmeshError('INVALID_ARGUMENT', `path ${rel} is ${disposition} in snapshot ${ctx.snapshot.id}, so no tool can answer for it; workspace_status lists the files with their dispositions`, { detail: 'path_not_indexed', path: rel, disposition })
  }
  return { id: f.id, path: rel }
}

/** The other id of a file and its module symbol, which are one node (FR090): imports are recorded on the file, calls on the module. */
const fileAlias = (db: Database.Database, id: string): string | undefined => id.startsWith('file_')
  ? (db.prepare("select id from symbol where file_id = ? and kind = 'module' order by id limit 1").get(id) as { id: string } | undefined)?.id
  : (db.prepare("select file_id as id from symbol where id = ? and kind = 'module'").get(id) as { id: string } | undefined)?.id

/** The note a structure listing carries when it left generated files under its prefix out (FR299). */
const generatedNote = (ctx: Ctx, listing: string, input: Record<string, unknown>): string[] => {
  const prefix = String(input.path_prefix ?? '')
  const note = generatedLeftOut(listing, [...generatedPaths(ctx.db)].filter((p) => p.startsWith(prefix)).length, input.include_generated === true)
  return note ? [note] : []
}

/** get_context_map's default budget_bytes and max_depth (FR920). */
const CONTEXT_BUDGET = 4096, CONTEXT_DEPTH = 2

/** The symbols a name in get_context_map's focus names: an id, else every symbol whose row name is it, else every symbol of that plain name. */
function symbolsNamed(db: Database.Database, name: string): string[] {
  if (db.prepare('select 1 from symbol where id = ?').get(name)) return [name]
  const plain = name.slice(Math.max(name.lastIndexOf('.'), name.lastIndexOf(':')) + 1)
  const all = db.prepare(`${SYMBOL_SQL} where s.name = ? and s.kind <> 'module' order by f.path, s.start_line, s.id`).all(plain) as SymbolRow[]
  const exact = all.filter((s) => leanName(s) === name || s.qualified_name === name)
  const hits = exact.length ? exact : name === plain ? all : []
  if (!hits.length) throw new ProofmeshError('NOT_FOUND', `no symbol named ${name} in this snapshot; find_symbols searches by part of a name`)
  return hits.map((s) => s.id)
}

/** trace_paths over this snapshot, and with a workspace over the member sides of its link files too (FR1261, FR1262). */
function tracePaths(ctx: Ctx, input: Record<string, unknown>, ws: Workspace | null): Partial {
  // The snapshot that holds a node or an assertion: this one, or a member's side of the link file.
  const sideOf = (id: string) => (ws && !id.startsWith('ext_') ? ws.sideOf(id) : null)
  const dbOf = (id: string) => sideOf(id)?.db ?? ctx.db
  const end = (id: unknown, file: unknown, name: string) => {
    if (id === undefined && file === undefined) throw new ProofmeshError('INVALID_ARGUMENT', `give ${name}_id or ${name}_path`)
    // A file is traced as its module symbol, from which its top-level calls go.
    if (file !== undefined) { const f = fileAt(ctx, String(file)).id; return fileAlias(ctx.db, f) ?? f }
    if (!ctx.db.prepare('select 1 from symbol where id = ?').get(id) && !sideOf(String(id))) throw new ProofmeshError('NOT_FOUND', `symbol ${String(id)} is not in snapshot ${ctx.snapshot.id}${ws ? ' nor in a linked workspace member' : ''}`)
    return String(id)
  }
  const types = (input.types as string[]) ?? ['calls', ...DISPATCH_TYPES]
  const resolutions = (input.resolutions as string[]) ?? ['resolved']
  // A file and its module symbol are one node (FR090): imports run between files, calls from the module, so a path is
  // traced over both and shows the module symbol.
  const moduleOf = new Map<string, string>(), fileOf = new Map<string, string>()
  if (types.includes('imports')) for (const r of ctx.db.prepare("select id, file_id from symbol where kind = 'module' order by id desc").all() as Array<{ id: string; file_id: string }>) { moduleOf.set(r.file_id, r.id); fileOf.set(r.id, r.file_id) }
  const one = (id: string) => moduleOf.get(id) ?? id
  const source = end(input.source_id, input.source_path, 'source'), target = end(input.target_id, input.target_path, 'target')
  const follow = resolveFollow(ctx.db, input.include_inferred, [source, target].filter((id) => !sideOf(id)))
  const sqlite = new SqliteEdges(ctx.db, follow.on ? (nodes) => candidatesFrom(ctx.db, nodes, types) : undefined)
  const withFiles = (nodes: string[]) => [...nodes, ...nodes.flatMap((n) => fileOf.get(n) ?? [])]
  // A hop into another member: the site's assertion, with the link's basis and the repository it enters.
  const crossing = new Map<string, { basis: Basis }>()
  const edges = {
    outEdges: (nodes: string[], ty: string[], rs: string[]) => {
      const here = nodes.filter((n) => !sideOf(n))
      const out = sqlite.outEdges(withFiles(here), ty, rs).map((e) => ({ ...e, src: one(e.src), dst: one(e.dst) }))
      if (!ws) return out
      // Each member's nodes over its own side, then the links out of every side's nodes, this snapshot's included.
      const bySide = new Map<Side, string[]>()
      for (const n of nodes) { const s = sideOf(n); if (s) bySide.set(s, [...(bySide.get(s) ?? []), n]) }
      for (const [s, ns] of bySide) out.push(...new SqliteEdges(s.db).outEdges(ns, ty, rs))
      const links = [...ws.outbound(ctx.repo.id, ctx.snapshot.id, here, ty), ...[...bySide].flatMap(([s, ns]) => ws.outbound(s.id, s.snapshot_id, ns, ty))]
      for (const l of links) { crossing.set(l.assertion_id, { basis: l.basis }); out.push({ src: l.src, dst: l.target, assertion_id: l.assertion_id }) }
      return out
    },
  }
  const rank = (id: string) => (id.startsWith('as_') ? assertionKey(dbOf(id), id) : nodeKey(dbOf(id), id))
  const t = trace(edges, { source, target, types, resolutions, maxDepth: ctx.limits.max_depth, maxRows: ctx.limits.max_rows, deadline: ctx.started + ctx.limits.timeout_ms, rank })
  // Boundaries and candidate notes are this snapshot's: a member's unresolved sites are its own.
  const expanded = withFiles(t.expanded.filter((n) => !sideOf(n)))
  const boundaries = expanded.length
    // A candidate site the walk followed is no gap in it; one it never follows, for its cap, still is.
    ? boundariesFrom(ctx.db, types, `a.source_id in (${expanded.map(() => '?').join(',')})${follow.on ? ` and not (a.resolution in ('candidate', 'ambiguous') and a.type in (${CANDIDATE_TYPES.map((x) => `'${x}'`).join(',')}) and json_extract(a.detail, '$.more') is null)` : ''}`, ctx.limits.max_rows, ...expanded)
    : NO_BOUNDARIES
  const conclusion = t.paths.length ? 'path_found' : t.stopped_by ? 'no_path_within_bounds' : boundaries.count ? 'no_resolved_path' : 'no_path_exhaustive'
  const limitations = conclusion === 'no_path_within_bounds' ? ['No path was found within the limits. This is not evidence that no path exists.']
    : conclusion === 'no_resolved_path' ? ['Unresolved call sites in the explored region could lead to the target.']
    : conclusion === 'no_path_exhaustive' ? ['Exhaustive only for the declared relationship types and resolutions in this snapshot.', 'Calls made from code outside the repository, such as library callbacks, are not modelled.']
    : []
  const hopType = (a: string) => (dbOf(a).prepare('select type from assertion where id = ?').get(a) as { type: string }).type
  const isDispatch = (type: string) => (DISPATCH_TYPES as readonly string[]).includes(type)
  // Lean states the dispatch caveat only when the path it shows has a dispatch hop, and says when it shows one of several paths.
  if (types.some(isDispatch) && (!ctx.lean || !!t.paths[0]?.assertions.some((a) => isDispatch(hopType(a))))) limitations.push('implements and overrides hops run both ways: a call to an interface or virtual member may dispatch to any implementation, and the path shows the one found.')
  limitations.push(...leanReferencesNote(ctx, types))
  limitations.push(...inferredNotes(follow, sitesNaming(ctx.db, expanded, types, 'src'), 2))
  if (ctx.lean && t.paths.length > 1) limitations.push(`${t.paths.length - 1} other shortest path${t.paths.length === 2 ? '' : 's'} of the same length; envelope compact lists them.`)
  if (ws) limitations.push(...ws.limitations, 'A hop into another repository follows its sealed package_symbol link from the call site; dispatch is not followed across repositories. Nodes of another repository carry it; their ids and evidence are of its snapshot.')
  const ids = new Set<string>([source, target, ...t.paths.flatMap((p) => p.nodes), ...t.horizon.map((h) => h.id), ...boundaries.items.map((b) => b.from_id), ...t.explored.flatMap((e) => [e.from, e.to])])
  const nodes: Record<string, unknown> = {}
  for (const id of [...ids].sort(byKey((i) => nodeKey(dbOf(i), i)))) {
    const db = dbOf(id), side = sideOf(id), repository = side ? { repository: { id: side.id, name: side.name, commit: side.commit } } : {}
    const s = db.prepare(`${SYMBOL_SQL} where s.id = ?`).get(id) as SymbolRow | undefined
    if (s) { nodes[id] = { kind: s.kind, name: s.name, qualified_name: s.qualified_name, path: s.path, start_line: s.start_line, ...repository }; continue }
    const x = db.prepare('select module, name from external_symbol where id = ?').get(id) as { module: string; name: string } | undefined
    if (x) { nodes[id] = { kind: 'external', name: x.name, qualified_name: `${x.module}:${x.name}`, path: x.module, start_line: 0 }; continue }
    // A file with no module symbol, such as an imported JSON file.
    const f = db.prepare('select path from file where id = ?').get(id) as { path: string } | undefined
    if (f) nodes[id] = { kind: 'file', name: f.path.slice(f.path.lastIndexOf('/') + 1), qualified_name: f.path, path: f.path, start_line: 1, ...repository }
  }
  const relationships: Record<string, unknown> = {}
  const hopBasis = new Map<string, Basis>()
  // A hop of a path carries its call site, so a reader sees each hop's proof with no request per hop (FR1185).
  const onPath = new Set(t.paths.flatMap((p) => p.assertions))
  for (const id of [...new Set([...t.paths.flatMap((p) => p.assertions), ...t.explored.map((e) => e.assertion_id)])].sort(byKey((i) => assertionKey(dbOf(i), i)))) {
    const a = dbOf(id).prepare('select type, origin, resolution, detail from assertion where id = ?').get(id) as { type: string; origin: string; resolution: string; detail: string | null }
    const across = crossing.get(id)
    const basis = across?.basis ?? basisOf(a) ?? 'observed'
    hopBasis.set(id, basis)
    const site = onPath.has(id) ? siteOf(dbOf(id), id) : null
    relationships[id] = { type: a.type, origin: a.origin, basis, rule: across ? 'package_symbol' : a.detail ? ((JSON.parse(a.detail) as { rule?: string }).rule ?? null) : null, ...(site ? { site: { path: site.path, start_line: site.start_line } } : {}) }
  }
  // A path is inferred when any hop is.
  const paths = t.paths.map((p) => ({ ...p, basis: p.assertions.some((a) => hopBasis.get(a) === 'inferred') ? 'inferred' as const : 'observed' as const }))
  const stop = t.stopped_by ? [t.stopped_by] : []
  // Under the byte budget the explored edges go first, then boundaries, then paths beyond the first: a found path is never cut away.
  const exploredTotal = t.explored.length
  const prune = (data: Record<string, unknown>) => {
    const d = data as { paths: typeof paths; search: { horizon: typeof t.horizon; explored: typeof t.explored; explored_truncated: boolean }; boundaries: Boundary[]; nodes: Record<string, unknown>; relationships: Record<string, unknown> }
    const keep = new Set<string>([source, target, ...d.paths.flatMap((p) => p.nodes), ...d.search.horizon.map((h) => h.id), ...d.boundaries.map((b) => b.from_id), ...d.search.explored.flatMap((e) => [e.from, e.to])])
    const edges = new Set<string>([...d.paths.flatMap((p) => p.assertions), ...d.search.explored.map((e) => e.assertion_id)])
    for (const k of Object.keys(d.nodes)) if (!keep.has(k)) delete d.nodes[k]
    for (const k of Object.keys(d.relationships)) if (!edges.has(k)) delete d.relationships[k]
    if (d.search.explored.length < exploredTotal) d.search.explored_truncated = true
  }
  // The first path's hops, read now: a member's snapshot is closed by the time a lean answer is written.
  const hops = new Map((t.paths[0]?.assertions ?? []).map((a) => [a, { type: hopType(a), site: siteOf(dbOf(a), a) }]))
  return {
    data: { conclusion, paths, search: { levels: t.levels, stopped_by: t.stopped_by, horizon: t.horizon, explored: t.explored, explored_truncated: t.explored_truncated }, boundaries: boundaries.items, nodes, relationships, ...(ws ? { workspace: ws.header } : {}) },
    // The envelope's evidence is this snapshot's; a hop in another repository has its own.
    evidence_ids: [...new Set(t.paths.flatMap((p) => p.assertions.filter((a) => !sideOf(a)).flatMap((a) => siteOf(ctx.db, a).evidence)))].sort(byKey((i) => evidenceKey(ctx.db, i))),
    unresolved: { scope: 'query', items: boundaries.items, count: boundaries.count, by_reason: boundaries.by_reason }, stop_reasons: stop, limitations, shrink: ['search.explored', 'boundaries', 'search.horizon', 'paths'], keep: 1, prune,
    // The first path's hops in order: each node at its call to the next (at its declaration for a dispatch hop), then the target (FR098).
    lean: (data) => {
      const p = (data.paths as typeof paths)[0], nodes = data.nodes as Record<string, { kind: string; name: string; qualified_name: string; path: string; start_line: number; repository?: Inbound['repository'] }>
      return (p?.nodes ?? []).map((id, i) => {
        const n = nodes[id]!, hop = i < p!.assertions.length ? hops.get(p!.assertions[i]!)! : null, type = hop?.type ?? null
        if (n.kind === 'external') return leanRow(n.name, null, null)
        const tags = [...(type !== null && hopBasis.get(p!.assertions[i]!) === 'inferred' ? ['inferred'] : []), ...(n.repository ? [repoTag(n.repository)] : [])]
        if (type === null || isDispatch(type)) return leanRow(leanName(n), n.path, n.start_line, [...(type ? ['dispatch'] : []), ...tags])
        return leanRow(leanName(n), hop!.site.path, hop!.site.start_line, [...(type === 'calls' ? [] : [type]), ...tags])
      })
    },
  }
}

const IMPL: Record<ToolName, (ctx: Ctx, input: Record<string, unknown>) => Partial> = {
  workspace_status(ctx, input) {
    const meta = Object.fromEntries((ctx.db.prepare('select key, value from meta').all() as Array<{ key: string; value: string }>).map((m) => [m.key, m.value]))
    // File rows only when asked: on a large repository they would spend the row budget on unsupported files before anything useful.
    const ask = input.files as { disposition?: string[]; path_prefix?: string } | undefined
    const all = ask
      ? ctx.db.prepare(`select path, disposition, disposition_detail as detail, language, capabilities from file where (? is null or path like ? escape '\\')${ask.disposition ? ` and disposition in (${ask.disposition.map(() => '?').join(',')})` : ''} order by path limit ? offset ?`)
        .all(ask.path_prefix ?? null, ask.path_prefix ? `${ask.path_prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null, ...(ask.disposition ?? []), ctx.limits.max_rows + 1, ctx.page.offset) as Array<{ path: string; disposition: string; detail: string | null; language: string | null; capabilities: string }>
      : []
    const files = all.slice(0, ctx.limits.max_rows).map((f) => ({ ...f, capabilities: JSON.parse(f.capabilities) as Record<string, string> }))
    const groups = new Map<string, { disposition: string; detail: string | null; extension: string; files: number }>()
    for (const f of ctx.db.prepare('select path, disposition, disposition_detail as detail from file').all() as Array<{ path: string; disposition: string; detail: string | null }>) {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1), dot = name.lastIndexOf('.')
      const extension = dot > 0 ? name.slice(dot).toLowerCase() : name
      const key = `${f.disposition}\u0000${f.detail ?? ''}\u0000${extension}`
      const g = groups.get(key) ?? { disposition: f.disposition, detail: f.detail, extension, files: 0 }
      g.files++
      groups.set(key, g)
    }
    // The census is built when the snapshot is (FR136); one sealed before it answers no rows and says so.
    const censusRows = meta.census ? (JSON.parse(meta.census) as Array<{ kind: string; language: string; files: number }>) : []
    const languages = censusRows
    const cycles = (meta.module_cycles ? JSON.parse(meta.module_cycles) : []) as ModuleCycle[]
    const docMentions = { ...mentionCounts(ctx.db), stale: meta.doc_links ? (JSON.parse(meta.doc_links) as { stale: unknown[] }).stale.length : 0 }
    const fileSummary = [...groups.values()].sort((a, b) => b.files - a.files || (a.extension < b.extension ? -1 : 1)).slice(0, 50)
    const failed = lastIndexFailure(ctx.catalog, ctx.repo.id)
    return {
      data: {
        repository: { id: ctx.repo.id, name: ctx.repo.name, git: JSON.parse(meta.git ?? '{"available":false}') },
        adapters: (JSON.parse(meta.adapters ?? '[]') as Array<Record<string, unknown>>).map((a) => ({ id: a.id, version: a.version, protocol_version: a.protocol_version, languages: a.languages })),
        analysis: {
          mode: ctx.snapshot.analysis_mode,
          // The policy the snapshot was built with; null for one sealed before the policy was recorded.
          generated_policy: meta.generated_policy ? (JSON.parse(meta.generated_policy) as Record<string, unknown>) : null,
          config: meta.analysis_config ? (JSON.parse(meta.analysis_config) as Record<string, unknown>) : null,
          generated_sources: ctx.snapshot.analysis_mode === 'trusted_build'
            ? 'Build logic ran, so source generators and build-time code generation took part; generated files on disk are indexed like any other unless an exclusion rule or git ignore leaves them out.'
            : 'No build logic ran, so no source generator or build-time code generation took part: names they would add do not bind and are reported as unresolved. Generated files already on disk are indexed like any other unless an exclusion rule or git ignore leaves them out.',
          dependencies: (JSON.parse(meta.adapters ?? '[]') as Array<{ id: string; analysis_mode?: string; external_inputs?: string[] }>).map((a) => {
            const missing = (a.external_inputs ?? []).filter((i) => i.endsWith(' missing'))
            return { adapter: a.id, analysis_mode: a.analysis_mode ?? ctx.snapshot.analysis_mode, inputs_read: (a.external_inputs ?? []).length - missing.length, inputs_missing: missing.length, missing: missing.slice(0, 20) }
          }),
        },
        files,
        file_summary: fileSummary,
        languages,
        // The FFI seams by mechanism (FR467); empty for a snapshot sealed before the FFI rules, or with none.
        ffi_seams: (meta.ffi_seams ? JSON.parse(meta.ffi_seams) : {}) as Record<string, number>,
        doc_mentions: docMentions,
        hubs: input.include_generated === true ? hubsOf(ctx.db, true) : snapshotSummary(ctx.db, ctx.snapshot.id).hubs,
        module_cycles: cycles,
        jobs: ctx.catalog.openJobs(ctx.repo.id),
        calls: { sites: snapshotSummary(ctx.db, ctx.snapshot.id).call_sites, unresolved: snapshotSummary(ctx.db, ctx.snapshot.id).unresolved_calls.count, by_reason: snapshotSummary(ctx.db, ctx.snapshot.id).unresolved_calls.by_reason, dependency_missing_by_package: snapshotSummary(ctx.db, ctx.snapshot.id).unresolved_calls.dependency_missing_by_package },
      },
      stop_reasons: all.length > ctx.limits.max_rows ? ['max_rows'] : [],
      shrink: ['files', 'hubs'],
      more: all.length > ctx.limits.max_rows,
      limitations: [
        ...(failed ? [`Warning: ${failed.note}; this answer is from snapshot ${ctx.snapshot.id}, which an earlier index published.`] : []),
        ...(docMentions.stale ? [`${docMentions.stale} doc mention${docMentions.stale === 1 ? '' : 's'} name code that was renamed, moved or deleted; find_stale_mentions (profile extra) lists ${docMentions.stale === 1 ? 'it' : 'them'} with ${docMentions.stale === 1 ? 'its' : 'their'} file and line.`] : []),
        ...cycles.map((c) => `Warning: build modules ${c.modules.join(', ')} form a cycle through syntax-tier name matches, and ${c.ecosystem} forbids module cycles; the edges are ${c.edges.map((e) => `${e.from} to ${e.to} (${e.type}, ${e.sites} site${e.sites === 1 ? '' : 's'}, first ${e.path}:${e.line})`).join(', ')}.`),
        ...[generatedLeftOut('hubs', (ctx.db.prepare("select count(*) as n from file where json_extract(capabilities, '$.generated') = 'true'").get() as { n: number }).n, input.include_generated === true)].filter((n): n is string => !!n),
        ...(ask ? [] : ['No file rows were asked for: file_summary groups the files by disposition, reason and extension; pass files to list rows.']),
        ...(!meta.census ? ['This snapshot was sealed before the language census existed, so languages is empty; index again to build it.'] : []),
        ...(meta.census && !censusRows.some((r) => r.kind === 'code' || r.kind === 'template') ? ['No code was recognised in this repository: the rows are data and prose files.'] : []),
        ...(censusRows.at(-1)?.language === 'other' ? [`The languages list ends with an other row that sums ${censusRows.at(-1)!.files} files of the smallest rows beyond the first ${censusRows.length - 1}; the census keeps at most ${censusRows.length} rows.`] : []),
      ],
    }
  },

  find_symbols(ctx, input) {
    const text = String(input.text)
    const escape = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`)
    const lower = text.toLowerCase()
    const kinds = input.kinds as string[] | undefined
    const prefix = input.path_prefix as string | undefined
    // Ranked and limited in SQL: a broad term matches thousands of symbols through their namespace on a large repository.
    const rows = ctx.db.prepare(`${SYMBOL_SQL}
      where s.id in (select symbol_id from symbol_fts where name like @like escape '\\' or qualified_name like @like escape '\\')
      ${kinds ? `and s.kind in (${kinds.map((_, i) => `@k${i}`).join(',')})` : ''}
      ${input.include_tests === false ? `and pm_is_test(f.path, ${rolesSql(ctx.db)}) = 0` : ''}
      ${prefix ? "and f.path like @path escape '\\'" : ''}
      order by case when lower(s.name) = @lower then 0 when lower(s.name) like @prefix escape '\\' then 1 when lower(s.name) like @like escape '\\' then 2 else 3 end,
        case s.kind when 'project' then 0 when 'module' then 2 when 'method' then 3 when 'function' then 3 when 'property' then 3 when 'field' then 3
          when 'constructor' then 3 when 'variable' then 3 else 1 end,
        s.qualified_name, f.path, s.start_line, s.start_byte, s.kind, s.id
      limit @limit offset @offset`).all({ like: `%${escape(text)}%`, prefix: `${escape(lower)}%`, lower, limit: ctx.limits.max_rows + 1, offset: ctx.page.offset, ...(prefix ? { path: `${escape(prefix)}%` } : {}), ...Object.fromEntries((kinds ?? []).map((k, i) => [`k${i}`, k])) }) as SymbolRow[]
    const symbols = withRoles(ctx.db, rows.slice(0, ctx.limits.max_rows).map(publicSymbol))
    // A path prefix that names no indexed file says so, so an empty answer is not read as "no such symbol" (FR015).
    const noPath = prefix !== undefined && !ctx.db.prepare("select 1 from file where disposition = 'indexed' and path like ? escape '\\' limit 1").get(`${escape(prefix)}%`)
    return { data: { symbols }, stop_reasons: rows.length > ctx.limits.max_rows ? ['max_rows'] : [], more: rows.length > ctx.limits.max_rows, shrink: 'symbols', lean: (data) => (data.symbols as typeof symbols).map((sym) => symbolRow(sym, input.include_ids === true)), limitations: [...(input.include_tests === false ? [TEST_FILTER_NOTE] : []), ...(noPath ? [`No indexed file is under path_prefix ${prefix}; the search covered nothing.`] : [])] }
  },

  analyze_impact(ctx, input) {
    const subjects = [...((input.subject_ids as string[] | undefined) ?? []), ...((input.paths as string[] | undefined) ?? []).map((p) => fileAt(ctx, p).id)]
    if (!subjects.length) throw new ProofmeshError('INVALID_ARGUMENT', 'name at least one subject_id or path')
    for (const id of subjects) if (!ctx.db.prepare(`select 1 from ${id.startsWith('ext_') ? 'external_symbol' : id.startsWith('file_') ? 'file' : 'symbol'} where id = ?`).get(id)) throw new ProofmeshError('NOT_FOUND', `symbol ${id} is not in snapshot ${ctx.snapshot.id}`)
    const types = (input.types as string[] | undefined) ?? [...IMPACT_TYPES]
    const follow = resolveFollow(ctx.db, input.include_inferred, subjects)
    const across = input.include_workspace === true
    const { reached_by, sites, ...r } = analyzeImpact(ctx.db, ctx.snapshot.id, subjects, types, ctx.limits.max_depth, across ? Number.MAX_SAFE_INTEGER : ctx.limits.max_rows, undefined, follow.on)
    // FR903: dependents in the other members of this repository's workspaces, through the packages it builds, after the local walk.
    const ws = across ? withWorkspace(ctx.catalog, ctx.repo, ctx.snapshot, ctx.db, (w) => {
      const reached = new Map<string, number>(), { membersOf } = structure(ctx.db, ctx.snapshot.id)
      for (const id of subjects) for (const m of [id, ...(membersOf.get(id) ?? [])]) reached.set(m, 0)
      for (const d of r.dependents) if (!reached.has(d.id)) reached.set(d.id, d.depth)
      return { header: w.header, limitations: w.limitations, ...workspaceDependents(w, reached, types, ctx.limits.max_depth) }
    }) : null
    if (ws) {
      const all: Array<Impact['dependents'][number] & { repository?: WorkspaceDependent['repository'] }> = [...r.dependents, ...ws.dependents]
      all.sort((a, b) => a.depth - b.depth || (a.repository?.name ?? '').localeCompare(b.repository?.name ?? '') || a.qualified_name.localeCompare(b.qualified_name) || a.path.localeCompare(b.path))
      r.dependents = all.slice(0, ctx.limits.max_rows)
      r.totals.dependents += ws.dependents.length
      for (const d of ws.dependents) { r.totals.by_basis[d.basis]++; r.totals.by_depth[String(d.depth)] = (r.totals.by_depth[String(d.depth)] ?? 0) + 1 }
      if (ws.stopped && !r.stopped_by) r.stopped_by = 'max_depth'
    }
    const calls = snapshotSummary(ctx.db, ctx.snapshot.id).unresolved_calls
    // Lean states only what applies to this answer; the tool description carries the standing caveat.
    const limitations = [
      ...(ctx.lean ? [] : ['Potential impact, not a safety proof: only resolved relationships of the listed types are followed.']),
      ...(calls.count ? [`${calls.count} unresolved call site${calls.count === 1 ? '' : 's'} in this snapshot ${calls.count === 1 ? 'has an unknown target and' : 'have unknown targets and'} could also reach these symbols.`] : []),
      ...(r.stopped_by ? [`The search stopped at the ${r.stopped_by === 'max_depth' ? 'depth limit' : 'node budget'}; more code may be affected.`] : []),
      ...inferredNotes(follow, sites, subjects.length),
      ...(!types.includes('imports') && subjects.some((id) => id.startsWith('file_') || fileAlias(ctx.db, id) !== undefined) ? ['A file is reached only through imports; add imports to types for the files that depend on it.'] : []),
      ...leanReferencesNote(ctx, types),
      ...(ws ? [...ws.limitations, ...mismatchNotes(ws.notes), ...(ws.dependents.length ? ['Dependents in other repositories carry their repository; by_project, by_area and by_team count this repository\'s dependents only.'] : [])] : []),
    ]
    const stop: Array<'max_depth' | 'max_rows'> = [...(r.stopped_by === 'max_depth' ? ['max_depth' as const] : []), ...(r.stopped_by === 'node_budget' || r.totals.dependents > ctx.limits.max_rows ? ['max_rows' as const] : [])]
    const rows = impactRows(ctx, r.dependents, reached_by)
    return {
      data: { subjects, types, ...r, dependents: rows, ...(ws ? { workspace: ws.header } : {}) }, stop_reasons: stop, limitations, shrink: 'dependents', total: r.totals.dependents,
      lean: (data) => (data.dependents as typeof rows).map((x) => leanRow(leanName(x), x.site?.path ?? x.path, x.site?.start_line ?? x.line, [`depth=${x.depth}`, ...(x.relationship === 'dispatch' ? ['dispatch'] : types.length > 1 ? [x.relationship] : []), ...('repository' in x && x.repository ? [repoTag(x.repository)] : []), ...(x.basis === 'inferred' ? ['inferred'] : [])])),
    }
  },

  request_index(ctx) {
    const { id, created } = startIndex(ctx)
    return { data: { job: ctx.catalog.job(id)!, started: created }, limitations: created ? [] : ['An index job for this repository is already queued or running; its ID is returned instead of a second job.'] }
  },

  impact_completeness(ctx, input) {
    const root = ctx.repo.root
    const commit = (rev: string) => {
      const g = gitInfo(root, rev)
      if (!g.commit) throw new ProofmeshError('INVALID_ARGUMENT', g.available ? `${rev} names no commit in ${ctx.repo.name}` : `${root} is not the top of a git working tree, so it has no commits`, { detail: 'unknown_commit', rev })
      return g.commit
    }
    const base = commit(String(input.base)), head = input.head === undefined ? null : commit(String(input.head))
    // Each side is the sealed snapshot of its commit, or for the working tree the current snapshot while it matches the tree (FR109).
    const baseRow = ctx.catalog.snapshotOfCommit(ctx.repo.id, base)
    const headRow = head ? ctx.catalog.snapshotOfCommit(ctx.repo.id, head) : ctx.catalog.currentSnapshot(ctx.repo.id)?.id === ctx.snapshot.id && treeFreshness(ctx.db, ctx.dataDir, root, ctx.repo.id).current ? ctx.snapshot : undefined
    const sides = { base: { commit: base, snapshot_id: baseRow?.id ?? null }, head: { commit: head, snapshot_id: headRow?.id ?? null } }
    const zero = { changed_symbols: 0, dependents: 0, changed: 0, tested: 0, neither: 0, by_basis: { observed: 0, inferred: 0 } }
    const missing = [...(headRow ? [] : [head]), ...(baseRow ? [] : [base])]
    if (missing.length) {
      // One index job per repository at a time: the first missing side now, the other on a later call.
      const { id: job, created } = startIndex(ctx, missing[0] ?? undefined)
      const side = missing[0] ?? 'the working tree'
      return {
        data: { ...sides, pending: [{ commit: missing[0]!, job_id: job }], changed: [], totals: zero },
        limitations: [`No snapshot of ${side} yet; ${created ? `index job ${job} builds it` : `index job ${job}, already running, must finish before ${side} can be indexed`}. Call again when get_job reports it finished${missing.length > 1 ? `; ${missing[1] ?? 'the working tree'} is indexed after it` : ''}.`],
        lean: () => [],
      }
    }
    const open = (row: NonNullable<typeof baseRow>) => (row.id === ctx.snapshot.id ? ctx.db : openSnapshot(ctx.catalog, row))
    const baseDb = open(baseRow!), headDb = open(headRow!)
    try {
      const diff = diffLines(root, base, head)
      const read = (db: Database.Database, p: string) => {
        const f = db.prepare('select content_hash from file where path = ?').get(p) as { content_hash: string | null } | undefined
        return f?.content_hash ? ctx.store.read(f.content_hash)?.toString('utf8') : undefined
      }
      const headSnap = { db: headDb, id: headRow!.id, ranges: diff.head }, baseSnap = { db: baseDb, id: baseRow!.id, ranges: diff.base }
      const depth = Number(input.depth ?? 1)
      const includeTests = input.include_tests === true
      // Test code changed by the diff is evidence for the rest, not a changed symbol of its own, unless asked for.
      const done = changedSymbols(headSnap, baseSnap, diff, read).filter((c) => includeTests || !inTestCode(c.snap.db, c.sym, isTestCode))
        .map((c) => complete(c, { head: headSnap, base: baseSnap, depth, includeTests, isTest: isTestCode, read, readHash: (h) => ctx.store.read(h), maxDepth: ctx.limits.max_depth, include: input.include_inferred }))
      const all = done.map((d) => d.changed), stopped = done.reduce((n, d) => n + d.stopped, 0), unfollowed = [...new Set(done.flatMap((d) => d.unfollowed))].sort()
      const deps = all.flatMap((c) => c.dependents)
      const count = (s: string) => deps.filter((x) => x.status === s).length
      const totals = { changed_symbols: all.length, dependents: deps.length, changed: count('changed'), tested: count('tested'), neither: count('neither'), by_basis: byBasis(deps) }
      // Files the diff touches that a side's snapshot does not analyse are named, never dropped.
      const unanalysed = [...new Set([...[...diff.head.keys()].filter((p) => !indexed(headDb, p)), ...[...diff.base.keys()].filter((p) => !indexed(baseDb, p) && !diff.head.has(p))])].sort()
      const end = ctx.page.offset + ctx.limits.max_rows
      return {
        data: { ...sides, pending: [], changed: all.slice(ctx.page.offset, end), totals },
        stop_reasons: all.length > end ? ['max_rows'] : [], more: all.length > end, shrink: 'changed',
        limitations: [
          ...(ctx.lean ? [summaryLine(totals)] : []),
          ...[baseRow!, headRow!].filter((row, i, rows) => row.id !== ctx.snapshot.id && rows.findIndex((x) => x.id === row.id) === i).flatMap((row) => partialLimitations(row.id === baseRow!.id ? baseDb : headDb, row.id)),
          ...inferredNotesFor(done),
          ...(stopped ? [`The test search stopped at the depth limit for ${stopped} row${stopped === 1 ? '' : 's'}; a row marked neither may have a test further away.`] : []),
          ...(unfollowed.length ? [`Calls through interfaces and base classes are not followed for ${unfollowed.join(', ')} code, so a row marked neither may have a test that reaches it by dispatch.`] : []),
          ...(unanalysed.length ? [`The diff touches ${unanalysed.length} file${unanalysed.length === 1 ? '' : 's'} no snapshot analyses, so their changes are not listed: ${unanalysed.slice(0, 20).join(', ')}${unanalysed.length > 20 ? ', ...' : ''}.`] : []),
          ...(ctx.catalog.workspaces().some((w) => w.members.includes(ctx.repo.id)) ? ['Dependents in the other repositories of this workspace are not searched.'] : []),
          ...(ctx.lean ? [] : [
            'Symbols are matched by kind and qualified name, so a rename is one deleted symbol and one added; an edit of only whitespace or comments inside a symbol counts as modified.',
            'Tested means a test executes it by a call, a chain of calls or dispatch, as find_tests finds it; test code is recognised by file convention, project naming and symbol roles.',
          ]),
        ],
        lean: (data) => completenessRows(data.changed as Changed[]),
      }
    } finally {
      for (const db of new Set([baseDb, headDb])) if (db !== ctx.db) db.close()
    }
  },

  get_context_map(ctx, input) {
    const focus = input.focus as { paths?: string[]; symbols?: string[]; base?: string; head?: string }
    const ids: string[] = [], changed = new Set<string>(), limitations: string[] = []
    for (const p of focus.paths ?? []) {
      try { ids.push(fileAt(ctx, p).id) } catch (e) {
        // A file no adapter analyses has an empty map, and the answer says why (FR923).
        if (!(e instanceof ProofmeshError) || e.details.detail !== 'path_not_indexed' || e.details.disposition === 'not found') throw e
        limitations.push(`${String(e.details.path)} is ${String(e.details.disposition)} in snapshot ${ctx.snapshot.id}, so it has no declarations to map.`)
      }
    }
    for (const name of focus.symbols ?? []) ids.push(...symbolsNamed(ctx.db, name))
    if (focus.base !== undefined) {
      const root = ctx.repo.root
      const commit = (rev: string) => {
        const g = gitInfo(root, rev)
        if (!g.commit) throw new ProofmeshError('INVALID_ARGUMENT', g.available ? `${rev} names no commit in ${ctx.repo.name}` : `${root} is not the top of a git working tree, so it has no commits`, { detail: 'unknown_commit', rev })
        return g.commit
      }
      const base = commit(focus.base), head = focus.head === undefined ? null : commit(focus.head)
      const text = (p: string) => { const f = ctx.db.prepare('select content_hash from file where path = ?').get(p) as { content_hash: string | null } | undefined; return f?.content_hash ? ctx.store.read(f.content_hash)?.toString('utf8') : undefined }
      // The changed lines are placed on this snapshot's declarations: the declarations of head, or of the working tree with no head.
      const diff = diffLines(root, base, head)
      // A declaration that only lost lines has none on the head side: the head line at its gap places it.
      // shortcut: a gap at a declaration's first or last line can fall on its neighbour; read the base side's declarations if that misleads.
      const lines = new Map(diff.head)
      for (const [p, rs] of diff.gaps) lines.set(p, [...(lines.get(p) ?? []), ...rs])
      for (const s of touched(ctx.db, lines, text)) { ids.push(s.id); changed.add(s.id) }
      const snapCommit = (JSON.parse((ctx.db.prepare("select value from meta where key = 'git'").get() as { value: string } | undefined)?.value ?? '{}') as { commit?: string }).commit
      if (head ? snapCommit !== head : !treeFreshness(ctx.db, ctx.dataDir, root).current) limitations.push(`Snapshot ${ctx.snapshot.id} is not of ${head ?? 'the working tree'}, so changed lines may fall on other declarations than they changed; index ${head ? 'that commit' : 'again'} first.`)
      if (!changed.size) limitations.push(`The diff from ${focus.base} changes no declaration this snapshot holds.`)
    }
    if (!ids.length && !limitations.length) throw new ProofmeshError('INVALID_ARGUMENT', 'focus names nothing: give paths, symbols, or base')
    const rows = contextMap(ctx.db, ids, changed, Number(input.max_depth ?? CONTEXT_DEPTH))
    const end = ctx.page.offset + ctx.limits.max_rows
    return {
      data: { rows: rows.slice(ctx.page.offset, end).map(({ direction: _d, weight: _w, inferred, ...r }) => ({ ...r, ...(inferred ? { basis: 'inferred' } : {}) })), totals: { rows: rows.length } },
      stop_reasons: rows.length > end ? ['max_rows'] : [], more: rows.length > end, shrink: 'rows', keep: 1, limitations,
      lean: (data) => (data.rows as Array<{ name: string; path: string; line: number; relation: string; depth: number; basis?: string }>).map((r) => leanRow(r.name, r.path, r.line, [r.relation, `depth=${r.depth}`, ...(r.basis ? ['inferred'] : [])])),
    }
  },

  get_symbols_at(ctx, input) {
    const all = input.locations as string[]
    if (all.length > MAX_LOCATIONS) throw new ProofmeshError('INVALID_ARGUMENT', `get_symbols_at takes at most ${MAX_LOCATIONS} locations per call; ${all.length} were given`, { detail: 'too_many_locations', limit: MAX_LOCATIONS })
    // max_rows or max_bytes may answer fewer than were asked: the cursor continues with the rest, in order.
    const end = ctx.page.offset + ctx.limits.max_rows, asked = all.slice(ctx.page.offset, end)
    type At = { id: string; kind: string; name: string; qualified_name: string; stable_key: string; path: string; start_line: number; end_line: number; extractor: string }
    const files = new Map<string, At[]>()
    let column = false
    const results = asked.map((location) => {
      const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(location)
      // The input schema holds every location to path:line, so the pattern matches.
      column ||= m![3] !== undefined
      const line = Number(m![2])
      let file: { id: string; path: string }
      try {
        file = fileAt(ctx, m![1]!)
      } catch (e) {
        if (!(e instanceof ProofmeshError) || e.code !== 'INVALID_ARGUMENT') throw e
        const disposition = e.details.disposition as string | undefined
        if (e.details.detail === 'path_outside_repository') return { location, symbol: null, error: { code: 'path_outside_repository', message: e.message } }
        if (disposition === 'not found') return { location, symbol: null, error: { code: 'not_found', message: `${m![1]} is not a file of snapshot ${ctx.snapshot.id}` } }
        return { location, symbol: null, disposition: disposition!, reason: 'not_indexed' }
      }
      let syms = files.get(file.id)
      if (!syms) files.set(file.id, syms = ctx.db.prepare('select s.id, s.kind, s.name, s.qualified_name, s.stable_key, f.path, s.start_line, s.end_line, ev.extractor from symbol s join file f on f.id = s.file_id join evidence ev on ev.id = s.evidence_id where s.file_id = ?').all(file.id) as At[])
      if (!syms.length) return { location, symbol: null, reason: 'no_symbol' }
      if (line < 1 || line > Math.max(...syms.map((s) => s.end_line))) return { location, symbol: null, error: { code: 'line_out_of_range', message: `${file.path} has no line ${line}` } }
      const hit = innermost(syms.filter((s) => s.kind !== 'module'), line) ?? syms.find((s) => s.kind === 'module')
      if (!hit) return { location, symbol: null, reason: 'no_symbol' }
      const { extractor, ...rest } = hit
      return { location, symbol: { ...rest, tier: extractor === 'scip' ? 'scip' : extractor === 'syntax' ? 'syntax' : 'precise' } }
    })
    return {
      data: { results }, stop_reasons: all.length > end ? ['max_rows'] : [], more: all.length > end, shrink: 'results',
      limitations: column ? ['A location with a column is answered by its line only.'] : [],
      lean: (data) => (data.results as typeof results).map((r) => {
        const s = r.symbol as { kind: string; name: string; qualified_name: string; path: string; start_line: number } | null
        const reason = 'error' in r ? r.error!.code : 'reason' in r ? r.reason : undefined
        return `${quote(r.location)} ${s ? symbolRow(s as never) : `- ${reason}`}`
      }),
    }
  },

  get_job(ctx, input) {
    const job = ctx.catalog.job(String(input.job_id))
    if (!job || job.repository_id !== ctx.repo.id) throw new ProofmeshError('NOT_FOUND', `no index job ${String(input.job_id)} for this repository`)
    return { data: { job }, limitations: job.state === 'interrupted' ? ['The process running this job stopped before finishing; request a new index.'] : [] }
  },

  plan_rename(ctx, input) {
    if (input.subject_id === undefined) throw new ProofmeshError('INVALID_ARGUMENT', 'give subject_id or key')
    const id = String(input.subject_id)
    if (!ctx.db.prepare("select 1 from symbol where id = ? and kind <> 'module'").get(id)) throw new ProofmeshError('NOT_FOUND', `${id} is no symbol of snapshot ${ctx.snapshot.id}; plan_rename takes a symbol, not a file`)
    const p = planRename(ctx.db, ctx.store, id, ctx.started + ctx.limits.timeout_ms)
    const s = p.subject, newName = String(input.new_name)
    const row = (x: typeof s) => ({ id: x.id, key: x.key, name: x.name, kind: x.kind, path: x.path, line: p.declared.get(x.id) ?? x.start_line })
    // A name the new one would collide with: a symbol of that name in the container of the subject or of a member renamed with it,
    // or at the top of the same file.
    const named = ctx.db.prepare('select f.path, s.start_line as line, s.kind from symbol s join file f on f.id = s.file_id where s.qualified_name = ? order by f.path, s.start_line')
    const clash = [s, ...p.group].flatMap((m) => named.all(`${m.qualified_name.slice(0, (m.qualified_name.includes('.') ? m.qualified_name.lastIndexOf('.') : m.qualified_name.indexOf(':')) + 1)}${newName}`) as Array<{ path: string; line: number; kind: string }>)
    const entry = publicEntry(ctx.db, ctx.store, [...(p.exported ? [s.path] : []), ...p.carriers])
    // FR985: with include_workspace, the sites in the other repositories of this repository's workspaces that reach it through a package
    // it builds, from the sealed link file (FR902), each with its repository; observed when the installed version is the built one.
    const across = input.include_workspace === true
      ? withWorkspace(ctx.catalog, ctx.repo, ctx.snapshot, ctx.db, (w) => ({ linked: w.header.some((h) => h.link_file_id), limitations: w.limitations, rows: w.inbound([s.id, ...p.group.map((g) => g.id)], ['calls', 'references', 'inherits', 'implements']) }))
      : null
    for (const r of across?.rows ?? []) p.sites.push({ path: r.site.path, line: r.site.start_line, kind: r.type === 'calls' ? 'call' : 'reference', basis: r.basis === 'observed' ? 'observed' : 'inferred', key: r.target === s.id ? s.key : p.group.find((g) => g.id === r.target)?.key ?? s.key, repository: r.repository })
    const observed = p.sites.filter((x) => x.basis === 'observed').length
    const sites = p.sites.slice(0, ctx.limits.max_rows)
    return {
      data: {
        subject: row(s), new_name: newName, sites, must_rename_together: p.group.map((g) => ({ ...row(g), relationship: g.relationship })),
        possibly_affected: p.possibly.slice(0, ctx.limits.max_rows),
        counts: { observed, inferred: p.sites.length - observed, must_rename_together: p.group.length, possibly_affected: p.possibly.length },
      },
      stop_reasons: [...(p.sites.length > sites.length || p.possibly.length > ctx.limits.max_rows ? ['max_rows' as const] : []), ...(p.stopped ? ['timeout' as const] : [])],
      shrink: ['possibly_affected', 'sites'],
      limitations: [
        'A plan only: no file is changed. An observed site is one the compiler or the syntax bound to the symbol; an inferred site is a seam a rule or a string binds by name (route, rpc, graphql, ffi, di_key, serialised_key, doc_mention) and needs review before it is changed.',
        ...(p.possibly.length ? [`${p.possibly.length} call${p.possibly.length === 1 ? '' : 's'} that did not resolve, or resolved to several candidates, might reach ${s.name}; they are listed under possibly_affected, not as sites.`] : []),
        ...(entry && !across?.linked ? ['public export: consumers outside this repository are not listed', `${s.name} is exported from ${entry}, a public entry of its package; with include_workspace, a linked workspace's other repositories that call or name it are listed too.`] : []),
        ...(entry && across?.linked ? [`${s.name} is exported from ${entry}; the sites listed with a repository are its calls and references in this repository's workspaces, from their sealed link file. Their import specifiers are not listed, nor any consumer outside the workspaces.`] : []),
        ...(across?.limitations ?? []),
        ...(clash.length ? [`${newName} already names ${clash.map((c) => `a ${c.kind} at ${c.path}:${c.line}`).join(', ')} in the same scope.`] : []),
        ...(p.stopped ? ['The scan of string literals stopped at the time limit; string seams in later files are not listed.'] : []),
      ],
    }
  },

  find_stale_mentions(ctx, input) {
    const prefix = String(input.path_prefix ?? '')
    const meta = ctx.db.prepare("select value from meta where key = 'doc_links'").get() as { value: string } | undefined
    const all = (meta ? (JSON.parse(meta.value) as { stale: Array<{ path: string }> }).stale : []).filter((m) => m.path.startsWith(prefix))
    return {
      data: { mentions: all.slice(0, ctx.limits.max_rows), total: all.length }, stop_reasons: all.length > ctx.limits.max_rows ? ['max_rows'] : [], shrink: 'mentions',
      limitations: [
        'A mention is a Markdown doc\'s inline code or link matched to code by name, never proved, so every one is inferred. It is stale when it resolved in an earlier snapshot and names nothing now: renamed, moved or moved_renamed when one removed and one added symbol share a body hash, as compare_snapshots pairs them, else deleted. It stays listed until the doc is changed to name real code.',
        ...(meta ? [] : ['This snapshot was sealed before doc mentions were recorded (format 0.12); index again to find them.']),
      ],
    }
  },

  compare_snapshots(ctx, input) {
    const base = ctx.catalog.snapshot(String(input.base_snapshot_id))
    if (!base || base.repository_id !== ctx.repo.id) throw new ProofmeshError('INVALID_ARGUMENT', 'base_snapshot_id must name a snapshot of the same repository', { detail: 'base_not_in_repository' })
    // The base is attached as a second sealed file, read only, like the head (D03).
    const db = openSnapshot(ctx.catalog, base)
    try {
      const r = compare(db, ctx.db, { base: { id: base.id, published_at: base.published_at! }, head: { id: ctx.snapshot.id, published_at: ctx.snapshot.published_at! } }, ctx.limits.max_rows)
      // Each side's rows are tagged from the snapshot they came from: removed ones from the base, added and changed ones from the head.
      const [was, now] = [generatedPaths(db), generatedPaths(ctx.db)]
      const { symbols, files } = r.data as { symbols: { added: unknown; removed: unknown; changed: unknown; paired: Array<{ base: unknown; head: unknown }>; ambiguous: Array<{ removed: unknown; added: unknown }> }; files: { disposition_changes: Array<{ path: string; generated?: boolean }> } }
      markGenerated(symbols.removed, was); markGenerated(symbols.added, now); markGenerated(symbols.changed, now)
      for (const p of symbols.paired) { markGenerated(p.base, was); markGenerated(p.head, now) }
      for (const a of symbols.ambiguous) { markGenerated(a.removed, was); markGenerated(a.added, now) }
      const inHead = (p: string) => !!ctx.db.prepare('select 1 from file where path = ?').get(p)
      for (const c of files.disposition_changes) if ((inHead(c.path) ? now : was).has(c.path)) c.generated = true
      return { data: r.data, stop_reasons: r.truncated ? ['max_rows'] : [], limitations: [...partialLimitations(db, base.id), 'Symbols are matched by kind and qualified name; a removed and an added symbol that match by body hash are paired instead.', ...r.limitations] }
    } finally {
      db.close()
    }
  },

  list_queries(ctx, input) {
    const limit = Math.min(Number(input.limit ?? 50), ctx.limits.max_rows)
    const tools = toolCatalog()
    const all = ctx.catalog.queryRecords({ repository_id: ctx.repo.id, tool: input.tool as string | undefined, limit: limit + 1 })
    const records = all.slice(0, limit)
    return { data: { tools, contract: CONTRACT, records }, stop_reasons: all.length > limit ? ['max_rows'] : [], limitations: ['Records hold the hash of each query input, never its text or its result.', PROFILES_NOTE] }
  },

  get_session_trail(ctx, input) {
    const { entries, cut } = ctx.catalog.trail(String(input.session_id), ctx.repo.id)
    const recording = ctx.catalog.trailRecording(ctx.repo.id)
    // A failed or denied call was attempted, not done. A search covers the files under the path it searched; a search of the whole
    // repository (.) covers no file in particular, since the trail keeps no matches.
    const done = entries.filter((e) => e.outcome === 'ok')
    const covers = (kind: string, d: { id: string; path: string }) => done.some((e) => e.kind === kind && (e.symbol_id === d.id || (e.path !== undefined && (d.path === e.path || d.path.startsWith(`${e.path}/`)))))
    const paths = [...new Set(done.flatMap((e) => (e.kind === 'changed' && e.path !== undefined ? [e.path] : [])))]
    const symbols = paths.flatMap((p) => ctx.db.prepare("select s.id, s.kind, s.name, s.qualified_name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where f.path = ? and s.kind <> 'module' order by s.start_byte, s.id").all(p) as Array<{ id: string; kind: string; name: string; qualified_name: string; path: string; line: number }>)
    const missing = paths.filter((p) => !ctx.db.prepare('select 1 from file where path = ?').get(p))
    type Row = { id: string; kind: string; name: string; qualified_name: string; path: string; line: number; depth: number }
    let stopped = false
    const changed = symbols.map((s) => {
      const { dependents, reached_by, stopped_by } = analyzeImpact(ctx.db, ctx.snapshot.id, [s.id], IMPACT_TYPES, ctx.limits.max_depth, ctx.limits.max_rows)
      stopped ||= stopped_by !== null
      // The site of the use that reaches the change, as an impact row gives it; a peer reached through dispatch has its declaration.
      const row = (d: Impact['dependents'][number]): Row => {
        const via = reached_by.get(d.id), site = via ? siteOf(ctx.db, via) : null
        return { id: d.id, kind: d.kind, name: d.name, qualified_name: d.qualified_name, path: site?.path ?? d.path, line: site?.start_line ?? (ctx.db.prepare('select start_line from symbol where id = ?').get(d.id) as { start_line: number }).start_line, depth: d.depth }
      }
      const unopened = dependents.filter((d) => !covers('opened', d))
      return { ...s, never_seen: unopened.filter((d) => !covers('searched', d)).map(row), searched_only: unopened.filter((d) => covers('searched', d)).map(row) }
    })
    const lastChange = done.filter((e) => e.kind === 'changed').at(-1)?.at
    const entryRow = (e: (typeof entries)[number]) => [e.seq, e.kind, e.tool, quote(e.path ?? e.symbol_id ?? '-'), ...(e.outcome === 'failed' ? ['failed'] : []), ...(e.agent_id ? [`agent=${e.agent_id}`] : [])].join(' ')
    const rows = (list: Row[], tag: string) => list.map((d) => leanRow(leanName(d), d.path, d.line, [tag, `depth=${d.depth}`]))
    return {
      data: { session_id: String(input.session_id), recording, cut, entries, changed },
      shrink: ['entries', 'changed'],
      limitations: [
        ...(recording ? [] : [`Session trail recording is off for ${ctx.repo.name}; a person turns it on with proofmesh trail on ${ctx.repo.id}, and the Claude Code plugin then records its sessions.`]),
        ...(cut ? ['The trail was cut at 10,000 entries; later steps of the session were not recorded.'] : []),
        ...(lastChange && ctx.snapshot.published_at && ctx.snapshot.published_at < lastChange ? [`Snapshot ${ctx.snapshot.id} was published before the session's last change (${lastChange}); index again for the dependents of the code as it was changed.`] : []),
        ...(missing.length ? [`${missing.length} changed file${missing.length === 1 ? ' is' : 's are'} not in this snapshot: ${missing.slice(0, 20).join(', ')}.`] : []),
        ...(stopped ? ['The impact search stopped at a limit for a changed symbol; more dependents may exist.'] : []),
        'A dependent counts as opened when a successful opened entry names its file or its symbol; a search covers the files under the path it searched, and a search of the whole repository covers none, since the trail keeps no matches. Of the steps taken through Bash, only a plain cat, head, tail, sed -n, grep, rg or find command that names its paths is recorded.',
      ],
      lean: (data) => [
        ...(data.entries as typeof entries).map(entryRow),
        ...(data.changed as typeof changed).flatMap((c) => [leanRow(leanName(c), c.path, c.line, ['changed']), ...rows(c.never_seen, 'never_seen'), ...rows(c.searched_only, 'searched_only')]),
      ],
    }
  },

  prepare_verification(ctx, input) {
    const v = prepare(ctx.catalog, ctx.repo.id, ctx.snapshot.id, input as Parameters<typeof prepare>[3], 'tool')
    return { data: { verification: { ...v, record_valid: null }, next: `A person reads the binding, then: proofmesh verification approve ${v.id} && proofmesh verification run ${v.id}` }, limitations: ['Nothing has run. Only a person can approve, once, and run it; the run happens outside the query service in a disposable copy of the snapshot.'] }
  },

  get_verification(ctx, input) {
    requireEnabled(ctx.catalog)
    const v = ctx.catalog.verification(String(input.verification_id))
    if (!v || v.repository_id !== ctx.repo.id) throw new ProofmeshError('NOT_FOUND', `no verification ${String(input.verification_id)} for this repository`)
    const log = path.join(ctx.dataDir, 'verification', v.id, 'output.log')
    const record = v.record as { record: RunRecord; mac: string } | null
    return {
      data: { verification: { ...v, record_valid: record ? verifyRecord(ctx.dataDir, record) : null }, output: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null },
      limitations: record?.record.sandbox === 'process' ? ['The run was a plain process with limits on time and output; network and filesystem policy were not enforced by a sandbox. Run with --container for isolation.'] : [],
    }
  },

  get_claims(ctx) {
    const all = ctx.catalog.claims()
    return { data: { claims: all.slice(0, ctx.limits.max_rows) }, stop_reasons: all.length > ctx.limits.max_rows ? ['max_rows'] : [], shrink: 'claims', limitations: ['A verdict holds for the snapshot it names; verify again to check it against the current one.'] }
  },

  verify_claim(ctx, input) {
    let claimId = input.claim_id as string | undefined
    if (!claimId) {
      const c = input.claim as { statement: string; proposition: Proposition } | undefined
      if (!c) throw new ProofmeshError('INVALID_ARGUMENT', 'give a structured claim or a stored claim_id')
      claimId = ctx.catalog.storeClaim(c.statement, c.proposition)
    }
    const stored = ctx.catalog.claim(claimId)
    if (!stored) throw new ProofmeshError('NOT_FOUND', `no stored claim ${claimId}`)
    const r = verify(ctx.db, ctx.store, stored.proposition as Proposition, { maxDepth: ctx.limits.max_depth, maxRows: ctx.limits.max_rows, deadline: ctx.started + ctx.limits.timeout_ms }, { snapshot: ctx.snapshot.id, current: ctx.catalog.currentSnapshot(ctx.repo.id)?.id ?? null })
    const runId = ctx.catalog.recordVerification(claimId, ctx.snapshot.id, r.verdict, r.layers, r.dependencies)
    return {
      data: { claim_id: claimId, run_id: runId, statement: stored.statement, proposition: stored.proposition, verdict: r.verdict, layers: r.layers, dependencies: r.dependencies },
      evidence_ids: r.dependencies.evidence, limitations: r.limitations,
    }
  },

  save_memory(ctx, input) {
    const id = String(input.id), refs = (input.nodes as string[] | undefined) ?? []
    if (!(NOTE_KINDS as readonly string[]).includes(String(input.kind))) throw new ProofmeshError('INVALID_ARGUMENT', `kind must be one of ${NOTE_KINDS.join(', ')}`)
    ctx.catalog.saveAgentNote({ id, title: String(input.title), kind: String(input.kind), refs, body: String(input.body) })
    const missing = refs.filter((r) => !resolveRef(ctx.db, r))
    return {
      data: { id, staleness: 'unaccepted', missing_refs: missing },
      limitations: ['A saved note is a proposal: get_memory reports it as unaccepted until a person accepts it with proofmesh notes accept.', ...(missing.length ? [`${missing.length} reference(s) do not resolve in this snapshot.`] : [])],
    }
  },

  get_memory(ctx, input) {
    // A path names its file's module symbol; a file without one matches no note.
    const symbolId = input.path !== undefined ? (fileAlias(ctx.db, fileAt(ctx, String(input.path)).id) ?? '') : (input.symbol_id as string | undefined)
    const q = (input.query as string | undefined)?.toLowerCase()
    const all = ctx.catalog.notes()
    const matching = all.filter((n) => {
      if (symbolId !== undefined && !n.refs.some((r) => resolveRefs(ctx.db, r).includes(symbolId))) return false
      if (q && !`${n.title}\n${n.body}\n${n.refs.join('\n')}`.toLowerCase().includes(q)) return false
      return true
    })
    const notes = matching.slice(0, ctx.limits.max_rows).map((n) => {
      const missing = n.refs.filter((r) => !resolveRefs(ctx.db, r).length)
      const ambiguous = n.refs.flatMap((r) => { const hits = resolveRefs(ctx.db, r); return hits.length > 1 ? [{ ref: r, keys: hits.map((h) => (ctx.db.prepare('select stable_key from symbol where id = ?').get(h) as { stable_key: string }).stable_key).sort() }] : [] })
      return { id: n.id, title: n.title, kind: n.kind, status: n.status, target: n.target, refs: n.refs, missing_refs: missing, ambiguous_refs: ambiguous, staleness: staleness(ctx.db, n.refs, n.fingerprint, ambiguous.length > 0), accepted_by: n.accepted_by, accepted_at: n.accepted_at, sources: n.sources, body: n.body.length > 4000 ? `${n.body.slice(0, 4000)}…` : n.body }
    })
    const limitations = [
      'Notes are curated by people; a note marked changed describes code whose relationships moved since it was accepted, and may be out of date. One marked tier_changed describes code whose file was analysed by another tier since, with its content unchanged.',
      ...(notes.some((n) => n.missing_refs.length) ? ['With snapshot format 0.8, qualified names changed (FR146): a reference written in the older form (Java, Kotlin, Scala and PHP names started with the file path; Go and Rust members lacked their receiver or impl type) no longer matches. Rewrite it with the qualified name find_symbols or get_symbol shows.'] : []),
      ...(all.length === 0 ? ['No notes are synced in this workspace; a person adds a notes directory with proofmesh notes add and syncs it.'] : []),
    ]
    return { data: { notes, total: matching.length }, stop_reasons: matching.length > ctx.limits.max_rows ? ['max_rows'] : [], limitations, shrink: 'notes' }
  },

  search_sources(ctx, input) {
    if ((input.mode ?? 'lexical') !== 'lexical') throw new ProofmeshError('INVALID_ARGUMENT', 'only lexical search is available in this version; semantic candidates are optional and not installed', { detail: 'semantic_unavailable' })
    const r = searchSources(ctx.db, ctx.store, { text: String(input.text), caseSensitive: input.case_sensitive === true, pathPrefix: input.path_prefix as string | undefined, maxRows: ctx.limits.max_rows, maxBytes: ctx.limits.max_bytes, deadline: ctx.started + ctx.limits.timeout_ms, fileOffset: ctx.page.offset })
    const scanned = ctx.page.offset + r.files_scanned
    const limitations: string[] = [
      'Lexical matches in the indexed files of this snapshot, not a semantic search.',
      ...(r.stopped === 'timeout' ? [`The scan stopped at the time limit after ${scanned} of ${r.files_total} files; at this call's rate the rest takes about ${r.files_scanned ? Math.ceil((r.files_total - scanned) / r.files_scanned) : 'many'} more call${r.files_scanned && Math.ceil((r.files_total - scanned) / r.files_scanned) === 1 ? '' : 's'}, so a local text search of the working tree may be faster.`] : []),
      ...(r.overflow ? [`${r.overflow} has more matches than one page holds; only its first ${r.hits.length} are listed.`] : []),
    ]
    const notes = notesMatching(ctx.catalog.notes(), String(input.text))
    for (const n of notes) limitations.push(`Note ${n.id} says ${n.target ?? 'the code it names'} writes text like this (pattern ${n.pattern}): look for its callers, since the text itself may appear nowhere in source.`)
    // The scan budgets rows and bytes itself, file by file, so the page is whole files and the cursor continues at the next.
    const data = { hits: r.hits, files_scanned: scanned, files_total: r.files_total, ...(notes.length ? { notes } : {}) }
    const result: Partial = { data, stop_reasons: r.stopped ? [r.stopped] : [], limitations, next_offset: r.next_offset, shrink: 'hits', keep: 1 }
    // A hit the byte budget drops takes its whole file with it, and the cursor continues at that file: no hit is skipped or repeated.
    // The first file is never cut: a page continues at a file, so cutting inside it would skip the hits cut (FR368).
    result.prune = (d) => {
      const hits = d.hits as unknown[]
      const dropped = r.hit_files[hits.length]!
      if (r.hit_files[0] === dropped) throw new ProofmeshError('INVALID_ARGUMENT', `max_bytes ${ctx.limits.max_bytes} is too small for the matches of one file in a search_sources answer; raise it or narrow path_prefix`, { detail: 'max_bytes_too_small', max_bytes: ctx.limits.max_bytes })
      while (hits.length && r.hit_files[hits.length - 1] === dropped) hits.pop()
      d.files_scanned = result.next_offset = dropped
    }
    return result
  },

  search_concepts(ctx, input) {
    // A snapshot sealed before format 0.13 has no term index: said, not answered as if nothing matched.
    if (!ctx.db.prepare("select 1 from sqlite_master where name = 'term'").get()) {
      return { data: { symbols: [], files: [], terms: [] }, limitations: [`Snapshot ${ctx.snapshot.id} was built before concept search had a term index (snapshot format 0.13); index the repository again.`], shrink: 'symbols', lean: () => [] }
    }
    // A ranking, not a listing: 20 rows of each unless max_rows asks for more or fewer.
    const rows = (input.limits as Limits | undefined)?.max_rows ?? Math.min(20, ctx.limits.max_rows)
    const prefix = input.path_prefix as string | undefined
    const r = searchConcepts(ctx.db, { text: String(input.text), kinds: input.kinds as string[] | undefined, pathPrefix: prefix, includeTests: input.include_tests === true, rows: Math.min(rows, ctx.limits.max_rows), generated: generatedPaths(ctx.db) })
    const limitations = [
      ...(r.terms.length ? [] : ['no indexed term matched: no word of the text occurs in the indexed files of this snapshot, so nothing is ranked.']),
      ...(r.terms.length && !r.matched ? [`No indexed file${prefix ? ` under path_prefix ${prefix}` : ''} holds a term of the text, so nothing is ranked.`] : []),
      ...(r.dropped ? [`The text has ${r.terms.length + r.dropped} indexed terms; only the ${MAX_TERMS} heaviest were ranked by, and ${r.dropped} lighter ones were left out.`] : []),
    ]
    const tags = (x: { score: number; terms: string[]; via?: string }) => [`score=${x.score}`, ...(x.terms.length ? [`terms=${x.terms.join(',')}`] : []), ...(x.via ? [`via=${x.via}`] : [])]
    return {
      data: { symbols: r.symbols, files: r.files, terms: r.terms, ...(r.dropped ? { terms_dropped: r.dropped } : {}) }, limitations, shrink: ['files', 'symbols'], keep: 1,
      lean: (data) => [
        ...(data.symbols as typeof r.symbols).map((s) => leanRow(leanName(s), s.path, s.start_line, [s.kind, ...tags(s)])),
        ...(data.files as typeof r.files).map((f) => leanRow(null, f.path, f.line, ['file', ...tags(f)])),
      ],
    }
  },

  find_tests(ctx, input) {
    const ids = [...((input.subject_ids as string[] | undefined) ?? [])]
    for (const id of ids) if (!ctx.db.prepare('select 1 from symbol where id = ?').get(id)) throw new ProofmeshError('NOT_FOUND', `symbol ${id} is not in snapshot ${ctx.snapshot.id}`)
    const files: string[] = []
    for (const raw of (input.paths as string[] | undefined) ?? []) {
      const f = fileAt(ctx, raw)
      const rows = ctx.db.prepare('select s.id from symbol s where s.file_id = ?').all(f.id) as Array<{ id: string }>
      if (!rows.length) throw new ProofmeshError('NOT_FOUND', `no symbols in ${f.path} in snapshot ${ctx.snapshot.id}`)
      ids.push(...rows.map((r) => r.id))
      files.push(f.id)
    }
    if (!ids.length) throw new ProofmeshError('INVALID_ARGUMENT', 'name at least one symbol or path')
    const follow = resolveFollow(ctx.db, input.include_inferred, ids)
    const local = testReach(ctx.db, ctx.snapshot.id, ids, files, (h) => ctx.store.read(h), ctx.limits.max_depth, isTestCode, follow.on)
    // FR1260: with include_workspace, the tests in the other members of this repository's workspaces that reach the subjects through the
    // packages this repository builds, or through a member that reaches them (FR1262): each member's tests of the sites linked to what reaches
    // the subjects, one deeper than that site. Its chain runs in its own repository and ends at the call that crosses out of it.
    type Row = TestRow & { chain: ReturnType<typeof local.chain>; repository?: Inbound['repository'] }
    const ws = input.include_workspace === true ? withWorkspace(ctx.catalog, ctx.repo, ctx.snapshot, ctx.db, (w) => {
      const types = ['calls', ...DISPATCH_TYPES]
      const walk = analyzeImpact(ctx.db, ctx.snapshot.id, ids, types, ctx.limits.max_depth, Number.MAX_SAFE_INTEGER)
      const reached = new Map<string, number>([...ids.map((id) => [id, 0] as const), ...walk.dependents.map((d) => [d.id, d.depth] as const)])
      const across = workspaceDependents(w, reached, types, ctx.limits.max_depth)
      const found = new Map<string, Row>()
      for (const g of across.groups) {
        const side = w.member(g.repository.id, g.snapshot_id)
        const t = testReach(side.db, side.snapshot_id, g.ids, [], (h) => ctx.store.read(h), ctx.limits.max_depth - g.depth, isTestCode)
        const crossing = new Map(g.rows.map((x) => [x.source.key, x.site]))
        for (const row of t.rows) {
          const chain = t.chain(row), last = chain.at(-1), out = last && crossing.get(last.key)
          const x: Row = { ...row, depth: row.depth + g.depth, evidence: row.evidence === 'call' ? 'transitive_call' : row.evidence, basis: g.basis === 'inferred' ? 'inferred' : row.basis, chain: out ? [...chain.slice(0, -1), { ...last!, path: out.path, line: out.start_line }] : chain, repository: g.repository }
          const k = `${g.repository.id}:${row.id}`, had = found.get(k)
          if (!had || had.depth > x.depth || (had.depth === x.depth && had.basis === 'inferred' && x.basis === 'observed')) found.set(k, x)
        }
      }
      const rows = [...found.values()].sort((a, b) => a.depth - b.depth || cmp(a.repository!.name, b.repository!.name) || cmp(a.path, b.path) || a.line - b.line || cmp(a.id, b.id))
      return { header: w.header, limitations: [...w.limitations, ...mismatchNotes(across.notes)], rows, stopped: across.stopped }
    }) : null
    const r = { ...local, rows: [...local.rows.map((t): Row => ({ ...t, chain: local.chain(t) })), ...(ws?.rows ?? [])] }
    const end = ctx.page.offset + ctx.limits.max_rows, executing = r.rows.filter((t) => EXECUTING.has(t.evidence)).length
    // A subject whose file's calls are not resolved has no call to find a test through: say so, since no row would not mean no test.
    // Not for a subject whose candidate calls were followed: it has candidate sites of its own, so some of its calls are read, as inferred (FR205).
    const ownSites = (id: string) => { const n = sitesNaming(ctx.db, [id], ['calls']); return n.followable + n.capped > 0 }
    const noCalls = [...new Set(ids.flatMap((id) => {
      const f = ctx.db.prepare("select f.language, json_extract(f.capabilities, '$.resolved_calls') as calls from symbol s join file f on f.id = s.file_id where s.id = ?").get(id) as { language: string | null; calls: string | null } | undefined
      return f?.language && f.calls === 'unsupported' && !(follow.on && ownSites(id)) ? [ADAPTER_LANGUAGE_NAMES[f.language] ?? f.language] : []
    }))].sort()
    const byProject = new Map<string, number>()
    for (const t of local.rows) byProject.set(t.project ?? '(no project)', (byProject.get(t.project ?? '(no project)') ?? 0) + 1)
    // Lean states only what applies to this answer; the tool description carries the standing caveats.
    const limitations = [
      ...(ctx.lean ? [] : [
        'Static reach only: tests that reach the code through unresolved calls, reflection, or configuration are missed.',
        `Test code is recognised ${TEST_RECOGNISED}.`,
        'In a file whose adapter sent no test roles (TypeScript, JavaScript, a language with no markers, a file with no test attribute or marker), every symbol in test code counts as a test, so a helper there, such as a fixture builder or a beforeEach body, is listed as one.',
      ]),
      ...(noCalls.length ? [`Calls in ${noCalls.join(' and ')} are not resolved yet, so no test is listed as executing code in ${noCalls.length === 1 ? 'it' : 'them'}; a test that calls it is not found.`] : []),
      ...(r.unfollowed.length ? [`In this snapshot, calls through interfaces and base classes are not followed for ${r.unfollowed.join(', ')} code, so a test that reaches a member only by dispatch is missed.`] : []),
      ...(follow.on ? inferredNotes(follow, r.sites, ids.length) : r.ambiguous ? [`${r.ambiguous} call site${r.ambiguous === 1 ? '' : 's'} with no single resolved target name${r.ambiguous === 1 ? 's' : ''} code on these paths as a candidate; a test that reaches the subject only through one is not listed.`] : []),
      ...(r.rows.some((t) => t.evidence === 'import_only') ? ['An import_only row is a test file that imports the subject by name, its whole module, or for a file subject the file, and in which nothing calls or references it.'] : []),
      ...(ws ? [...ws.limitations, ...(ws.rows.length ? ['Tests in other repositories carry their repository; by_project counts this repository\'s tests only.'] : [])]
        : ctx.catalog.workspaces().some((w) => w.members.includes(ctx.repo.id)) ? ['Tests in the other repositories of this workspace are not searched.'] : []),
      ...(r.stopped_by || ws?.stopped ? [`The search stopped at the ${r.stopped_by === 'node_budget' ? 'node budget' : 'depth limit'}; more tests may reach this code.`] : []),
    ]
    const stopped = r.stopped_by ?? (ws?.stopped ? 'max_depth' : null)
    return {
      data: {
        tests: r.rows.slice(ctx.page.offset, end),
        totals: { tests: r.rows.length, executing, not_executing: r.rows.length - executing, by_basis: byBasis(r.rows), by_project: [...byProject].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name, count]) => ({ name, count })) },
        observed: { available: false, reason: 'No coverage data has been imported for this snapshot.' }, stopped_by: stopped, ...(ws ? { workspace: ws.header } : {}),
      },
      stop_reasons: [...(stopped === 'max_depth' ? ['max_depth' as const] : []), ...(r.rows.length > end ? ['max_rows' as const] : [])], more: r.rows.length > end, limitations, shrink: 'tests', total: r.rows.length,
      // A lean row is the test at its first call toward the subject, as an impact row is; a call is depth=1, a transitive call deeper (FR097, FR101).
      lean: (data) => (data.tests as Row[]).map((t) => t.evidence === 'import_only'
        ? leanRow(null, t.path, t.line, ['import_only', ...(t.basis === 'inferred' ? ['inferred'] : []), ...(t.repository ? [repoTag(t.repository)] : [])])
        : leanRow(leanName(t), t.chain[0]!.path, t.chain[0]!.line, [`depth=${t.depth}`, ...(t.evidence === 'dispatch' || t.evidence === 'reference' ? [t.evidence] : []), ...(t.basis === 'inferred' ? ['inferred'] : []), ...(t.repository ? [repoTag(t.repository)] : [])])),
    }
  },

  find_unused(ctx, input) {
    const kinds = (input.kinds as string[] | undefined) ?? ['function', 'class', 'interface', 'type_alias', 'enum', 'variable']
    const { rows, checked } = findUnused(ctx.db, ctx.store, { kinds, pathPrefix: input.path_prefix as string | undefined, topLevelOnly: input.top_level_only !== false, includeTests: input.include_tests === true, includeGenerated: input.include_generated === true })
    const count = (f: (r: UnusedRow) => boolean) => rows.filter(f).length
    const by = (b: UnusedRow['by']) => count((r) => r.by === b)
    const totals = { checked, unused: count((r) => r.group === 'unused'), reachable_only_by: { test: by('test'), framework: by('framework'), public_export: by('public_export') }, possibly_used: count((r) => r.group === 'possibly_used') }
    const refs = referencesNote(snapshotSummary(ctx.db, ctx.snapshot.id).capabilities.references)
    const end = ctx.page.offset + ctx.limits.max_rows
    const limitations = [
      'A symbol is unused when no resolved relationship from another symbol uses it (a call, reference, import, inheritance or injection). A use by reflection, configuration, a string or a call that did not resolve is not seen, so read possibly_used and the unresolved calls before deleting anything.',
      ...(refs ? [refs] : []),
      ...(totals.reachable_only_by.public_export ? ['public_export: exported (export, or an export list) from a file that a package.json main, module, types or exports names, or that such a file re-exports; a file re-exported by name counts whole.'] : []),
      ...(input.include_tests === true ? [] : ['Test code was not checked; a symbol only test code uses is listed under reachable_only_by test.']),
      ...generatedNote(ctx, 'dead code', input),
    ]
    return {
      data: { symbols: rows.slice(ctx.page.offset, end), totals }, more: rows.length > end, stop_reasons: rows.length > end ? ['max_rows'] : [], limitations, shrink: 'symbols',
      lean: (data) => (data.symbols as UnusedRow[]).map((r) => leanRow(leanName(r), r.path, r.line, [r.kind, r.group === 'reachable_only_by' ? `reachable_only_by=${r.by}` : r.group, ...(r.sites ? [`sites=${r.sites}`] : []), ...(r.inferred ? ['inferred'] : [])])),
    }
  },

  find_cycles(ctx, input) {
    const r = findCycles(ctx.db, { pathPrefix: input.path_prefix as string | undefined, includeTypeOnly: input.include_type_only !== false, includeTests: input.include_tests !== false, isTest: isTestPath })
    const end = ctx.page.offset + ctx.limits.max_rows
    const typeOnly = r.cycles.filter((c) => c.type_only).length
    const totals = { cycles: r.cycles.length, type_only: typeOnly, files: new Set(r.cycles.flatMap((c) => c.files)).size, edges: r.edges.length }
    const limitations = [
      `${totals.cycles} cycle${totals.cycles === 1 ? '' : 's'} over ${totals.files} file${totals.files === 1 ? '' : 's'}: ${totals.cycles - typeOnly} runtime, ${typeOnly} only through type-only imports (type_only); ${totals.edges} import${totals.edges === 1 ? '' : 's'} inside them.`,
      'Only imports that resolved to a file of the repository, or that bind one module by name (inferred), are edges; an import that did not resolve can hide a cycle.',
    ]
    return {
      data: { cycles: r.cycles, edges: r.edges.slice(ctx.page.offset, end), totals }, more: r.edges.length > end, stop_reasons: r.edges.length > end ? ['max_rows'] : [], limitations, shrink: 'edges',
      lean: (data) => (data.edges as CycleEdge[]).map((e) => leanRow(e.to, e.from, e.line, [`cycle=${e.cycle}`, ...(e.kind === 'static' ? [] : [e.kind]), ...(e.inferred ? ['inferred'] : [])])),
    }
  },

  find_entry_points(ctx, input) {
    const rows = findEntryPoints(ctx.db, ctx.store, { pathPrefix: input.path_prefix as string | undefined, includeTests: input.include_tests === true, includeGenerated: input.include_generated === true, isTest: isTestPath })
    const end = ctx.page.offset + ctx.limits.max_rows
    const totals = { not_imported: 0, endpoint: 0, job: 0, main: 0, bin: 0, exports: 0 }
    for (const e of rows) totals[e.reason]++
    const limitations = [
      'A module is not_imported when no file under the prefix imports it through a resolved import (static, dynamic or re-export): an entry point, a script, or a file nothing uses. A file loaded by path at run time (a worker, a preload, a config) is listed too.',
      'Framework entry points are the endpoints and jobs the snapshot records; package entries come from package.json main, module, types, exports and bin, mapped to the indexed file they name (a .js path to its .ts source), else shown at the manifest as not_indexed.',
      ...generatedNote(ctx, 'entry points', input),
    ]
    return {
      data: { entries: rows.slice(ctx.page.offset, end), totals }, more: rows.length > end, stop_reasons: rows.length > end ? ['max_rows'] : [], limitations, shrink: 'entries',
      lean: (data) => (data.entries as EntryPoint[]).map((e) => e.reason === 'not_imported' ? leanRow(null, e.path, e.line, ['not_imported'])
        : e.kind ? leanRow(e.name, e.path, e.line, [e.kind]) : e.name === null ? leanRow(null, e.path, e.line, [e.reason]) : leanRow(e.name, e.path, e.line, [e.reason, 'not_indexed'])),
    }
  },

  find_hubs(ctx, input) {
    const by = (input.by as 'fan_in' | 'fan_out' | 'betweenness' | undefined) ?? 'fan_in'
    const r = findHubs(ctx.db, { top: Math.min(Number(input.top ?? 10), ctx.limits.max_rows), by, kinds: input.kinds as string[] | undefined, pathPrefix: input.path_prefix as string | undefined, includeTests: input.include_tests !== false, includeGenerated: input.include_generated === true, deadline: ctx.started + ctx.limits.timeout_ms })
    const limitations = [
      'fan_in counts the distinct symbols that use one through a resolved relationship (a call, reference, import, inheritance or injection); fan_out the distinct symbols it uses. Unresolved calls count for neither, nor do imports between files, so a module ranks by uses of its module symbol alone.',
      ...generatedNote(ctx, 'hubs', input),
      ...(r.sampled !== null ? [`betweenness was computed from ${r.sampled} evenly spaced source symbols, not every one, and scaled up${r.timedOut ? ', stopping at timeout_ms' : ''}: an estimate.`] : []),
    ]
    return {
      data: { hubs: r.hubs, by, sampled_sources: r.sampled }, stop_reasons: [...(Number(input.top ?? 10) > ctx.limits.max_rows && r.hubs.length === ctx.limits.max_rows ? ['max_rows' as const] : []), ...(r.timedOut ? ['timeout' as const] : [])], limitations, shrink: 'hubs',
      lean: (data) => (data.hubs as Hub[]).map((h) => leanRow(leanName(h), h.path, h.line, [h.kind, `fan_in=${h.fan_in}`, `fan_out=${h.fan_out}`, ...(h.betweenness !== undefined ? [`betweenness=${h.betweenness}`] : [])])),
    }
  },

  search_structure(ctx, input) {
    const scope = (input.scope ?? {}) as { reachable_from?: unknown[]; reaching?: unknown[]; importing?: string[] }
    const deadline = ctx.started + ctx.limits.timeout_ms
    const symbolRef = (r: unknown): string => {
      if (r !== null && typeof r === 'object') return symbolNamed(ctx.db, r as { name: string; path: string })
      const s = String(r)
      if (!/^sym_[0-9a-z]+$/.test(s)) return symbolByName(ctx.db, s)
      if (!ctx.db.prepare('select 1 from symbol where id = ?').get(s)) throw new ProofmeshError('NOT_FOUND', `symbol ${s} is not in snapshot ${ctx.snapshot.id}`)
      return s
    }
    // Each scope given narrows the search; together they intersect (FR1062).
    let symbols = null as Set<string> | null
    const walkNotes: string[] = []
    for (const [key, direction] of [['reachable_from', 'out'], ['reaching', 'in']] as const) {
      if (!scope[key]) continue
      const r = reachSet(ctx.db, scope[key].map(symbolRef), direction, ctx.limits.max_depth, deadline)
      symbols = symbols ? new Set([...symbols].filter((id) => r.ids.has(id))) : r.ids
      if (r.stopped) walkNotes.push(`The ${key} walk stopped at ${r.stopped === 'max_depth' ? `max_depth ${ctx.limits.max_depth}` : 'the time limit'}; symbols further away are outside the scope.`)
    }
    const files = scope.importing ? importersOf(ctx.db, scope.importing.map((p) => fileAt(ctx, p).id)) : null
    const r = searchStructure(ctx.db, ctx.store, { pattern: String(input.pattern), language: input.language as string | undefined, pathPrefix: input.path_prefix as string | undefined, symbols, files, offset: ctx.page.offset, maxRows: ctx.limits.max_rows, deadline })
    const git = JSON.parse((ctx.db.prepare("select value from meta where key = 'git'").get() as { value: string } | undefined)?.value ?? '{}') as { commit?: string }
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
    const noGrammar = Object.entries(r.skipped.no_grammar).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    const skippedFiles = noGrammar.reduce((n, [, c]) => n + c, 0)
    const limitations = [
      // The snapshot's captured content, never the working tree: a stale snapshot answers for what it captured (FR1065).
      `Matched against the content snapshot ${ctx.snapshot.id} captured${git.commit ? ` at commit ${git.commit.slice(0, 12)}` : ''}, not the working tree.`,
      ...walkNotes,
      ...(skippedFiles ? [`${plural(skippedFiles, 'file')} in a language with no grammar here ${skippedFiles === 1 ? 'was' : 'were'} not searched: ${noGrammar.slice(0, 5).map(([e, n]) => `${e} ${n}`).join(', ')}${noGrammar.length > 5 ? ', ...' : ''}.`] : []),
      ...Object.entries(r.failed_languages).map(([lang, why]) => `The pattern does not parse as ${lang} (${why.split('\n')[0]}), so ${lang} files were not searched.`),
      ...(r.skipped.too_large ? [`${plural(r.skipped.too_large, 'file')} over ${MAX_FILE_BYTES / 1024 / 1024} MiB ${r.skipped.too_large === 1 ? 'was' : 'were'} not parsed.`] : []),
      ...(r.skipped.over_budget ? [`${plural(r.skipped.over_budget, 'file')} past the ${MAX_SOURCE_BYTES / 1024 / 1024} MiB one search reads ${r.skipped.over_budget === 1 ? 'was' : 'were'} not searched; narrow path_prefix or the scope.`] : []),
      ...(r.stopped ? [`The search stopped at timeout_ms ${ctx.limits.timeout_ms}; total counts the matches found before it.`] : []),
    ]
    const end = ctx.page.offset + r.matches.length
    return {
      data: { matches: r.matches, totals: { matches: r.total, files_searched: r.files_searched, ...(symbols ? { scope_symbols: symbols.size } : {}), ...(files ? { scope_files: files.size } : {}) } },
      total: r.total, more: r.total > end, stop_reasons: [...(r.total > end ? ['max_rows' as const] : []), ...(r.stopped ? ['timeout' as const] : [])], limitations, shrink: 'matches',
      lean: (data) => (data.matches as StructureMatch[]).map((m) => leanRow(m.symbol ? leanName({ ...m.symbol, path: m.path }) : null, m.path, m.line, [quote(visible(m.text))])),
    }
  },

  get_table_reach(ctx, input) {
    const tables = findTables(ctx.db, input.table as string)
    if (!tables.length) {
      const known = (ctx.db.prepare("select count(*) as n from symbol where kind = 'table'").get() as { n: number }).n
      throw new ProofmeshError('NOT_FOUND', `no table named ${String(input.table)} in snapshot ${ctx.snapshot.id} (${known} tables known; tables come from the EF Core, EF6, SQLAlchemy, Django, TypeORM and Prisma rules, from SQL table and view declarations, and from installed extensions, see "proofmesh extension list"${known ? '' : '; this snapshot has none, so the repository may need an extension for its data layer'})`, { tables_known: known })
    }
    const reached = tables.map((t) => tableReach(ctx.db, ctx.snapshot.id, t, ctx.limits.max_depth, ctx.limits.max_rows))
    const observed = ctx.catalog.observations(ctx.repo.id, 'table')
    const propertyOf = ctx.db.prepare("select id from symbol where kind in ('property', 'field') and qualified_name = ?")
    const data = reached.map(({ stopped_by, ...t }) => ({
      ...t,
      observed: observed.filter((o) => o.subject_name === t.qualified_name || o.subject_name === t.name).map((o) => ({ source: o.source, window: { from: o.window_from, to: o.window_to }, metric: o.metric, value: o.value })),
      // Observed reads of the mapped entities' properties, per endpoint, with the property symbol when the snapshot has one.
      property_reads: ctx.catalog.propertyReads(ctx.repo.id, t.entities.map((e) => e.qualified_name)).map((r) => propertyReadRow(r, propertyOf)),
    }))
    const stopped = reached.map((t) => t.stopped_by).find((x) => x) ?? null
    const limitations = [
      'static reach, not load',
      'Static reach only: code that reaches the table through unresolved calls, raw SQL, reflection, or configuration is missed.',
      ...(reached.some((t) => t.horizon) ? ['A limit stopped the search; the reach is a lower bound.'] : []),
      ...(data.some((t) => t.observed.length) ? ['observed in window, not load from code: observation counts come from a metrics file a person imported, not from the code.'] : []),
      ...(data.some((t) => t.property_reads.length) ? [PROPERTY_READS_NOTE] : []),
    ]
    return { data: { tables: data, stopped_by: stopped }, stop_reasons: [...(stopped === 'max_depth' ? ['max_depth' as const] : []), ...(reached.some((t) => t.horizon && t.stopped_by !== 'max_depth') ? ['max_rows' as const] : [])], limitations, shrink: ['tables[].property_reads', 'tables[].reach', 'tables[].accessors', 'tables[].entities', 'tables[].symbols'] }
  },

  get_property_reads(ctx, input) {
    const endpoint = input.endpoint as string | undefined, entity = input.entity as string | undefined
    if (!endpoint && !entity) throw new ProofmeshError('INVALID_ARGUMENT', 'name an endpoint, an entity, or both')
    const propertyOf = ctx.db.prepare("select id from symbol where kind in ('property', 'field') and qualified_name = ?")
    const rows = ctx.catalog.propertyReadsWhere(ctx.repo.id, { endpoint, entity })
    const reads = rows.slice(0, ctx.limits.max_rows).map((r) => propertyReadRow(r, propertyOf))
    // A property the ORM loaded that no application code was seen reading: the candidate for leaving out of a projection.
    const appRead = new Set(rows.filter((r) => r.read_kind === 'application').map((r) => `${r.endpoint}\u0000${r.entity}\u0000${r.property}`))
    const loadedNotUsed = [...new Map(rows.filter((r) => r.read_kind === 'orm' && !appRead.has(`${r.endpoint}\u0000${r.entity}\u0000${r.property}`)).map((r) => [`${r.endpoint}\u0000${r.entity}\u0000${r.property}`, { endpoint: r.endpoint, entity: r.entity, property: r.property }])).values()]
    // Mapped properties of the entity that no import mentions at all, when the snapshot knows the entity's properties.
    const unread = entity
      ? (ctx.db.prepare("select id, name from symbol where kind in ('property', 'field') and qualified_name like ? escape '\\' order by name, qualified_name, start_byte").all(`${entity.replace(/[\\%_]/g, (c) => `\\${c}`)}.%`) as Array<{ id: string; name: string }>)
          .filter((p) => !p.name.includes('.') && !rows.some((r) => r.property === p.name)).map((p) => ({ entity, property: p.name, symbol_id: p.id }))
      : []
    const limitations: string[] = [
      // An empty observed side most often means nothing was imported, so it is the first thing said (FR392).
      ...(rows.length ? [] : [`No imported run observed property reads for ${[endpoint, entity].filter(Boolean).join(' and ')}, so reads and loaded_not_used are empty: they come only from an instrumented run imported with proofmesh observe import, and an empty list is not evidence that nothing reads a property.`]),
      PROPERTY_READS_NOTE,
      ...(rows.some((r) => r.read_kind === 'orm') ? ['ORM reads are the properties the ORM materialised or tracked, loaded but not necessarily used; application reads are what code read. loaded_not_used lists properties with ORM reads and no application read.'] : ['No import distinguished ORM reads from application reads (observations 0.3 read_kind), so every read counts as an application read.']),
      ...(entity && !unread.length && !rows.length ? ['The snapshot has no property symbols for that entity name and no import names it; check the qualified name.'] : []),
    ]
    // From an endpoint, the static side: entity properties read along resolved paths, and how it compares with what an import observed.
    const endpoints = endpoint ? (ctx.db.prepare("select id from symbol where kind = 'endpoint' and qualified_name = ?").all(endpoint) as Array<{ id: string }>).map((e) => e.id) : []
    const statics = endpoint ? staticPropertyReads(ctx.db, endpoints, ctx.limits.max_depth, 20000) : null
    const key = (entityName: string, property: string) => `${entityName}.${property}`
    // Only application reads are compared: an ORM read is a load, not code using the property.
    const observed = new Map(rows.filter((r) => r.endpoint === endpoint && r.read_kind === 'application').map((r) => [key(r.declaring_type ?? r.entity, r.property), { entity: r.declaring_type ?? r.entity, property: r.property }]))
    const statically = new Map((statics?.reads ?? []).map((r) => [key(r.entity, r.property), { entity: r.entity, property: r.property }]))
    const comparison = statics && observed.size
      ? { both: [...statically].filter(([k]) => observed.has(k)).map(([, v]) => v), static_only: [...statically].filter(([k]) => !observed.has(k)).map(([, v]) => v), observed_only: [...observed].filter(([k]) => !statically.has(k)).map(([, v]) => v) }
      : null
    // Why static_reads is what it is (FR390): an adapter that fell back to the syntax tier left code with no endpoints and no property reads.
    const fallbacks = endpoint && !endpoints.length ? (JSON.parse((ctx.db.prepare("select value from meta where key = 'fallbacks'").get() as { value: string } | undefined)?.value ?? '{"handoffs":[]}') as { handoffs: Array<{ adapter: string; files: number; reason: string }> }).handoffs : []
    const staticAnalysis = !endpoint ? null : !endpoints.length ? (fallbacks.length ? 'not_available_in_mode' : 'no_endpoint') : statics!.stopped_by === 'max_depth' ? 'cut_by_depth' : statics!.stopped_by === 'max_rows' ? 'cut_by_rows' : 'ran'
    if (fallbacks.length) limitations.push(`Static property-read analysis is not available for this code: the syntax tier read ${fallbacks.map((f) => `${f.files} file${f.files === 1 ? '' : 's'} adapter ${f.adapter} could not analyse (${f.reason})`).join(', ')}, and the syntax tier records no endpoints and no property reads. Make the adapter available and index again, or check the endpoint's qualified name.`)
    else if (endpoint && !endpoints.length) limitations.push(`The snapshot has no endpoint named ${endpoint}, so there are no static reads; check the qualified name.`)
    if (statics?.stopped_by === 'max_depth') limitations.push(`The static traversal stopped at max_depth ${ctx.limits.max_depth}: static_reads lists the reads found within ${ctx.limits.max_depth} hops; ${statics.not_visited} symbol${statics.not_visited === 1 ? '' : 's'} one hop further ${statics.not_visited === 1 ? 'was' : 'were'} not visited, so reads in and past ${statics.not_visited === 1 ? 'it' : 'them'} are missing.`)
    if (statics && endpoints.length) limitations.push(`Static reads are static reach, not load: properties read on any resolved path from the endpoint, an upper bound on what one request reads, and blind past the ${statics.unresolved_calls} call${statics.unresolved_calls === 1 ? '' : 's'} with no single resolved target and to reads by reflection or serialization (an entity returned whole is serialized property by property).`)
    return {
      data: { reads, loaded_not_used: loadedNotUsed, unread_mapped_properties: unread, static_reads: (statics?.reads ?? []).slice(0, ctx.limits.max_rows), static_analysis: staticAnalysis, static_bound: statics ? { endpoints: endpoints.length, methods: statics.methods, unresolved_calls: statics.unresolved_calls, stopped_by: statics.stopped_by, not_visited: statics.not_visited } : null, comparison },
      stop_reasons: [...(rows.length > ctx.limits.max_rows || (statics?.reads.length ?? 0) > ctx.limits.max_rows ? ['max_rows' as const] : []), ...(statics?.stopped_by === 'max_depth' ? ['max_depth' as const] : [])], limitations, shrink: ['reads', 'static_reads', 'unread_mapped_properties', 'loaded_not_used'],
    }
  },
  get_external_usage(ctx, input) {
    const r = externalUsage(ctx.db, { module: input.module as string | undefined, prefix: input.name_prefix as string | undefined, groupBy: (input.group_by as UsageGroup | undefined) ?? 'member', fold: input.fold_generics !== false, includeTests: input.include_tests !== false, pathPrefix: input.path_prefix as string | undefined })
    const limitations = [
      'Only calls that resolved to code outside the repository count: a call that did not bind, or a member reached through reflection or configuration, is not in these numbers.',
      ...(input.fold_generics !== false ? ['Closed generic instantiations are counted under their open definition, written with <…>.'] : []),
      ...(r.totals.call_sites === 0 ? ['No resolved external call matches; check the module or name prefix with find_symbols or a sample site.'] : []),
    ]
    return { data: { groups: r.rows.slice(0, ctx.limits.max_rows), totals: r.totals }, stop_reasons: r.rows.length > ctx.limits.max_rows ? ['max_rows'] : [], limitations, shrink: 'groups' }
  },
  find_query_source(ctx, input) {
    const r = findQuerySource(ctx.db, ctx.snapshot.id, ctx.catalog.notes(), String(input.sql), { maxDepth: ctx.limits.max_depth, maxRows: ctx.limits.max_rows })
    const unmatched = r.parsed.tables.filter((t) => !t.matched.length).map((t) => t.name)
    const limitations = [
      'Candidates statically reach the statement\'s tables; none is proven to issue it. Code that builds the SQL at runtime, reaches the table through an unresolved call, or uses a table no entity maps is not seen.',
      'The statement is read by pattern, not parsed: tables after FROM, JOIN, UPDATE and INTO, and columns before a comparison.',
      ...(unmatched.length ? [`No table symbol is named ${unmatched.join(', ')}: an unmapped table, or a convention the rules could not evaluate.`] : []),
      ...(r.notes.length ? [] : ['No accepted note maps a clause of this statement to the helper that writes it; a clause a helper adds cannot be found by searching source text.']),
      ...(r.considered > WEIGHED ? [`${r.considered} endpoints and jobs reach these tables; reads and helpers were weighed for the ${WEIGHED} strongest by tables and owner.`] : []),
    ]
    return { data: { parsed: r.parsed, candidates: r.candidates, considered: r.considered, notes: r.notes }, stop_reasons: r.considered > ctx.limits.max_rows ? ['max_rows'] : [], limitations, shrink: 'candidates' }
  },
  // Routed before a repository context exists; see catalogTool.
  list_repositories() { throw new ProofmeshError('INVALID_ARGUMENT', 'list_repositories answers from the catalog, not a repository snapshot') },
  list_snapshots() { throw new ProofmeshError('INVALID_ARGUMENT', 'list_snapshots answers from the catalog, not a repository snapshot') },
  list_workspaces() { throw new ProofmeshError('INVALID_ARGUMENT', 'list_workspaces answers from the catalog, not a repository snapshot') },
  // Routed before a repository context exists; see getEcosystem.
  get_ecosystem() { throw new ProofmeshError('INVALID_ARGUMENT', 'get_ecosystem answers from a workspace link file, not a repository snapshot') },

  get_overview(ctx, input) {
    const o = overview(ctx.db, ctx.snapshot.id, { path: input.path as string | undefined, text: input.text as string | undefined, maxRows: ctx.limits.max_rows })
    return { data: o, stop_reasons: o.omitted > 0 ? ['max_rows'] : [], shrink: 'children' }
  },

  get_symbol(ctx, input) {
    if (input.symbol_id === undefined && input.path === undefined) throw new ProofmeshError('INVALID_ARGUMENT', 'give symbol_id or path')
    const id = input.path !== undefined ? fileAlias(ctx.db, fileAt(ctx, String(input.path)).id) : String(input.symbol_id)
    const s = ctx.db.prepare(`${SYMBOL_SQL} where s.id = ?`).get(id) as SymbolRow | undefined
    if (!s) throw new ProofmeshError('NOT_FOUND', input.path !== undefined ? `${String(input.path)} has no module symbol in snapshot ${ctx.snapshot.id}` : `symbol ${String(input.symbol_id)} is not in snapshot ${ctx.snapshot.id}`)
    // Only a hash sealed with the snapshot is answered; none is computed here from another reading of the span (FR135).
    const sealed = hasBodyHash(ctx.db)
    const identity = ctx.db.prepare(`select stable_key, ${sealed ? 'body_hash' : 'null as body_hash'} from symbol where id = ?`).get(id) as { stable_key: string; body_hash: string | null }
    // What the adapter kept beside the name, such as the SCIP index's own symbol (FR441); a snapshot before format 0.11 has none.
    const detail = ctx.db.prepare("select 1 from pragma_table_info('symbol') where name = 'detail'").get() ?(ctx.db.prepare('select detail from symbol where id = ?').get(id) as { detail: string | null }).detail : null
    return {
      data: { symbol: { ...withRoles(ctx.db, [s])[0]!, ...identity, ...(detail ? { detail: JSON.parse(detail) as Record<string, string> } : {}) } }, evidence_ids: [s.evidence_id],
      limitations: !sealed ? ['This snapshot was sealed before body hashes existed, so body_hash is null; index again to compute it.']
        : identity.body_hash ? []
        : unreadableFiles(ctx.db).paths.includes(s.path) ? [`The content of ${s.path} was unavailable when the snapshot was sealed, so body_hash is null.`]
        : ['body_hash is null: the declaration span is no more than the name, so there is no text to hash.'],
      lean: () => [leanRow(leanName(s), s.path, s.start_line, [s.kind, `stable_key=${quote(identity.stable_key)}`, ...(identity.body_hash ? [`body_hash=${identity.body_hash}`] : [])])],
    }
  },

  get_relationships(ctx, input) {
    if (input.subject_id === undefined && input.path === undefined) throw new ProofmeshError('INVALID_ARGUMENT', 'give subject_id or path')
    const subject = input.path !== undefined ? fileAt(ctx, String(input.path)).id : String(input.subject_id)
    const isFile = subject.startsWith('file_'), isExternal = subject.startsWith('ext_')
    const exists = ctx.db.prepare(`select 1 from ${isFile ? 'file' : isExternal ? 'external_symbol' : 'symbol'} where id = ?`).get(subject)
    if (!exists) throw new ProofmeshError('NOT_FOUND', `${subject} is not in snapshot ${ctx.snapshot.id}`)
    // A file and its module symbol answer as one (FR090): rows of either id are the subject's.
    const alias = isExternal ? undefined : fileAlias(ctx.db, subject)
    const ids = alias ? [subject, alias] : [subject], sp = ids.map(() => '?').join(',')
    // An external symbol has no code here: only the calls into it are known.
    const direction = isExternal ? 'in' : ((input.direction as string) ?? 'both')
    const types = (input.types as string[]) ?? [isFile ? 'imports' : 'calls']
    // Outbound rows default to code in the repository: calls into frameworks and libraries are most of a method's calls and rarely the question.
    // Only calls into frameworks and libraries are left out by default; a type whose targets are external by nature, such as a package
    // dependency, keeps them.
    const hideExternal = !input.resolutions && !isExternal && input.include_external !== true && direction !== 'in' && types.includes('calls')
    const resolutions = (input.resolutions as string[]) ?? ['resolved', 'resolved_external', 'candidate', 'ambiguous', 'unresolved']
    const outFilter = hideExternal ? " and not (resolution = 'resolved_external' and type = 'calls')" : ''
    const tp = types.map(() => '?').join(','), rp = resolutions.map(() => '?').join(',')
    // With include_tests false, a row whose other side lives in test code is left out in SQL, so paging stays a slice of one order.
    // An importer's source is the file itself, so a file id is looked up as well as a symbol id.
    const notTest = (side: string) => input.include_tests === false ? ` and coalesce((select pm_is_test(f.path, ${rolesSql(ctx.db)}) from symbol s join file f on f.id = s.file_id where s.id = ${side}), (select pm_is_test(f.path) from file f where f.id = ${side}), 0) = 0` : ''
    type A = Sited & { origin: string; resolution: string; source_kind: string; source_id: string; target_kind: string | null; target_id: string | null; reason: string | null; detail: string | null }
    const all: Array<A & { direction: 'in' | 'out' }> = []
    // Outgoing then incoming, each by site (path, then position), then type, then id: fetching offset + cap of each keeps every page a slice of one total order.
    const offset = ctx.page.offset, cap = offset + ctx.limits.max_rows + 1
    // Ownership is recorded on the file module (FR016); every symbol in the file inherits its owners.
    const inherited = !isFile && !isExternal && direction !== 'in' && types.includes('owned_by')
      ? ctx.db.prepare(`select a.*, ${siteCols(ctx.db)} from assertion a join symbol m on m.id = a.source_id where m.kind = 'module' and m.id <> ? and m.file_id = (select file_id from symbol where id = ?) and a.type = 'owned_by' and a.resolution in (${rp})`).all(subject, subject, ...resolutions) as A[]
      : []
    // The unary plus keeps type and resolution out of the index lookup, so the index order of the site is what the query returns.
    // One index-ordered read for each id the subject answers to, so no read sorts more than the rows it returns.
    const indexed = (idx: string) => (hasSites(ctx.db) ? ` indexed by ${idx}` : '')
    const mergeInto = (rows: A[][], dir: 'in' | 'out') => {
      const seen = new Set<string>()
      return rows.flat().filter((a) => !seen.has(a.id) && seen.add(a.id)).sort(bySite).slice(0, cap).map((a) => ({ ...a, direction: dir }))
    }
    if (direction !== 'in') all.push(...mergeInto([...ids.map((id) => ctx.db.prepare(`select a.*, ${siteCols(ctx.db)} from assertion a${indexed('assertion_by_source_site')} where a.source_id = ? and +a.type in (${tp}) and +a.resolution in (${rp})${outFilter}${notTest('a.target_id')} order by ${siteOrder(ctx.db)} limit ?`).all(id, ...types, ...resolutions, cap) as A[]), inherited], 'out'))
    // Inbound: assertions that target the subject, and candidate or ambiguous calls whose candidates name it (A18). A call or reference
    // to a member the subject implements or overrides may dispatch to it, so those come too, each saying which member it named.
    const via = !isFile && !isExternal && direction !== 'out' ? dispatchedFrom(ctx.db, subject) : new Map<string, string>()
    const dispatched = types.filter((t) => t === 'calls' || t === 'references'), named = [subject, ...via.keys()]
    const vp = [...via.keys()].map(() => '?').join(','), dp = dispatched.map(() => '?').join(','), np = named.map(() => '?').join(',')
    const inbound = `select * from assertion where (target_id in (${sp}) and type in (${tp})${via.size && dispatched.length ? ` or target_id in (${vp}) and type in (${dp})` : ''}) and resolution in (${rp})${notTest('assertion.source_id')} union select a.* from assertion_candidate c join assertion a on a.id = c.assertion_id where c.symbol_id in (${np}) and a.type in (${tp}) and a.resolution in (${rp})${notTest('a.source_id')}`
    const inboundParams = [...ids, ...types, ...(via.size && dispatched.length ? [...via.keys(), ...dispatched] : []), ...resolutions, ...named, ...types, ...resolutions]
    if (direction !== 'out') {
      const byTarget = (id: string, tys: string[]) => ctx.db.prepare(`select a.*, ${siteCols(ctx.db)} from assertion a${indexed('assertion_by_target_site')} where a.target_id = ? and +a.type in (${tys.map(() => '?').join(',')}) and +a.resolution in (${rp})${notTest('a.source_id')} order by ${siteOrder(ctx.db)} limit ?`).all(id, ...tys, ...resolutions, cap) as A[]
      const byCandidate = (id: string) => ctx.db.prepare(`select a.*, ${siteCols(ctx.db, 'a', 'c')} from assertion_candidate c${indexed('candidate_by_site')} join assertion a on a.id = c.assertion_id where c.symbol_id = ? and +a.type in (${tp}) and +a.resolution in (${rp})${notTest('a.source_id')} order by ${siteOrder(ctx.db, 'a', 'c', 'c.assertion_id')} limit ?`).all(id, ...types, ...resolutions, cap) as A[]
      all.push(...mergeInto([...ids.map((id) => byTarget(id, types)), ...(via.size && dispatched.length ? [...via.keys()].map((id) => byTarget(id, dispatched)) : []), ...named.map(byCandidate)], 'in'))
    }
    const viaOf = (a: A & { direction: 'in' | 'out' }): string | undefined => {
      if (a.direction !== 'in' || !via.size) return undefined
      if (a.target_id) return via.has(a.target_id) ? a.target_id : undefined
      const names = (ctx.db.prepare('select symbol_id from assertion_candidate where assertion_id = ?').all(a.id) as Array<{ symbol_id: string }>).map((c) => c.symbol_id)
      return names.includes(subject) ? undefined : names.find((n) => via.has(n))
    }
    const rows = all.slice(offset, offset + ctx.limits.max_rows + 1)
    // FR902: inbound sites in the other members of this repository's workspaces, through the packages it builds. They follow every local row
    // in the total order, so a page reaches them only once the local rows are all listed.
    const ws = input.include_workspace === true && !isFile && !isExternal && direction !== 'out'
      ? withWorkspace(ctx.catalog, ctx.repo, ctx.snapshot, ctx.db, (w) => ({ header: w.header, limitations: w.limitations, rows: w.inbound(ids, types).filter((r) => resolutions.includes(r.resolution) && !(input.include_tests === false && isTestPath(r.source.path))) }))
      : null
    const across = ws ? ws.rows.slice(Math.max(0, offset - all.length), Math.max(0, offset + ctx.limits.max_rows + 1 - all.length)) : []
    const describe = (kind: string | null, id: string | null) => {
      if (!kind || !id) return { kind: 'none' }
      if (kind === 'symbol') { const s = ctx.db.prepare(`${SYMBOL_SQL} where s.id = ?`).get(id) as SymbolRow; return { kind: 'symbol', id, symbol_kind: s.kind, name: s.name, qualified_name: s.qualified_name, path: s.path, start_line: s.start_line } }
      if (kind === 'file') { const f = ctx.db.prepare('select path from file where id = ?').get(id) as { path: string }; return { kind: 'file', id, name: f.path.split('/').pop()!, path: f.path } }
      const x = ctx.db.prepare('select module, name from external_symbol where id = ?').get(id) as { module: string; name: string }
      return { kind: 'external', id, name: x.name, module: x.module }
    }
    const relationships = rows.map((a) => {
      const site = siteOf(ctx.db, a.id), basis = basisOf(a)
      return {
        assertion_id: a.id, type: a.type, direction: a.direction, resolution: a.resolution, origin: a.origin, ...(basis ? { basis } : {}),
        other: a.direction === 'out' ? describe(a.target_kind, a.target_id) : describe(a.source_kind, a.source_id),
        site: { path: site.path, start_line: site.start_line, end_line: site.end_line }, reason: a.reason, detail: a.detail ? (JSON.parse(a.detail) as Record<string, string>) : null, evidence_ids: site.evidence,
        ...(viaOf(a) ? { via: { id: viaOf(a)!, qualified_name: (ctx.db.prepare('select qualified_name from symbol where id = ?').get(viaOf(a)) as { qualified_name: string }).qualified_name } } : {}),
      } as { via?: { id: string; qualified_name: string }; repository?: Inbound['repository'] } & Record<string, unknown> & { assertion_id: string; type: string; direction: 'in' | 'out'; resolution: string; basis?: Basis; other: Record<string, unknown>; site: { path: string; start_line: number; end_line: number }; reason: string | null; detail: Record<string, string> | null; evidence_ids: string[] }
    }).concat(across.map((r) => ({
      assertion_id: r.assertion_id, type: r.type, direction: 'in' as const, resolution: r.resolution, origin: r.origin, basis: r.basis,
      other: { kind: 'symbol', id: r.source.id, symbol_kind: r.source.kind, name: r.source.name, qualified_name: r.source.qualified_name, path: r.source.path, start_line: r.source.start_line, key: r.source.key },
      site: r.site, reason: null, detail: r.detail, evidence_ids: r.evidence_ids, repository: r.repository,
    })))
    const boundaries = !isFile && !isExternal && direction !== 'out' && types.includes('calls')
      ? incomingBoundaries(ctx, subject, via)
      : NO_BOUNDARIES
    const outUnresolved: Boundary[] = relationships.filter((r) => r.resolution === 'unresolved' && r.direction === 'out').map((r) => ({ assertion_id: r.assertion_id, type: r.type, reason: r.reason!, path: r.site.path, line: r.site.start_line, from_id: subject }))
    const outGroups = direction !== 'in' && resolutions.includes('unresolved')
      ? ctx.db.prepare(`select reason, count(*) as n from assertion where source_id in (${sp}) and type in (${tp}) and resolution = 'unresolved' group by reason`).all(...ids, ...types) as Array<{ reason: string; n: number }>
      : []
    const byReason = { ...boundaries.by_reason }
    // Every matching row, by basis; an unresolved boundary is no relationship and has none.
    const counted = (from: string, params: unknown[]) => {
      const c = { observed: 0, inferred: 0, none: 0 }
      for (const r of ctx.db.prepare(`select case when x.resolution = 'unresolved' then 'none' when ${inferredSql('x')} then 'inferred' else 'observed' end as basis, count(*) as n from (${from}) x group by basis`).all(...params) as Array<{ basis: keyof typeof c; n: number }>) c[r.basis] = r.n
      return { ...c, total: c.observed + c.inferred + c.none }
    }
    const outCount = direction === 'in' ? null : counted(`select * from assertion where source_id in (${sp}) and type in (${tp}) and resolution in (${rp})${outFilter}${notTest('assertion.target_id')}`, [...ids, ...types, ...resolutions])
    const inCount = direction === 'out' ? null : counted(inbound, inboundParams)
    const inheritedBasis = byBasis(inherited.map((a) => ({ basis: basisOf(a) })))
    const outExternal = hideExternal ? (ctx.db.prepare(`select count(*) as n from assertion where source_id in (${sp}) and type = 'calls' and resolution = 'resolved_external'`).get(...ids) as { n: number }).n : 0
    const wsBasis = byBasis(ws?.rows ?? [])
    const totals = { in: (inCount?.total ?? 0) + (ws?.rows.length ?? 0), out: outCount ? outCount.total + inherited.length : 0, by_basis: { observed: (outCount?.observed ?? 0) + (inCount?.observed ?? 0) + (outCount ? inheritedBasis.observed : 0) + wsBasis.observed, inferred: (outCount?.inferred ?? 0) + (inCount?.inferred ?? 0) + (outCount ? inheritedBasis.inferred : 0) + wsBasis.inferred }, ...(boundaries !== NO_BOUNDARIES ? { boundaries_calling_name: boundaries.name_matched } : {}), ...(outExternal ? { out_external: outExternal } : {}) }
    for (const g of outGroups) byReason[g.reason] = (byReason[g.reason] ?? 0) + g.n
    const truncated = relationships.length > ctx.limits.max_rows
    const limitations = [
      // Lean rows leave the boundaries out, so its note counts those calling the subject's name and says how to list them.
      ...(boundaries.count ? [`${boundaries.count} unresolved call site${boundaries.count === 1 ? '' : 's'} in this snapshot ${boundaries.count === 1 ? 'has an unknown target and may call' : 'have unknown targets and may call'} this symbol${ctx.lean ? `, ${boundaries.name_matched} by its name; envelope compact lists them` : boundaries.items.length < boundaries.count ? `; listed first are the ${boundaries.name_matched} that call its name${boundaries.name_matched > boundaries.items.length ? ` (${boundaries.items.length} fit)` : ''}, then the nearest others by path` : ''}.`] : []),
      ...(outExternal ? [`${outExternal} outbound call${outExternal === 1 ? '' : 's'} to code outside the repository (frameworks and libraries) ${outExternal === 1 ? 'is' : 'are'} left out; pass include_external true to list them.`] : []),
      ...(via.size && direction !== 'out' ? [`Inbound rows include calls and references to the ${via.size} member${via.size === 1 ? '' : 's'} this symbol implements or overrides, each marked with ${ctx.lean ? 'dispatch' : 'via'}: they reach this symbol only when the runtime type is its own.`] : []),
      ...(inherited.length ? ['Ownership is recorded on the file module; the owned_by rows are the owners of this symbol\'s file.'] : []),
      ...(isExternal ? ['The subject is an external symbol: only resolved calls into it are listed, and a closed generic is a separate external symbol from its open definition.'] : []),
      ...(input.include_tests === false ? [`Rows whose other side is test code were left out: ${TEST_RECOGNISED}.`] : []),
      ...leanReferencesNote(ctx, types),
      ...(ws ? [...ws.limitations, ...mismatchNotes(ws.rows), ...(ws.rows.length ? ['Rows from other repositories carry their repository and commit; their ids and evidence ids are of that repository\'s snapshot.'] : [])] : []),
    ]
    return {
      data: { relationships: relationships.slice(0, ctx.limits.max_rows), boundaries: boundaries.items, totals, ...(ws ? { workspace: ws.header } : {}) },
      // The envelope's evidence is this snapshot's; a row of another repository lists its own.
      evidence_ids: [...new Set(relationships.slice(0, ctx.limits.max_rows).filter((r) => !r.repository).flatMap((r) => r.evidence_ids))].sort(byKey((i) => evidenceKey(ctx.db, i))),
      unresolved: { scope: 'query', items: [...boundaries.items, ...outUnresolved], count: boundaries.count + outGroups.reduce((n, g) => n + g.n, 0), by_reason: byReason },
      stop_reasons: truncated ? ['max_rows'] : [], more: relationships.length > ctx.limits.max_rows, limitations, shrink: ['relationships', 'boundaries'],
      // One row per site: the other side's name at the call, import or reference line, tagged with what a plain row would hide (FR096).
      lean: (data) => (data.relationships as typeof relationships).map((r) => {
        const o = r.other as { kind: string; symbol_kind?: string; name?: string; qualified_name?: string; path?: string }
        const name = o.kind === 'symbol' ? leanName({ kind: o.symbol_kind, name: o.name!, qualified_name: o.qualified_name, path: o.path }) : o.kind === 'file' ? o.path! : o.name ?? r.detail?.callee ?? r.detail?.specifier ?? null
        return leanRow(name, r.site.path, r.site.start_line, [
          // A query that mixes directions or types says which each row is, as the JSON rows' direction and type fields do.
          ...(direction === 'both' ? [r.direction] : []), ...(types.length > 1 ? [r.type] : []), ...(r.via ? ['dispatch'] : []), ...(o.kind === 'external' ? ['external'] : []),
          ...(r.resolution === 'unresolved' ? [`unresolved:${r.reason}`] : r.resolution === 'candidate' || r.resolution === 'ambiguous' ? [r.resolution] : []),
          ...(r.basis === 'inferred' ? ['inferred'] : []), ...(r.repository ? [repoTag(r.repository)] : []),
        ])
      }),
    }
  },

  trace_paths(ctx, input) {
    // FR1261: with include_workspace, an end may be a symbol of another member of this repository's workspaces, by its id there, and a path
    // crosses repositories through their sealed package_symbol links (FR901). The files stay open for the answer's making.
    return input.include_workspace === true ? withWorkspace(ctx.catalog, ctx.repo, ctx.snapshot, ctx.db, (ws) => tracePaths(ctx, input, ws)) : tracePaths(ctx, input, null)
  },

  read_evidence(ctx, input) {
    const ids = input.evidence_ids as string[]
    const evidence = ids.map((id) => {
      const e = ctx.db.prepare('select e.*, f.path from evidence e join file f on f.id = e.file_id where e.id = ?').get(id) as Record<string, any> | undefined
      if (!e) throw new ProofmeshError('NOT_FOUND', `evidence ${id} is not in snapshot ${ctx.snapshot.id}`)
      const { integrity, content } = ctx.store.verify(e.object_hash)
      return {
        id, path: e.path, start_line: e.start_line, end_line: e.end_line, start_byte: e.start_byte, end_byte: e.end_byte, object_hash: e.object_hash,
        source_kind: e.source_kind, extractor: e.extractor, extractor_version: e.extractor_version, analysis_mode: e.analysis_mode,
        integrity, text: integrity.status === 'verified' && content ? content.subarray(e.start_byte, e.end_byte).toString('utf8') : null,
      }
    })
    return { data: { evidence }, evidence_ids: ids, shrink: 'evidence' }
  },

  // FR1180: a symbol's card in one request, so a reader sees its proof without four round trips. Read-only; every part is what
  // get_symbol, get_relationships and read_evidence answer, each object verified once per request.
  get_symbol_card(ctx, input) {
    const symbol = IMPL.get_symbol(ctx, { symbol_id: input.symbol_id }).data.symbol as SymbolRow & Record<string, unknown>
    const verified = new Map<string, ReturnType<EvidenceStore['verify']>>()
    const verify = (hash: string) => { if (!verified.has(hash)) verified.set(hash, ctx.store.verify(hash)); return verified.get(hash)! }
    const evidenceRow = (id: string) => ctx.db.prepare('select e.*, f.path from evidence e join file f on f.id = e.file_id where e.id = ?').get(id) as Record<string, any>
    const decl = evidenceRow((ctx.db.prepare('select evidence_id from symbol where id = ?').get(symbol.id) as { evidence_id: string }).evidence_id)
    const d = verify(decl.object_hash)
    const declaration = {
      id: decl.id, path: decl.path, start_line: decl.start_line, end_line: decl.end_line, object_hash: decl.object_hash, extractor: decl.extractor, extractor_version: decl.extractor_version,
      analysis_mode: decl.analysis_mode, integrity: d.integrity, text: d.integrity.status === 'verified' && d.content ? d.content.subarray(decl.start_byte, decl.end_byte).toString('utf8') : null,
    }
    // A row's call site: the whole lines of the cited span, at most CARD_CONTEXT_LINES, with the span's character offsets in them;
    // no text when the object fails its integrity check, so the lens says why rather than showing unverified source.
    const cited = (id: string | undefined) => {
      if (!id) return null
      const e = evidenceRow(id), v = verify(e.object_hash)
      const site = { id, path: e.path as string, start_line: e.start_line as number, end_line: e.end_line as number, integrity: v.integrity }
      if (v.integrity.status !== 'verified' || !v.content) return { ...site, context: null }
      // Buffer.lastIndexOf counts a negative offset from the end, so a span at the file's first byte starts its line there.
      const c = v.content, from = e.start_byte === 0 ? 0 : c.lastIndexOf(10, e.start_byte - 1) + 1
      let to = e.end_byte, lines = 0
      while (to < c.length && c[to] !== 10) to++
      for (let i = from; i < to; i++) if (c[i] === 10 && ++lines >= CARD_CONTEXT_LINES) { to = i; break }
      const before = c.subarray(from, e.start_byte).toString('utf8'), span = c.subarray(e.start_byte, Math.min(e.end_byte, to)).toString('utf8')
      return { ...site, context: { start_line: e.start_line as number, text: c.subarray(from, to).toString('utf8'), highlight: [before.length, before.length + span.length] } }
    }
    const types = (input.types as string[] | undefined) ?? ['calls']
    const offset = (input.offset as number | undefined) ?? 0
    const notes = new Set<string>()
    let more = false
    const side = (direction: 'in' | 'out') => {
      if (input.direction && input.direction !== direction) return null
      const r = IMPL.get_relationships({ ...ctx, page: { ...ctx.page, offset } }, { subject_id: symbol.id, direction, types, include_external: true })
      for (const l of r.limitations ?? []) notes.add(l)
      more ||= !!r.more
      const d = r.data as { relationships: Array<Record<string, unknown> & { evidence_ids: string[] }>; totals: { in: number; out: number } }
      const total = d.totals[direction]
      return { rows: d.relationships.map((row) => ({ ...row, evidence: cited(row.evidence_ids[0]) })), total, next_offset: offset + d.relationships.length < total ? offset + d.relationships.length : null }
    }
    const incoming = side('in'), outgoing = side('out')
    return {
      data: { symbol, declaration, incoming, outgoing },
      evidence_ids: [decl.id, ...[incoming, outgoing].flatMap((s) => s?.rows.flatMap((r) => r.evidence_ids) ?? [])],
      stop_reasons: more ? ['max_rows'] : [], limitations: [...notes, ...(more ? ['Each side lists its first rows; pass direction and its next_offset as offset for the rest.'] : [])],
      // A row that does not fit max_bytes is cut from the end of each side; next_offset still counts from what was listed.
      shrink: ['outgoing.rows', 'incoming.rows'],
      prune: (data) => { for (const s of [data.incoming, data.outgoing] as Array<{ rows: unknown[]; total: number; next_offset: number | null } | null>) if (s) s.next_offset = offset + s.rows.length < s.total ? offset + s.rows.length : null },
    }
  },
}
/** Most lines of source a card row carries of its call site. */
const CARD_CONTEXT_LINES = 8

/** What impact_completeness says about candidate edges: for the changed symbols that followed them, and for those that did not (FR209). */
const inferredNotesFor = (done: Array<{ follow: { on: boolean; asked: boolean }; sites: { followable: number; capped: number } }>): string[] => {
  const group = (on: boolean) => done.filter((d) => d.follow.on === on)
  const sum = (list: typeof done) => ({ followable: list.reduce((n, d) => n + d.sites.followable, 0), capped: list.reduce((n, d) => n + d.sites.capped, 0) })
  const followed = group(true)
  return [...(followed.length ? inferredNotes({ on: true, asked: followed.some((d) => d.follow.asked) }, sum(followed), followed.length) : []), ...inferredNotes({ on: false, asked: group(false).some((d) => d.follow.asked) }, sum(group(false)), 0)]
}

/** Whether a snapshot analyses a path. */
const indexed = (db: Database.Database, p: string) => !!db.prepare("select 1 from file where path = ? and disposition = 'indexed'").get(p)

/** An index job run by the ordinary CLI in its own process, so a crash cannot take the server down; the job row carries its progress. */
function startIndex(ctx: Ctx, rev?: string): { id: string; created: boolean } {
  const job = ctx.catalog.requestJob(ctx.repo.id, 'tool')
  // A commit indexed for impact_completeness leaves the current snapshot as it was.
  if (job.created) spawn(process.execPath, [cliPath(), '--data-dir', ctx.dataDir, 'index', ctx.repo.id, '--job', job.id, ...(rev ? ['--rev', rev, '--keep-current'] : [])], { detached: true, stdio: 'ignore' }).unref()
  return job
}

/** The CLI entry beside this module's package, found by walking up, so jobs run the same build that serves the request. */
export function cliPath(): string {
  if (process.env.PROOFMESH_CLI) return process.env.PROOFMESH_CLI
  for (let dir = import.meta.dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'bin', 'proofmesh.mjs')
    if (fs.existsSync(candidate)) return candidate
  }
  throw new ProofmeshError('INTERNAL_ERROR', 'cannot find the proofmesh CLI to run the index job')
}
