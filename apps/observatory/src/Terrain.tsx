import Graph from 'graphology'
import Sigma from 'sigma'
import { extremityArrow, layerDashed, layerFill, pathCurved, sdfCircle, sdfRectangle } from 'sigma/rendering'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ghostAreas, matchIndices, shortName, type GalaxyData } from './galaxyData'
import { OVERLAY_RGB } from './diff'
import { CELL, cellRect, coverageOf, drawnStrokes, FRAME, GHOST_SIDE, GHOST_Y, GHOSTS, ghostRect, labels as labelsOf, MATCH, POINT, STROKE, SYMBOL, pairText, symbolSide, type Label, type Pair, type Stroke, type Terrain as Model, type View } from './terrainModel'
import { visible } from './visible'
import { plural } from './plural'
import { grid, points } from './points'
import { UNDRAWN, type Mark } from './time'

type Props = {
  data: GalaxyData; terrain: Model; query: string; focusArea: number | null; hoverArea: number | null; overlay?: Uint8Array | null
  onOpen: (index: number) => void; onHover?: (index: number | null) => void; onHoverArea: (area: number | null) => void; onBundle: (pair: Pair) => void; onClear: () => void
  /** A cell to bring into view, such as a file the palette opened; its key changes each time it is asked for. */
  show?: { cell: number; key: number } | null
  onWebGlFailure: () => void
  /** Time's marks for the step shown (FR1762): drawn over the map at any zoom; a point's own mark is said in its tooltip. */
  marks?: Mark[] | null
  /** What another view draws over the Terrain where it puts it, such as claims at their symbols (#50). */
  drawOver?: (view: View) => ReactNode
}

/** Symbols are drawn once their cell is this many pixels across (FR1404); before that the areas, directories and files stand for them. */
const POINTS_PX = 4
/** Cells added to the graph per task: each batch, and sigma's processing of all the cells added so far, stays inside the main thread's 100 ms budget (#208). */
const CELL_BATCH = 16000
const BYTES = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]

/** The renderer's settings, programs and styles; the warm-up below builds the same programs. */
const sigmaOptions = () => ({
    settings: { renderLabels: false, renderEdgeLabels: false, enableEdgeEvents: true, itemSizesReference: 'positions', zoomToSizeRatioFunction: (x: number) => x, minEdgeThickness: 1.5, stagePadding: 24, enableCameraRotation: false, gestureTarget: 'graph', minCameraRatio: 0.0005, maxCameraRatio: 2, autoRescale: true },
    primitives: {
      nodes: { shapes: [sdfCircle(), sdfRectangle()], layers: [layerFill()] },
      edges: { paths: [pathCurved()], extremities: [extremityArrow({ lengthRatio: 4, widthRatio: 3.5 })], layers: [layerDashed({ dashSize: { value: 7, mode: 'pixels' }, gapSize: { value: 5, mode: 'pixels' }, gapColor: { attribute: 'gapColor', default: 'rgba(0,0,0,0)' } })] },
      depthLayers: ['cells', 'edges', 'nodes', 'topEdges', 'topNodes'],
    },
    styles: {
      nodes: { x: { attribute: 'x' }, y: { attribute: 'y' }, size: { attribute: 'size' }, color: { attribute: 'color' }, shape: { attribute: 'shape', defaultValue: 'circle' }, aspectRatio: { attribute: 'aspectRatio', defaultValue: 1 }, zIndex: { attribute: 'zIndex', defaultValue: 0 }, depth: { attribute: 'depth', defaultValue: 'nodes' }, labelVisibility: 'hidden' },
      edges: { size: { attribute: 'size' }, color: { attribute: 'color' }, head: 'arrow', path: 'curved', curvature: { attribute: 'curvature' }, gapColor: { attribute: 'gapColor' }, visibility: { whenData: { hidden: true }, then: 'hidden', else: 'visible' }, depth: 'edges' },
    },
  })

/**
 * Compiles the renderer's shaders on a throwaway canvas while the snapshot's payload is still loading, so the browser's shader
 * cache serves the Terrain's own renderer and its first task stays inside the main thread's budget (#208).
 */
export function warmRenderer(): void {
  const box = Object.assign(document.createElement('div'), { ariaHidden: 'true' })
  box.style.cssText = 'position:fixed;left:-10px;top:-10px;width:8px;height:8px;opacity:0;pointer-events:none'
  document.body.append(box)
  try { new Sigma(new Graph(), box, sigmaOptions() as never).kill() } catch { /* no WebGL: the Terrain says so when it mounts */ }
  box.remove()
}

