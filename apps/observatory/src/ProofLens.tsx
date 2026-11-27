// The Proof lens (FR1183, FR1184): callers, the focus and callees as rows, each with its call site and how it is known. Drawn with the
// DOM, so it opens with no renderer to start; the keyboard walks it like a grid of three lists.
import { useEffect, useRef, useState } from 'react'
import { declarationEvidence, MARK_GLYPH, rowEvidence, rowMark, rowName, rowWords, type Card, type CardRow, type Evidence } from './card'
import { visible } from './visible'

export type Hop = { id: string; name: string; qualifiedName: string; site: { path: string; start_line: number } | null; basis: string | null }
export type Chain = { hops: Hop[]; basis: string; conclusion: string }
type Hover = (id: string | undefined) => { onMouseEnter: () => void; onMouseLeave: () => void }
type Props = { card: Card; chain: Chain | null; onOpen: (e: Evidence) => void; onFocus: (id: string) => void; onMore: (side: 'in' | 'out') => void; hover: Hover }

const SIDES = [{ key: 'incoming', label: 'Callers', side: 'in' }, null, { key: 'outgoing', label: 'Callees', side: 'out' }] as const

export function ProofLens({ card, chain, onOpen, onFocus, onMore, hover }: Props) {
  const [at, setAt] = useState({ col: 1, row: [0, 0, 0] })
  const lists = useRef<Array<HTMLUListElement | null>>([])
  // A newly opened symbol takes the keyboard, so a reader walks its rows at once (FR1184).
  useEffect(() => { setAt({ col: 1, row: [0, 0, 0] }); lists.current[1]?.focus({ preventScroll: true }) }, [card.symbol.id])
  const rows = (c: number): CardRow[] => (c === 1 ? [] : card[SIDES[c]!.key].rows)
  const len = (c: number) => (c === 1 ? 1 : rows(c).length)
  const open = (c: number, i: number) => onOpen(c === 1 ? declarationEvidence(card) : rowEvidence(rows(c)[i]!))
  const more = (c: number, i: number) => { if (c !== 1 && i >= len(c) - 1 && card[SIDES[c]!.key].next_offset !== null) onMore(SIDES[c]!.side) }
  const id = (c: number, i: number) => `lens-${c}-${i}`
  useEffect(() => { document.getElementById(id(at.col, at.row[at.col]!))?.scrollIntoView?.({ block: 'nearest' }) }, [at])

  const onKeyDown = (e: React.KeyboardEvent) => {
    let { col } = at
    let r = at.row[col]!
    if (e.key === 'ArrowDown') { r = Math.min(len(col) - 1, r + 1); more(col, r) }
    else if (e.key === 'ArrowUp') r = Math.max(0, r - 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // An empty side has nothing to stand on, so the move stays where it is.
      const next = col + (e.key === 'ArrowLeft' ? -1 : 1)
      if (next >= 0 && next <= 2 && len(next) > 0) { col = next; r = Math.min(at.row[col]!, len(col) - 1); lists.current[col]?.focus() }
    } else if (e.key === 'Enter') open(col, r)
    else if (e.key === 'f') { const o = rows(col)[r]?.other; if (o?.kind === 'symbol' && o.id) onFocus(o.id) }
    else return
    e.preventDefault()
    setAt({ col, row: at.row.map((x, i) => (i === col ? r : x)) })
  }

  const column = (c: number) => {
    const s = SIDES[c]
    const active = at.col === c
    const listProps = {
      ref: (el: HTMLUListElement | null) => { lists.current[c] = el },
      role: 'listbox', tabIndex: active ? 0 : -1, 'aria-activedescendant': len(c) ? id(c, at.row[c]!) : undefined, onKeyDown,
      onFocus: () => { if (!active && len(c)) setAt({ ...at, col: c }) },
    }
    if (!s) {
      const ev = card.declaration
      return (
        <section className="lens-col focus" key="focus">
          <h3>Focus</h3>
          <ul aria-label="Focus" {...listProps}>
            <li id={id(1, 0)} role="option" aria-selected={active} className="lens-row observed" onClick={() => { setAt({ ...at, col: 1 }); open(1, 0) }}>
              <span className="name">{visible(card.symbol.name)}</span>
              <span className="site">{card.symbol.kind} · {visible(ev.path)}:{ev.start_line}</span>
              <span className={`integrity ${ev.integrity.status}`}>integrity: {ev.integrity.status}</span>
            </li>
          </ul>
        </section>
      )
    }
    const side = card[s.key]
    return (
      <section className={`lens-col ${s.key}`} key={s.key}>
        <h3>{s.label} <span className="dim" data-testid={`${s.key}-count`}>{side.rows.length} of {side.total}</span></h3>
        <ul aria-label={s.label} {...listProps} onScroll={(e) => { const t = e.currentTarget; if (t.scrollTop + t.clientHeight >= t.scrollHeight - 40) more(c, len(c) - 1) }}>
          {side.rows.map((r, i) => {
            const mark = rowMark(r)
            return (
              <li key={r.assertion_id} id={id(c, i)} role="option" aria-selected={active && at.row[c] === i} className={`lens-row ${mark}`} data-mark={mark}
                onClick={() => { setAt({ col: c, row: at.row.map((x, j) => (j === c ? i : x)) }); open(c, i) }}
                onDoubleClick={() => { if (r.other.kind === 'symbol' && r.other.id) onFocus(r.other.id) }} {...hover(r.other.kind === 'symbol' ? r.other.id : undefined)}>
                <span className="mark" aria-hidden="true">{MARK_GLYPH[mark]}</span>
                <span className="name">{visible(rowName(r))}</span>
                <span className="site">{visible(r.site.path)}:{r.site.start_line}</span>
                <span className="words">{rowWords(r).join(' · ')}</span>
              </li>
            )
          })}
          {side.rows.length === 0 && <li className="dim" role="presentation">none</li>}
        </ul>
      </section>
    )
  }

  return (
    <section className="lens" aria-label="Proof lens">
      <div className="lens-cols">{[0, 1, 2].map(column)}</div>
      <p className="dim lens-help">↑ ↓ move between rows, ← → between columns, Enter opens the evidence, f makes the row the focus. ● observed · ◌ inferred · ┄ unresolved.</p>
      {chain && (
        <section className="lens-path" aria-label="Path">
          <h3>Path · <span data-testid="path-basis">{chain.basis}</span> <span className="dim">{chain.conclusion}</span></h3>
          <ol>
            {chain.hops.map((h, i) => (
              <li key={`${h.id}${i}`} className={`lens-row ${h.basis ?? 'observed'}`}>
                <span className="mark" aria-hidden="true">{h.basis ? MARK_GLYPH[h.basis as keyof typeof MARK_GLYPH] ?? "●" : '◎'}</span>
                <span className="name">{visible(h.name)}</span>
                <span className="site">{h.site ? `calls the next at ${visible(h.site.path)}:${h.site.start_line}` : 'target'}</span>
                <span className="words">{h.basis ?? ''}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  )
}
