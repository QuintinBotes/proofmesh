// The command palette's name index and ranking (FR1141, FR1142). No DOM, so the worker and the tests share it.
import { lowerNames, scanNames, shortName, type LoweredNames } from './galaxyData'

/** How many symbols and files the palette lists at once; it counts the rest. */
export const LIMIT = 30

/** Items are numbered symbols first, then files: item i < symbols.length is Galaxy point i, the rest are files. */
export type PaletteIndex = LoweredNames & { order: Int32Array; short: string[] }

/** A file's name as the palette ranks it: its base name without the extension, so DataSource matches DataSource.ts exactly. */
const fileName = (path: string) => (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '')

/**
 * Built once per snapshot: every name lowered and joined in name order, so a query is one native substring scan whose hits
 * already come out in name order; ranking then only sorts them into four buckets.
 */
export function buildIndex(symbols: string[], files: string[]): PaletteIndex {
  const all = [...symbols, ...files]
  const order = Int32Array.from(all.keys()).sort((a, b) => (all[a]! < all[b]! ? -1 : all[a]! > all[b]! ? 1 : a - b))
  return {
    ...lowerNames(Array.from(order, (i) => all[i]!)), order,
    short: all.map((n, i) => (i < symbols.length ? shortName(n) : fileName(n)).toLowerCase()),
  }
}

/** The first LIMIT items matching the text in rank order (exact name, prefix, substring, qualified name; each by name), and how many match. */
export function searchIndex(index: PaletteIndex, text: string): { items: number[]; total: number } {
  const q = text.trim().toLowerCase()
  if (q.length < 2) return { items: [], total: 0 }
  const { order, short } = index
  const buckets: number[][] = [[], [], [], []]
  let total = 0
  scanNames(index, q, (slot) => {
    const item = order[slot]!, n = short[item]!
    const bucket = buckets[n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3]!
    if (bucket.length < LIMIT) bucket.push(item)
    total++
  })
  return { items: buckets.flat().slice(0, LIMIT), total }
}
