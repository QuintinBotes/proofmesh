// A minimal protobuf writer for the fields scip.proto defines; the index below is hand-written, never produced by running an indexer.
const varint = (n: number): number[] => { const out: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b) } while (n); return out }
const field = (no: number, v: number | string | number[]): number[] => {
  if (typeof v === 'number') return [...varint(no * 8), ...varint(v)]
  const bytes = typeof v === 'string' ? [...new TextEncoder().encode(v)] : v
  return [...varint(no * 8 + 2), ...varint(bytes.length), ...bytes]
}
const packed = (ns: number[]) => ns.flatMap(varint)
export type Occ = { symbol: string; range: number[]; enclosing?: number[]; def?: boolean }
/** The current typed ranges, or the deprecated packed ones, so the reader is checked on both. */
const occurrence = (o: Occ, typed: boolean) => {
  const r = (no: number, n: number[]) => field(no, n.length === 3 ? [...field(1, n[0]!), ...field(2, n[1]!), ...field(3, n[2]!)] : [...field(1, n[0]!), ...field(2, n[1]!), ...field(3, n[2]!), ...field(4, n[3]!)])
  const range = typed ? r(o.range.length === 3 ? 8 : 9, o.range) : field(1, packed(o.range))
  const enclosing = !o.enclosing ? [] : typed ? r(o.enclosing.length === 3 ? 10 : 11, o.enclosing) : field(7, packed(o.enclosing))
  return [...range, ...field(2, o.symbol), ...field(3, o.def ? 1 : 8), ...enclosing]
}
export type Doc = { path: string; language: string; typed: boolean; occurrences: Occ[]; symbols?: Array<{ symbol: string; kind: number; signature?: string }> }
export const encode = (root: string, tool: string, docs: Doc[]) => Uint8Array.from([
  ...field(1, [...field(2, [...field(1, tool), ...field(2, '1.0')]), ...field(3, `file://${root}`)]),
  ...docs.flatMap((d) => field(2, [
    ...field(4, d.language), ...field(1, d.path),
    ...d.occurrences.flatMap((o) => field(2, occurrence(o, d.typed))),
    ...(d.symbols ?? []).flatMap((s) => field(3, [...field(1, s.symbol), ...field(5, s.kind), ...(s.signature ? field(7, field(5, s.signature)) : [])])),
  ])),
])

