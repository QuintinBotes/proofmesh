// Change review (FR1810 to FR1816): a diff's changed symbols and every dependent, on the Terrain and as a list, read from
// impact_completeness, with each row's chain from the same answer and its tests from find_tests. It decides no status itself.
import { useState } from 'react'
import { callTool, fetchGalaxy, galaxyPoints, loadGalaxy } from './api'
import { gate, hopText, MARK_WORDS, markAt, markCounts, marksOf, reviewRows, rowTitle, rowWords, sideText, summaryText, type Completeness, type Mark, type MarkKind, type Range, type Row } from './changeModel'
import type { GalaxyData } from './galaxyData'
import { terrainOf, type Terrain, type View } from './terrainModel'
import { visible } from './visible'
import { plural } from './plural'

export type Review = { range: Range; depth: number; data: Completeness; limitations: string[]; head: GalaxyData; base: GalaxyData | null; terrain: Terrain; rows: Row[]; marks: Mark[]; unplaced: number }
/** A find_tests row as the panel shows it: the test, its evidence and its chain to the subject. */
type Reach = { name: string; path: string; line: number; evidence: string; depth: number; chain: Array<{ name: string; path: string; line: number }> }

/**
 * Loads a review: impact_completeness for the range (every page of it, waiting while a side is indexed), then the head snapshot's
 * Terrain and, when a symbol was deleted, the base's, and where each row's key sits on them.
 */
export async function loadReview(range: Range, depth: number, onPending: (text: string) => void): Promise<Review> {
  const input = { base: range.base, ...(range.head ? { head: range.head } : {}), depth, limits: { max_rows: 1000 } }
  let env = await callTool('impact_completeness', input)
  while (env.data.pending.length) {
    const p = env.data.pending[0]
    onPending(`Indexing ${p.commit ? p.commit.slice(0, 12) : 'the working tree'} (job ${p.job_id}) so both sides have a snapshot…`)
    const job = (await callTool('get_job', { job_id: p.job_id })).data.job
    if (job.state === 'failed') throw new Error(`Indexing ${p.commit ?? 'the working tree'} failed: ${job.error?.message ?? 'see proofmesh jobs'}`)
    if (job.state === 'queued' || job.state === 'running') { await new Promise((t) => setTimeout(t, 1000)); continue }
    env = await callTool('impact_completeness', input)
  }
  const data = env.data as Completeness, limitations: string[] = [...(env.limitations ?? [])]
  for (let next = env.completion?.next_cursor; next;) {
    const more = await callTool('impact_completeness', { ...input, cursor: next })
    data.changed.push(...(more.data as Completeness).changed)
    next = more.completion?.next_cursor
  }
  const rows = reviewRows(data)
  const deleted = rows.filter((r) => !r.dependent && r.changed.change === 'deleted')
  if (!data.head.snapshot_id) throw new Error('Change review needs an indexed head snapshot')
  const [head, base] = await Promise.all([
    fetchGalaxy(data.head.snapshot_id).then(loadGalaxy),
    deleted.length && data.base.snapshot_id ? fetchGalaxy(data.base.snapshot_id).then(loadGalaxy) : Promise.resolve(null),
  ])
  // Rows are looked up by stable key: a deleted symbol's dependents come from base and are drawn where they are in head.
  const keyed = rows.filter((r) => (r.dependent ? r.dependent.key : r.changed.change !== 'deleted' && r.changed.key))
  const [headAt, baseAt] = await Promise.all([
    keyed.length ? galaxyPoints(keyed.map((r) => (r.dependent?.key ?? r.changed.key)!), data.head.snapshot_id!) : [],
    deleted.length && base ? galaxyPoints(deleted.map((r) => r.changed.key), data.base.snapshot_id!) : [],
  ])
  const terrain = terrainOf(head)
  const placed = marksOf(rows, terrain, new Map(keyed.map((r, i) => [r.id, headAt[i]!])), new Map(deleted.map((r, i) => [r.id, baseAt[i]!])))
  return { range, depth, data, limitations, head, base, terrain, rows, ...placed }
}

