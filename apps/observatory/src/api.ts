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

/** The whole snapshot as the binary Galaxy payload; the browser undoes the gzip transfer encoding. */
export async function fetchGalaxy(): Promise<ArrayBuffer> {
  const r = await fetch('/api/v1/galaxy', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scoped(replay ? { snapshot_id: replay } : {})) })
  if (!r.ok) { const body = await r.json().catch(() => ({})); throw new ToolError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? `HTTP ${r.status}`, r.status) }
  return r.arrayBuffer()
}

export async function galaxySymbolId(index: number): Promise<string> {
  const r = await fetch('/api/v1/galaxy/symbol', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scoped(replay ? { index, snapshot_id: replay } : { index })) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ToolError(body?.error?.code ?? 'INTERNAL_ERROR', body?.error?.message ?? `HTTP ${r.status}`, r.status)
  return body.id as string
}

export type SnapshotInfo = { id: string; published_at: string | null; analysis_mode: string; current: boolean; git: { available: boolean; reason?: string } | null }

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
