// get_ecosystem (A11, A28): a workspace's repositories as nodes and the links between them as edges, read from one sealed link
// file and the member snapshots it was built from. Every file is opened read-only; nothing is matched at query time.
import Database from 'better-sqlite3'
import { ProofmeshError } from '../core/errors.js'
import type { Envelope, Limits } from '../core/generated.js'
import { queryId } from '../core/hash.js'
import { ENVELOPE_VERSION } from '../core/schemas.js'
import { applyLimits } from '../core/limits.js'
import { Catalog, type LinkFileRecord } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'
import { partialLimitations, snapshotSummary } from './summary.js'

export { openLinkFile } from '../links/index.js'
import { openLinkFile } from '../links/index.js'

type LinkRow = { id: string; type: string; rule: string; source_repository_id: string; source_symbol_id: string; target_repository_id: string | null; target_symbol_id: string | null; confidence: number; resolution: string; reason: string | null }
type Coverage = NonNullable<Envelope['coverage']>
type Capability = Coverage['capabilities'][keyof Coverage['capabilities']]
const RANK: Record<Capability, number> = { complete: 0, partial: 1, unsupported: 2, not_run: 3, failed: 4 }
const SAMPLE = 5

/** `now` is the clock the deadline is read from; a test passes its own. */
export function getEcosystem(dataDir: string, input: Record<string, unknown>, now: () => number = Date.now): Envelope {
  // The input schema admits no freshness: a workspace tool answers only from its sealed link file.
  const started = now()
  const { applied, limitations: clampNotes } = applyLimits(input.limits as Limits | undefined)
  const catalog = Catalog.open(dataDir)
  try {
    const workspace = catalog.workspace(String(input.workspace))
    const record = input.link_file_id ? catalog.linkFile(String(input.link_file_id)) : catalog.latestLinkFile(workspace.name)
    if (!record || record.workspace !== workspace.name) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', input.link_file_id ? `no link file ${String(input.link_file_id)} for workspace ${workspace.name}` : `no link file for workspace ${workspace.name}; run "proofmesh workspace link ${workspace.name}" first`, { detail: 'none' })
    const links = openLinkFile(catalog, record)
    const members = new Map<string, { db: Database.Database; name: string; snapshot_id: string }>()
    try {
      const meta = Object.fromEntries((links.prepare('select key, value from meta').all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]))
      for (const m of links.prepare('select repository_id, snapshot_id, name from member order by repository_id').all() as Array<{ repository_id: string; snapshot_id: string; name: string }>) {
        const snapshot = catalog.snapshot(m.snapshot_id)
        if (!snapshot) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `member snapshot ${m.snapshot_id} of link file ${record.id} is not in the catalog`, { detail: 'missing' })
        members.set(m.repository_id, { db: openSnapshot(catalog, snapshot), name: m.name, snapshot_id: m.snapshot_id })
      }
      const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n
      const keyOf = (repo: string, symbolId: string | null) => (symbolId ? (members.get(repo)?.db.prepare('select stable_key from symbol where id = ?').get(symbolId) as { stable_key: string } | undefined)?.stable_key : undefined)
      const qn = (repo: string, symbolId: string | null) => (symbolId ? (members.get(repo)?.db.prepare('select qualified_name from symbol where id = ?').get(symbolId) as { qualified_name: string } | undefined)?.qualified_name ?? symbolId : null)

      const data = {
        workspace: { name: workspace.name, link_file_id: record.id, sealed_at: record.sealed_at, rules: JSON.parse(meta.rules ?? '{}') as Record<string, string> },
        members: [...members].map(([repository_id, m]) => ({
          repository_id, name: m.name, snapshot_id: m.snapshot_id, current: catalog.currentSnapshot(repository_id)?.id === m.snapshot_id,
          symbols: count(m.db, 'select count(*) as n from symbol'), files_indexed: count(m.db, "select count(*) as n from file where disposition = 'indexed'"),
          endpoints: count(m.db, "select count(*) as n from symbol where kind = 'endpoint'"), channels: count(m.db, "select count(*) as n from symbol where kind = 'channel'"), projects: count(m.db, "select count(*) as n from symbol where kind = 'project'"),
        })),
        links: [] as Array<Record<string, unknown>>,
        boundaries: [] as Array<Record<string, unknown>>,
      }
      const rows = links.prepare('select * from link order by source_repository_id, type, id').all() as LinkRow[]
      const pairs = new Map<string, { source_repository_id: string; target_repository_id: string; type: string; resolved: number; candidate: number; min_confidence: number; max_confidence: number; sample: unknown[] }>()
      const bounds = new Map<string, { repository_id: string; type: string; count: number; sample: unknown[] }>()
      const candidates = links.prepare('select target_repository_id, target_symbol_id, confidence from link_candidate where link_id = ? order by confidence desc, target_repository_id, target_symbol_id')
      for (const l of rows) {
        if (l.resolution === 'unresolved') {
          const key = `${l.source_repository_id}|${l.type}`
          const b = bounds.get(key) ?? { repository_id: l.source_repository_id, type: l.type, count: 0, sample: [] }
          b.count++
          if (b.sample.length < SAMPLE) b.sample.push({ link_id: l.id, source: qn(l.source_repository_id, l.source_symbol_id), source_key: keyOf(l.source_repository_id, l.source_symbol_id), reason: l.reason ?? 'no_match' })
          bounds.set(key, b)
          continue
        }
        // A candidate link names no target of its own; each of its candidates counts toward that candidate's pair.
        const targets = l.resolution === 'resolved' ? [{ target_repository_id: l.target_repository_id!, target_symbol_id: l.target_symbol_id, confidence: l.confidence }] : (candidates.all(l.id) as Array<{ target_repository_id: string; target_symbol_id: string | null; confidence: number }>)
        for (const t of targets) {
          const key = `${l.source_repository_id}|${t.target_repository_id}|${l.type}`
          const p = pairs.get(key) ?? { source_repository_id: l.source_repository_id, target_repository_id: t.target_repository_id, type: l.type, resolved: 0, candidate: 0, min_confidence: t.confidence, max_confidence: t.confidence, sample: [] }
          if (l.resolution === 'resolved') p.resolved++; else p.candidate++
          p.min_confidence = Math.min(p.min_confidence, t.confidence); p.max_confidence = Math.max(p.max_confidence, t.confidence)
          if (p.sample.length < SAMPLE) p.sample.push({ link_id: l.id, source: qn(l.source_repository_id, l.source_symbol_id), source_key: keyOf(l.source_repository_id, l.source_symbol_id), target: qn(t.target_repository_id, t.target_symbol_id), target_key: keyOf(t.target_repository_id, t.target_symbol_id), confidence: t.confidence, rule: l.rule })
          pairs.set(key, p)
        }
      }
      data.links = [...pairs.values()]
      data.boundaries = [...bounds.values()]
      const stop = new Set<'max_rows' | 'max_bytes' | 'timeout'>()
      if (data.links.length > applied.max_rows) { data.links.length = applied.max_rows; stop.add('max_rows') }

      // Coverage spans the members: counts add up, and a capability is as weak as its weakest member.
      const summaries = [...members.values()].map((m) => snapshotSummary(m.db, m.snapshot_id))
      const dispositions = { indexed: 0, excluded_by_rule: 0, unsupported: 0, failed: 0, pending: 0 }
      for (const s of summaries) for (const k of Object.keys(dispositions) as Array<keyof typeof dispositions>) dispositions[k] += s.dispositions[k]
      const capabilities = Object.fromEntries((Object.keys(RANK) as never[]).length ? (Object.keys(summaries[0]?.capabilities ?? {}) as Array<keyof Coverage['capabilities']>).map((k) => [k, summaries.map((s) => s.capabilities[k]).sort((a, b) => RANK[b] - RANK[a])[0]]) : []) as Coverage['capabilities']
      const unresolvedCount = rows.filter((l) => l.resolution === 'unresolved').length
      const limitations = [...[...members.values()].flatMap((m) => partialLimitations(m.db, m.snapshot_id)), ...clampNotes, 'Links are matched from the member snapshots the link file was built from; a member whose current snapshot is newer is marked current: false until the workspace is linked again.', ...(unresolvedCount ? [`${unresolvedCount} client fact${unresolvedCount === 1 ? '' : 's'} matched nothing in this workspace; each is a boundary, not an absence of a counterpart elsewhere.`] : [])]
      const build = (): Envelope => ({
        schema_version: ENVELOPE_VERSION, query_id: queryId(), tool: 'get_ecosystem',
        snapshot: { id: record.id, repository_id: `ws_${workspace.name}`, analysis_mode: 'no_execution', published_at: record.sealed_at, members: record.members },
        freshness: { mode: 'snapshot', status: 'as_of_snapshot' },
        coverage: { inventory_complete: true, files_discovered: summaries.reduce((n, s) => n + s.files_discovered, 0), dispositions, capabilities },
        data, evidence_ids: [],
        unresolved: { count: unresolvedCount, scope: 'query', sample: [], by_reason: rows.filter((l) => l.resolution === 'unresolved').reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.reason ?? 'no_match']: (acc[l.reason ?? 'no_match'] ?? 0) + 1 }), {}) },
        completion: { truncated: stop.size > 0, stop_reasons: (['max_rows', 'max_bytes', 'timeout'] as const).filter((s) => stop.has(s)), timed_out: stop.has('timeout'), next_cursor: null },
        limits: { requested: (input.limits as Limits | undefined) ?? {}, applied },
        limitations: stop.size ? [...limitations, 'Results were truncated and this tool does not page; raise the limits.'] : limitations,
      })
      // The budget is the whole answer's, measured with the note and flags a cut adds. Links go first, then the unresolved boundaries.
      const size = (e: Envelope) => Buffer.byteLength(JSON.stringify(e))
      // The deadline is read again after every cut, so one that passes while trimming is reported.
      let out: Envelope
      for (;;) {
        if (now() - started > applied.timeout_ms) stop.add('timeout')
        out = build()
        if (size(out) <= applied.max_bytes || !(data.links.length || data.boundaries.length)) break
        (data.links.length ? data.links : data.boundaries).pop(); stop.add('max_bytes')
      }
      if (size(out) > applied.max_bytes) throw new ProofmeshError('INVALID_ARGUMENT', `max_bytes ${applied.max_bytes} is too small for a get_ecosystem answer; its envelope alone takes ${size(out)} bytes`, { detail: 'max_bytes_too_small', max_bytes: applied.max_bytes, needed: size(out) })
      return out
    } finally {
      links.close()
      for (const m of members.values()) m.db.close()
    }
  } finally {
    catalog.close()
  }
}
