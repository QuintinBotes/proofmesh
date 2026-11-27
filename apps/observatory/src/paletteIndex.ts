// The command palette's name index and ranking (FR1141, FR1142). No DOM, so the worker and the tests share it.
import { shortName } from './galaxyData'

/** How many symbols and files the palette lists at once; it counts the rest. */
export const LIMIT = 30

/** Items are numbered symbols first, then files: item i < symbols.length is Galaxy point i, the rest are files. */
export type PaletteIndex = { text: string; starts: Int32Array; order: Int32Array; short: string[] }

/** A file's name as the palette ranks it: its base name without the extension, so DataSource matches DataSource.ts exactly. */
const fileName = (path: string) => (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '')

/**
 * Built once per snapshot: every name lowered and joined in name order, so a query is one native substring scan whose hits
 * already come out in name order; ranking then only sorts them into four buckets.
 */
export function buildIndex(symbols: string[], files: string[]): PaletteIndex {
  const all = [...symbols, ...files]
  const order = Int32Array.from(all.keys()).sort((a, b) => (all[a]! < all[b]! ? -1 : all[a]! > all[b]! ? 1 : a - b))
  // Lowering can lengthen a name (İ becomes two code units), so the offsets come from the lowered names.
  const lowered = Array.from(order, (i) => all[i]!.toLowerCase())
  const starts = new Int32Array(all.length)
  let at = 0
  lowered.forEach((n, slot) => { starts[slot] = at; at += n.length + 1 })
  return {
    text: lowered.join('\n'), starts, order,
    short: all.map((n, i) => (i < symbols.length ? shortName(n) : fileName(n)).toLowerCase()),
  }
}

/** The first LIMIT items matching the text in rank order (exact name, prefix, substring, qualified name; each by name), and how many match. */
export function searchIndex(index: PaletteIndex, text: string): { items: number[]; total: number } {
  const q = text.trim().toLowerCase()
  if (q.length < 2) return { items: [], total: 0 }
  const { text: all, starts, order, short } = index
  const buckets: number[][] = [[], [], [], []]
  let total = 0
  for (let at = all.indexOf(q); at >= 0;) {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= at) lo = mid; else hi = mid - 1 }
    const item = order[lo]!, n = short[item]!
    const bucket = buckets[n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3]!
    if (bucket.length < LIMIT) bucket.push(item)
    total++
    // Skip the rest of this name, so a name that holds the text twice is counted once.
    at = lo + 1 < starts.length ? all.indexOf(q, starts[lo + 1]!) : -1
  }
  return { items: buckets.flat().slice(0, LIMIT), total }
}
