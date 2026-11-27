import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callTool, establishSession, fetchBundle, fetchGalaxy, fetchWorkspaces, galaxySymbol, listSnapshots, replaying, setReplay, setRepository, ToolError, type Bundle, type SnapshotInfo, type Workspace } from './api'
import { DiffView } from './DiffView'
import { overlay as diffOverlay, type CompareData } from './diff'
import { Terrain } from './Terrain'
import { coverageOf, drawnStrokes, pairText, terrainOf, terrainSummary, type Pair } from './terrainModel'
import { ClaimsView } from './ClaimsView'
import { areaFog, areaLabel, legendAreas, matchIndices, parseGalaxy, rankMatches, shortName, type GalaxyData } from './galaxyData'
import { GraphView } from './GraphView'
import { Palette, type Command } from './Palette'
import { toNeighbourhood, type RelationshipsEnvelope } from './explore'
import { appendSide, CARD_ROWS, cardHood, declarationEvidence, rowEvidence, type Card, type Evidence } from './card'
import { ProofLens, type Chain } from './ProofLens'
import { defaultSelection, evidenceFor, LINK_WORDS, pairs, RELATION_COLOURS, RELATION_WORDS, relations, toEcosystem, type Ecosystem, type Relation } from './ecosystem'
import { FRAMEWORK_TYPES, glyph, toScene, type TraceEnvelope } from './scene'
import { visible } from './visible'
import { share } from './share'
import { plural } from './plural'
import { areasSvg, caveatLines, CONTAINMENT, NO_MEANING, offlineHtml, pngWithText, sceneSvg, sceneTable, type Caveats, type Source } from './exporting'

type Sym = { id: string; kind: string; name: string; qualified_name: string; path: string; start_line: number; signature: string | null }
type Hub = { id: string; kind: string; name: string; qualified_name: string; inbound: number }

const EXPLORE_TYPES = ['calls', 'inherits', 'implements', 'overrides', ...FRAMEWORK_TYPES]
/** What Explore asks a symbol's card for: the first page of each side, the whole card under a megabyte. */
const CARD_INPUT = { types: EXPLORE_TYPES, limits: { max_rows: CARD_ROWS, max_bytes: 1048576 } }
/** Keeps an answer that may still be in flight; a failed one is dropped so the next open asks again, and the oldest goes past 64. */
function hold<K, V>(map: Map<K, Promise<V>>, key: K, asked: Promise<V>): Promise<V> {
  asked.catch(() => map.delete(key))
  map.set(key, asked)
  if (map.size > 64) map.delete(map.keys().next().value!)
  return asked
}
const param = (name: string) => new URLSearchParams(window.location.search).get(name)
// In tab order; a view's single key is its place here (FR1144). Paths are traced in Explore's lens, which replaced the Trace a path tab (FR1300);
// the Terrain replaced the Galaxy and Map tabs (FR1400).
const VIEW_NAMES = { terrain: 'Terrain', explore: 'Explore', claims: 'Claims', diff: 'Diff', ecosystem: 'Ecosystem' } as const
type Mode = keyof typeof VIEW_NAMES
const VIEWS = Object.entries(VIEW_NAMES) as Array<[Mode, string]>

/** Saves bytes as a file the person downloads; nothing is sent anywhere. */
function download(name: string, blob: Blob): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/** Draws an SVG into a PNG of the same size, in the browser. */
async function svgToPng(svg: string): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('the drawing could not be rendered')); i.src = url })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the image could not be encoded'))), 'image/png'))
    return new Uint8Array(await blob.arrayBuffer())
  } finally { URL.revokeObjectURL(url) }
}
const focusFromUrl = () => param('focus')

function Picker({ label, value, onPick }: { label: string; value: Sym | null; onPick: (s: Sym) => void }) {
  const [text, setText] = useState('')
  const [hits, setHits] = useState<Sym[]>([])
  const [more, setMore] = useState(false)
  useEffect(() => {
    if (text.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => callTool('find_symbols', { text: text.trim(), limits: { max_rows: 20 } }).then((r) => { setHits(r.data.symbols); setMore(r.completion.truncated) }).catch(() => setHits([])), 150)
    return () => clearTimeout(t)
  }, [text])
  const id = `picker-${label.toLowerCase().replace(/\s+/g, '-')}`
  return (
    <div className="picker">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={text} onChange={(e) => setText(e.target.value)} placeholder="Search symbols" autoComplete="off" spellCheck={false} />
      {value && <div className="picked" data-testid={`${id}-value`}>{visible(value.qualified_name)}</div>}
      {hits.length > 0 && (
        <ul className="hits" role="listbox" aria-label={`${label} candidates`}>
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => { onPick(h); setHits([]); setText('') }}>
                <b>{visible(h.name)}</b> <span className="dim">{h.kind} · {visible(h.qualified_name)} · {visible(h.path)}:{h.start_line}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hits.length > 0 && more && <p className="dim" role="note">The first {hits.length} matches; type more to narrow them.</p>}
    </div>
  )
}

