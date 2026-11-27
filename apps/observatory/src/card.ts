// The Proof lens's data (FR1180 to FR1186): a get_symbol_card answer as rows a reader walks, and the words each row says. No DOM,
// so it is testable without a browser.
import type { Relationship, RelationshipsEnvelope } from './explore'
import { glyph } from './scene'

export type Cited = { id: string; path: string; start_line: number; end_line: number; integrity: { status: string }; context: { start_line: number; text: string; highlight: [number, number] } | null }
export type CardRow = Relationship & { basis?: 'observed' | 'inferred'; evidence_ids: string[]; evidence: Cited | null; via?: { id: string; qualified_name: string } }
export type CardSide = { rows: CardRow[]; total: number; next_offset: number | null }
export type CardSymbol = { id: string; kind: string; name: string; qualified_name: string; path: string; start_line: number; signature: string | null }
export type Card = {
  symbol: CardSymbol
  declaration: { id: string; path: string; start_line: number; end_line: number; object_hash: string; extractor: string; extractor_version: string; analysis_mode: string; integrity: { status: string }; text: string | null }
  incoming: CardSide; outgoing: CardSide
}
/** What the evidence panel shows: the cited span, when there is one, is highlighted inside the text. */
export type Evidence = { title: string; facts: Array<[string, string]>; integrity: string; text: string | null; highlight?: [number, number]; focusId?: string; view?: string }

/** Rows per side in the first answer; the rest page in as the list scrolls (FR058). */
export const CARD_ROWS = 24

/** The neighbourhood the Table view, the export and the conclusion read, from the rows the card holds. */
export const cardHood = (c: Card): RelationshipsEnvelope => ({
  data: { relationships: [...c.outgoing.rows, ...c.incoming.rows], boundaries: [], totals: { in: c.incoming.total, out: c.outgoing.total } },
  completion: { truncated: c.incoming.next_offset !== null || c.outgoing.next_offset !== null },
})

/** A row's name: the symbol or external it reaches, or for an unresolved call the call as written. */
export function rowName(r: CardRow): string {
  if (r.other.kind === 'symbol') return glyph(r.other.symbol_kind) + r.other.name!
  if (r.other.kind === 'external' || r.other.kind === 'file') return r.other.name!
  const c = r.evidence?.context
  return c ? c.text.slice(c.highlight[0], c.highlight[1]).replace(/\s+/g, ' ') : r.detail?.callee ?? r.reason ?? r.resolution
}

/**
 * How a row is known, in words, so it never rests on colour (FR057, FR1183): observed or inferred for a relationship, and for an
 * unresolved call `unresolved · <reason>`, since a site with no target is not a relationship. Then what else a plain row would hide.
 */
export function rowWords(r: CardRow): string[] {
  if (r.resolution === 'unresolved') return ['unresolved', r.reason ?? 'unknown']
  return [
    r.basis ?? 'observed',
    ...(r.type !== 'calls' ? [r.type] : []),
    ...(r.other.kind === 'external' ? ['external'] : []),
    ...(r.resolution === 'candidate' || r.resolution === 'ambiguous' ? [r.resolution] : []),
    ...(r.via ? ['dispatch'] : []),
  ]
}
/** The marker's kind: solid for observed, dashed for inferred, dotted for an unresolved call; each has its own glyph too. */
export const rowMark = (r: CardRow): 'observed' | 'inferred' | 'unresolved' => (r.resolution === 'unresolved' ? 'unresolved' : r.basis ?? 'observed')
export const MARK_GLYPH = { observed: '●', inferred: '◌', unresolved: '┄' } as const

/** The evidence panel for a row: its call site's lines with the cited span highlighted, from the card alone. */
export function rowEvidence(r: CardRow): Evidence {
  const e = r.evidence
  return {
    title: `${rowName(r)} · ${rowWords(r).join(' · ')}`,
    facts: [['origin', r.origin], ['file', e ? `${e.path}:${e.start_line}` : `${r.site.path}:${r.site.start_line}`], ...(r.via ? [['via', r.via.qualified_name] as [string, string]] : [])],
    integrity: e?.integrity.status ?? 'unavailable', text: e?.context?.text ?? null, ...(e?.context ? { highlight: e.context.highlight } : {}),
    ...(r.other.kind === 'symbol' && r.other.id ? { focusId: r.other.id } : {}),
  }
}

/** The evidence panel for the focus: its declaration. */
export const declarationEvidence = (c: Card): Evidence => {
  const ev = c.declaration
  return {
    title: c.symbol.qualified_name,
    facts: [['kind', c.symbol.kind], ['file', `${ev.path}:${ev.start_line}–${ev.end_line}`], ['extractor', `${ev.extractor} ${ev.extractor_version}`], ['analysis', ev.analysis_mode], ['hash', ev.object_hash.slice(0, 12)]],
    integrity: ev.integrity.status, text: ev.text,
  }
}

/** A side with the next page's rows appended. */
export const appendSide = (side: CardSide, next: CardSide): CardSide => ({ rows: [...side.rows, ...next.rows], total: next.total, next_offset: next.next_offset })