export function Terrain({ data: d, terrain: t, query, focusArea, hoverArea, overlay, onOpen, onHover, onHoverArea, onBundle, onClear, show, onWebGlFailure, marks, drawOver }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const sigma = useRef<Sigma | null>(null)
  const handlers = useRef({ onOpen, onHover, onHoverArea, onBundle, onWebGlFailure })
  handlers.current = { onOpen, onHover, onHoverArea, onBundle, onWebGlFailure }
  const mouse = useRef({ x: 0, y: 0 })
  const notes = useRef(new Map<number, string>())
  notes.current = new Map((marks ?? []).flatMap((m) => (m.index === null ? [] : [[m.index, m.title] as const])))
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<View | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null)
  const [shown, setShown] = useState<{ matched: number } | null>(null)

  useEffect(() => {
    if (!box.current) return
    const graph = new Graph({ type: 'directed', multi: true })
    const r = d.cells.rects
    // Cells: every area and what it holds, nested by depth; directories above the areas are not drawn. They join the graph once the
    // renderer exists, a batch per task, as sigma processes every node of a refresh in one go (#208).
    const cells: Array<[string, Record<string, unknown>]> = []
    for (let c = 0; c < t.cellArea.length; c++) {
      const depth = t.cellDepth[c]!
      if (depth < 0 || (depth > 0 && !d.cells.names[c])) continue
      const w = Math.max(1, r[c * 4 + 2]!), h = Math.max(1, r[c * 4 + 3]!)
      cells.push([`c${c}`, { x: r[c * 4]! + w / 2, y: FRAME - (r[c * 4 + 1]! + h / 2), size: Math.max(w, h) / 2, aspectRatio: w / h, shape: 'rectangle', color: CELL[Math.min(depth, 2)], zIndex: depth, depth: 'cells' }])
    }
    // Bundles join area centres; each pair has a solid stroke for its observed relationships and a dashed one for its inferred (FR1402).
    // A bundle ends at an unseen anchor in the middle of each area, not at the area's edge, where neighbouring cells would leave no room to draw it.
    t.areaCell.forEach((c, k) => {
      if (c < 0) return
      const w = r[c * 4 + 2]!, h = r[c * 4 + 3]!
      graph.addNode(`a${k}`, { x: r[c * 4]! + w / 2, y: FRAME - (r[c * 4 + 1]! + h / 2), size: Math.min(w, h) * 0.12, color: 'rgba(0,0,0,0)', zIndex: 5 })
    })
    const max = Math.max(1, ...t.pairs.map((p) => p.observed + p.inferred))
    t.pairs.forEach((p, k) => {
      const a = `a${p.from}`, b = `a${p.to}`
      if (!graph.hasNode(a) || !graph.hasNode(b)) return
      for (const basis of ['observed', 'inferred'] as const) {
        if (!p[basis]) continue
        graph.addDirectedEdgeWithKey(`${basis[0]}${k}`, a, b, { px: 1.5 + 4 * Math.log(1 + p[basis]) / Math.log(1 + max), size: 1, color: STROKE[basis], gapColor: basis === 'inferred' ? 'rgba(0,0,0,0)' : STROKE[basis], curvature: basis === 'inferred' ? 0.22 : 0.12, hidden: true, pair: k, basis })
      }
    })
    let s: Sigma
    try {
      s = new Sigma(graph, box.current, sigmaOptions() as never)
    } catch {
      handlers.current.onWebGlFailure()
      return
    }
    sigma.current = s
    s.setCustomBBox({ x: [0, FRAME], y: [ghostAreas(d.areas, GHOSTS).shown.length ? -(GHOST_Y - FRAME + GHOST_SIDE) : 0, FRAME] })
    // Symbols show per area as the zoom reaches them, so a large snapshot's overview draws areas and bundles only (FR1404); while
    // searching, the matches show too, at any zoom, at least a few pixels wide. They are one custom layer on sigma's canvas (points.ts).
    const side = Math.max(1, (FRAME * 0.85) / Math.sqrt(Math.max(1, d.n)))
    const colour = (i: number): [number, number, number] => (overlay?.[i] ? OVERLAY_RGB[overlay[i]!]!.map((v) => Math.round(v * 255)) as [number, number, number] : BYTES(SYMBOL))
    const pos = new Float32Array(d.n * 2)
    for (let i = 0; i < d.n; i++) { pos[i * 2] = d.positions[i * 2]!; pos[i * 2 + 1] = FRAME - d.positions[i * 2 + 1]! }
    // The points layer and its grid are built in a task of their own, after the renderer's (#208).
    let layer: ReturnType<typeof points> | undefined, find: ReturnType<typeof grid> | undefined
    const loaded = new Set<number>()
    let matches: Set<number> | null = null
    const paint = () => { layer?.paint((i) => loaded.has(d.area[i]!) || !!matches?.has(i), (i) => (matches?.has(i) ? BYTES(MATCH) : colour(i)), (i) => !!matches?.has(i)); s.scheduleRender() }
    /** The shown point under a viewport position, if any. */
    const pointAt = (vx: number, vy: number) => {
      const v = viewOf(), k = Math.abs(v.kx)
      return find && layer ? find((vx - v.bx) / v.kx, FRAME - (vy - v.by) / v.ky, Math.max(side * POINT, 3 / k) + 2 / k, (i) => layer!.shown[i] === 1) : -1
    }
    let frame = 0, perPx = 0
    const viewOf = (): View => {
      const o = s.graphToViewport({ x: 0, y: FRAME }), e = s.graphToViewport({ x: FRAME, y: 0 }), dim = s.getDimensions()
      return { kx: (e.x - o.x) / FRAME, bx: o.x, ky: (e.y - o.y) / FRAME, by: o.y, width: dim.width, height: dim.height }
    }
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const v = viewOf(), f0 = s.graphToFramedGraph({ x: 0, y: 0 }), f1 = s.graphToFramedGraph({ x: FRAME, y: FRAME }), ratio = window.devicePixelRatio || 1
        layer?.frame([(f1.x - f0.x) / FRAME, (f1.y - f0.y) / FRAME, f0.x, f0.y], 2 * side * POINT * Math.abs(v.kx) * ratio, 6 * ratio)
        setView(v)
        // Sizes are in layout units so cells scale with the zoom; a bundle keeps its width in pixels, so it is resized as the zoom changes.
        const units = 1 / Math.abs(v.kx)
        if (Math.abs(units - perPx) > perPx * 0.04) { perPx = units; graph.updateEachEdgeAttributes((_, a) => ({ ...a, size: (a.px as number) * units })) }
        if (symbolSide(d, v) < POINTS_PX) return
        const before = loaded.size
        d.areas.forEach((_, k) => {
          const c = t.areaCell[k]!
          if (c < 0 || loaded.has(k)) return
          const q = cellRect(d, v, c)
          if (q.left > v.width || q.top > v.height || q.left + q.width < 0 || q.top + q.height < 0) return
          loaded.add(k)
        })
        if (loaded.size > before) paint()
      })
    }
    s.on('afterRender' as never, update as never)
    const areaOfNode = (node: string) => (node[0] === 'a' ? Number(node.slice(1)) : t.cellArea[Number(node.slice(1))]!)
    const cellOfNode = (node: string) => (node[0] === 'a' ? t.areaCell[Number(node.slice(1))]! : Number(node.slice(1)))
    s.on('enterNode' as never, (({ node }: { node: string }) => {
      const k = areaOfNode(node)
      handlers.current.onHoverArea(k >= 0 ? k : null)
      if (hovered.current >= 0) return
      const c = cellOfNode(node), a = d.areas[k]!, cov = coverageOf(a)
      const title = t.cellDepth[c] === 0 ? a.name : t.paths[c]!
      setTip({ ...mouse.current, title, lines: [plural(d.cells.count[c]!, 'symbol'), ...(cov.text && t.cellDepth[c] === 0 ? [cov.text] : [])] })
    }) as never)
    s.on('leaveNode' as never, (() => { if (hovered.current < 0) setTip(null) }) as never)
    // A point under the pointer wins over the cell it sits in.
    hoverPoint.current = (vx, vy) => {
      const i = pointAt(vx, vy)
      if (i === hovered.current) return
      hovered.current = i
      handlers.current.onHover?.(i >= 0 ? i : null)
      if (i >= 0) { handlers.current.onHoverArea(d.area[i]!); setTip({ x: vx, y: vy, title: shortName(d.names[i]!), lines: [d.names[i]!, d.areas[d.area[i]!]!.name, ...(notes.current.has(i) ? [notes.current.get(i)!] : [])] }) } else setTip(null)
    }
    s.on('enterEdge' as never, (({ edge }: { edge: string }) => { const p = t.pairs[graph.getEdgeAttribute(edge, 'pair') as number]!; setTip({ ...mouse.current, title: graph.getEdgeAttribute(edge, 'basis') === 'inferred' ? 'Inferred bundle, dashed' : 'Observed bundle, solid', lines: [pairText(d, p), 'Click to list its relationships'] }) }) as never)
    s.on('leaveEdge' as never, (() => setTip(null)) as never)
    s.on('clickEdge' as never, (({ edge }: { edge: string }) => handlers.current.onBundle(t.pairs[graph.getEdgeAttribute(edge, 'pair') as number]!)) as never)
    s.on('clickNode' as never, (({ node, event }: { node: string; event: { x: number; y: number } }) => {
      const i = pointAt(event.x, event.y)
      if (i >= 0) return handlers.current.onOpen(i)
      zoomToCell(s, d, cellOfNode(node))
    }) as never)
    s.on('clickStage' as never, (({ event }: { event: { x: number; y: number } }) => { const i = pointAt(event.x, event.y); if (i >= 0) handlers.current.onOpen(i) }) as never)
    s.on('leaveStage' as never, (() => { handlers.current.onHoverArea(null); setTip(null) }) as never)
    graphRef.current = { graph, search: (picked) => { matches = picked && new Set(picked); paint() } }
    let batch = 0
    const addCells = (from: number) => {
      for (let k = from; k < Math.min(cells.length, from + CELL_BATCH); k++) graph.addNode(cells[k]![0], cells[k]![1])
      if (from + CELL_BATCH < cells.length) batch = window.setTimeout(() => addCells(from + CELL_BATCH), 0)
      // Ready once sigma has drawn the last cells, so a pointer finds them from then on.
      else s.once('afterRender' as never, (() => { setReady(true); update() }) as never)
    }
    batch = window.setTimeout(() => {
      layer = points(pos, d.n); find = grid(pos, d.n, side)
      s.addCustomLayerProgram('points', 'nodes' as never, layer.program as never)
      batch = window.setTimeout(() => addCells(0), 0)
    }, 0)
    return () => { clearTimeout(batch); cancelAnimationFrame(frame); s.kill(); sigma.current = null; graphRef.current = null; hoverPoint.current = () => {}; setReady(false) }
  }, [d, t, overlay])
  const graphRef = useRef<{ graph: Graph; search: (picked: number[] | null) => void } | null>(null)
  const hoverPoint = useRef<(x: number, y: number) => void>(() => {})
  const hovered = useRef(-1)

  // The drawn bundles follow the area the pointer rests on (FR1402).
  const strokes = drawnStrokes(t.pairs, hoverArea)
  useEffect(() => {
    const g = graphRef.current
    if (!g || !ready) return
    const on = new Set(strokes.map((s) => `${s.basis[0]}${t.pairs.indexOf(s.pair)}`))
    g.graph.forEachEdge((e, a) => { const hidden = !on.has(e); if (a.hidden !== hidden) g.graph.setEdgeAttribute(e, 'hidden', hidden) })
  }, [strokes.map((s) => `${s.basis}${s.pair.from}>${s.pair.to}`).join(), ready])

  // Search draws its matches at any zoom, over the points the zoom has shown; clearing it leaves only those.
  useEffect(() => {
    const g = graphRef.current
    if (!g || !ready) return
    const picked = query.trim().length >= 2 ? matchIndices(d, query) : null
    // The count is said at once; redrawing the matches waits until that frame has painted, and a further keystroke cancels it (NFR005).
    setShown(picked && { matched: picked.length })
    let later = 0
    const soon = requestAnimationFrame(() => { later = window.setTimeout(() => g.search(picked), 0) })
    return () => { cancelAnimationFrame(soon); clearTimeout(later) }
  }, [query, d, ready])

  useEffect(() => { const s = sigma.current; if (s && ready && focusArea !== null && t.areaCell[focusArea]! >= 0) zoomToCell(s, d, t.areaCell[focusArea]!) }, [focusArea, ready, d, t])
  useEffect(() => { const s = sigma.current; if (s && ready && show) zoomToCell(s, d, show.cell) }, [show?.key, ready])

  const placed: Label[] = view ? labelsOf(d, t, view) : []
  const zoomBy = (f: number) => { const c = sigma.current?.getCamera(); if (c) (f > 1 ? c.zoomIn({ duration: 250, factor: f }) : c.zoomOut({ duration: 250, factor: 1 / f })) }
  const filterLabel = focusArea !== null ? `Area ${d.areas[focusArea]!.name}` : `“${query.trim()}”`
  const ghosts = ghostAreas(d.areas, GHOSTS)
  return (
    <div className="terrain" data-ready={ready || undefined} data-snapshot={d.snapshotId} onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top }; hoverPoint.current(mouse.current.x, mouse.current.y) }}>
      <div ref={box} className="terrain-canvas" aria-hidden="true" />
      {view && d.areas.map((a, k) => {
        const c = t.areaCell[k]!, cov = coverageOf(a)
        if (c < 0 || (!cov.hatched && !cov.ghost)) return null
        const q = cellRect(d, view, c)
        return (
          <div key={a.name} className={`terrain-fog${cov.hatched ? ' hatched' : ''}`} data-area={a.name} title={cov.text} aria-hidden="true" style={{ left: q.left, top: q.top, width: q.width, height: q.height }}>
            {cov.ghost && <span className="terrain-ghost" title={cov.text} />}
          </div>
        )
      })}
      {view && [...ghosts.shown.map((a) => ({ name: a.name, text: coverageOf(a).text })), ...(ghosts.rest.areas ? [{ name: `+${plural(ghosts.rest.areas, 'smaller area')}`, text: `${plural(ghosts.rest.areas, 'more area')} with no symbols ${ghosts.rest.areas === 1 ? 'holds' : 'hold'} ${plural(ghosts.rest.files, 'file')} the graph cannot see; the table lists them` }] : [])].map((g, i) => {
        const q = ghostRect(view, i)
        return <div key={g.name} className="terrain-fog empty" data-area={g.name} title={g.text} aria-hidden="true" style={{ left: q.left, top: q.top, width: q.width, height: q.height }}>{q.width >= 40 && <span className="fog-label">{visible(g.name)}</span>}</div>
      })}
      {placed.map((l) => <div key={l.key} className={`terrain-label ${l.kind}${l.height > 16 ? ' stacked' : ''}`} data-kind={l.kind} data-point={l.kind === 'symbol' ? l.index : undefined} title={l.title} style={{ left: l.kind === 'symbol' ? l.left + l.width / 2 : l.left, top: l.top }} aria-hidden="true">{l.kind === 'area' ? l.text.split(' ').map((x, i) => <span key={i}>{i ? ' ' : ''}{visible(x)}</span>) : visible(l.text)}</div>)}
      {/* Moved lines and changes through members are not ringed (FR1762); a moved symbol slides in from where it was, as far as it is on screen now. */}
      {view && marks?.map((m) => UNDRAWN.has(m.change) ? null : (
        <i key={`${m.change}:${m.name}`} className={`time-mark ${m.change}`} data-change={m.change} data-name={m.name} aria-hidden="true"
          style={{ left: m.x * view.kx + view.bx, top: m.y * view.ky + view.by, ...(m.from ? { '--dx': `${(m.from[0] - m.x) * view.kx}px`, '--dy': `${(m.from[1] - m.y) * view.ky}px` } : {}) } as CSSProperties} />
      ))}
      {shown && (
        <div className="filter-chip" role="status">
          <span>{visible(filterLabel)}: <b>{shown.matched.toLocaleString('en')}</b> of {plural(d.n, 'symbol')}</span>
          <button type="button" onClick={onClear} aria-label="Clear filter" title="Clear filter">✕</button>
        </div>
      )}
      {shown && shown.matched === 0 && <div className="galaxy-empty" role="status">No symbol matches {visible(filterLabel)}.</div>}
      <div className="canvas-controls" role="toolbar" aria-label="Terrain controls">
        <button type="button" onClick={() => zoomBy(1.6)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" onClick={() => sigma.current?.getCamera().reset({ duration: 300 })} aria-label="Fit everything" title="Fit everything">⤢</button>
      </div>
      {view && drawOver?.(view)}
      {tip && <div className="galaxy-tip" style={{ left: tip.x + 14, top: tip.y + 14 }} role="status"><b>{visible(tip.title)}</b>{tip.lines.map((l, i) => <div key={i} className="dim">{visible(l)}</div>)}</div>}
      <span hidden data-testid="terrain-strokes">{strokes.map((s: Stroke) => `${s.basis}:${s.pair.from}>${s.pair.to}`).join(' ')}</span>
    </div>
  )
}

/** Moves the camera so a cell fills most of the view; nothing else moves (FR1404). */
function zoomToCell(s: Sigma, d: GalaxyData, c: number) {
  const r = d.cells.rects, w = r[c * 4 + 2]!, h = r[c * 4 + 3]!
  const centre = s.graphToFramedGraph({ x: r[c * 4]! + w / 2, y: FRAME - (r[c * 4 + 1]! + h / 2) })
  s.getCamera().animate({ x: centre.x, y: centre.y, ratio: Math.max(0.0005, (Math.max(w, h) / FRAME) * 1.15) }, { duration: 400 })
}
