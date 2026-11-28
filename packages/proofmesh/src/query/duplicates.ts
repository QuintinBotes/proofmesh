import type { EvidenceStore } from '../evidence/store.js'
import type Database from 'better-sqlite3'
import { hasBodyHash } from './compare.js'
import { excludeGeneratedSql } from './generated-policy.js'
import { rolesSql } from './tests.js'
import type { Changed } from './completeness.js'

export type Member = { id: string; key: string; name: string; kind: string; path: string; line: number; test: boolean }
type Group = { hash: string; tokens: number; members: number; callers_overlap: boolean; symbols: Member[] }
const DEFAULT_KINDS = ['method', 'function']
const FROM = 'from symbol s join file f on f.id = s.file_id'
// TypeScript indexes a callable interface member as a method even though the interface supplies no implementation.
const IMPLEMENTATION = `not (s.kind in ('function','method') and
  (f.path glob '*.pyi' or f.path glob '*.d.ts' or f.path glob '*.d.cts' or f.path glob '*.d.mts' or
   (s.kind = 'method' and f.language in ('typescript','javascript') and exists (
     select 1 from symbol owner where owner.file_id=s.file_id and owner.kind='interface'
     and owner.start_line <= s.start_line and owner.start_byte <= s.start_byte and owner.end_byte >= s.end_byte))))`
const MEMBER = 's.id, s.stable_key as key, s.name, s.kind, f.path, s.start_line as line'

type Body = { path: string; kind: string; content_hash: string; start_byte: number; end_byte: number }
const SPAN = 'f.path, s.kind, f.content_hash, s.start_byte, s.end_byte'

/** The sealed hash covers the whole declaration, including prototypes and ambient methods. Inspect a representative only after hashes match. */
function hasImplementation(store: EvidenceStore, span: Body) {
  if (!DEFAULT_KINDS.includes(span.kind) || !/\.(?:[cm]?[jt]sx?|cs|java|cc|cpp|c|h|hpp)$/i.test(span.path)) return true
  const bytes = store.read(span.content_hash)
  if (!bytes) return true // the sealed digest remains available when the source object is absent
  const text = bytes.toString('utf8', span.start_byte, span.end_byte).trim()
  if (/^(?:(?:export|default|public|protected|private|static|readonly|override|internal|unsafe|partial)\s+)*(?:abstract|declare)\b/.test(text)) return false
  if (!text.endsWith(';')) return true
  if (/\.(?:cs|java|cc|cpp|c|h|hpp)$/i.test(span.path)) return /=>/.test(text)
  // A TS method/function declaration with a block ends at its closing brace. An arrow/function initializer may end in a semicolon.
  return /(?:=>|=\s*(?:async\s+)?function\b)/.test(text)
}

/** Group on the full sealed digest. Only groups on the requested page need caller and member lookups. */
export function duplicateGroups(db: Database.Database, store: EvidenceStore, input: Record<string, unknown>, offset: number, limit: number) {
  const empty = { groups: [] as Group[], total_groups: 0, too_small: 0 }
  if (!hasBodyHash(db)) return { ...empty, status: 'no_body_hash' }
  const kinds = (input.kinds ?? DEFAULT_KINDS) as string[], min = Number(input.min_tokens ?? 30)
  const args: (number | string)[] = [...kinds]
  const test = `pm_is_test(f.path, ${rolesSql(db)})`
  const filters = [IMPLEMENTATION, 's.body_hash is not null', `s.kind in (${kinds.map(() => '?')})`]
  if (!input.include_generated) filters.push(excludeGeneratedSql())
  if (input.include_tests === false) filters.push(test + ' = 0')
  if (typeof input.path_prefix === 'string') {
    filters.push('instr(f.path, ?) = 1')
    args.push(input.path_prefix)
  }
  const where = FROM + ' where ' + filters.join(' and ')
  const scope = typeof input.subject_id === 'string' ? 's.id' : typeof input.path === 'string' ? 'f.path' : null
  const subject = String(input.subject_id ?? input.path)
  const tooSmall = db.prepare('select count(*) ' + where + ' and s.body_tokens < ?' + (scope ? ' and ' + scope + ' = ?' : '')).pluck().get(...args, min, ...(scope ? [subject] : [])) as number
  const candidates = db.prepare(`select min(s.id) as sample, s.body_hash as hash, max(s.body_tokens) as tokens, count(*) as members ${where}
    and s.body_tokens >= ? group by s.body_hash having count(*) > 1 ${scope ? 'and max(' + scope + ' = ?)' : ''}
    order by count(*) * max(s.body_tokens) desc, min(f.path), s.body_hash`).all(...args, min, ...(scope ? [subject] : [])) as Array<Pick<Group, 'hash' | 'members' | 'tokens'> & { sample: string }>
  const sample = db.prepare(`select ${SPAN} ${FROM} where s.id=?`)
  const grouped = candidates.filter((g) => hasImplementation(store, sample.get(g.sample) as Body))
  const members = db.prepare(`select ${MEMBER}, ${test} as test ${where} and s.body_hash = ? order by f.path, s.start_line, s.id`)
  const overlap = db.prepare(`select 1 from assertion where type = 'calls' and resolution = 'resolved' and target_id in (select value from json_each(?))
    group by source_id having count(distinct target_id) > 1 limit 1`)
  const groups = grouped.slice(offset, offset + limit).map((g) => {
    const rows = members.all(...args, g.hash) as Array<Omit<Member, 'test'> & { test: number }>
    return { members: g.members, tokens: g.tokens, hash: g.hash.slice(0, 12), callers_overlap: !!overlap.get(JSON.stringify(rows.map((s) => s.id))),
      symbols: rows.filter((s) => s.id !== input.subject_id).map((s) => ({ ...s, test: !!s.test })) }
  })
  return { groups, total_groups: grouped.length, too_small: tooSmall, status: scope && !grouped.length ? 'unique' : 'ok' }
}

/** A base member touched anywhere in the diff cannot count as an unchanged twin, even on another page. */
export function unchangedTwins(base: Database.Database, store: EvidenceStore, touched: Set<string>, page: Changed[]) {
  if (!hasBodyHash(base)) return []
  const original = base.prepare(`select s.body_hash, ${SPAN} ${FROM} where s.stable_key=? and s.body_tokens >= 30
    and s.kind in ('method', 'function') and ${IMPLEMENTATION} and ${excludeGeneratedSql()}`)
  const twins = base.prepare(`select ${MEMBER} ${FROM} where s.body_hash = ?
    and s.kind in ('method', 'function') and ${IMPLEMENTATION} and ${excludeGeneratedSql()} order by f.path, s.start_line, s.id`)
  return page.flatMap((s) => {
    if (s.change === 'added') return []
    const before = original.get(s.key) as (Body & { body_hash: string | null }) | undefined
    if (!before?.body_hash) return []
    const symbols = (twins.all(before.body_hash) as Omit<Member, 'test'>[]).filter((t) => !touched.has(t.key))
    if (symbols.length && !hasImplementation(store, before)) return []
    return symbols.length ? [{ changed_key: s.key, symbols }] : []
  })
}
