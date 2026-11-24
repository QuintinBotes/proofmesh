/**
 * Deterministic force layout for up to a few hundred nodes: seeded on a circle in input order, then repulsion between
 * every pair, springs along links, and a pull to the centre, with cooling. The same input always gives the same picture.
 */
export function forceLayout(radii: number[], links: Array<{ a: number; b: number; weight: number }>, iterations = 300): Array<{ x: number; y: number }> {
  const n = radii.length
  if (n === 0) return []
  const k = 6 + 2 * Math.sqrt(n)
  const pos = radii.map((_, i) => ({ x: Math.cos((2 * Math.PI * i) / n) * k * 2, y: Math.sin((2 * Math.PI * i) / n) * k * 2 }))
  for (let it = 0; it < iterations; it++) {
    const step = k * 0.6 * (1 - it / iterations) + 0.01
    const disp = pos.map(() => ({ x: 0, y: 0 }))
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i]!.x - pos[j]!.x, dy = pos[i]!.y - pos[j]!.y
        const d = Math.max(0.05, Math.hypot(dx, dy) - (radii[i]! + radii[j]!) * 0.5)
        const f = (k * k) / d
        disp[i]!.x += (dx / (d || 1)) * f; disp[i]!.y += (dy / (d || 1)) * f
        disp[j]!.x -= (dx / (d || 1)) * f; disp[j]!.y -= (dy / (d || 1)) * f
      }
    }
    for (const { a, b, weight } of links) {
      const dx = pos[a]!.x - pos[b]!.x, dy = pos[a]!.y - pos[b]!.y
      const d = Math.max(0.05, Math.hypot(dx, dy))
      const f = ((d * d) / k) * 0.15 * Math.min(3, 0.5 + Math.log10(1 + weight))
      disp[a]!.x -= (dx / d) * f; disp[a]!.y -= (dy / d) * f
      disp[b]!.x += (dx / d) * f; disp[b]!.y += (dy / d) * f
    }
    for (let i = 0; i < n; i++) {
      disp[i]!.x -= pos[i]!.x * 0.02 * k; disp[i]!.y -= pos[i]!.y * 0.02 * k
      const len = Math.hypot(disp[i]!.x, disp[i]!.y) || 1
      pos[i]!.x += (disp[i]!.x / len) * Math.min(len, step)
      pos[i]!.y += (disp[i]!.y / len) * Math.min(len, step)
    }
  }
  // Unlinked nodes drift outwards and would shrink everything else when the view fits; keep them at the cluster's rim.
  const cx = pos.reduce((a, p) => a + p.x, 0) / n, cy = pos.reduce((a, p) => a + p.y, 0) / n
  const dist = pos.map((p) => Math.hypot(p.x - cx, p.y - cy))
  const rim = 1.15 * ([...dist].sort((a, b) => a - b)[Math.floor(0.9 * (n - 1))] ?? 0)
  return pos.map((p, i) => (dist[i]! > rim && rim > 0 ? { x: cx + ((p.x - cx) * rim) / dist[i]!, y: cy + ((p.y - cy) * rim) / dist[i]! } : p))
}
