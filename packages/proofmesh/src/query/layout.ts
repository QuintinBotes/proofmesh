/** A symbol as the layout sees it: its file's path, its qualified name, and where it is declared, for ties. */
export type Placed = { path: string; name: string; line: number; byte: number }

type Cell = { name: string; weight: number; dirs: Map<string, Cell>; files: Map<string, Cell>; items: number[] }
const cell = (name: string): Cell => ({ name, weight: 0, dirs: new Map(), files: new Map(), items: [] })
// Code-unit order, never localeCompare, so the order is the same on every machine.
const byName = (a: Cell, b: Cell) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
/** A directory's or file's cell gives this share of its shorter side to a margin, so containment shows as space between groups. */
const MARGIN = 0.04
/** Positions are quantised to 16 bits per axis within the map's square frame. */
export const LAYOUT_SCALE = 65536
/** A directory's or file's cell as placed (FR1401): its parent's index (-1 for the root), its path segment, its symbols and its box in the unit square. A directory's own files, beside its subdirectories, are one more cell named ''. */
export type LayoutCell = { parent: number; name: string; count: number; x: number; y: number; w: number; h: number }

/**
 * Where each symbol sits (FR1220): an ordered strip treemap of the path tree, directories then files then symbols, each in
 * name order, a symbol's area the same as every other's. Edges play no part. It is a pure function of the paths, names and
 * declaration order, and uses only arithmetic that IEEE 754 rounds the same everywhere, so every machine gets the same
 * bytes. Returns x, y pairs in item order, each 0 to 65535. Given cells, it also lists every cell it placed, parents first.
 */
export function layoutPositions(items: Placed[], cells?: LayoutCell[]): Uint16Array {
  const root = cell('')
  items.forEach((it, i) => {
    const parts = it.path.split('/')
    const file = parts.pop()!
    let at = root
    at.weight++
    for (const p of parts) { let d = at.dirs.get(p); if (!d) at.dirs.set(p, d = cell(p)); at = d; at.weight++ }
    let f = at.files.get(file)
    if (!f) at.files.set(file, f = cell(file))
    f.weight++
    f.items.push(i)
  })
  const out = new Uint16Array(items.length * 2)
  const q = (v: number) => Math.min(LAYOUT_SCALE - 1, Math.floor(v * LAYOUT_SCALE))
  // Strips are rows at even depths and columns at odd ones, never chosen by a cell's shape: a cell that grows from a little
  // wide to a little tall would turn everything in it.
  const place = (c: Cell, depth: number, x: number, y: number, w: number, h: number, parent: number) => {
    const me = cells ? cells.push({ parent, name: c.name, count: c.weight, x, y, w, h }) - 1 : -1
    if (c.items.length) {
      // Overloads share a name, so declaration order breaks the tie, never an id or a hash.
      const order = c.items.slice().sort((a, b) => { const p = items[a]!, r = items[b]!; return p.name < r.name ? -1 : p.name > r.name ? 1 : p.line - r.line || p.byte - r.byte || a - b })
      strips(order.map(() => 1), false, depth % 2 === 0, x, y, w, h, (k, cx, cy, cw, ch) => { out[order[k]! * 2] = q(cx + cw / 2); out[order[k]! * 2 + 1] = q(cy + ch / 2) })
      return
    }
    const dirs = [...c.dirs.values()].sort(byName), files = [...c.files.values()].sort(byName)
    // A directory's own files sit together after its subdirectories, as one more cell, so a file added never reorders them.
    const own = { ...cell(''), files: c.files, weight: files.reduce((n, f) => n + f.weight, 0) }
    const kids = dirs.length && files.length ? [...dirs, own] : [...dirs, ...files]
    strips(kids.map((k) => k.weight), dirs.length > 0, depth % 2 === 0, x, y, w, h, (k, cx, cy, cw, ch) => {
      const m = Math.min(cw, ch) * MARGIN
      place(kids[k]!, depth + 1, cx + m, cy + m, cw - 2 * m, ch - 2 * m, me)
    })
  }
  if (items.length) place(root, 0, 0, 0, 1, 1, -1)
  return out
}

/**
 * Ordered strips: items keep their order in strips (rows, or columns), and each item goes in the strip its weight's midpoint
 * falls in, so a small change of weight or one more item moves at most a boundary item to the next strip (FR2621).
 * - A directory's children (subdirectories, and its own files as one) take a whole number of strips, the square root of
 *   their count rounded, so no strip is born thin: a fractional count starts its last strip with almost no share, and a
 *   directory there is a sliver whose files jump far when its strips re-break (TypeORM's src/util, a 42:1 column, #275).
 *   The price: when a child added or removed moves that rounded count, the directory's strips are laid out anew.
 * - Files and symbols take about one item's thickness each: the square root of their count times the cell's length across
 *   the strips over its length along them, that ratio rounded to a power of two. A re-broken strip then moves an item by
 *   about its own size, and a cell whose items did not change keeps its strips unless its shape doubles or halves.
 */
function strips(weights: number[], whole: boolean, rows: boolean, x: number, y: number, w: number, h: number, put: (i: number, x: number, y: number, w: number, h: number) => void): void {
  let total = 0
  for (const v of weights) total += v
  const length = rows ? w : h, across = rows ? h : w
  const k = whole ? Math.max(1, Math.round(Math.sqrt(weights.length))) : Math.sqrt(weights.length * powerOfTwo(across / length))
  const strip = new Int32Array(weights.length)
  let before = 0
  weights.forEach((v, i) => { strip[i] = Math.floor((k * (before + v / 2)) / total); before += v })
  let at = 0, offset = 0
  while (at < weights.length) {
    let end = at, sum = 0
    while (end < weights.length && strip[end] === strip[at]) sum += weights[end++]!
    const t = (sum / total) * across
    // Every other strip runs back, so an item that moves to the next strip stays at the same end of it.
    const back = strip[at]! % 2 === 1
    let along = 0
    for (let i = at; i < end; i++) {
      const l = (weights[i]! / sum) * length, a = back ? length - along - l : along
      if (rows) put(i, x + a, y + offset, l, t); else put(i, x + offset, y + a, t, l)
      along += l
    }
    offset += t
    at = end
  }
}

/** r rounded to the nearest power of two on a log scale, by exact comparisons rather than Math.log2, which IEEE 754 does not pin. */
export function powerOfTwo(r: number): number {
  let p = 1
  while (r * r >= 2 * p * p) p *= 2
  while (r * r < (p * p) / 2) p /= 2
  return p
}

/** The cells as payload sections: each box as x, y, width and height quantised to 16 bits like positions, the parent, the symbol count and the segment names joined by newlines. */
export function packCells(cells: LayoutCell[]): { rects: Uint16Array; parent: Int32Array; count: Uint32Array; cellNames: Uint8Array } {
  const q = (v: number) => Math.max(0, Math.min(65535, Math.round(v * 65536)))
  const rects = new Uint16Array(cells.length * 4), parent = new Int32Array(cells.length), count = new Uint32Array(cells.length)
  cells.forEach((c, i) => { rects.set([q(c.x), q(c.y), q(c.w), q(c.h)], i * 4); parent[i] = c.parent; count[i] = c.count })
  return { rects, parent, count, cellNames: new TextEncoder().encode(cells.map((c) => c.name.replace(/\n/g, ' ')).join('\n')) }
}