const COLOUR: Record<MarkKind, string> = { modified: '#f2b84b', added: '#6ee8a8', deleted: '#ff7b7b', changed: '#f2b84b', tested: '#6ee8a8', covered: '#80d8ff', neither: '#ff7b7b' }
/** One mark's shape at the origin (FR1814): dots and a cross for changed symbols, rings for dependents, each told apart by shape, not colour alone. */
function Shape({ kind }: { kind: MarkKind }) {
  const c = COLOUR[kind]
  if (kind === 'modified') return <><circle r={4.5} fill={c} /><circle r={8} fill="none" stroke={c} strokeWidth={2} /></>
  if (kind === 'added') return <circle r={5} fill={c} />
  if (kind === 'deleted') return <path d="M-5,-5L5,5M5,-5L-5,5" stroke={c} strokeWidth={2.5} />
  if (kind === 'tested') return <><circle r={11} fill="none" stroke={c} strokeWidth={1.5} /><circle r={14.5} fill="none" stroke={c} strokeWidth={1.5} /></>
  return <circle r={12} fill="none" stroke={c} strokeWidth={2} strokeDasharray={kind === 'neither' ? '4 3' : kind === 'covered' ? '1 2' : undefined} />
}

/** The marks over the Terrain, placed for the view; a click on one opens its row. */
export function ChangeMarks({ review, view, open, onOpen }: { review: Review; view: View; open: string | null; onOpen: (r: Row) => void }) {
  return (
    <svg className="change-marks" width={view.width} height={view.height} aria-hidden="true">
      {review.marks.map((m, i) => {
        const at = markAt(m, review.head, review.base, view)
        if (!at) return null
        return (
          <g key={i} className={`change-mark ${m.kind}${m.row.id === open ? ' open' : ''}`} data-kind={m.kind} data-row={m.row.id} data-name={(m.row.dependent ?? m.row.changed).name} transform={`translate(${at.x},${at.y})`} onClick={() => onOpen(m.row)}>
            <title>{visible(m.title)}</title>
            <Shape kind={m.kind} />
          </g>
        )
      })}
    </svg>
  )
}

/** How far a list goes before it is drawn a window at a time (FR058). */
const WINDOW = 500, ROW_PX = 26

