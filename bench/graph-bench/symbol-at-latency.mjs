// Latency of get_symbols_at over MCP (FR122): single-location calls and 100-location calls on random declaration sites of the truth.
const BUDGET = { single_p95_ms: 20, batch_p95_ms: 100 }
export const percentile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(q * s.length) - 1)] }
/** n locations `path:line` drawn with a seeded generator, so a run asks what the last one did. */
export function sampleLocations(symbols, n, seed) {
  let a = seed >>> 0
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pool = symbols.filter((s) => s.kind !== 'module' && s.line > 0)
  return Array.from({ length: n }, () => { const s = pool[Math.floor(next() * pool.length)]; return `${s.file}:${s.line}` })
}
/** `call(locations)` resolves to { ms }; one warm-up call first, so the snapshot is open. */
export async function measureSymbolAt(call, symbols, seed = 1) {
  const locations = sampleLocations(symbols, 1000 + 100 * 100, seed)
  await call(locations.slice(0, 1))
  const single = [], batch = []
  for (let i = 0; i < 1000; i++) single.push((await call([locations[i]])).ms)
  for (let i = 0; i < 100; i++) batch.push((await call(locations.slice(1000 + i * 100, 1100 + i * 100))).ms)
  const single_p95_ms = +percentile(single, 0.95).toFixed(2), batch_p95_ms = +percentile(batch, 0.95).toFixed(2)
  return { single_calls: single.length, batch_calls: batch.length, single_p95_ms, batch_p95_ms, budget: BUDGET, within_budget: single_p95_ms <= BUDGET.single_p95_ms && batch_p95_ms <= BUDGET.batch_p95_ms }
}
