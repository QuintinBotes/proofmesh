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

/** Group on the full sealed digest. Only groups on the requested page need caller and member lookups. */
export function duplicateGroups(db: Database.Database, input: Record<string, unknown>, offset: number, limit: number) {
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
  const grouped = db.prepare(`select s.body_hash as hash, max(s.body_tokens) as tokens, count(*) as members ${where}
    and s.body_tokens >= ? group by s.body_hash having count(*) > 1 ${scope ? 'and max(' + scope + ' = ?)' : ''}
    order by count(*) * max(s.body_tokens) desc, min(f.path), s.body_hash`).all(...args, min, ...(scope ? [subject] : [])) as Array<Pick<Group, 'hash' | 'members' | 'tokens'>>
  const members = db.prepare(`select ${MEMBER}, ${test} as test ${where} and s.body_hash = ? order by f.path, s.start_line, s.id`)
  const overlap = db.prepare(`select 1 from assertion where type = 'calls' and resolution = 'resolved' and target_id in (select value from json_each(?))
    group by source_id having count(distinct target_id) > 1 limit 1`)
  const groups = grouped.slice(offset, offset + limit).map((g) => {
    const rows = members.all(...args, g.hash) as Array<Omit<Member, 'test'> & { test: number }>
    return { ...g, hash: g.hash.slice(0, 12), callers_overlap: !!overlap.get(JSON.stringify(rows.map((s) => s.id))),
      symbols: rows.filter((s) => s.id !== input.subject_id).map((s) => ({ ...s, test: !!s.test })) }
  })
  return { groups, total_groups: grouped.length, too_small: tooSmall, status: scope && !grouped.length ? 'unique' : 'ok' }
}

/** A base member touched anywhere in the diff cannot count as an unchanged twin, even on another page. */
export function unchangedTwins(base: Database.Database, touched: Set<string>, page: Changed[]) {
  if (!hasBodyHash(base)) return []
  const twins = base.prepare(`select ${MEMBER} ${FROM} where s.body_hash = (select s.body_hash ${FROM} where s.stable_key = ?
    and s.body_tokens >= 30 and s.kind in ('method', 'function') and ${IMPLEMENTATION} and ${excludeGeneratedSql()}) and s.kind in ('method', 'function') and ${IMPLEMENTATION} and ${excludeGeneratedSql()}
    order by f.path, s.start_line, s.id`)
  return page.flatMap((s) => {
    if (s.change === 'added') return []
    const symbols = (twins.all(s.key) as Omit<Member, 'test'>[]).filter((t) => !touched.has(t.key))
    return symbols.length ? [{ changed_key: s.key, symbols }] : []
  })
}
