import Graph from 'graphology'
import Sigma, { DEFAULT_STYLES } from 'sigma'
import { useEffect, useRef, useState } from 'react'
import type { Scene } from './scene'
import { visible } from './visible'

type Props = { scene: Scene; reducedMotion: boolean; onNode: (id: string) => void; onWebGlFailure: () => void }

const halo = (hex: string) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},0.16)`
const labelColor = () => (window.matchMedia('(prefers-color-scheme: light)').matches ? '#111827' : '#dfe7ff')

/** Sigma renders the scene; horizon badges are DOM overlays, so they stay readable and testable. */
const hasWebGl = () => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') ?? c.getContext('webgl')) }

export function GraphView({ scene, reducedMotion, onNode, onWebGlFailure }: Props) {
  const container = useRef<HTMLDivElement>(null)
  // Handlers change identity on every parent render; only a new scene should rebuild the renderer.
  const handlers = useRef({ onNode, onWebGlFailure })
  const camera = useRef<{ zoom: (f: number) => void; fit: () => void } | null>(null)
  handlers.current = { onNode, onWebGlFailure }
  const [badgePositions, setBadgePositions] = useState<Array<{ text: string; x: number; y: number }>>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [chevrons, setChevrons] = useState<Array<{ id: string; x: number; y: number; angle: number; color: string }>>([])
  useEffect(() => {
    if (!container.current) return
    const graph = new Graph({ type: 'directed', multi: true })
    // A wide translucent twin under each node gives it a glow; halos are drawn first and ignored by clicks.
    for (const n of scene.nodes) if (n.role !== 'stub') graph.addNode(`halo:${n.id}`, { x: n.x, y: n.y, size: n.size * 2.4, color: halo(n.color), label: '', zIndex: 0 })
    for (const n of scene.nodes) graph.addNode(n.id, { x: n.x, y: n.y, size: n.size, color: n.color, label: visible(n.label), labelColor: labelColor(), labelPosition: n.labelPosition ?? 'below', role: n.role, zIndex: 1 })
    for (const e of scene.edges) graph.addDirectedEdgeWithKey(e.id, e.source, e.target, { color: e.color, size: e.size, label: visible(e.label ?? '') })
    let sigma: Sigma
    try {
      sigma = new Sigma(graph, container.current, {
        settings: { renderLabels: true, renderEdgeLabels: true, stagePadding: 140, labelRenderedSizeThreshold: 0, enableCameraRotation: false, gestureTarget: 'graph', itemSizesReference: 'screen' },
        // A styles entry replaces Sigma's defaults, so layer the overrides on top of DEFAULT_STYLES.
        styles: { nodes: [DEFAULT_STYLES.nodes, { labelVisibility: 'visible', labelPosition: { attribute: 'labelPosition', defaultValue: 'below' }, labelColor: { attribute: 'labelColor', defaultValue: '#dfe7ff' } }], edges: [DEFAULT_STYLES.edges, { labelVisibility: 'visible', labelPosition: 'above', labelColor: '#c79bff', labelSize: 12 }] },
      } as never)
    } catch (e) {
      // Only a missing WebGL context means the graph can never draw here; anything else is a bug to show, not a mode switch.
      if (!hasWebGl()) handlers.current.onWebGlFailure()
      else { console.error(e); setFailure(String((e as Error)?.message ?? e)) }
      return
    }
    setFailure(null)
    const cam = sigma.getCamera()
    camera.current = { zoom: (f) => (f > 1 ? cam.zoomIn({ duration: 250, factor: f }) : cam.zoomOut({ duration: 250, factor: 1 / f })), fit: () => cam.reset({ duration: 300 }) }
    sigma.on('clickNode' as never, ((e: { node: string }) => handlers.current.onNode(e.node.replace(/^halo:/, ''))) as never)
    const timers: number[] = []
    if (!reducedMotion) {
      const maxDepth = Math.max(0, ...scene.edges.map((e) => e.depth))
      for (const e of scene.edges) graph.setEdgeAttribute(e.id, 'color', 'rgba(0,0,0,0)')
      for (let level = 0; level <= maxDepth; level++) {
        timers.push(window.setTimeout(() => {
          for (const e of scene.edges.filter((x) => x.depth === level)) graph.setEdgeAttribute(e.id, 'color', e.color)
        }, 120 * level))
      }
    }
    const place = () => {
      setBadgePositions(scene.badges.map((b) => {
        const n = scene.nodes.find((x) => x.id === b.nodeId)!
        const p = sigma.graphToViewport({ x: n.x, y: n.y })
        return { text: b.text, x: p.x, y: p.y }
      }))
      setChevrons(scene.edges.filter((e) => e.style !== 'unresolved' && e.style !== 'aggregate').map((e) => {
        const a = scene.nodes.find((n) => n.id === e.source)!, b = scene.nodes.find((n) => n.id === e.target)!
        const pa = sigma.graphToViewport({ x: a.x, y: a.y }), pb = sigma.graphToViewport({ x: b.x, y: b.y })
        return { id: e.id, x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, angle: (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI, color: e.color }
      }))
    }
    place()
    sigma.on('afterRender' as never, place as never)
    return () => {
      timers.forEach((t) => clearTimeout(t))
      sigma.kill()
    }
  }, [scene, reducedMotion])
  return (
    <div className="graph-wrap">
      <div ref={container} className="graph" aria-hidden="true" />
      <div className="canvas-controls" role="toolbar" aria-label="Graph controls">
        <button type="button" onClick={() => camera.current?.zoom(1.6)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" onClick={() => camera.current?.zoom(1 / 1.6)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" onClick={() => camera.current?.fit()} aria-label="Fit everything" title="Fit everything">⤢</button>
      </div>
      {failure && <div className="notice" role="alert">The graph could not be drawn: {failure}. The Table view shows the same data.</div>}
      {chevrons.map((c) => (
        <div key={c.id} className="chevron" aria-hidden="true" style={{ left: c.x, top: c.y, transform: `translate(-50%, -50%) rotate(${c.angle}deg)`, color: c.color }}>›</div>
      ))}
      {badgePositions.map((b, i) => (
        <div key={i} className="horizon-badge" style={{ left: b.x + 14, top: b.y - 34 }} role="note">{b.text}</div>
      ))}
    </div>
  )
}
