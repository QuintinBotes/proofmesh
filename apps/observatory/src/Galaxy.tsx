import { Graph } from '@cosmos.gl/graph'
import { useEffect, useRef, useState } from 'react'
import { areaFog, areaLabel, ghostAreas, layoutKey, placeLabels, seeds, matchIndices, nameHashes, shortName, warmStart, type GalaxyData } from './galaxyData'
import { OVERLAY_RGB } from './diff'
import { areaColor } from './map'
import { visible } from './visible'

type Props = { data: GalaxyData; query: string; focusArea: number | null; onOpen: (index: number) => void; onClear: () => void; onSettled?: () => void; overlay?: Uint8Array | null }

const BASE: Record<string, number> = { project: 9, class: 3.2, interface: 3.2, struct: 3, enum: 2.6, type_alias: 2.6, endpoint: 6, job: 6, table: 8, feature_flag: 5.5, message: 7, channel: 7, config_key: 4.5 }
const MINOR = new Set(['method', 'function', 'property', 'field', 'constructor', 'variable'])
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
/** Frames the simulation cools over: a small graph settles in seconds, a huge one stops early and is cached (B6). */
/** Above this many links the galaxy draws them only while the camera is still. */
export const MOVING_LINK_LIMIT = 200_000
export const manyLinks = (d: { links: Uint32Array }) => d.links.length / 2 > MOVING_LINK_LIMIT
const LINKS_BACK_MS = 400
export const settleTicks = (n: number) => (n > 50000 ? 1500 : n < 1000 ? 400 : 5000)

