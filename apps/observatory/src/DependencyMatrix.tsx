import { useMemo, useState } from 'react'
import type { GalaxyArea } from './galaxyData'
import type { Pair } from './terrainModel'
import { visible } from './visible'

const PAGE = 10

function PagePicker({ axis, page, count, change }: { axis: string; page: number; count: number; change: (p: number) => void }) {
  const last = Math.ceil(count / PAGE)
  if (last < 2) return null
  return <label>{axis} page <input type="number" min={1} max={last} value={page + 1}
    onChange={(e) => change(Math.min(last, Math.max(1, Math.trunc(e.currentTarget.valueAsNumber) || 1)) - 1)} /> of {last} </label>
}

export function DependencyMatrix({ areas, pairs, open }: { areas: GalaxyArea[]; pairs: Pair[]; open: (p: Pair) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [row, setRow] = useState(0), [column, setColumn] = useState(0)
  const byPair = useMemo(() => new Map(expanded ? pairs.map((p) => [p.from * areas.length + p.to, p] as const) : []), [expanded, pairs, areas.length])
  const columns = areas.slice(column * PAGE, (column + 1) * PAGE)
  const partial = (a: GalaxyArea) => !a.files.indexed || a.files.unsupported + a.files.excluded + a.files.failed + a.files.pending > 0
  return <details className="dependency-matrix" onToggle={(e) => setExpanded(e.currentTarget.open)}><summary>Dependency matrix</summary>
    {expanded && <>
    <PagePicker axis="Source" page={row} count={areas.length} change={setRow} />
    <PagePicker axis="Target" page={column} count={areas.length} change={setColumn} />
    <table><caption>Direct relationships from source rows to target columns</caption>
      <thead><tr><th scope="col">Source ↓ / Target →</th>{columns.map((a) => <th scope="col" key={a.name}>{visible(a.name)}</th>)}</tr></thead>
      <tbody>{areas.slice(row * PAGE, (row + 1) * PAGE).map((a, i) => {
        const from = row * PAGE + i
        return <tr key={a.name}><th scope="row">{visible(a.name)}</th>{columns.map((b, j) => {
          const to = column * PAGE + j, pair = byPair.get(from * areas.length + to)
          const incomplete = partial(a) || partial(b) || a.calls.unresolved > 0
          return <td key={b.name}>{from === to ? 'Same area' : pair
            ? <button type="button" aria-label={`${visible(a.name)} to ${visible(b.name)}: ${pair.observed} observed, ${pair.inferred} inferred`} onClick={() => open(pair)}>{pair.observed + pair.inferred}</button>
            : incomplete ? 'Incomplete coverage' : '0'}</td>
        })}</tr>
      })}</tbody>
    </table></>}
  </details>
}
