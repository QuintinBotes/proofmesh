// Layout stability (#41 scenario 3): how far symbols present in two settled Galaxy layouts moved, as a share of the map's width.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import zlib from 'node:zlib'
import { pct } from './lib.mjs'

/** Read positions from the binary representation served for this snapshot, on either side of HTTP gzip decoding. */
export function decodeLayout(body, snapshotId) {
  const buf = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body) : body
  const size = buf.readUInt32LE(0), h = JSON.parse(buf.subarray(4, 4 + size).toString())
  if (h.snapshot_id !== snapshotId) throw new Error('The served layout belongs to a different snapshot')
  const start = 4 + size + ((4 - size % 4) % 4) + h.offsets.positions
  const positions = new Uint16Array(2 * h.nodes)
  for (let i = 0; i < positions.length; i++) positions[i] = buf.readUInt16LE(start + i * 2)
  return { key: snapshotId, format: h.format, positions }
}

/** The server's point-to-symbol mapping is local to each snapshot. Stable declaration keys survive a reindex. */
export function identifyLayout(dataDir, layout) {
  if (!/^snap_[0-9a-z]+$/.test(layout.key) || !Number.isInteger(layout.format)) throw new Error('Invalid layout identity')
  const ids = JSON.parse(fs.readFileSync(path.join(dataDir, 'cache', `galaxy-v${layout.format}-${layout.key}.ids.json`), 'utf8'))
  if (ids.length * 2 !== layout.positions.length) throw new Error('Point mapping and served layout differ in length')
  const db = new DatabaseSync(path.join(dataDir, 'snapshots', layout.key + '.db'), { readOnly: true })
  try {
    const lookup = db.prepare('select stable_key from symbol where id = ?')
    const keys = ids.map(id => {
      const row = lookup.get(id)
      if (!row) throw new Error(`Point has no symbol in ${layout.key}: ${id}`)
      return row.stable_key
    })
    if (new Set(keys).size !== keys.length) throw new Error('The snapshot contains duplicate point keys')
    return { ...layout, keys }
  } finally { db.close() }
}

/** Each layout fitted to view on its own: its bounding box's longer side becomes 1, as fitView would show it. */
function bounds(positions) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < positions.length; i += 2) {
    minX = Math.min(minX, positions[i])
    minY = Math.min(minY, positions[i + 1])
    maxX = Math.max(maxX, positions[i])
    maxY = Math.max(maxY, positions[i + 1])
  }
  return { minX, minY, width: Math.max(maxX - minX, maxY - minY) || 1 }
}

/** Within one immutable snapshot, even synthetic points have stable indices. Across revisions, match by declaration key. */
export function displacement(a, b) {
  const same = a.key === b.key
  if (same && a.positions.length !== b.positions.length) throw new Error('Point count changed for the same snapshot')
  if (!same && (!a.keys || !b.keys)) throw new Error('Cross-snapshot comparison requires stable keys')
  const index = same ? null : new Map(b.keys.map((k, i) => [k, i]))
  const left = bounds(a.positions), right = bounds(b.positions), d = []
  for (let i = 0; i < a.positions.length / 2; i++) {
    const j = index ? index.get(a.keys[i]) : i
    if (j === undefined) continue
    const dx = (a.positions[2 * i] - left.minX) / left.width - (b.positions[2 * j] - right.minX) / right.width
    const dy = (a.positions[2 * i + 1] - left.minY) / left.width - (b.positions[2 * j + 1] - right.minY) / right.width
    d.push(Math.hypot(dx, dy))
  }
  const r = (x) => Math.round(x * 1e4) / 1e4
  if (!d.length) return { shared: 0, median: null, p90: null, max: null, moved_2pct: null, moved_5pct: null }
  return { shared: d.length, median: r(pct(d, 0.5)), p90: r(pct(d, 0.9)), max: r(d.reduce((m, x) => Math.max(m, x), 0)), moved_2pct: r(d.filter((x) => x > 0.02).length / d.length), moved_5pct: r(d.filter((x) => x > 0.05).length / d.length) }
}