type Layout = { positions: Float32Array; names: Uint32Array }
const openLayouts = () => new Promise<IDBDatabase>((ok, no) => { const r = indexedDB.open('proofmesh-galaxy', 2); r.onupgradeneeded = () => { if (r.result.objectStoreNames.contains('layouts')) r.result.deleteObjectStore('layouts'); r.result.createObjectStore('layouts') }; r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
const getRecord = (db: IDBDatabase, key: string) => new Promise<unknown>((ok) => { const g = db.transaction('layouts').objectStore('layouts').get(key); g.onsuccess = () => ok(g.result); g.onerror = () => ok(undefined) })

/** A settled layout by its key, or the most recently settled one when key is 'latest'. */
async function cachedLayout(key: string): Promise<Layout | null> {
  try {
    const db = await openLayouts()
    const at = key === 'latest' ? await getRecord(db, 'latest') : key
    const r = typeof at === 'string' ? await getRecord(db, at) as { positions: ArrayBuffer; names: ArrayBuffer } | undefined : undefined
    return r ? { positions: new Float32Array(r.positions), names: new Uint32Array(r.names) } : null
  } catch { return null }
}
async function storeLayout(key: string, positions: number[], names: Uint32Array): Promise<void> {
  try {
    const db = await openLayouts()
    const t = db.transaction('layouts', 'readwrite')
    t.objectStore('layouts').put({ positions: Float32Array.from(positions).buffer, names: names.slice().buffer }, key)
    t.objectStore('layouts').put(key, 'latest')
  } catch { /* a missing cache only costs a fresh layout next time */ }
}

type Fog = { name: string; x: number; y: number; r: number; haze: number; ring: boolean; empty: boolean; text: string; label?: string }

/** What an area's fog says in words, for its tooltip and, for an area with no symbols, its label. */
export function fogText(a: GalaxyData['areas'][number], reasons = true): string {
  const f = areaFog(a)
  const parts = [
    ...(f.unanalysed ? [`${f.unanalysed.toLocaleString('en')} file${f.unanalysed === 1 ? '' : 's'} not analysed`] : []),
    ...(f.excluded ? [`${f.excluded.toLocaleString('en')} excluded`] : []),
    ...(f.unresolvedShare !== null && f.ring ? [`${Math.round(f.unresolvedShare * 100)}% of calls unresolved`] : []),
  ]
  const why = reasons ? a.gaps.map(([reason, n]) => `${reason} ${n.toLocaleString('en')}`).join(', ') : ''
  return `${a.name}: ${parts.join(', ')}${why ? ` (${why})` : ''}`
}

/**
 * Fog over the areas the graph cannot fully see (FR059). An area with symbols gets haze in proportion to its unanalysed files
 * and a ring when most of its calls are unresolved, sized to its points' spread; an area with no symbols at all is a labelled
 * ghost on a ring just outside the galaxy, so missing coverage never reads as empty space.
 */
function fogOf(d: GalaxyData, sum: Float64Array, sq: Float64Array, g: Graph): Fog[] {
  const out: Fog[] = []
  const toScreen = (x: number, y: number) => g.spaceToScreenPosition([x, y])
  let cx = 0, cy = 0, n = 0
  for (let k = 0; k < d.areas.length; k++) if (sum[k * 3 + 2]) { cx += sum[k * 3]!; cy += sum[k * 3 + 1]!; n += sum[k * 3 + 2]! }
  if (!n) return out
  cx /= n; cy /= n
  let rim = 0
  d.areas.forEach((a, k) => {
    const m = sum[k * 3 + 2]!
    if (!m) return
    const mx = sum[k * 3]! / m, my = sum[k * 3 + 1]! / m, spread = Math.sqrt(Math.max(1, sq[k]! / m - mx * mx - my * my))
    rim = Math.max(rim, Math.hypot(mx - cx, my - cy) + 2 * spread)
    const f = areaFog(a)
    if (!f.haze && !f.ring) return
    const [x, y] = toScreen(mx, my), [ex] = toScreen(mx + spread * 1.6, my)
    out.push({ name: a.name, x, y, r: Math.max(14, Math.abs(ex - x)), haze: f.haze, ring: f.ring, empty: false, text: fogText(a) })
  })
  // The largest areas with no symbols are drawn one by one and the rest as one, so a large repository's hundred small folders stay readable.
  const { shown, rest } = ghostAreas(d.areas, GHOSTS)
  const ghosts = [
    ...shown.map((a) => ({ name: a.name, files: Object.values(a.files).reduce((x, y) => x + y, 0), haze: areaFog(a).haze, label: fogText(a, false), text: fogText(a) })),
    ...(rest.areas ? [{ name: `+${rest.areas} smaller areas`, files: rest.files, haze: 1, label: `+${rest.areas} smaller areas: ${rest.files.toLocaleString('en')} files`, text: `${rest.areas} more areas with no symbols hold ${rest.files.toLocaleString('en')} files the graph cannot see; the table lists them` }] : []),
  ]
  const placed: Array<{ x: number; y: number; w: number }> = []
  ghosts.forEach((gh, i) => {
    const t = (2 * Math.PI * i) / ghosts.length - Math.PI / 2
    const [x, y] = toScreen(cx + Math.cos(t) * rim * 1.08, cy + Math.sin(t) * rim * 1.08)
    const r = Math.min(48, 10 + 3 * Math.sqrt(gh.files)), w = gh.label.length * 6.2
    // A label that would overlap one already placed is left off; the ghost stays, and the table names it.
    const free = !placed.some((p) => Math.abs(p.y - (y + r)) < 16 && Math.abs(p.x - x) < (p.w + w) / 2 + 8)
    if (free) placed.push({ x, y: y + r, w })
    out.push({ name: gh.name, x, y, r, haze: gh.haze, ring: false, empty: true, text: gh.text, label: free ? gh.label : '' })
  })
  return out
}
const GHOSTS = 10

export function Galaxy({ data, query, focusArea, onOpen, onClear, onSettled, overlay }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const graph = useRef<Graph | null>(null)
  // The last positions read back from the GPU, until the simulation moves a point: reading them again costs a GPU stall.
  const positions = useRef<ArrayLike<number> | null>(null)
  const handlers = useRef({ onOpen, onSettled })
  handlers.current = { onOpen, onSettled }
  const mouse = useRef({ x: 0, y: 0 })
  // The full drawing, kept while a filter shows a subset; viewMap maps a shown point to its index in the full galaxy.
  const full = useRef<{ colours: Float32Array; sizes: Float32Array; linkColours: Float32Array; linkWidths: Float32Array } | null>(null)
  const fullPositions = useRef<Float32Array | null>(null)
  const viewMap = useRef<Int32Array | null>(null)
  const relabel = useRef<() => void>(() => {})
  const [ready, setReady] = useState(false)
  const [connected, setConnected] = useState(false)
  const [shown, setShown] = useState<{ matched: number; total: number } | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number; name: string; area: string } | null>(null)
  const [running, setRunning] = useState(true)
  const [labels, setLabels] = useState<Array<{ key: string; name: string; x: number; y: number; color: string }>>([])
  const [fog, setFog] = useState<Fog[]>([])
  const orig = (i: number) => (viewMap.current ? viewMap.current[i]! : i)

  useEffect(() => {
    if (!box.current) return
    const d = data
    const colours = new Float32Array(d.n * 4), sizes = new Float32Array(d.n)
    const palette = d.areas.map((_, i) => rgb(areaColor(i)))
    for (let i = 0; i < d.n; i++) {
      const kind = d.kinds[d.kind[i]!]!, minor = MINOR.has(kind)
      // A Diff overlay tints added and changed symbols; everything else keeps its area's hue (FR019).
      const [r, g, b] = (overlay?.[i] ? OVERLAY_RGB[overlay[i]!] : undefined) ?? palette[d.area[i]!]!
      colours.set([r * (minor ? 0.82 : 1), g * (minor ? 0.82 : 1), b * (minor ? 0.82 : 1), minor ? 0.8 : 1], i * 4)
      sizes[i] = (BASE[kind] ?? (minor ? 1.6 : 3)) + Math.log2(d.degree[i]! + 1) * (minor ? 0.7 : 1.5)
    }
    const L = d.links.length / 2
    const linkColours = new Float32Array(L * 4), linkWidths = new Float32Array(L)
    for (let j = 0; j < L; j++) {
      const a = d.links[j * 2]!, b = d.links[j * 2 + 1]!, [r, g, bl] = palette[d.area[a]!]!
      linkColours.set([r, g, bl, d.area[a] === d.area[b] ? 0.06 : 0.1], j * 4)
      linkWidths[j] = 0.7
    }
    full.current = { colours, sizes, linkColours, linkWidths }
    const key = layoutKey(d)
    // Area sums in graph space. Reading every position back from the GPU is the costly part, and moving the camera changes no
    // position, so the sums are kept until the simulation moves the points again (NFR005).
    let areaSums: { sum: Float64Array; sq: Float64Array } | null = null
    const refreshLabels = (positionsMoved = true) => {
      const g = graph.current
      if (!g) return
      if (positionsMoved || !areaSums) {
        const pos = g.getPointPositions()
        positions.current = pos
        const count = pos ? pos.length / 2 : 0
        if (!count) { areaSums = null; setLabels([]); return }
        const sum = new Float64Array(d.areas.length * 3), sq = new Float64Array(d.areas.length)
        for (let i = 0; i < count; i++) {
          const k = d.area[orig(i)]!, a = k * 3, x = pos[i * 2]!, y = pos[i * 2 + 1]!
          sum[a] = sum[a]! + x; sum[a + 1] = sum[a + 1]! + y; sum[a + 2] = sum[a + 2]! + 1; sq[k] = sq[k]! + x * x + y * y
        }
        areaSums = { sum, sq }
      }
      const { sum, sq } = areaSums
      setFog(viewMap.current ? [] : fogOf(d, sum, sq, g))
      // Biggest areas first; a label that would overlap one already placed is skipped rather than piled on top (B14).
      const candidates = d.areas.slice(0, 40).flatMap((a, i) => {
        if (!sum[i * 3 + 2]) return []
        const [x, y] = g.spaceToScreenPosition([sum[i * 3]! / sum[i * 3 + 2]!, sum[i * 3 + 1]! / sum[i * 3 + 2]!])
        return [{ key: a.name, name: areaLabel(a.name), x, y, color: areaColor(i) }]
      })
      setLabels(placeLabels(candidates))
    }
    relabel.current = refreshLabels
    let frame = 0
    let linksBack = 0
    const scheduleLabels = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => refreshLabels(false)) }
    const g = new Graph(box.current, {
      backgroundColor: '#04060d', pointSizeScale: 1, scalePointsOnZoom: d.n > 1000, renderLinks: true, linkWidthScale: 1, curvedLinks: false,
      simulationRepulsion: 0.45, simulationLinkSpring: 0.06, simulationLinkDistance: 10, simulationGravity: 0.02, simulationCluster: 0.55,
      simulationFriction: 0.88, simulationDecay: settleTicks(d.n), fitViewOnInit: false, fitViewPadding: 0.12, enableDrag: true,
      hoveredPointCursor: 'pointer', renderHoveredPointRing: true, hoveredPointRingColor: '#ffffff', focusedPointRingColor: '#ffd36e',
      pointGreyoutOpacity: 0.05, linkGreyoutOpacity: 0.015, attribution: '',
      onPointMouseOver: (i: number) => { const o = orig(i); setTip({ x: mouse.current.x, y: mouse.current.y, name: d.names[o]!, area: d.areas[d.area[o]!]!.name }) },
      onPointMouseOut: () => setTip(null),
      onPointClick: (i: number) => handlers.current.onOpen(orig(i)),
      onZoom: scheduleLabels,
      onSimulationTick: () => { areaSums = null; positions.current = null },
      // Drawing every link of a very large galaxy each frame makes moving the camera stutter, so its links rest while it moves (NFR005).
      // cosmos can zoom while it is being constructed, before g exists, so the callbacks reach the graph through its ref.
      // They return only once the view has been still for a moment, so a run of pans never waits on a full draw of the links
      // between presses, where cosmos reads the GPU back to see whether a press lands on a point.
      onZoomStart: () => { if (manyLinks(d)) { clearTimeout(linksBack); (graph.current as unknown as { setConfigPartial: (c: object) => void } | null)?.setConfigPartial({ renderLinks: false }) } },
      onZoomEnd: () => { if (manyLinks(d)) { clearTimeout(linksBack); linksBack = window.setTimeout(() => (graph.current as unknown as { setConfigPartial: (c: object) => void } | null)?.setConfigPartial({ renderLinks: true }), LINKS_BACK_MS) } },
      onSimulationEnd: () => {
        setRunning(false)
        refreshLabels()
        // Only the full galaxy's layout is the snapshot's layout; a filtered view is re-arranged and must not replace it.
        if (!viewMap.current) storeLayout(key, g.getPointPositions(), nameHashes(d))
        handlers.current.onSettled?.()
      },
    } as never)
    graph.current = g
    let disposed = false
    ;(async () => {
      await g.ready
      const exact = await cachedLayout(key)
      const cached = exact && exact.positions.length === d.n * 2 ? exact.positions : null
      // A new snapshot starts from the last settled layout, so its picture stays where the reader left it (A11).
      const warm = cached ? null : warmStart(d, await cachedLayout('latest'), seeds(d))
      if (disposed) return
      g.setPointPositions(cached ?? warm!.positions)
      g.setPointColors(colours)
      g.setPointSizes(sizes)
      g.setLinks(new Float32Array(d.links))
      g.setLinkColors(linkColours)
      g.setLinkWidths(linkWidths)
      g.setPointClusters(Array.from(d.area))
      g.render(cached ? 0 : warm!.reused ? 0.15 : 1)
      if (cached) { g.stop(); setRunning(false); refreshLabels(); handlers.current.onSettled?.() }
      g.fitView(0)
      scheduleLabels()
      setReady(true)
    })().catch((e) => console.error('Galaxy failed to start', e))
    return () => { disposed = true; cancelAnimationFrame(frame); clearTimeout(linksBack); g.destroy(); graph.current = null; viewMap.current = null; setReady(false) }
  }, [data, overlay])

  useEffect(() => {
    const g = graph.current, f = full.current
    if (!g || !f || !ready) return
    const d = data
    const g2 = g as unknown as { setConfigPartial: (c: object) => void }
    const active = focusArea !== null || query.trim().length >= 2
    if (!active) {
      setShown(null)
      // Restoring the whole galaxy waits, as a filtered view does, until the cleared search has painted.
      let back = 0
      const restore = requestAnimationFrame(() => { back = window.setTimeout(() => {
        if (graph.current !== g) return
        if (viewMap.current) {
          viewMap.current = null
          g2.setConfigPartial({ highlightedPointIndices: undefined })
          g.setPointPositions(fullPositions.current!)
          g.setPointColors(f.colours); g.setPointSizes(f.sizes)
          g.setLinks(new Float32Array(d.links)); g.setLinkColors(f.linkColours); g.setLinkWidths(f.linkWidths)
          g.setPointClusters(Array.from(d.area))
          g.render(0)
          g.stop(); setRunning(false)
        }
        setTimeout(() => { if (graph.current === g) { g.fitView(500); relabel.current() } }, 50)
      }, 0) })
      return () => { cancelAnimationFrame(restore); clearTimeout(back) }
    }
    const picked = focusArea !== null ? Array.from({ length: d.n }, (_, i) => i).filter((i) => d.area[i] === focusArea) : matchIndices(d, query)
    const isMatch = new Uint8Array(d.n)
    for (const i of picked) isMatch[i] = 1
    const keep = new Uint8Array(isMatch)
    if (connected) for (let j = 0; j < d.links.length / 2; j++) { const a = d.links[j * 2]!, b = d.links[j * 2 + 1]!; if (isMatch[a]) keep[b] = 1; if (isMatch[b]) keep[a] = 1 }
    const map: number[] = []
    for (let i = 0; i < d.n; i++) if (keep[i]) map.push(i)
    // The count is known now and the status line can say it; rebuilding the picture waits until that frame has painted, and a
    // further keystroke cancels it (NFR005).
    setShown({ matched: picked.length, total: map.length })
    let later = 0
    const soon = requestAnimationFrame(() => { later = window.setTimeout(() => {
    if (!viewMap.current) fullPositions.current = Float32Array.from(positions.current && positions.current.length === d.n * 2 ? positions.current : g.getPointPositions())
    const local = new Int32Array(d.n).fill(-1)
    map.forEach((o, i) => { local[o] = i })
    const all = fullPositions.current!
    const pos = new Float32Array(map.length * 2), colours = new Float32Array(map.length * 4), sizes = new Float32Array(map.length)
    map.forEach((o, i) => {
      pos[i * 2] = all[o * 2]!; pos[i * 2 + 1] = all[o * 2 + 1]!
      colours.set(f.colours.subarray(o * 4, o * 4 + 4), i * 4)
      // Neighbours shown for context are drawn dimmer than the matches themselves.
      if (!isMatch[o]) colours[i * 4 + 3] = 0.3
      sizes[i] = f.sizes[o]!
    })
    const links: number[] = [], linkColours: number[] = [], linkWidths: number[] = []
    for (let j = 0; j < d.links.length / 2; j++) {
      const a = local[d.links[j * 2]!]!, b = local[d.links[j * 2 + 1]!]!
      if (a < 0 || b < 0) continue
      links.push(a, b)
      linkColours.push(f.linkColours[j * 4]!, f.linkColours[j * 4 + 1]!, f.linkColours[j * 4 + 2]!, 0.35)
      linkWidths.push(1)
    }
    viewMap.current = Int32Array.from(map)
    g2.setConfigPartial({ highlightedPointIndices: undefined })
    g.setPointPositions(pos); g.setPointColors(colours); g.setPointSizes(sizes)
    g.setLinks(new Float32Array(links)); g.setLinkColors(new Float32Array(linkColours)); g.setLinkWidths(new Float32Array(linkWidths))
    g.setPointClusters(map.map((o) => d.area[o]!))
    // A small subset re-settles a little so its own structure shows; a large one keeps the galaxy's arrangement.
    g.render(map.length && map.length < 20000 ? 0.25 : 0)
    setRunning(map.length > 0 && map.length < 20000)
    setTimeout(() => { if (graph.current === g) { if (map.length) g.fitView(500); relabel.current() } }, 80)
    }, 0) })
    return () => { cancelAnimationFrame(soon); clearTimeout(later) }
  }, [query, focusArea, connected, data, ready])

  const zoomBy = (factor: number) => { const g = graph.current; if (g) g.setZoomLevel(g.getZoomLevel() * factor, 250) }
  const toggleLayout = () => {
    const g = graph.current
    if (!g) return
    // Pausing the full galaxy means the picture is good enough, so it is kept like a settled layout.
    if (running) { g.pause(); setRunning(false); if (!viewMap.current) storeLayout(layoutKey(data), g.getPointPositions(), nameHashes(data)) } else { g.start(0.3); setRunning(true) }
  }
  const filterLabel = focusArea !== null ? `Area ${data.areas[focusArea]!.name}` : `“${query.trim()}”`
  return (
    <div className="galaxy" onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top } }}>
      <div ref={box} className="galaxy-canvas" aria-hidden="true" />
      {fog.map((f) => (
        <div key={f.name} className={`galaxy-fog${f.empty ? ' empty' : ''}${f.ring ? ' ring' : ''}`} data-area={f.name} title={f.text} aria-hidden="true"
          style={{ left: f.x - f.r, top: f.y - f.r, width: f.r * 2, height: f.r * 2, ['--haze' as string]: f.haze }}>
          {f.label && <span className="fog-label">{visible(f.label)}</span>}
        </div>
      ))}
      {labels.map((l) => <div key={l.key} className="galaxy-label" style={{ left: l.x, top: l.y, color: l.color }} aria-hidden="true">{visible(l.name)}</div>)}
      {shown && (
        <div className="filter-chip" role="status">
          <span>{visible(filterLabel)}: <b>{shown.matched.toLocaleString('en')}</b> of {data.n.toLocaleString('en')} symbols{connected && shown.total > shown.matched ? `, plus ${(shown.total - shown.matched).toLocaleString('en')} connected` : ''}</span>
          <button type="button" aria-pressed={connected} onClick={() => setConnected((c) => !c)} title="Also show the symbols directly connected to the matches">+ connected</button>
          <button type="button" onClick={onClear} aria-label="Clear filter" title="Clear filter">✕</button>
        </div>
      )}
      {shown && shown.matched === 0 && <div className="galaxy-empty" role="status">No symbol matches {visible(filterLabel)}.</div>}
      <div className="canvas-controls" role="toolbar" aria-label="Galaxy controls">
        <button type="button" onClick={() => zoomBy(1.6)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" onClick={() => graph.current?.fitView(500)} aria-label="Fit everything" title="Fit everything">⤢</button>
        <button type="button" onClick={toggleLayout} aria-pressed={running} aria-label={running ? 'Pause layout' : 'Resume layout'} title={running ? 'Pause layout' : 'Resume layout'}>{running ? '❚❚' : '▶'}</button>
      </div>
      {tip && <div className="galaxy-tip" style={{ left: tip.x + 14, top: tip.y + 14 }} role="status"><b>{visible(shortName(tip.name))}</b><div className="dim">{visible(tip.name)}</div><div className="dim">{visible(tip.area)}</div></div>}
    </div>
  )
}
