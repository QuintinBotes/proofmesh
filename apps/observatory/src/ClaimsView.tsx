import { useCallback, useEffect, useMemo, useState } from 'react'
import { callTool } from './api'
import { claimsSummary, GLYPH, missed, pinState, pointOnScreen, pointsByRef, stackPins, stepsOf, visits, type Changed, type Entry } from './claimsModel'
import type { GalaxyData } from './galaxyData'
import { Terrain } from './views'
import type { Terrain as Model, View } from './terrainModel'
import { visible } from './visible'
import './claims.css'

type Layer = { name: string; outcome: string; detail: string }
type Run = { run_id: string; snapshot_id: string; verdict: 'supported' | 'refuted' | 'inconclusive' | 'invalid'; layers: Layer[]; dependencies: { assertions: string[]; evidence: string[] }; verified_at: string }
type Claim = { id: string; statement: string; proposition: Record<string, unknown>; created_at: string; latest: Run | null }
type Evidence = { id: string; path: string; start_line: number; text: string | null; integrity: { status: string } }
type Trail = { snapshot: { id: string; repository_id: string }; data: { session_id: string; recording: boolean; entries: Entry[]; changed: Changed[] }; limitations: string[] }
type Props = { onError: (e: unknown) => void; galaxy: GalaxyData | null; terrain: Model | null; snapshotId: string | null; map: boolean; onWebGlFailure: () => void }

const describe = (p: Record<string, unknown>, name: (ref: string) => string = String) =>
  p.type === 'relationship' ? `${name(String(p.source))} ${String(p.relationship)} ${name(String(p.target))}`
  : p.type === 'path' ? `a path leads from ${name(String(p.source))} to ${name(String(p.target))}`
  : `no path leads from ${name(String(p.source))} to ${name(String(p.target))}`

/** A reference reads as its symbol's short name: a `kind:qualified_name` reference directly, a symbol id once looked up. */
const shortName = (qualified: string) => qualified.split(/[.:/]/).pop() || qualified
const qualifiedOf = (ref: string) => ref.slice(ref.indexOf(':') + 1)
/** A qualified name without its file: `DataSource.initialize`. */
const member = (qualified: string) => qualified.slice(qualified.lastIndexOf(':') + 1)
const words = (outcome: string) => outcome.replace('_', ' ')
const NOOP = () => {}

/**
 * Claims pinned to their subjects on the Terrain, each with its layers as equal cells, and a session's trail over the same map with
 * the dependents of its change it never looked at (#50). Every layer is drawn the same size, in pipeline order, with its outcome in
 * words; a failure is never quieter than a pass (FR061).
 */
