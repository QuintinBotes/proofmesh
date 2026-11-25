import type Database from 'better-sqlite3'

// Reach through candidate edges (FR201 to FR210). A `candidate` row has one target and an `ambiguous` row up to five listed ones; neither is an
// edge in the snapshot, so a walk that follows them reads `assertion_candidate` itself and labels every row it reaches inferred.

/** The most candidates a site may list for a walk to follow it (FR176, FR202); a site with more carries `detail.more`. */
export const MAX_FOLLOWED = 5
/** Relationship types a candidate row can stand for in a walk: a call, a supertype. Imports are not followed. shortcut: a candidate import is no edge here; add it if file reach needs it. */
export const CANDIDATE_TYPES = ['calls', 'inherits', 'implements']

export type Follow = { on: boolean; asked: boolean }
export type Candidate = { src: string; dst: string; type: string; assertion_id: string }

const capped = (a = 'a') => `json_extract(${a}.detail, '$.more') is not null`
const marks = (n: number) => Array.from({ length: n }, () => '?').join(',')

/** The file of a symbol or file id, and whether only the syntax tier analysed it; undefined for an external or an unknown id. */
function syntaxOnly(db: Database.Database, id: string): boolean {
  const row = (id.startsWith('file_') ? db.prepare("select json_extract(capabilities, '$.tier') as tier from file where id = ?") : db.prepare("select json_extract(f.capabilities, '$.tier') as tier from symbol s join file f on f.id = s.file_id where s.id = ?")).get(id) as { tier: string | null } | undefined
  return row?.tier === 'syntax'
}

/**
 * Whether a walk follows candidate edges (FR201): true or false as asked; auto (the default) is true when every subject's file was analysed by the
 * syntax tier alone, so no compiler or index could have resolved its calls, and false otherwise, which leaves every answer for a precise tier as it was.
 */
export function resolveFollow(db: Database.Database, input: unknown, subjects: string[]): Follow {
  if (input === true || input === false) return { on: input, asked: true }
  return { on: subjects.length > 0 && subjects.every((id) => syntaxOnly(db, id)), asked: false }
}

/** The candidate edges a walk follows: those of candidate sites and of ambiguous sites that list every candidate they have, of the given types. */
function edges(db: Database.Database, column: 'dst' | 'src', ids: string[], types: readonly string[]): Candidate[] {
  const wanted = types.filter((t) => CANDIDATE_TYPES.includes(t))
  if (!wanted.length || !ids.length) return []
  const out: Candidate[] = []
  const where = column === 'dst' ? 'c.symbol_id' : 'a.source_id'
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    out.push(...(db.prepare(`select a.source_id as src, c.symbol_id as dst, a.type, a.id as assertion_id from assertion_candidate c join assertion a on a.id = c.assertion_id
      where ${where} in (${marks(chunk.length)}) and a.source_kind = 'symbol' and a.resolution in ('candidate', 'ambiguous') and not ${capped()} and a.type in (${marks(wanted.length)}) order by a.id, c.rank`).all(...chunk, ...wanted) as Candidate[]))
  }
  return out
}
/** The sites whose candidates name one of the nodes, the callers a walk backwards follows. */
export const candidatesTo = (db: Database.Database, ids: string[], types: readonly string[]) => edges(db, 'dst', ids, types)
/** The sites in one of the nodes, the calls a walk forwards follows. */
export const candidatesFrom = (db: Database.Database, ids: string[], types: readonly string[]) => edges(db, 'src', ids, types)

/** The candidate and ambiguous sites of the given types that name one of the nodes (side dst) or lie in one (side src): those a walk may follow, and those it never does for their cap. */
export function sitesNaming(db: Database.Database, ids: string[], types: readonly string[], side: 'dst' | 'src' = 'dst'): { followable: number; capped: number } {
  const wanted = types.filter((t) => CANDIDATE_TYPES.includes(t))
  const seen = new Map<string, boolean>()
  if (wanted.length) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      for (const r of db.prepare(`select distinct a.id, ${capped()} as capped from assertion_candidate c join assertion a on a.id = c.assertion_id where ${side === 'dst' ? 'c.symbol_id' : 'a.source_id'} in (${marks(chunk.length)}) and a.resolution in ('candidate', 'ambiguous') and a.type in (${marks(wanted.length)})`).all(...chunk, ...wanted) as Array<{ id: string; capped: number }>) seen.set(r.id, !!r.capped)
    }
  }
  const all = [...seen.values()]
  return { followable: all.filter((c) => !c).length, capped: all.filter((c) => c).length }
}

/**
 * What an answer says about candidate edges (FR209): that they were followed and why, how many sites it stopped at for their cap, or, when include_inferred
 * said not to follow, how many it did not. An answer that followed none and was not told so says nothing, so one for a precise tier keeps its bytes (FR204).
 */
export function inferredNotes(f: Follow, seen: { followable: number; capped: number }, subjects: number): string[] {
  if (f.on) {
    return [
      `Candidate edges were followed in every file the walk reached because ${f.asked ? 'include_inferred was true' : `${subjects === 1 ? "the subject's file has" : "the subjects' files have"} no precise tier`}: every row reached through one is inferred.`,
      ...(seen.capped ? [`${seen.capped} ambiguous site${seen.capped === 1 ? '' : 's'} naming code on these paths ${seen.capped === 1 ? 'lists' : 'list'} more than ${MAX_FOLLOWED} candidates and ${seen.capped === 1 ? 'was' : 'were'} not followed.`] : []),
    ]
  }
  const n = seen.followable + seen.capped
  return f.asked && n ? [`${n} candidate site${n === 1 ? '' : 's'} naming code on these paths ${n === 1 ? 'was' : 'were'} not followed; pass include_inferred true to follow ${n === 1 ? 'it' : 'them'}.`] : []
}
