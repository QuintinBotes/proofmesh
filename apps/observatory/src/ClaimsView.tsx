import { useCallback, useEffect, useState } from 'react'
import { callTool } from './api'
import { visible } from './visible'

type Layer = { name: string; outcome: string; detail: string }
type Run = { run_id: string; snapshot_id: string; verdict: string; layers: Layer[]; dependencies: { assertions: string[]; evidence: string[] }; verified_at: string }
type Claim = { id: string; statement: string; proposition: Record<string, unknown>; created_at: string; latest: Run | null }
type Evidence = { id: string; path: string; start_line: number; text: string | null; integrity: { status: string } }

const describe = (p: Record<string, unknown>, name: (ref: string) => string = String) =>
  p.type === 'relationship' ? `${name(String(p.source))} ${String(p.relationship)} ${name(String(p.target))}`
  : p.type === 'path' ? `a path leads from ${name(String(p.source))} to ${name(String(p.target))}`
  : `no path leads from ${name(String(p.source))} to ${name(String(p.target))}`

/** A reference reads as its symbol's short name: a `kind:qualified_name` reference directly, a symbol id once looked up. */
const shortName = (qualified: string) => qualified.split(/[.:/]/).pop() || qualified
const refName = (ref: string, looked: Record<string, string>) => looked[ref] ?? (ref.startsWith('sym_') ? ref : shortName(ref.slice(ref.indexOf(':') + 1)))

/** Every layer is drawn the same size, in pipeline order, with its outcome in words; a failure is never quieter than a pass. */
export function ClaimsView({ onError }: { onError: (e: unknown) => void }) {
  const [claims, setClaims] = useState<Claim[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const load = useCallback(async () => {
    try { setClaims((await callTool('get_claims', {})).data.claims) } catch (e) { onError(e) }
  }, [onError])
  useEffect(() => { load() }, [load])
  const [looked, setLooked] = useState<Record<string, string>>({})
  useEffect(() => {
    const ids = [...new Set((claims ?? []).flatMap((c) => [c.proposition.source, c.proposition.target]).filter((r): r is string => typeof r === 'string' && r.startsWith('sym_')))]
    // A symbol gone from the current snapshot keeps its id, which still names it exactly.
    Promise.all(ids.map((id) => callTool('get_symbol', { symbol_id: id }).then((r) => [id, shortName(r.data.symbol.qualified_name)] as const, () => [id, id] as const)))
      .then((pairs) => setLooked(Object.fromEntries(pairs)))
  }, [claims])
  const name = (ref: string) => refName(ref, looked)
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
  if (!claims) return <p className="hint">Loading claims…</p>
  if (!claims.length) return <section className="claims-empty" aria-label="Claims"><h2>No claims yet</h2><p className="dim">An agent records a claim with verify_claim; each check is kept here with every layer's outcome.</p></section>
  return (
    <div className="claims" aria-label="Claims">
      <ul className="claim-list" aria-label="Stored claims">
        {claims.map((c) => (
          <li key={c.id}>
            <button type="button" aria-pressed={claim?.id === c.id} onClick={() => setSelected(c.id)}>
              <span className={`verdict ${c.latest?.verdict ?? 'none'}`}>{c.latest?.verdict ?? 'not checked'}</span>
              <span className="claim-text" title={describe(c.proposition)}>{visible(describe(c.proposition, name))}</span>
            </button>
          </li>
        ))}
      </ul>
      {claim && (
        <section className="claim-detail" aria-label="Claim">
          <div className={`verdict-banner ${claim.latest?.verdict ?? 'none'}`} data-testid="claim-verdict">
            {claim.latest ? `${claim.latest.verdict} against ${claim.latest.snapshot_id}` : 'not checked yet'}
          </div>
          <p><span className="dim">Proposition checked:</span> {visible(describe(claim.proposition, name))} <span className="dim">({visible(describe(claim.proposition))})</span></p>
          <p><span className="dim">Statement, not checked:</span> {visible(claim.statement)}</p>
          <button type="button" onClick={verifyAgain}>Verify again against the current snapshot</button>
          {claim.latest && (
            <table className="layers">
              <caption>Verification layers, in order</caption>
              <thead><tr><th>Layer</th><th>Outcome</th><th>Detail</th></tr></thead>
              <tbody>
                {claim.latest.layers.map((l) => <tr key={l.name} data-outcome={l.outcome}><td>{l.name}</td><td><span className={`outcome ${l.outcome}`}>{l.outcome.replace('_', ' ')}</span></td><td>{visible(l.detail)}</td></tr>)}
              </tbody>
            </table>
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
  )
}
