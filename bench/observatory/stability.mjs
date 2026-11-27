// Layout stability (#41 scenario 3): how far symbols present in two settled Galaxy layouts moved, as a share of the map's width.
import { pct } from './lib.mjs'

/** Each layout fitted to view on its own: its bounding box's longer side becomes 1, as fitView would show it. */
function fitted({ positions, names }) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < positions.length; i += 2) { minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]); minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]) }
  const w = Math.max(maxX - minX, maxY - minY) || 1
  // A name held by two symbols (overloads) cannot be matched across layouts, so it is left out.
  const at = new Map(), dup = new Set()
  Array.from(names).forEach((h, i) => { if (at.has(h)) dup.add(h); at.set(h, [(positions[i * 2] - minX) / w, (positions[i * 2 + 1] - minY) / w]) })
  for (const h of dup) at.delete(h)
  return at
}

/** Displacement of every symbol both layouts hold ({ positions: x,y pairs, names: one hash per symbol }), as shares of the width. */
export function displacement(a, b) {
  const pa = fitted(a), pb = fitted(b), d = []
  for (const [h, [x, y]] of pa) { const q = pb.get(h); if (q) d.push(Math.hypot(q[0] - x, q[1] - y)) }
  const r = (x) => Math.round(x * 1e4) / 1e4
  if (!d.length) return { shared: 0, median: null, p90: null, max: null, moved_2pct: null, moved_5pct: null }
  return { shared: d.length, median: r(pct(d, 0.5)), p90: r(pct(d, 0.9)), max: r(d.reduce((m, x) => Math.max(m, x), 0)), moved_2pct: r(d.filter((x) => x > 0.02).length / d.length), moved_5pct: r(d.filter((x) => x > 0.05).length / d.length) }
}
