import { useMemo, useState } from 'react'
import { kinds, rows, tiles, type Change, type CompareData } from './diff'
import { visible } from './visible'
import { plural } from './plural'

const CHANGES: Change[] = ['added', 'removed', 'changed']

/** What changed between two snapshots: tiles, then every symbol change as an ordered, keyboard-navigable table (FR019). */
export function DiffView({ data, truncated, onOpen }: { data: CompareData; truncated: boolean; onOpen: (symbolId: string) => void }) {
  const [kind, setKind] = useState('')
  const [changes, setChanges] = useState<Set<Change>>(new Set(CHANGES))
  const list = useMemo(() => rows(data, { kinds: kind ? new Set([kind]) : undefined, changes }), [data, kind, changes])
  const toggle = (c: Change) => setChanges((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n })
  return (
    <section className="table-view" aria-label="Diff">
      <ul className="tiles" aria-label="Summary">
        {tiles(data).map((t) => <li key={t.label}><span className="label">{t.label}</span><span className="value">{t.value}</span></li>)}
      </ul>
      <div className="diff-legend" aria-hidden="true"><span><i className="sw added" />added</span><span><i className="sw changed" />changed</span><span><i className="sw removed" />removed: listed below, not drawn in the Galaxy</span></div>
      <div className="diff-filters" role="group" aria-label="Filters">
        <label>Kind <select className="snapshots" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">all</option>{kinds(data).map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
        {CHANGES.map((c) => <label key={c}><input type="checkbox" checked={changes.has(c)} onChange={() => toggle(c)} /> {c}</label>)}
      </div>
      {truncated && <p className="dim" role="note">The comparison was cut at its row limit; counts above are complete, the lists below are not.</p>}
      <table>
        <caption>{plural(list.length, 'symbol change')}, by path then name</caption>
        <thead><tr><th>Change</th><th>Kind</th><th>Name</th><th>Path</th><th>What</th><th /></tr></thead>
        <tbody>
          {list.map((r) => (
            <tr key={`${r.change}|${r.qualified_name}|${r.path}`} data-change={r.change}>
              <td>{r.change}</td><td>{r.kind}</td><td>{visible(r.qualified_name)}</td><td>{visible(r.path)}</td><td>{r.what}</td>
              <td>{r.change !== 'removed' && <button type="button" onClick={() => onOpen(r.id)}>Explore</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.files.disposition_changes.length > 0 && (
        <table>
          <caption>Files whose disposition changed</caption>
          <thead><tr><th>Path</th><th>From</th><th>To</th></tr></thead>
          <tbody>{data.files.disposition_changes.map((f) => <tr key={f.path}><td>{visible(f.path)}</td><td>{f.from}</td><td>{f.to}</td></tr>)}</tbody>
        </table>
      )}
    </section>
  )
}
