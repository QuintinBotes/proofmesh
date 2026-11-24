import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { EvidenceStore } from '../evidence/store.js'
import { canonicalJson } from '../core/hash.js'

/**
 * Reviewed expected facts for a fixture, in the format of fixtures/<name>/expected.json. Every section is optional; a section
 * present is a closed world: anything the adapter adds or leaves out is a difference.
 */
export type Expected = {
  dispositions?: Record<string, [string, string | null]>
  symbols?: Array<{ kind: string; qualified_name: string; lines: [number, number]; signature: string | null }>
  calls?: Array<Record<string, unknown>>
  imports?: Array<{ from: string; to: string; statement_lines: number[] }>
  structure?: Array<Record<string, unknown>>
}
export type Difference = { section: string; missing: string[]; unexpected: string[] }

/** What a snapshot holds, in the shape of each expected section. */
export function actualFacts(db: Database.Database, store: EvidenceStore): Required<Expected> {
  const slice = (evidenceId: string) => {
    const e = db.prepare('select object_hash, start_byte, end_byte from evidence where id = ?').get(evidenceId) as { object_hash: string; start_byte: number; end_byte: number }
    return fs.readFileSync(store.objectPath(e.object_hash)).subarray(e.start_byte, e.end_byte).toString('utf8')
  }
  const qn = (id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string } | undefined)?.qualified_name ?? id
  const external = (id: string) => db.prepare('select module, name from external_symbol where id = ?').get(id)
  const line = (evidenceId: string) => (db.prepare('select start_line from evidence where id = ?').get(evidenceId) as { start_line: number }).start_line
  const dispositions = Object.fromEntries((db.prepare('select path, disposition, disposition_detail from file').all() as Array<{ path: string; disposition: string; disposition_detail: string | null }>).map((r) => [r.path, [r.disposition, r.disposition_detail] as [string, string | null]]))
  const symbols = (db.prepare('select kind, qualified_name, start_line, end_line, signature from symbol').all() as Array<{ kind: string; qualified_name: string; start_line: number; end_line: number; signature: string | null }>)
    .map((r) => ({ kind: r.kind, qualified_name: r.qualified_name, lines: [r.start_line, r.end_line] as [number, number], signature: r.signature }))
  const calls = (db.prepare(`select a.resolution, a.reason, a.source_id, a.target_id, ae.evidence_id from assertion a join assertion_evidence ae on ae.assertion_id = a.id where a.type = 'calls'`).all() as Array<{ resolution: string; reason: string | null; source_id: string; target_id: string | null; evidence_id: string }>)
    .map((r) => ({ from: qn(r.source_id), line: line(r.evidence_id), site_text: slice(r.evidence_id), resolution: r.resolution, ...(r.resolution === 'resolved' ? { to: qn(r.target_id!) } : {}), ...(r.resolution === 'resolved_external' ? { external: external(r.target_id!) } : {}), ...(r.reason ? { reason: r.reason } : {}) }))
  const imports = (db.prepare(`select a.id, fs.path as from_path, ft.path as to_path from assertion a join file fs on fs.id = a.source_id join file ft on ft.id = a.target_id where a.type = 'imports'`).all() as Array<{ id: string; from_path: string; to_path: string }>)
    .map((r) => ({ from: r.from_path, to: r.to_path, statement_lines: (db.prepare('select e.start_line from assertion_evidence ae join evidence e on e.id = ae.evidence_id where ae.assertion_id = ? order by e.start_line').all(r.id) as Array<{ start_line: number }>).map((x) => x.start_line) }))
  const structure = (db.prepare(`select id, type, source_id, target_kind, target_id, detail from assertion where type in ('implements', 'inherits', 'overrides', 'depends_on', 'depends_on_package', 'contains')`).all() as Array<{ id: string; type: string; source_id: string; target_kind: string; target_id: string; detail: string | null }>)
    .map((r) => ({
      type: r.type, from: qn(r.source_id), ...(r.target_kind === 'external' ? { external: external(r.target_id) } : { to: qn(r.target_id) }), ...(r.detail ? { detail: JSON.parse(r.detail) } : {}),
      ...(r.type === 'implements' || r.type === 'inherits' ? { site_text: slice((db.prepare('select evidence_id from assertion_evidence where assertion_id = ?').get(r.id) as { evidence_id: string }).evidence_id) } : {}),
    }))
  return { dispositions, symbols, calls, imports, structure }
}

/** The differences between what a snapshot holds and the reviewed expected facts, section by section, as multisets. */
export function compare(expected: Expected, actual: Required<Expected>): Difference[] {
  const out: Difference[] = []
  for (const section of ['dispositions', 'symbols', 'calls', 'imports', 'structure'] as const) {
    const want = expected[section]
    if (want === undefined) continue
    const rows = (v: unknown) => (Array.isArray(v) ? v : Object.entries(v as object)).map((x) => canonicalJson(x))
    const left = rows(want), right = rows(actual[section])
    const counts = new Map<string, number>()
    for (const r of right) counts.set(r, (counts.get(r) ?? 0) + 1)
    const missing: string[] = []
    for (const r of left) { const n = counts.get(r) ?? 0; if (n) counts.set(r, n - 1); else missing.push(r) }
    const unexpected = [...counts].flatMap(([r, n]) => Array.from({ length: n }, () => r))
    if (missing.length || unexpected.length) out.push({ section, missing: missing.sort(), unexpected: unexpected.sort() })
  }
  return out
}
