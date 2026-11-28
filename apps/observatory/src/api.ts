import { parseGalaxySliced, rememberNames, type GalaxyData, type LoweredNames } from './galaxyData'

export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message) }
}

/** The snapshot Replay pins, or null for the current one; every query that can be pinned carries it (FR010). */
let replay: string | null = null
export const setReplay = (id: string | null) => { replay = id }
export const replaying = () => replay
/** Tools that act on the catalog or an index job, not on a snapshot. */
const UNPINNED = new Set(['request_index', 'get_job', 'save_memory'])

/** The repository every query is about; unset, the server answers for its only repository. Drill-down from the ecosystem view sets it (A11). */
let repositoryId: string | undefined
export const setRepository = (id: string | undefined) => { repositoryId = id }
const scoped = (input: Record<string, unknown>) => (repositoryId && !('workspace' in input) ? { repository_id: repositoryId, ...input } : input)

export async function callTool<T = any>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const pinned = replay && !UNPINNED.has(name) && !('snapshot_id' in input) ? { ...input, snapshot_id: replay } : input
  const r = await fetch(`/api/v1/tools/${name}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scoped(pinned)) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ToolError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? `HTTP ${r.status}`, r.status)
  return body as T
}

/** Exchange the launch token from the URL fragment for a session cookie, then drop the fragment. */
export async function establishSession(): Promise<void> {
  const m = /[#&]t=([0-9a-f]{64})/.exec(location.hash)
  if (!m) return
  history.replaceState(null, '', location.pathname + location.search)
  const r = await fetch('/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: m[1] }) })
  if (!r.ok) throw new ToolError('UNAUTHORIZED', 'This launch link was already used or has expired. Run "proofmesh view" again.', r.status)
}

/** The Galaxy payload format this page reads (packages/proofmesh/src/query/galaxy.ts); it is part of the payload's address. */
const GALAXY_FORMAT = 6
const galaxyAt = (snapshotId: string) => fetch(`/api/v1/galaxy/v${GALAXY_FORMAT}/${encodeURIComponent(snapshotId)}`, { credentials: 'same-origin', headers: { Accept: 'application/vnd.proofmesh.terrain' } })

/**
 * A snapshot's binary Galaxy payload, from the address that changes only with the snapshot and the format, so a reload is
 * served from the HTTP cache; the browser undoes the gzip transfer encoding (FR1453).
 */
export async function fetchGalaxy(snapshotId: string): Promise<ArrayBuffer> {
  let r = await galaxyAt(snapshotId)
  // gc retired the snapshot since the page learnt it was current: ask again for the current one. A replayed one is simply gone.
  if (r.status === 404 && !replay) r = await galaxyAt((await callTool('workspace_status', { limits: { max_rows: 1 } })).snapshot.id)
  if (!r.ok) { const body = await r.json().catch(() => ({})); throw new ToolError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? `HTTP ${r.status}`, r.status) }
  return r.arrayBuffer()
}

/** The payload parsed, with its names lowered for search, in a worker (FR1452); a page without workers parses it in slices. */
export function loadGalaxy(buf: ArrayBuffer): Promise<GalaxyData> {
  if (typeof Worker === 'undefined') return parseGalaxySliced(buf)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./galaxyWorker.ts', import.meta.url), { type: 'module' })
    let galaxy: GalaxyData | undefined
    // The payload comes first and is drawn; its lowered names follow, and a search before them lowers the names here.
    worker.onmessage = ({ data }: MessageEvent<{ galaxy: GalaxyData } | { names: LoweredNames }>) => {
      if ('galaxy' in data) resolve(galaxy = data.galaxy)
      else { worker.terminate(); rememberNames(galaxy!, data.names) }
    }
    worker.onerror = (e) => { worker.terminate(); reject(new Error(`the Galaxy could not be read: ${e.message}`)) }
    worker.postMessage(buf, [buf])
  })
}

export async function galaxySymbolId(index: number): Promise<string> {
  return (await galaxySymbol(index)).id
}

/** A galaxy point's symbol id, and with `card` (the get_symbol_card input) its card in the same request (FR1180). */
export async function galaxySymbol(index: number, card?: Record<string, unknown>): Promise<{ id: string; card?: { data: unknown } }> {
  const r = await fetch('/api/v1/galaxy/symbol', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scoped({ index, ...(replay ? { snapshot_id: replay } : {}), ...(card ? { card } : {}) })) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ToolError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? `HTTP ${r.status}`, r.status)
  return body
}

/** The Galaxy point of each stable key in a snapshot, -1 where it has none (FR1813). */
export async function galaxyPoints(keys: string[], snapshotId: string): Promise<number[]> {
  const r = await fetch('/api/v1/galaxy/points', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scoped({ keys, snapshot_id: snapshotId })) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ToolError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? `HTTP ${r.status}`, r.status)
  return body.indices as number[]
}

export type BundleEnd = { id: string; qualified_name: string; path: string; start_line: number }
export type Bundle = {
  from: string; to: string; total: number; by_basis: { observed: number; inferred: number }; next_offset: number | null
  rows: Array<{ assertion_id: string; type: string; basis: 'observed' | 'inferred'; source: BundleEnd; target: BundleEnd; site: { path: string; start_line: number } | null }>
}

/** A page of the relationships a Terrain bundle stands for, from one area to another (FR1403). */
export async function fetchBundle(from: string, to: string, offset: number): Promise<Bundle> {
  const r = await fetch('/api/v1/galaxy/bundle', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scoped({ from, to, offset, ...(replay ? { snapshot_id: replay } : {}) })) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ToolError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? `HTTP ${r.status}`, r.status)
  return body as Bundle
}

export type SnapshotInfo = { id: string; published_at: string | null; analysis_mode: string; current: boolean; git: { available: boolean; reason?: string } | null; symbols: number | null; relationships: number | null; unresolved: number | null }

/** The repository's published snapshots, newest first, for Replay and Diff. */
export async function listSnapshots(): Promise<SnapshotInfo[]> {
  const r = await fetch('/api/v1/snapshots', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scoped({})) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ToolError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? `HTTP ${r.status}`, r.status)
  return body.snapshots as SnapshotInfo[]
}

export type Workspace = { name: string; members: Array<{ repository_id: string; name: string }> }
export async function fetchWorkspaces(): Promise<Workspace[]> {
  const r = await fetch('/api/workspaces', { credentials: 'same-origin' })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ToolError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? `HTTP ${r.status}`, r.status)
  return body.workspaces as Workspace[]
}