export function ClaimsView({ onError, galaxy, terrain, snapshotId, map, onWebGlFailure }: Props) {
  const [claims, setClaims] = useState<Claim[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const load = useCallback(async () => {
    try { setClaims((await callTool('get_claims', {})).data.claims) } catch (e) { onError(e) }
  }, [onError])
  useEffect(() => { load() }, [load])
  // A symbol id named in a claim, as `kind:qualified_name`; one gone from the current snapshot keeps its id, which still names it.
  const [looked, setLooked] = useState<Record<string, string>>({})
  useEffect(() => {
    const ids = [...new Set((claims ?? []).flatMap((c) => [c.proposition.source, c.proposition.target]).filter((r): r is string => typeof r === 'string' && r.startsWith('sym_')))]
    Promise.all(ids.map((id) => callTool('get_symbol', { symbol_id: id }).then((r) => [id, `${r.data.symbol.kind}:${r.data.symbol.qualified_name}`] as const, () => [id, id] as const)))
      .then((pairs) => setLooked(Object.fromEntries(pairs)))
  }, [claims])
  const refOf = (ref: string) => looked[ref] ?? ref
  const name = (ref: string) => (refOf(ref).startsWith('sym_') ? ref : shortName(qualifiedOf(refOf(ref))))
  const claim = claims?.find((c) => c.id === selected) ?? claims?.[0] ?? null
  useEffect(() => {
    const ids = claim?.latest?.dependencies.evidence ?? []
    if (!ids.length) { setEvidence([]); return }
    callTool('read_evidence', { evidence_ids: ids }).then((r) => setEvidence(r.data.evidence)).catch(onError)
  }, [claim?.latest?.run_id, onError])
  const verifyAgain = async () => {
    if (!claim) return
    try { await callTool('verify_claim', { claim_id: claim.id }); await load() } catch (e) { onError(e) }
  }

  // The sessions proofmesh mcp recorded, newest first, and the trail of the one chosen (FR1954).
  const [sessions, setSessions] = useState<string[]>([])
  const [session, setSession] = useState('')
  const [trail, setTrail] = useState<Trail | null>(null)
  useEffect(() => {
    callTool('list_queries', { limit: 1000 }).then((r) => {
      const ids = [...new Set((r.data.records as Array<{ session_id?: string }>).flatMap((q) => q.session_id ?? []))]
      setSessions(ids)
      setSession((s) => s || ids[0] || '')
    }).catch(onError)
  }, [onError])
  useEffect(() => {
    let live = true
    // With no session, the answer still says whether recording is on and how to turn it on.
    const ask = async () => {
      const first: Trail = await callTool('get_session_trail', { session_id: session || 'none' })
      // The change is the diff's, on its base snapshot: its dependents are read there, where a deleted symbol still exists.
      const base = first.data.entries.find((e) => e.kind === 'changed' && e.snapshot_id && e.snapshot_id !== first.snapshot.id)?.snapshot_id
      return base ? ((await callTool('get_session_trail', { session_id: session, snapshot_id: base })) as Trail) : first
    }
    ask().then((t) => live && setTrail(t)).catch(onError)
    return () => { live = false }
  }, [session, onError])
  // Each subject's symbol as `kind:qualified_name`, read from the snapshot its step queried.
  const [subjects, setSubjects] = useState<Record<string, string>>({})
  useEffect(() => {
    const keys = [...new Set((trail?.data.entries ?? []).flatMap((e) => (e.symbol_id ? [`${e.snapshot_id ?? trail!.snapshot.id} ${e.symbol_id}`] : [])))]
    Promise.all(keys.map((k) => {
      const [snapshot_id, symbol_id] = k.split(' ')
      return callTool('get_symbol', { symbol_id, snapshot_id }).then((r) => [k, `${r.data.symbol.kind}:${r.data.symbol.qualified_name}`] as const, () => [k, ''] as const)
    })).then((pairs) => setSubjects(Object.fromEntries(pairs)))
  }, [trail])
  const subjectRef = (e: Entry) => (e.symbol_id ? subjects[`${e.snapshot_id ?? trail?.snapshot.id} ${e.symbol_id}`] || null : null)
  const subjectText = (e: Entry) => { const r = subjectRef(e); return r ? member(qualifiedOf(r)) : (e.path ?? e.symbol_id ?? '-') }

  const points = useMemo(() => (galaxy ? pointsByRef(galaxy) : null), [galaxy])
  const steps = useMemo(() => stepsOf(trail?.data.entries ?? []), [trail])
  const seen = useMemo(() => visits(steps, subjectRef), [steps, subjects])
  const gap = useMemo(() => missed(trail?.data.changed ?? []), [trail])
  const runs = (claims ?? []).map((c) => c.latest)
  const stale = claim?.latest && snapshotId && claim.latest.snapshot_id !== snapshotId

  const marks = (v: View) => galaxy && points && (
    <>
      {[...seen].map(([ref, at]) => {
        const i = points.get(ref)
        if (i === undefined) return null
        const p = pointOnScreen(galaxy, v, i)
        return <span key={`t${ref}`} className="trail-mark" data-symbol={qualifiedOf(ref)} title={`${member(qualifiedOf(ref))}: steps ${at.join(', ')}`} aria-hidden="true" style={{ left: p.left, top: p.top }}>{at[0]}{at.length > 1 && <sup>+{at.length - 1}</sup>}</span>
      })}
      {(() => {
        const shown = (claims ?? []).flatMap((c) => {
          const ref = refOf(String(c.proposition.source)), i = points.get(ref)
          if (i === undefined) return []
          const state = pinState(c.latest, snapshotId)
          return [{ c, ref, state, ...pointOnScreen(galaxy, v, i), width: state === 'stale' ? 170 : 28 }]
        })
        const tops = stackPins(shown)
        return shown.map(({ c, ref, state, left }, k) => {
          const label = `${state === 'stale' ? `checked at ${c.latest!.snapshot_id}, not current` : state === 'none' ? 'not checked' : state}: ${describe(c.proposition, name)}${c.latest ? `, checked at ${c.latest.snapshot_id}` : ''}`
          return (
            <button key={c.id} type="button" className={`claim-pin ${state}`} data-verdict={state} data-symbol={qualifiedOf(ref)} aria-label={label} title={label} aria-pressed={claim?.id === c.id} style={{ left, top: tops[k] }} onClick={() => setSelected(c.id)}>
              {state === 'stale' ? `${GLYPH.stale} checked at ${c.latest!.snapshot_id.slice(0, 13)}` : GLYPH[state]}
            </button>
          )
        })
      })()}
    </>
  )

  const trailSection = (
    <section className="trail" aria-label="Session trail">
      <h3>Session trail</h3>
      {trail && !trail.data.recording && !sessions.length && (
        <p role="note">Recording is off for this repository, so no session trail is kept. A person turns it on with <code>proofmesh trail on {trail.snapshot.repository_id}</code>; the Claude Code plugin then records its sessions, and proofmesh mcp the subjects of each query, as symbol ids and paths, never source text.</p>
      )}
      {trail && trail.data.recording && !sessions.length && <p className="dim" role="note">No session has been recorded in this repository yet.</p>}
      {sessions.length > 0 && (
        <>
          <label>Session <select value={session} onChange={(e) => setSession(e.target.value)}>{sessions.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          {trail && !trail.data.recording && <p className="dim" role="note">Recording is off now; what was recorded stays until gc or proofmesh trail purge.</p>}
          {trail && !trail.data.entries.length && <p role="note">This session is no longer available: its records were deleted (gc or proofmesh trail purge).</p>}
          {steps.length > 0 && (
            <ol className="steps" aria-label="Steps in order">
              {steps.flatMap((s, k) => {
                const before = steps.slice(0, k).reverse().find((x) => x.snapshot_id)?.snapshot_id
                const changed = s.snapshot_id && before && s.snapshot_id !== before
                const shown = s.entries.slice(0, 8).map(subjectText)
                return [
                  ...(changed ? [<li key={`c${s.n}`} className="snapshot-change">snapshot changed to {s.snapshot_id!.slice(0, 13)}</li>] : []),
                  <li key={s.n} className="step">{s.n} {s.kind} {s.tool}: {visible(shown.join(', '))}{s.entries.length > 8 ? ` and ${s.entries.length - 8} more` : ''}</li>,
                ]
              })}
            </ol>
          )}
          {trail && trail.data.entries.length > 0 && (
            <section aria-label="Dependents never looked at">
              <h4>{gap.never.length} of {gap.total} dependents of the session's change never looked at</h4>
              {!trail.data.changed.length && <p className="dim">The session changed nothing Proofmesh can see: no edit the plugin recorded and no diff (compare_snapshots) among its queries.</p>}
              <ul className="missed">{gap.never.map((d) => <li key={d.id}>{visible(member(d.qualified_name))} <span className="dim">{visible(d.path)}:{d.line}</span></li>)}</ul>
              <p className="dim">Read on {trail.snapshot.id}. {trail.limitations.filter((l) => /not in |snapshots|stopped/.test(l)).join(' ')}</p>
            </section>
          )}
        </>
      )}
    </section>
  )

  if (!claims) return <p className="hint">Loading claims…</p>
  return (
    <div className="claims-trace">
      <p className="claims-summary" role="status" data-testid="claims-summary">{claimsSummary(runs, snapshotId)}</p>
      {map && galaxy && terrain && (
        <div className="claims-map">
          <Terrain data={galaxy} terrain={terrain} query="" focusArea={null} hoverArea={null} onOpen={NOOP} onHoverArea={NOOP} onBundle={NOOP} onClear={NOOP} onWebGlFailure={onWebGlFailure} drawOver={marks} />
        </div>
      )}
      {!claims.length ? (
        <section className="claims-empty" aria-label="Claims"><h2>No claims yet</h2><p className="dim">An agent records a claim with verify_claim; each check is kept here with every layer's outcome.</p></section>
      ) : (
        <div className="claims" aria-label="Claims">
          <ul className="claim-list" aria-label="Stored claims">
            {claims.map((c) => {
              const state = pinState(c.latest, snapshotId)
              return (
                <li key={c.id}>
                  <button type="button" aria-pressed={claim?.id === c.id} onClick={() => setSelected(c.id)}>
                    <span className={`verdict ${state === 'stale' ? 'none' : c.latest?.verdict ?? 'none'}`}>{state === 'stale' ? 'checked earlier' : c.latest?.verdict ?? 'not checked'}</span>
                    <span className="claim-text" title={describe(c.proposition)}>{visible(describe(c.proposition, name))}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {claim && (
            <section className="claim-detail" aria-label="Claim">
              <div className={`verdict-banner ${stale ? 'none' : claim.latest?.verdict ?? 'none'}`} data-testid="claim-verdict">
                {!claim.latest ? 'not checked yet' : stale ? `checked at ${claim.latest.snapshot_id}, not the current snapshot ${snapshotId}: verify again for a current verdict` : `${claim.latest.verdict} against ${claim.latest.snapshot_id}`}
              </div>
              <p><span className="dim">Proposition checked:</span> {visible(describe(claim.proposition, name))} <span className="dim">({visible(describe(claim.proposition))})</span></p>
              <p><span className="dim">Statement, not checked:</span> {visible(claim.statement)}</p>
              <button type="button" onClick={verifyAgain}>Verify again against the current snapshot</button>
              {claim.latest && (
                <>
                  <ol className="layer-strip" aria-label="Layers in pipeline order">
                    {claim.latest.layers.map((l) => <li key={l.name} className={`layer-cell ${l.outcome}`} data-outcome={l.outcome} title={l.detail}>{l.name}: {words(l.outcome)}</li>)}
                  </ol>
                  <table className="layers">
                    <caption>Verification layers, in order</caption>
                    <thead><tr><th>Layer</th><th>Outcome</th><th>Detail</th></tr></thead>
                    <tbody>
                      {claim.latest.layers.map((l) => <tr key={l.name} data-outcome={l.outcome}><td>{l.name}</td><td><span className={`outcome ${l.outcome}`}>{words(l.outcome)}</span></td><td>{visible(l.detail)}</td></tr>)}
                    </tbody>
                  </table>
                </>
              )}
              {evidence.length > 0 && (
                <section aria-label="Claim evidence">
                  <h3>Evidence the verdict rests on</h3>
                  {evidence.map((e) => (
                    <div key={e.id} className="claim-evidence">
                      <div className="dim">{visible(e.path)}:{e.start_line} · <span className={`integrity ${e.integrity.status}`}>integrity: {e.integrity.status}</span></div>
                      <pre className="source">{e.text === null ? 'Source unavailable: the evidence object failed its integrity check or is missing.' : visible(e.text)}</pre>
                    </div>
                  ))}
                </section>
              )}
            </section>
          )}
        </div>
      )}
      {trailSection}
    </div>
  )
}
