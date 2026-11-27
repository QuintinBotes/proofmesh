import { describe, expect, it } from 'vitest'
import { forceLayout } from '../src/layout'

describe('the ecosystem\'s force layout', () => {
  it('the layout is deterministic and keeps unlinked nodes at the rim of the cluster', () => {
    const radii = Array.from({ length: 12 }, (_, i) => 6 + i)
    const links = Array.from({ length: 10 }, (_, i) => ({ a: 0, b: i + 1, weight: 10 }))
    const first = forceLayout(radii, links), second = forceLayout(radii, links)
    expect(second).toEqual(first)
    const cx = first.reduce((a, p) => a + p.x, 0) / first.length, cy = first.reduce((a, p) => a + p.y, 0) / first.length
    const dist = first.map((p) => Math.hypot(p.x - cx, p.y - cy))
    const linkedMax = Math.max(...dist.slice(0, 11))
    expect(dist[11]!).toBeLessThanOrEqual(linkedMax * 1.6)
  })
})
