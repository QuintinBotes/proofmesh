import type { SnapshotInfo } from './api'
import { visible } from './visible'
import { shareText, UNDRAWN, type Mark, type MarkChange } from './time'

const WORDS: Array<[MarkChange, string, string]> = [
  ['added', 'added', 'a filled dot where it now is'], ['removed', 'removed', 'a ghost cross where it was'], ['changed', 'changed', 'a ring: its body or signature changed'],
  ['moved', 'moved', 'a dot that slides from where it was'], ['members', 'changed through members', 'not ringed: a member it holds was added, removed or changed'],
  ['lines', 'moved lines', 'not ringed: only its line range changed, so its declaration did not'],
]
const when = (s: SnapshotInfo) => (s.published_at ? new Date(s.published_at).toLocaleString() : 'unpublished')

/**
 * Time's scrubber and strip (FR1761): every published snapshot newest first, with its symbols and unresolved share; the scrubber runs
 * oldest to newest. Choosing one pins every view to it (FR010); the step's counts and legend follow (FR1762).
 */
export function TimeStrip({ snapshots, shown, onGo, step }: {
  snapshots: SnapshotInfo[]; shown: string; onGo: (id: string) => void
  step: { base: string; counts: Record<MarkChange, number>; truncated: boolean; marks: Mark[] } | null
}) {
  const oldest = [...snapshots].reverse(), at = oldest.findIndex((s) => s.id === shown)
  return (
    <section className="time" aria-label="Time">
      <label htmlFor="time-scrubber">Time: <kbd>[</kbd> older, <kbd>]</kbd> newer</label>
      <input id="time-scrubber" type="range" min={0} max={oldest.length - 1} step={1} value={Math.max(0, at)} aria-keyshortcuts="[ ]"
        aria-valuetext={at >= 0 ? `${shown.slice(0, 13)}, ${when(oldest[at]!)}` : undefined} onChange={(e) => onGo(oldest[Number(e.target.value)]!.id)} />
      <ol className="time-strip" aria-label="Snapshots, newest first">
        {snapshots.map((s) => (
          <li key={s.id}>
            <button type="button" data-snapshot={s.id} aria-current={s.id === shown || undefined} onClick={() => onGo(s.id)}>
              <span><span className="snap">{s.id.slice(0, 13)}</span> · {when(s)}{s.current ? ' (current)' : ''}</span>
              <span className="dim">{shareText(s)}</span>
            </button>
          </li>
        ))}
      </ol>
      {step && (
        <>
          <p role="status" data-testid="time-counts">Since {step.base.slice(0, 13)}: {WORDS.map(([c, word]) => `${step.counts[c].toLocaleString('en')} ${word}`).join(', ')}.{step.truncated ? ' The comparison was cut at its row limit: the counts are complete, the marks are not.' : ''}</p>
          <div className="time-key dim">{WORDS.map(([c, word, how]) => <span key={c}>{UNDRAWN.has(c) ? null : <i className={`time-mark ${c}`} aria-hidden="true" />}<b>{word}</b>: {how}</span>)}</div>
          <details>
            <summary>List the changes</summary>
            <table aria-label="Changes in this step">
              <thead><tr><th>Change</th><th>Symbol</th></tr></thead>
              <tbody>{step.marks.map((m) => <tr key={`${m.change}:${m.name}`} data-change={m.change}><td>{WORDS.find((w) => w[0] === m.change)![1]}</td><td title={m.title}>{visible(m.name)}</td></tr>)}</tbody>
            </table>
          </details>
        </>
      )}
    </section>
  )
}