/** The left panel: what to compare, the summary and gate, the legend, and every row (FR1810, FR1814, FR1815). */
export function ChangeControls({ review, range, depth, pending, open, onReview, onOpen }: {
  review: Review | null; range: Range | null; depth: number; pending: string | null; open: string | null
  onReview: (range: Range, depth: number) => void; onOpen: (r: Row) => void
}) {
  const [base, setBase] = useState(range?.base ?? 'HEAD~1'), [head, setHead] = useState(range?.head ?? 'HEAD')
  const [top, setTop] = useState(0)
  const rows = review?.rows ?? []
  const big = rows.length > WINDOW
  const first = big ? Math.max(0, Math.floor(top / ROW_PX) - 20) : 0, last = big ? Math.min(rows.length, first + 80) : rows.length
  const counts = markCounts(rows), g = review && gate(review.data.totals)
  return (
    <>
      <form className="change-form" aria-label="Change" onSubmit={(e) => { e.preventDefault(); if (base.trim()) onReview({ base: base.trim(), head: head.trim() || null }, depth) }}>
        <label htmlFor="change-base">Base</label>
        <input id="change-base" value={base} onChange={(e) => setBase(e.target.value)} spellCheck={false} autoComplete="off" />
        <label htmlFor="change-head">Head <span className="dim">(empty: the working tree)</span></label>
        <input id="change-head" value={head} onChange={(e) => setHead(e.target.value)} spellCheck={false} autoComplete="off" />
        <label htmlFor="change-depth">Depth</label>
        <select id="change-depth" value={depth} onChange={(e) => { const d = Number(e.target.value); if (review) onReview(review.range, d); else if (base.trim()) onReview({ base: base.trim(), head: head.trim() || null }, d) }}>
          {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button type="submit">Review</button>
      </form>
      {pending && <p className="dim" role="status">{visible(pending)}</p>}
      {review && g && (
        <section aria-label="Change summary">
          <p className="dim">{visible(sideText(review.data.base))} → {visible(sideText(review.data.head))}</p>
          <p data-testid="change-summary">{summaryText(review.data.totals)}</p>
          <p className={`gate ${g.passing ? 'passing' : 'failing'}`} data-testid="change-gate">Gate {g.text}</p>
          <ul className="change-legend" aria-label="Change legend">
            {(Object.keys(MARK_WORDS) as MarkKind[]).filter((k) => k !== 'covered' || review.data.totals.covered !== undefined).map((k) => (
              <li key={k}><svg width="32" height="32" viewBox="-16 -16 32 32" aria-hidden="true"><Shape kind={k} /></svg> {MARK_WORDS[k]} <span className="count">{counts[k]}</span></li>
            ))}
          </ul>
          {review.unplaced > 0 && <p className="dim" role="note">{plural(review.unplaced, 'row')} {review.unplaced === 1 ? 'has' : 'have'} no place on the map; the list holds {review.unplaced === 1 ? 'it' : 'them'}.</p>}
        </section>
      )}
      {review && (
        <section aria-label="Changes and dependents">
          <h2>{plural(rows.length, 'row')}</h2>
          <ol className="change-rows" onScroll={(e) => setTop(e.currentTarget.scrollTop)} data-windowed={big || undefined}>
            {big && <li aria-hidden="true" style={{ height: first * ROW_PX }} />}
            {rows.slice(first, last).map((r) => {
              const status = r.dependent ? r.dependent.status : r.changed.change
              return (
                <li key={r.id} className={r.dependent ? 'dependent' : 'changed'} data-status={status} style={big ? { height: ROW_PX } : undefined}>
                  <button type="button" aria-pressed={open === r.id} title={visible(`${rowTitle(r)} ${rowWords(r)}`)} onClick={() => onOpen(r)}>
                    <span className="name">{visible(rowTitle(r))}</span> <span className="words">{visible(rowWords(r))}</span>
                  </button>
                </li>
              )
            })}
            {big && <li aria-hidden="true" style={{ height: (rows.length - last) * ROW_PX }} />}
          </ol>
        </section>
      )}
    </>
  )
}

/** The tests find_tests says reach a row's symbol or file, each with its evidence kind and chain (FR1810). */
export async function testsOf(r: Row): Promise<Reach[]> {
  const subject = r.dependent?.relation === 'imports' ? { paths: [r.dependent.path] } : { subject_ids: [(r.dependent ?? r.changed).id] }
  return (await callTool('find_tests', { ...subject, snapshot_id: r.snapshot, limits: { max_rows: 20 } })).data.tests as Reach[]
}

/** A row's evidence (FR1811): its chain from the row itself, every hop at its site, and the tests that reach it. */
export function ChangePanel({ row, tests, onClose }: { row: Row; tests: Reach[] | null | Error; onClose: () => void }) {
  const d = row.dependent, x = d ?? row.changed
  const executing = (t: Reach) => ['call', 'transitive_call', 'dispatch', 'observed'].includes(t.evidence)
  return (
    <aside className="right" aria-label="Evidence" data-testid="change-panel">
      <button type="button" className="close" aria-label="Close evidence" onClick={onClose}>×</button>
      <h2 className="ev-title">{visible(x.name)}</h2>
      <p data-testid="change-status">{visible(rowWords(row))}</p>
      {d ? (
        <section aria-label="Chain">
          <h3>Chain: how it depends on {visible(row.changed.name)}</h3>
          <ol className="change-chain">{d.chain.map((_, i) => <li key={i}>{visible(hopText(d.chain, i, d.relation))}</li>)}</ol>
          {row.changed.change === 'deleted' && <p className="dim" role="note">From the base snapshot: {visible(row.changed.name)} is gone in head, so this call no longer resolves there.</p>}
        </section>
      ) : <p className="dim">{row.changed.change} at {visible(`${row.changed.path}:${row.changed.line}`)}; {plural(row.changed.dependents.length, 'dependent')}.</p>}
      <section aria-label="Tests">
        <h3>Tests</h3>
        {d?.status === 'changed' && <p className="dim">Changed in this diff, so the gate needs no test of it.</p>}
        {tests instanceof Error ? <p className="error" role="alert">{visible(tests.message)}</p>
          : tests === null ? <p className="dim" role="status">Asking find_tests…</p>
          : tests.length === 0 ? <p className="dim">{d?.status === 'covered' ? 'The coverage report records execution without naming a test.' : 'No test reaches it.'}</p>
          : (
            <ul className="change-tests">
              {tests.map((t, i) => (
                <li key={i} data-executing={executing(t)}>
                  <b>{visible(`${t.name} ${t.path}:${t.line}`)}</b> <span className="evidence">{t.evidence} depth={t.depth}</span>
                  {!executing(t) && x.status === 'neither' && <span className="dim"> runs none of it, so it stays neither</span>}
                  {t.chain.length > 0 && <ol className="change-chain">{t.chain.map((h, j) => <li key={j}>{visible(`${h.name} ${h.path}:${h.line}`)}</li>)}</ol>}
                </li>
              ))}
            </ul>
          )}
      </section>
      <p className="dim">From snapshot {row.snapshot.slice(0, 13)}.</p>
    </aside>
  )
}