export function App() {
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<any>(null)
  // The symbol the lens traces a path to from its focus, picked in Path to (FR1300).
  const [target, setTarget] = useState<Sym | null>(null)
  const [depth, setDepth] = useState(6)
  const [followFramework, setFollowFramework] = useState(false)
  const [mode, setMode] = useState<Mode>(() => (focusFromUrl() ? 'explore' : 'terrain'))
  // Replay (FR010): the published snapshots, and the one every query is pinned to when it is not the current one.
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([])
  const [replay, setReplayState] = useState<string | null>(null)
  // Diff (FR019): the comparison shown, and its overlay on the Galaxy while the Galaxy shows its head snapshot.
  const [diff, setDiff] = useState<{ data: CompareData; truncated: boolean } | null>(null)
  const [diffBase, setDiffBase] = useState('')
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null)
  const [workspace, setWorkspace] = useState<string>('')
  const [ecosystem, setEcosystem] = useState<Ecosystem | null>(null)
  // The member the ecosystem view colours the others by, and whose links it shows; null until a workspace loads.
  const [selected, setSelected] = useState<string | null>(null)
  const ecosystemRef = useRef<Ecosystem | null>(null)
  useEffect(() => { ecosystemRef.current = ecosystem; setSelected(ecosystem ? defaultSelection(ecosystem) : null) }, [ecosystem])
  // The repository drilled into from the ecosystem view; every other view then shows only it (A11).
  const [drilled, setDrilled] = useState<string | null>(null)
  const [galaxy, setGalaxy] = useState<GalaxyData | null>(null)
  const [galaxyArea, setGalaxyArea] = useState<number | null>(null)
  // The area the pointer rests on, whose every bundle the Terrain draws; the bundle opened, with its relationships once they arrive (FR1403).
  const [hoverArea, setHoverArea] = useState<number | null>(null)
  const [bundle, setBundle] = useState<{ pair: Pair; data: Bundle | null } | null>(null)
  // A cell the Terrain is asked to bring into view, such as a file the palette opened.
  const [showCell, setShowCell] = useState<{ cell: number; key: number } | null>(null)
  const galaxyAsked = useRef(false)
  const [palette, setPalette] = useState(false)
  // The commands with a single key, as of the last render, for the key handler below.
  const keyed = useRef<Command[]>([])
  useEffect(() => {
    // Control+K or ⌘K opens the palette from anywhere; '/', '?' and the single keys only where typing is not text (FR1140, FR1144).
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); return }
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable], [role=dialog]')) return
      const command = e.key === '/' || e.key === '?' ? { run: () => setPalette(true) } : keyed.current.find((c) => c.key === e.key)
      if (command) { e.preventDefault(); command.run() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const [query, setQuery] = useState(() => param('q') ?? '')
  const [focus, setFocus] = useState<Sym | null>(null)
  const [hood, setHood] = useState<RelationshipsEnvelope | null>(null)
  // The focus's card (FR1180): everything the Proof lens shows, so opening a row inside it asks the server nothing.
  const [card, setCard] = useState<Card | null>(null)
  // Cards asked for, by symbol id: a click on a row the pointer rested on reuses its prefetch, even one still in flight (FR1186).
  const cards = useRef(new Map<string, Promise<Card>>())
  const points = useRef(new Map<number, Promise<string>>())
  const prefetching = useRef(false)
  const hoverTimer = useRef<number | undefined>(undefined)
  const paging = useRef(new Set<string>())
  // Counts queries in flight: the first to finish must not show the view idle while another still loads (FR640).
  const [inFlight, setInFlight] = useState(0)
  const loading = inFlight > 0
  const setLoading = (on: boolean) => setInFlight((n) => n + (on ? 1 : -1))
  // Counts finished queries, so tests and assistive tech can tell a new answer from the previous one.
  const [answered, setAnswered] = useState(0)
  const [trace, setTrace] = useState<TraceEnvelope & Record<string, any> | null>(null)
  const [traced, setTraced] = useState<{ source: string; target: string } | null>(null)
  const [tableView, setTableView] = useState(false)
  const [noWebGl, setNoWebGl] = useState(false)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  // A symbol chosen in the palette moves focus to its evidence once it shows (FR1145).
  const evidencePanel = useRef<HTMLElement>(null)
  const focusEvidence = useRef(false)
  useEffect(() => { if (evidence && focusEvidence.current) { focusEvidence.current = false; evidencePanel.current?.focus() } }, [evidence])
  // The palette's Trace a path command puts the keyboard in the lens's Path to field, after the closing palette returns focus (FR1300).
  const focusPathTo = useRef(false)
  useEffect(() => { if (focusPathTo.current && !palette) { focusPathTo.current = false; document.getElementById('picker-path-to')?.focus() } })
  // Consent covers the source shown when it was given, so it lapses whenever the evidence panel changes (FR052).
  const [includeSource, setIncludeSource] = useState(false)
  useEffect(() => setIncludeSource(false), [evidence])
  // Evidence belongs to the view that opened it; another view starts without it.
  useEffect(() => setEvidence((e) => (e?.view === mode ? e : null)), [mode])
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  const report = useCallback((e: unknown) => {
    setError(e instanceof ToolError && e.status === 401 ? 'No valid session: the link expired (links last 10 minutes), was already used, or the server restarted. Run "proofmesh view" and open the new link it prints.' : String((e as Error)?.message ?? e))
  }, [])

  /** A path from the lens's focus to a picked symbol, at the chosen depth, following framework relationships on request (FR1185, FR1300). */
  const traceFrom = async (to: Sym) => {
    if (!focus) return
    setTarget(to)
    setLoading(true)
    try {
      const types = followFramework ? ['calls', ...FRAMEWORK_TYPES] : ['calls']
      const env = await callTool('trace_paths', { source_id: focus.id, target_id: to.id, types, limits: { max_depth: depth } })
      setTraced({ source: focus.id, target: to.id })
      setTrace(env)
      setTableView(false)
      setError(null)
    } catch (e) {
      setTrace(null)
      report(e)
    } finally {
      setLoading(false)
      setAnswered((n) => n + 1)
    }
  }
  // Explore shows a path while one traced from its focus is held; otherwise the focus's neighbourhood.
  const tracing = mode === 'explore' && trace !== null && traced !== null && traced.source === focus?.id
  // Claims and Diff are tables of their own: they draw no scene, so Explore's neighbourhood never covers them (FR1302).
  const scene = useMemo(() => mode === 'terrain' || mode === 'claims' || mode === 'diff' ? null : mode === 'ecosystem' ? (ecosystem ? toEcosystem(ecosystem, selected) : null)
    : tracing ? toScene(trace!, traced!.source, traced!.target)
    : (hood && focus ? toNeighbourhood(hood, focus) : null), [mode, tracing, trace, traced, hood, focus, ecosystem, selected])
  /** The path as the lens draws it: the first path's hops, each with its call site, labelled by its weakest hop; or, with none, where the search stopped. */
  const chain = useMemo<Chain | null>(() => {
    if (!tracing || !scene) return null
    const p = trace!.data.paths[0]
    const rel = (i: number) => (p && i < p.assertions.length ? trace!.data.relationships?.[p.assertions[i]!] : undefined)
    const node = (id: string) => trace!.data.nodes[id] as { name: string; qualified_name: string }
    const horizon = scene.badges.map((b) => `${scene.nodes.find((n) => n.id === b.nodeId)!.qualifiedName}: ${b.text}`)
    return p
      // The contract always sends a path's basis; were it missing, the weaker label is the honest one.
      ? { basis: p.basis ?? 'inferred', conclusion: `${plural(p.assertions.length, 'hop')} to ${node(traced!.target).name}`, horizon, hops: p.nodes.map((id, i) => ({ id, name: node(id).name, qualifiedName: node(id).qualified_name, site: rel(i)?.site ?? null, basis: rel(i)?.basis ?? null, type: rel(i)?.type })) }
      : { basis: 'no path', conclusion: scene.conclusion, horizon, hops: [] }
  }, [tracing, trace, traced, scene])

  // The workspace list is read each time the tab opens, so one created meanwhile appears without a reload.
  useEffect(() => { if (mode === 'ecosystem') fetchWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([])) }, [mode])
  /** Loads a workspace's overview from its sealed link file; nothing about any member is fetched. push adds a history entry. */
  const loadEcosystem = useCallback(async (name: string, push = true) => {
    setWorkspace(name)
    setEcosystem(null)
    if (push) window.history.pushState(null, '', name ? `?workspace=${encodeURIComponent(name)}` : window.location.pathname)
    if (!name) return
    setLoading(true)
    try { setEcosystem((await callTool('get_ecosystem', { workspace: name })).data as Ecosystem); setError(null) } catch (e) { report(e) } finally { setLoading(false); setAnswered((n) => n + 1) }
  }, [report])
  /** Drill-down: from here on every query names this repository only; the member list is never refetched. Back returns to the overview. */
  const drillInto = useCallback(async (repositoryId: string, push = true) => {
    if (push) window.history.pushState(null, '', `?workspace=${encodeURIComponent(param('workspace') ?? '')}&repository=${encodeURIComponent(repositoryId)}`)
    setRepository(repositoryId)
    setDrilled(repositoryId)
    setGalaxy(null); galaxyAsked.current = false; setBundle(null)
    setFocus(null); setHood(null); setCard(null); cards.current.clear(); points.current.clear(); setTrace(null); setTraced(null); setTarget(null); setEvidence(null)
    setLoading(true)
    try { setStatus(await callTool('workspace_status', { limits: { max_rows: 1 } })); setError(null); setMode('terrain') } catch (e) { report(e) } finally { setLoading(false); setAnswered((n) => n + 1) }
  }, [report])

  const showCode = useCallback(async (sym: Sym & { evidence_id: string }) => {
    const ev = (await callTool('read_evidence', { evidence_ids: [sym.evidence_id] })).data.evidence[0]
    setEvidence({
      title: sym.qualified_name,
      facts: [['kind', sym.kind], ['file', `${ev.path}:${ev.start_line}–${ev.end_line}`], ['extractor', `${ev.extractor} ${ev.extractor_version}`], ['analysis', ev.analysis_mode], ['hash', ev.object_hash.slice(0, 12)]],
      integrity: ev.integrity.status, text: ev.text,
    })
  }, [])
  const openSymbol = useCallback(async (id: string) => {
    if (id.startsWith('stub:') || id.startsWith('ext_')) return
    try {
      await showCode((await callTool('get_symbol', { symbol_id: id })).data.symbol)
    } catch (e) { report(e) }
  }, [report, showCode])

  /** One request for a symbol's card, shared by a prefetch and the click that follows it. */
  const fetchCard = useCallback((id: string): Promise<Card> => cards.current.get(id) ?? hold(cards.current, id, callTool('get_symbol_card', { symbol_id: id, ...CARD_INPUT }).then((env) => env.data as Card)), [])
  /** A galaxy point's symbol id, its card held beside it, from one request (FR1180). */
  const pointCard = useCallback((index: number): Promise<string> => points.current.get(index) ?? hold(points.current, index, galaxySymbol(index, CARD_INPUT).then(({ id, card }) => {
    if (!cards.current.has(id)) hold(cards.current, id, Promise.resolve(card!.data as Card))
    return id
  })), [])
  /** Prefetch on hover (FR1186): after 80 ms on a row or point, at most one request at a time, never for one already held. */
  const prefetch = useCallback((held: boolean, ask: () => Promise<unknown>) => {
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      if (held || prefetching.current) return
      prefetching.current = true
      ask().catch(() => undefined).finally(() => { prefetching.current = false })
    }, 80)
  }, [])
  const hover = useCallback((id: string | undefined) => ({
    onMouseEnter: () => { if (id) prefetch(cards.current.has(id), () => fetchCard(id)) },
    onMouseLeave: () => window.clearTimeout(hoverTimer.current),
  }), [fetchCard, prefetch])
  const hoverPoint = useCallback((index: number | null) => {
    if (index === null) window.clearTimeout(hoverTimer.current)
    else prefetch(points.current.has(index), () => pointCard(index))
  }, [pointCard, prefetch])

  /** Centres Explore on a symbol with one request; push adds a history entry so Back returns to the previous one. */
  const loadFocus = useCallback(async (id: string, push = true) => {
    setLoading(true)
    try {
      const c = await fetchCard(id)
      setFocus(c.symbol)
      setCard(c)
      // A new focus starts with no path; the lens traces from the focus it shows.
      setTrace(null); setTraced(null); setTarget(null)
      setHood(cardHood(c))
      setTableView(false)
      setMode('explore')
      setError(null)
      if (push) window.history.pushState({ focus: id }, '', `?focus=${encodeURIComponent(id)}`)
      // Opened with the view it belongs to, so the switch to Explore in the same update keeps it.
      setEvidence({ ...declarationEvidence(c), view: 'explore' })
    } catch (e) { report(e) } finally { setLoading(false); setAnswered((n) => n + 1) }
  }, [report, fetchCard])
  /** The next page of one side of the focus's card, as the list scrolls past its last row (FR058). */
  const loadMore = useCallback(async (side: 'in' | 'out') => {
    const c = card
    const key = side === 'in' ? 'incoming' : 'outgoing'
    const offset = c?.[key].next_offset
    if (!c || offset == null || paging.current.has(`${c.symbol.id}${side}`)) return
    paging.current.add(`${c.symbol.id}${side}`)
    try {
      const next = (await callTool('get_symbol_card', { symbol_id: c.symbol.id, direction: side, offset, types: EXPLORE_TYPES, limits: { max_rows: CARD_ROWS * 4, max_bytes: 1048576 } })).data as Card
      const grown = { ...c, [key]: appendSide(c[key], next[key]) }
      cards.current.set(c.symbol.id, Promise.resolve(grown))
      setCard((now) => (now?.symbol.id === c.symbol.id ? grown : now))
      setHood((now) => (now && focus?.id === c.symbol.id ? cardHood(grown) : now))
    } catch (e) { report(e) } finally { paging.current.delete(`${c.symbol.id}${side}`) }
  }, [card, focus, report])
  const clearPath = () => { setTrace(null); setTraced(null); setTarget(null) }

  /** The Terrain holds every name already, so search filters it in the browser without asking the server; typed in another view, it shows the Terrain. */
  const search = (text: string) => {
    setQuery(text)
    setGalaxyArea(null)
    if (mode !== 'terrain' && text.trim()) setMode('terrain')
  }

  useEffect(() => {
    document.body.dataset.motion = reducedMotion ? 'reduced' : 'full'
    // A link to one repository of a workspace (`?workspace=W&repository=R`) opens drilled into it, with the overview behind Back.
    const deep = () => { const w = param('workspace'), r = param('repository'); return w !== null && r ? { w, r } : null }
    const connect = () => deep()
      ? establishSession().then(() => { const { w, r } = deep()!; loadEcosystem(w, false); return drillInto(r, false) }).catch(report)
      : establishSession()
      .then(() => callTool('workspace_status', { limits: { max_rows: 1 } }))
      .then((s) => { setStatus(s); setError(null); listSnapshots().then(setSnapshots).catch(report); const f = focusFromUrl(); if (f) loadFocus(f, false); else setAnswered((n) => n + 1) })
      // Several repositories registered: there is no single one to show until a person picks a workspace member.
      .catch((e) => { if (e instanceof ToolError && e.code === 'INVALID_ARGUMENT' && /repository_id is required/.test(e.message)) { setMode('ecosystem'); setError(null) } else report(e) })
    const onPop = () => {
      const f = focusFromUrl(), w = param('workspace'), r = param('repository')
      if (w !== null && r) { setWorkspace(w); drillInto(r, false) }
      else if (w !== null) { setMode('ecosystem'); if (ecosystemRef.current?.workspace.name !== w) loadEcosystem(w, false) }
      else if (f) loadFocus(f, false)
      else { setQuery(param('q') ?? ''); setMode('terrain') }
    }
    connect()
    // A new launch link opened in this tab changes only the fragment, which does not reload the page.
    window.addEventListener('hashchange', connect)
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('hashchange', connect); window.removeEventListener('popstate', onPop) }
  }, [reducedMotion, report, loadFocus, drillInto, loadEcosystem])
  useEffect(() => {
    // The palette searches the Terrain's names, so opening it loads them in any view.
    if ((mode !== 'terrain' && !palette) || !status || galaxyAsked.current) return
    galaxyAsked.current = true
    setLoading(true)
    fetchGalaxy().then((b) => { setGalaxy(parseGalaxy(b)); setError(null) }).catch(report).finally(() => { setLoading(false); setAnswered((n) => n + 1) })
  }, [mode, palette, status, report])
  const galaxyMatches = useMemo(() => (galaxy && mode === 'terrain' ? matchIndices(galaxy, query) : []), [galaxy, mode, query])
  const terrain = useMemo(() => (galaxy ? terrainOf(galaxy) : null), [galaxy])
  const strokes = useMemo(() => (terrain ? drawnStrokes(terrain.pairs, hoverArea) : []), [terrain, hoverArea])
  // A pair drawn by either stroke, once, in the order drawn: the bundles the keyboard and assistive tech can open (FR067).
  const drawnPairs = useMemo(() => [...new Set(strokes.map((x) => x.pair))], [strokes])
  /** Lists the relationships a bundle stands for, every page of them, grouped by basis (FR1403). */
  const openBundle = useCallback(async (pair: Pair) => {
    if (!galaxy) return
    setBundle({ pair, data: null })
    setLoading(true)
    try {
      const from = galaxy.areas[pair.from]!.name, to = galaxy.areas[pair.to]!.name
      let b = await fetchBundle(from, to, 0)
      while (b.next_offset !== null) { const next = await fetchBundle(from, to, b.next_offset); b = { ...next, rows: [...b.rows, ...next.rows] } }
      setBundle((now) => (now?.pair === pair ? { pair, data: b } : now))
      setError(null)
    } catch (e) { report(e) } finally { setLoading(false); setAnswered((n) => n + 1) }
  }, [galaxy, report])
  const [overlayShown, setOverlayShown] = useState(true)
  const galaxyOverlay = useMemo(() => (overlayShown && galaxy && diff && diff.data.head.snapshot_id === galaxy.snapshotId ? diffOverlay(galaxy, diff.data) : null), [overlayShown, galaxy, diff])

  /** Pins every query to a published snapshot, or back to the current one, and starts the views over on it. */
  const pin = useCallback(async (id: string | null) => {
    const next = id && snapshots.find((s) => s.id === id && !s.current) ? id : null
    setReplay(next); setReplayState(next)
    setGalaxy(null); galaxyAsked.current = false; setBundle(null)
    setHood(null); setFocus(null); setCard(null); cards.current.clear(); points.current.clear(); setTrace(null); setTraced(null); setTarget(null); setEvidence(null)
    try {
      setStatus(await callTool('workspace_status', { limits: { max_rows: 1 } }))
      setAnswered((n) => n + 1)
    } catch (e) { report(e) }
  }, [snapshots, report])
  const current = snapshots.find((s) => s.current)
  const compare = async () => {
    if (!diffBase) return
    setLoading(true)
    try {
      const head = replaying() ?? current?.id
      const env = await callTool('compare_snapshots', { base_snapshot_id: diffBase, ...(head ? { snapshot_id: head } : {}) })
      setDiff({ data: env.data as CompareData, truncated: Boolean(env.completion?.truncated) })
      setError(null)
    } catch (e) { setDiff(null); report(e) } finally { setLoading(false); setAnswered((n) => n + 1) }
  }

  /** What an export of the current view draws and carries inside it (FR064); source only with consent (FR052). */
  const exportable = useMemo(() => {
    if (!status || mode === 'claims' || (mode === 'terrain' ? !galaxy : !scene)) return null
    const file = evidence?.facts.find(([k]) => k === 'file')?.[1]
    const at = file ? /^(.*):(\d+)/.exec(file) : null
    const source: Source = includeSource && evidence?.text && at ? { path: at[1]!, startLine: Number(at[2]), text: evidence.text } : null
    const calls = status.data.calls
    const searching = query.trim().length >= 2
    const caveats: Caveats = {
      view: VIEW_NAMES[mode]!, repository: status.data.repository.name, snapshotId: status.snapshot.id, analysisMode: status.snapshot.analysis_mode,
      scope: mode === 'terrain' ? (searching ? `names matching “${query.trim()}”` : 'the whole snapshot')
        : mode === 'explore' && !tracing ? `relationships of ${focus?.qualified_name ?? ''}`
        : `paths from ${scene!.nodes.find((n) => n.role === 'source')?.qualifiedName ?? ''} to ${scene!.nodes.find((n) => n.role === 'target' || n.role === 'unreached-target')?.qualifiedName ?? ''}`,
      limits: mode === 'terrain' ? [`symbols are summarised by area; ${drawnPairs.length} of ${terrain?.pairs.length ?? 0} bundles between areas are drawn, and the table lists every one`] : [
        ...(scene!.badges.length ? [`${scene!.badges.length} node${scene!.badges.length === 1 ? '' : 's'} at the horizon where expansion stopped`] : []),
        ...(scene!.stubs.length ? [`${scene!.stubs.length} unresolved boundar${scene!.stubs.length === 1 ? 'y' : 'ies'} drawn`] : []),
        ...(tracing && scene!.conclusion ? [scene!.conclusion] : []),
      ],
      coverage: calls ? [`${share(calls.unresolved, calls.sites)} of ${plural(calls.sites, 'call site')} unresolved`] : [],
    }
    if (mode === 'terrain') {
      const counts = new Map<number, number>()
      for (const i of galaxyMatches) counts.set(galaxy!.area[i]!, (counts.get(galaxy!.area[i]!) ?? 0) + 1)
      const areas = galaxy!.areas.map((a, i) => {
        const f = areaFog(a)
        return { name: a.name, count: a.count, ...(searching ? { matches: counts.get(i) ?? 0 } : {}), ...(f.haze || f.excluded || coverageOf(a).hatched ? { fog: coverageOf(a).text } : {}) }
      })
      return { caveats, source, svg: areasSvg(areas, caveats, source), table: { head: ['area', 'symbols', 'matches', 'coverage'], rows: areas.map((a) => [a.name, String(a.count), a.matches === undefined ? '' : String(a.matches), a.fog ?? 'complete']) } }
    }
    return { caveats, source, svg: sceneSvg(scene!, caveats, source), table: sceneTable(scene!) }
  }, [status, mode, galaxy, scene, tracing, evidence, includeSource, query, focus, galaxyMatches, drawnPairs, terrain])
  const fileStem = exportable ? `proofmesh-${exportable.caveats.view.toLowerCase().replace(/\W+/g, '-')}-${exportable.caveats.snapshotId}` : ''
  const exportPage = () => { if (exportable) download(`${fileStem}.html`, new Blob([offlineHtml(exportable.svg, exportable.caveats, exportable.table, exportable.source)], { type: 'text/html' })) }
  const exportImage = async () => {
    if (!exportable) return
    try {
      const png = pngWithText(await svgToPng(exportable.svg), 'proofmesh:caveats', caveatLines(exportable.caveats, exportable.source).join('\n'))
      download(`${fileStem}.png`, new Blob([png as BlobPart], { type: 'image/png' }))
    } catch (e) { report(e) }
  }
  // While searching, the legend lists only the areas that hold matches, with their match counts.
  const legend = useMemo(() => (galaxy ? legendAreas(galaxy, query.trim().length >= 2 ? galaxyMatches : [], 40) : { shown: [], total: 0 }), [galaxy, galaxyMatches, query])
  const openPoint = useCallback(async (index: number) => {
    setLoading(true)
    try { await loadFocus(await pointCard(index)) } catch (e) { report(e) } finally { setLoading(false) }
  }, [loadFocus, pointCard, report])
  const openView = (m: Mode) => setMode(m)
  /** Brings a file's cell into view in the Terrain, or its nearest directory's when it holds no symbol and so has no cell (FR1404). */
  const openFile = (path: string) => {
    setMode('terrain')
    const parts = path.split('/')
    for (let k = parts.length; k > 0 && terrain; k--) {
      const c = terrain.paths.indexOf(parts.slice(0, k).join('/'))
      if (c >= 0) return setShowCell((x) => ({ cell: c, key: (x?.key ?? 0) + 1 }))
    }
  }

  // The palette's commands (FR1143): every view and overlay with its key (FR1144), then what the current state allows.
  const commands: Command[] = [
    ...VIEWS.map(([m, name], i) => ({ label: `${name} view`, key: String(i + 1), run: () => openView(m) })),
    { label: 'Table or graph view', key: 't', run: () => setTableView((t) => !t) },
    { label: 'Diff overlay on the Terrain, shown or hidden', key: 'd', run: () => setOverlayShown((o) => !o) },
    ...snapshots.filter((s) => !s.current && s.id !== replay).map((s) => ({ label: `Pin snapshot ${s.id.slice(0, 13)}${s.published_at ? `, published ${new Date(s.published_at).toLocaleString()}` : ''}`, run: () => void pin(s.id) })),
    ...(replay ? [{ label: 'Back to the current snapshot', run: () => void pin(null) }] : []),
    ...(focus ? [{ label: `Trace a path from ${focus.qualified_name}`, run: () => { setMode('explore'); setTableView(false); focusPathTo.current = true } }] : []),
    ...(exportable ? [{ label: 'Export page', run: exportPage }, { label: 'Export image', run: () => void exportImage() }] : []),
  ]
  useEffect(() => { keyed.current = commands.filter((c) => c.key) })

  const onNode = useCallback((id: string) => {
    if (mode === 'ecosystem') { if (!id.startsWith('stub:')) setSelected(id); return }
    if (id === focus?.id) openSymbol(id)
    else if (!id.startsWith('stub:') && !id.startsWith('ext_')) loadFocus(id)
  }, [mode, focus, openSymbol, loadFocus])

  const openEdge = async (sourceId: string, assertionId: string) => {
    // The card already holds each row's evidence, so an edge of the focus opens with no request (FR1180); a path's edges open from the trace, as they always have.
    const held = mode === 'explore' && !tracing ? [...(card?.incoming.rows ?? []), ...(card?.outgoing.rows ?? [])].find((r) => r.assertion_id === assertionId) : undefined
    if (held) return setEvidence(rowEvidence(held))
    const rels = (await callTool('get_relationships', { subject_id: sourceId, direction: 'out', types: EXPLORE_TYPES, include_external: true })).data.relationships
    const rel = rels.find((r: any) => r.assertion_id === assertionId)
    if (!rel) return report(new Error('That relationship is not in this snapshot any more.'))
    const ev = (await callTool('read_evidence', { evidence_ids: rel.evidence_ids })).data.evidence[0]
    setEvidence({
      title: `${rel.type} · ${rel.resolution}`,
      facts: [['origin', rel.origin], ['file', `${ev.path}:${ev.start_line}`], ['extractor', `${ev.extractor} ${ev.extractor_version}`], ['analysis', ev.analysis_mode], ['hash', ev.object_hash.slice(0, 12)]],
      integrity: ev.integrity.status, text: ev.text,
    })
  }

  const cov = status?.coverage
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="mark" aria-hidden="true">◎</span> PROOFMESH <span className="dim">OBSERVATORY</span></div>
        <div className="tabs" role="tablist" aria-label="Mode">
          {VIEWS.map(([m, name], i) => <button key={m} type="button" role="tab" aria-selected={mode === m} aria-keyshortcuts={String(i + 1)} data-key={i + 1} onClick={() => openView(m)}>{name}</button>)}
        </div>
        <input id="search" className="search" type="search" aria-label="Search" value={query} placeholder="Search names, namespaces, areas…" autoComplete="off" spellCheck={false}
          onChange={(e) => search(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(query) }} />
        {status && (
          <div className="crumbs">
            <b>{visible(status.data.repository.name)}</b> · {new Date(status.snapshot.published_at).toLocaleDateString()} · {status.snapshot.analysis_mode === 'no_execution' ? 'no execution' : 'trusted build'}
            <span className="snap" title={status.snapshot.id}>{status.snapshot.id.slice(0, 13)}</span>
          </div>
        )}
        {snapshots.length > 1 && (
          <label className="dim">Snapshot <select className="snapshots" aria-label="Snapshot" value={replay ?? current?.id ?? ''} onChange={(e) => void pin(e.target.value)}>
            {snapshots.map((s) => <option key={s.id} value={s.id}>{s.id.slice(0, 13)} · {s.published_at ? new Date(s.published_at).toLocaleString() : ''}{s.current ? ' (current)' : ''}</option>)}
          </select></label>
        )}
      </header>
      {replay && status && (
        <div className="banner" role="status" data-testid="replay-banner">
          Replaying snapshot <span className="snap" title={replay}>{replay.slice(0, 13)}</span> published {new Date(status.snapshot.published_at).toLocaleString()}. Every view shows that snapshot.
          <button type="button" onClick={() => void pin(null)}>Back to current</button>
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <aside className="left" aria-label="Controls">
        {mode === 'ecosystem' && (
          <section aria-label="Workspace">
            <label htmlFor="workspace">Workspace</label>
            <select id="workspace" value={workspace} onChange={(e) => loadEcosystem(e.target.value)}>
              <option value="">{workspaces === null ? 'Loading…' : workspaces.length ? 'Choose a workspace' : 'No workspaces; create one with proofmesh workspace add'}</option>
              {workspaces?.map((w) => <option key={w.name} value={w.name}>{w.name} ({w.members.length})</option>)}
            </select>
            {ecosystem && <p className="dim" role="note">Link file {ecosystem.workspace.link_file_id.slice(0, 13)}, sealed {new Date(ecosystem.workspace.sealed_at).toLocaleDateString()}. Rules: {Object.entries(ecosystem.workspace.rules).map(([r, v]) => `${r} ${v}`).join(', ')}.</p>}
          </section>
        )}
        {drilled && mode !== 'ecosystem' && <p className="notice" role="status">Showing one repository of workspace {workspace}. <button type="button" onClick={() => { setMode('ecosystem'); window.history.pushState(null, '', `?workspace=${encodeURIComponent(workspace)}`) }}>Back to the ecosystem</button></p>}
        {mode === 'terrain' ? (
          galaxy && terrain && (
            <>
              <section aria-label="Areas">
                <h2>Areas</h2>
                <ul className="legend-areas">
                  {legend.shown.map(({ index: i, name, count }) => (
                    <li key={name}>
                      <button type="button" aria-pressed={galaxyArea === i} onClick={() => { setQuery(''); setGalaxyArea(galaxyArea === i ? null : i) }} onMouseEnter={() => setHoverArea(i)} onMouseLeave={() => setHoverArea(null)} onFocus={() => setHoverArea(i)} onBlur={() => setHoverArea(null)}>
                        <span className="name" title={name}>{visible(name)}</span><span className="count">{count.toLocaleString('en')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {legend.total > legend.shown.length && <p className="dim" role="note">The {legend.shown.length} largest of {legend.total} areas; the table lists them all.</p>}
              </section>
              <section aria-label="Bundles">
                <h2>Bundles</h2>
                <ul className="legend-bundles">
                  {drawnPairs.map((p) => (
                    <li key={`${p.from}>${p.to}`}>
                      <button type="button" aria-pressed={bundle?.pair === p} title={pairText(galaxy, p)} onClick={() => void openBundle(p)}>
                        <span className="name">{visible(areaLabel(galaxy.areas[p.from]!.name))} → {visible(areaLabel(galaxy.areas[p.to]!.name))}</span>
                        <span className="count">{p.observed ? <span className="basis observed">{p.observed.toLocaleString('en')} observed</span> : null}{p.inferred ? <span className="basis inferred">{p.inferred.toLocaleString('en')} inferred</span> : null}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="dim" role="note">{drawnPairs.length} of {plural(terrain.pairs.length, 'bundle')} drawn{hoverArea !== null ? `, with every bundle of ${galaxy.areas[hoverArea]!.name}` : ''}; the table lists every one.</p>
              </section>
            </>
          )
        ) : mode === 'explore' ? (
          <>
            {focus && (
              <section className="focus-card" aria-label="Focus">
                <div className="dim">{focus.kind}</div>
                <b>{visible(focus.qualified_name)}</b>
                <div className="dim">{visible(focus.path)}:{focus.start_line}</div>
              </section>
            )}
            {/* The lens traces a path from its focus (FR1300): picking the target traces it, at this depth and with these relationships. */}
            {focus && (
              <div className="path-to">
                <Picker label="Path to" value={target} onPick={(s) => void traceFrom(s)} />
                <label htmlFor="depth">Depth <output htmlFor="depth">{depth}</output></label>
                <input id="depth" type="range" min={1} max={12} value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
                <label className="check"><input type="checkbox" checked={followFramework} onChange={(e) => setFollowFramework(e.target.checked)} /> Follow framework relationships</label>
                {target && <button type="button" onClick={() => void traceFrom(target)}>Trace again</button>}
              </div>
            )}
          </>
        ) : null}
        {cov && (
          <details className="snapshot">
            <summary>Snapshot coverage</summary>
          <section aria-label="Coverage">
            <dl className="stats">
              <dt>files</dt><dd>{cov.files_discovered}</dd>
              <dt>indexed</dt><dd>{cov.dispositions.indexed}</dd>
              <dt>excluded</dt><dd>{cov.dispositions.excluded_by_rule}</dd>
              <dt>unsupported</dt><dd>{cov.dispositions.unsupported}</dd>
              <dt>call sites</dt><dd>{status.data.calls.sites.toLocaleString('en')}</dd>
              <dt>unresolved calls</dt><dd>{share(status.data.calls.unresolved, status.data.calls.sites)}</dd>
            </dl>
            <dl className="stats reasons" aria-label="Unresolved calls by reason">
              {Object.entries(status.data.calls.by_reason as Record<string, number>).sort((x, y) => y[1] - x[1]).map(([reason, n]) => [<dt key={`${reason}t`}>{reason.replace(/_/g, ' ')}</dt>, <dd key={`${reason}d`}>{share(n, status.data.calls.unresolved)}</dd>])}
            </dl>
          </section>
          </details>
        )}
      </aside>
      <main className="center" aria-label="Trace" data-loading={loading}>
        {/* Diff is a table of its own, so the graph-or-table switch has nothing to switch there. */}
        {mode !== 'diff' && (
          <div className="switch" role="group" aria-label="View">
            {/* Explore's lens, a path included, is DOM rows, so it needs no WebGL. */}
            <button type="button" aria-pressed={!tableView && (!noWebGl || mode === 'explore')} disabled={noWebGl && mode !== 'explore'} onClick={() => setTableView(false)}>Graph</button>
            <button type="button" aria-pressed={tableView || (noWebGl && mode !== 'explore')} onClick={() => setTableView(true)}>Table</button>
          </div>
        )}
        {noWebGl && <div className="notice" role="status">WebGL is not available here, so Observatory shows the table view.</div>}
        {mode === 'claims' && <ClaimsView onError={report} galaxy={galaxy} terrain={terrain} snapshotId={replay ?? current?.id ?? null} map={!noWebGl && !tableView} onWebGlFailure={() => setNoWebGl(true)} />}
        {mode === 'diff' && (
          <>
            <div className="diff-filters" role="group" aria-label="Compare">
              <label>Base <select className="snapshots" id="diff-base" value={diffBase} onChange={(e) => setDiffBase(e.target.value)}>
                <option value="">choose an older snapshot</option>
                {snapshots.filter((s) => s.id !== (replay ?? current?.id)).map((s) => <option key={s.id} value={s.id}>{s.id.slice(0, 13)} · {s.published_at ? new Date(s.published_at).toLocaleString() : ''}</option>)}
              </select></label>
              <span className="dim">Head: {(replay ?? current?.id ?? '').slice(0, 13)}{replay ? ' (replayed)' : ' (current)'}</span>
              <button type="button" disabled={!diffBase} onClick={() => void compare()}>Compare</button>
            </div>
            {/* A row holds its head symbol's id, so it opens with the one request a lens row's focus takes (FR1301). */}
            {diff && <DiffView data={diff.data} truncated={diff.truncated} onOpen={(id) => void loadFocus(id)} />}
            {!diff && snapshots.length < 2 && <p className="dim" role="note">Only one snapshot is published; index again after a change to compare.</p>}
          </>
        )}
        {mode === 'terrain' && galaxy && terrain && !noWebGl && !tableView && <Terrain data={galaxy} terrain={terrain} query={query} focusArea={galaxyArea} hoverArea={hoverArea} overlay={galaxyOverlay} show={showCell}
          onOpen={openPoint} onHover={hoverPoint} onHoverArea={setHoverArea} onBundle={(p) => void openBundle(p)} onClear={() => { setQuery(''); setGalaxyArea(null) }} onWebGlFailure={() => setNoWebGl(true)} />}
        {mode === 'terrain' && galaxyOverlay && <p className="dim diff-legend" role="note"><span><i className="sw added" />added since {diff!.data.base.snapshot_id.slice(0, 13)}</span><span><i className="sw changed" />changed</span><span>removed symbols are in the Diff table</span><span><kbd>d</kbd> hides this overlay</span></p>}
        {mode === 'terrain' && galaxy && terrain && (tableView || noWebGl) && (
          <section className="table-view" aria-label="Terrain table">
            <table>
              <caption>{query.trim().length >= 2 ? `Symbols matching “${query.trim()}”${galaxyMatches.length > 200 ? ', first 200' : ''}` : 'Areas'}</caption>
              {query.trim().length >= 2 ? (
                <tbody>
                  {rankMatches(galaxy, galaxyMatches, query).slice(0, 200).map((i) => (
                    <tr key={i}><td>{visible(shortName(galaxy.names[i]!))}</td><td>{galaxy.kinds[galaxy.kind[i]!]}</td><td>{visible(galaxy.names[i]!)}</td><td><button type="button" onClick={() => openPoint(i)}>Explore</button></td></tr>
                  ))}
                </tbody>
              ) : (
                <>
                  <thead><tr><th>Area</th><th>Symbols</th><th>Files analysed</th><th>Not analysed</th><th>Excluded</th><th>Unresolved calls</th><th>Why not analysed</th><th>Coverage</th><th /></tr></thead>
                  <tbody>
                    {galaxy.areas.map((a, i) => (
                      <tr key={a.name}>
                        <td>{visible(a.name)}</td><td>{a.count.toLocaleString('en')}</td><td>{a.files.indexed.toLocaleString('en')}</td>
                        <td>{areaFog(a).unanalysed.toLocaleString('en')}</td><td>{a.files.excluded.toLocaleString('en')}</td>
                        <td>{a.calls.sites ? `${share(a.calls.unresolved, a.calls.sites)} of ${a.calls.sites.toLocaleString('en')}` : 'no call sites'}</td>
                        <td>{visible(a.gaps.map(([reason, n]) => `${reason} ${n.toLocaleString('en')}`).join(', '))}</td>
                        <td>{[coverageOf(a).hatched ? 'hatched: calls unresolved' : '', coverageOf(a).ghost || !a.count ? 'ghost: files not analysed' : ''].filter(Boolean).join('; ') || 'complete'}</td>
                        <td>{a.count > 0 && <button type="button" onClick={() => { setGalaxyArea(i); setTableView(false) }}>Show</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
            </table>
            {query.trim().length < 2 && (
              <table>
                <caption>Bundles between areas</caption>
                <thead><tr><th>From</th><th>To</th><th>Observed</th><th>Inferred</th><th>Types</th><th>Drawn</th><th /></tr></thead>
                <tbody>
                  {terrain.pairs.map((p) => (
                    <tr key={`${p.from}>${p.to}`}>
                      <td>{visible(galaxy.areas[p.from]!.name)}</td><td>{visible(galaxy.areas[p.to]!.name)}</td><td>{p.observed.toLocaleString('en')}</td><td>{p.inferred.toLocaleString('en')}</td>
                      <td>{p.types.map((x) => `${x.type} ${(x.observed + x.inferred).toLocaleString('en')}`).join(', ')}</td><td>{drawnPairs.includes(p) ? 'yes' : 'no'}</td>
                      <td><button type="button" onClick={() => void openBundle(p)}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
        {mode !== 'terrain' && mode !== 'explore' && scene && !noWebGl && !tableView && <GraphView scene={scene} reducedMotion={reducedMotion} onNode={onNode} onWebGlFailure={() => setNoWebGl(true)} />}
        {mode === 'explore' && card && focus?.id === card.symbol.id && !tableView && <ProofLens card={card} chain={chain} onClear={clearPath} onOpen={setEvidence} onFocus={(id) => void loadFocus(id)} onMore={(side) => void loadMore(side)} hover={hover} />}
        {mode === 'ecosystem' && !ecosystem && !loading && <p className="hint">Pick a workspace to see its repositories and the links between them.</p>}
        {ecosystem && mode === 'ecosystem' && (tableView || noWebGl) && (
          <section className="table-view" aria-label="Ecosystem table">
            <table>
              <caption>Repositories of {ecosystem.workspace.name}</caption>
              <thead><tr><th>Repository</th><th>Symbols</th><th>Files analysed</th><th>Endpoints</th><th>Channels</th><th>Projects</th><th>Snapshot</th><th /></tr></thead>
              <tbody>
                {[...ecosystem.members].sort((a, b) => (a.name < b.name ? -1 : 1)).map((m) => (
                  <tr key={m.repository_id} data-current={m.current}>
                    <td><button type="button" className="link" aria-pressed={selected === m.repository_id} onClick={() => setSelected(m.repository_id)}>{visible(m.name)}</button></td><td>{m.symbols.toLocaleString('en')}</td><td>{m.files_indexed.toLocaleString('en')}</td><td>{m.endpoints}</td><td>{m.channels}</td><td>{m.projects}</td>
                    <td>{m.snapshot_id.slice(0, 13)}{m.current ? '' : ' (a newer snapshot exists)'}</td>
                    <td><button type="button" onClick={() => drillInto(m.repository_id)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>Links between repositories</caption>
              <thead><tr><th>From</th><th>To</th><th>Kinds</th><th>Resolved</th><th>Candidate</th><th>Confidence</th></tr></thead>
              <tbody>
                {pairs(ecosystem).map((p) => {
                  const name = (id: string) => ecosystem.members.find((m) => m.repository_id === id)?.name ?? id
                  return <tr key={`${p.source}>${p.target}`}><td>{visible(name(p.source))}</td><td>{visible(name(p.target))}</td><td>{p.types.map((t) => LINK_WORDS[t]).join('; ')}</td><td>{p.resolved}</td><td>{p.candidate}</td><td>{p.min === p.max ? p.max : `${p.min}–${p.max}`}</td></tr>
                })}
              </tbody>
            </table>
            {ecosystem.boundaries.length > 0 && (
              <ul className="stubs" aria-label="Unresolved boundaries">
                {ecosystem.boundaries.map((b) => <li key={`${b.repository_id}:${b.type}`}>{visible(ecosystem.members.find((m) => m.repository_id === b.repository_id)?.name ?? b.repository_id)}: {b.count} {b.type} matched nothing in the workspace{b.sample[0] ? `, such as ${visible(b.sample[0].source)} (${b.sample[0].reason})` : ''}</li>)}
              </ul>
            )}
          </section>
        )}
        {scene && mode !== 'ecosystem' && (tableView || (noWebGl && mode !== 'explore')) && (
          <section className="table-view" aria-label="Trace table">
            <table>
              <caption>{tracing ? 'Traced nodes in order' : 'Symbol and its neighbours'}</caption>
              <thead><tr><th>#</th><th>Role</th><th>Symbol</th><th>Location</th><th>Evidence</th></tr></thead>
              <tbody>
                {scene.nodes.filter((n) => n.role !== 'stub').map((n, i) => (
                  <tr key={n.id} data-role={n.role}>
                    <td>{i + 1}</td><td>{n.role}</td><td>{visible(n.qualifiedName)}</td><td>{visible(n.path)}:{n.line}</td>
                    <td>
                      <button type="button" onClick={() => openSymbol(n.id)}>Show evidence</button>
                      {mode === 'explore' && (n.role === 'caller' || n.role === 'callee') && <button type="button" onClick={() => loadFocus(n.id)}>Explore</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {scene.edges.filter((e) => e.assertionId).length > 0 && (
              <ul className="edges" aria-label="Edges">
                {scene.edges.filter((e) => e.assertionId).map((e) => (
                  <li key={e.id}>{visible(scene.nodes.find((n) => n.id === e.source)!.label)} → {visible(scene.nodes.find((n) => n.id === e.target)!.label)} · {e.style} <button type="button" onClick={() => openEdge(e.source, e.assertionId!)}>Show evidence</button></li>
                ))}
              </ul>
            )}
            {scene.stubs.length > 0 && <ul className="stubs" aria-label="Unresolved boundaries">{scene.stubs.map((s) => <li key={s.id}>Unresolved call ({s.reason}) at line {s.line}</li>)}</ul>}
            {scene.badges.length > 0 && <ul className="horizon" aria-label="Horizon">{scene.badges.map((b) => <li key={b.nodeId}>{visible(scene.nodes.find((n) => n.id === b.nodeId)!.qualifiedName)}: {b.text}</li>)}</ul>}
          </section>
        )}
        {!scene && !error && mode === 'explore' && (
          <section className="start" aria-label="Start exploring">
            <h2>Start exploring</h2>
            <p className="dim">Search for any symbol on the left, or start from one of the most-referenced symbols in this snapshot.</p>
            <ul>
              {(status?.data.hubs as Hub[] | undefined)?.map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => loadFocus(h.id)} {...hover(h.id)}>
                    <b>{glyph(h.kind)}{visible(h.name)}</b> <span className="dim">{h.kind} · {visible(h.qualified_name)} · {h.inbound} incoming</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      {mode === 'ecosystem' && ecosystem && selected && !evidence && (() => {
        const ev = evidenceFor(ecosystem, selected), rel = relations(ecosystem, selected)
        const row = (l: ReturnType<typeof evidenceFor>['outgoing'][number], dir: string) => (
          <li key={`${dir}${l.other}${l.type}`}>
            <b>{dir} {visible(l.other)}</b> <span className="dim">{LINK_WORDS[l.type]} · {l.resolved} resolved, {l.candidate} candidate · confidence {l.min === l.max ? l.max : `${l.min}–${l.max}`}</span>
            <ul>{l.sample.map((x) => <li key={x.link_id}>{visible(x.source)} → {visible(x.target ?? 'nothing')} <span className="dim">({x.rule}, {x.confidence})</span></li>)}</ul>
          </li>
        )
        return (
          <aside className="right" aria-label="Repository evidence">
            <h2 className="ev-title">{visible(ev.name)}</h2>
            <p className="dim">Links from the sealed link file {ecosystem.workspace.link_file_id.slice(0, 13)}; the other repositories are coloured by their relation to this one.</p>
            <ul className="stubs" aria-label={`Links of ${ev.name}`}>
              {ev.outgoing.map((l) => row(l, 'to'))}
              {ev.incoming.map((l) => row(l, 'from'))}
              {ev.outgoing.length + ev.incoming.length === 0 && <li>No links to or from another member.</li>}
              {ev.boundaries.map((b) => <li key={b.type}><b>{b.count} {b.type} matched nothing</b><ul>{b.sample.map((x) => <li key={x.link_id}>{visible(x.source)} <span className="dim">({x.reason})</span></li>)}</ul></li>)}
            </ul>
            <p className="dim">{ecosystem.members.filter((m) => m.repository_id !== selected).map((m) => `${m.name}: ${RELATION_WORDS[rel.get(m.repository_id)!]}`).join('; ')}</p>
            <button type="button" onClick={() => drillInto(selected)}>Open only {visible(ev.name)}</button>
          </aside>
        )
      })()}
      {mode === 'terrain' && bundle && galaxy && !evidence && (
        <aside className="right" aria-label="Bundle">
          <button type="button" className="close" aria-label="Close bundle" onClick={() => setBundle(null)}>×</button>
          <h2 className="ev-title">{visible(galaxy.areas[bundle.pair.from]!.name)} → {visible(galaxy.areas[bundle.pair.to]!.name)}</h2>
          <p className="dim">{visible(pairText(galaxy, bundle.pair))}</p>
          {!bundle.data ? <p className="dim" role="status">Loading the relationships…</p> : (['observed', 'inferred'] as const).filter((basis) => bundle.data!.by_basis[basis]).map((basis) => (
            <section key={basis} aria-label={`${basis === 'observed' ? 'Observed' : 'Inferred'} relationships`} className={`bundle-group ${basis}`}>
              <h3>{basis === 'observed' ? 'Observed (compiler or runtime), solid' : 'Inferred (rules, syntax tier, models), dashed'}: {bundle.data!.by_basis[basis].toLocaleString('en')}</h3>
              <table className="bundle-rows">
                <thead><tr><th>Source</th><th>Target</th><th>Type</th><th>Site</th><th>Basis</th><th /></tr></thead>
                <tbody>
                  {bundle.data!.rows.filter((r) => r.basis === basis).map((r) => (
                    <tr key={r.assertion_id}>
                      <td>{visible(r.source.qualified_name)}</td><td>{visible(r.target.qualified_name)}</td><td>{r.type}</td>
                      <td>{r.site ? `${visible(r.site.path)}:${r.site.start_line}` : 'no site'}</td><td>{r.basis}</td>
                      <td><button type="button" onClick={() => void loadFocus(r.source.id)}>Explore</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </aside>
      )}
      {evidence && (
        <aside className="right" aria-label="Evidence" tabIndex={-1} ref={evidencePanel}>
          <button type="button" className="close" aria-label="Close evidence" onClick={() => setEvidence(null)}>×</button>
          <h2 className="ev-title">{visible(evidence.title)}</h2>
          <dl className="stats">{evidence.facts.map(([k, v]) => [<dt key={`${k}t`}>{k}</dt>, <dd key={`${k}d`}>{visible(v)}</dd>])}</dl>
          <p className={`integrity ${evidence.integrity}`}>integrity: {evidence.integrity === 'verified' ? '✓ verified' : evidence.integrity}</p>
          <pre className="source" data-testid="evidence-text">{evidence.text === null ? 'Source unavailable: the evidence object failed its integrity check or is missing.'
            : evidence.highlight ? <>{visible(evidence.text.slice(0, evidence.highlight[0]))}<mark data-testid="cited">{visible(evidence.text.slice(...evidence.highlight))}</mark>{visible(evidence.text.slice(evidence.highlight[1]))}</>
            : visible(evidence.text)}</pre>
          {evidence.focusId && <button type="button" onClick={() => void loadFocus(evidence.focusId!)}>Explore from here</button>}
        </aside>
      )}
      <section className="legend" aria-label="Legend">
        {mode === 'terrain' && <div className="dim">Each area is a grey cell sized by its symbols, nested by directory and file; areas carry no colour. Zoom in to name files, then symbols, once their cell is over 40 px; nothing moves as you zoom. Lines are bundles of relationships between areas, the arrowhead at the area called: solid is observed (compiler or runtime), dashed is inferred (rules, syntax tier, models). Twelve of the strongest are drawn, every inferred one, and every bundle of the area the pointer rests on. Hatching marks an area with more than 4% of its calls unresolved; a dashed ghost cell holds files the graph cannot analyse. Click a bundle to list its relationships.</div>}
        {mode === 'ecosystem' && <div className="dim">Each node is a repository, sized by its symbols; a label ending “newer snapshot exists” was linked from a snapshot that is no longer its current one. Lines are links between repositories, thicker for more; an amber line has candidates only. Short amber stubs are client facts that matched nothing in the workspace. Click a repository to see its links and colour the others by their relation to it; open it from there.
          <div>{(Object.keys(RELATION_COLOURS) as Relation[]).map((r) => <span key={r}><span className="sw" style={{ background: RELATION_COLOURS[r] }} /> {RELATION_WORDS[r]} </span>)}</div></div>}
        {mode === 'explore' && <div className="dim">Callers on the left, callees on the right, each at its call site and marked observed, inferred or unresolved in words. Click a row to read its call site; double-click it, or press f, to explore from it. Back returns to the previous symbol. Path to traces a path from the focus: each hop at its call site, the path labelled by its weakest hop, or where the search stopped.</div>}
        {mode !== 'claims' && mode !== 'diff' && <div className="dim">{mode === 'terrain' ? CONTAINMENT : NO_MEANING}</div>}
        {exportable && (
          <div className="export" role="group" aria-label="Export this view">
            <button type="button" onClick={exportPage}>Export page</button>
            <button type="button" onClick={() => void exportImage()}>Export image</button>
            {evidence?.text && <label><input type="checkbox" checked={includeSource} onChange={(e) => setIncludeSource(e.target.checked)} /> include the source shown in the evidence panel</label>}
          </div>
        )}
      </section>
      {palette && <Palette commands={commands} galaxy={galaxy} noRepository={!status} onClose={() => setPalette(false)}
        onSymbol={(i) => { focusEvidence.current = true; void openPoint(i) }} onFile={openFile} />}
      <footer className="bottom" aria-live="polite" aria-busy={loading} data-answered={answered} data-testid="conclusion">{loading ? 'Loading…' : mode === 'terrain' ? (galaxy && terrain ? (query.trim().length === 1 ? 'Type at least two characters to search.' : query.trim().length >= 2 ? `“${query.trim()}”: showing the ${plural(galaxyMatches.length, 'matching symbol')}; click one to explore it.` : galaxyArea !== null ? `${galaxy.areas[galaxyArea]!.name}: ${plural(galaxy.areas[galaxyArea]!.count, 'symbol')}. Click a point to explore it.` : terrainSummary(galaxy, terrain.pairs, drawnPairs.length)) : '') : scene ? scene.conclusion : ''}</footer>
    </div>
  )
}
