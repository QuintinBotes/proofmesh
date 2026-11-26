// HTTP seams inside one repository (FR255 to FR259): a client call is linked to the handler of the endpoint it names, whatever language
// either is written in, by the rule the workspace links use across repositories (routeScore of links/index.ts) and its confidences.
// Facts only the whole repository can see, so the pass runs once over every adapter's facts, cached or not, as constrained name matching does.
//
// What it reads: a client's outbound `dispatches_to` an endpoint, a code route's `exposes` of its handler, and the endpoints an OpenAPI or
// Swagger document declares (the build adapter's endpoint symbols). The same `VERB path` in code and in a document is one endpoint (A36).
// What it writes, all `contract_match` rows, which read as inferred (FR181), and no new relationship type:
//   - client function -> handler, `dispatches_to`, detail.rule `http_route`, detail.endpoint the endpoint it matched, detail.confidence;
//   - a client that matches nothing stays unresolved `unknown_name` with its path; one that matches only a declared endpoint with no
//     implementation stays unresolved `not_indexed`; one that matches several equally well is `ambiguous`;
//   - declared endpoint -> handler, `exposes`, where code serves the same endpoint, or where the document's operationId names exactly one
//     function (confidence 0.7); a declared endpoint nothing serves is an unresolved `exposes` and invents no link.
import type { AnalyzeResponse } from '../core/generated.js'
import { CAP } from './constrained/common.js'
import { route, routeScore } from '../links/index.js'

type Rel = AnalyzeResponse['relationships'][number]
type Range = Rel['site']['range']
export type EndpointSym = { producer: string; local_id: string; path: string; name: string; qualified_name: string; range: Range; signature: string | null }
export type CodeSym = { producer: string; local_id: string; kind: string; name: string }
type Item<P> = { rel: Rel; producer: P }

/** Bump when the rule changes what it links: it is part of a snapshot's identity, so an older snapshot is never reused. */
export const SEAMS_VERSION = '1'
/** The confidence of a match made only on a repository's own endpoints when the client's base is unknown (`fetch(base + '/orders')`). */
const PREFIX_UNKNOWN = 0.5
/** The confidence of a handler found only by the operationId of the document that declares the endpoint. */
const OPERATION_ID = 0.7

const refOf = (producer: string, local: string) => `@${producer}:${local}`
const pathOf = (qualified: string) => qualified.slice(qualified.indexOf(' ') + 1)
/** Names of the `{param}` segments of a route, by position from the end, as written. */
const params = (qualified: string) => pathOf(qualified).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map((s) => (s.startsWith('{') ? s.replace(/[{}*]/g, '').split(':')[0]!.toLowerCase() : null))

/** routeScore, with path parameters matched by position and not by name: where both sides have one at the same place under different names, the match is 0.9 and not exact. */
function score(client: string, server: string): number {
  const s = routeScore(client, server)
  if (s < 1) return s
  const c = params(client), sv = params(server).slice(-c.length || undefined)
  return c.some((n, i) => n !== null && sv[i] !== null && sv[i] !== undefined && n !== sv[i]) ? 0.9 : s
}

const operationKey = (qualified: string) => { const r = route(qualified); return `${r.verb} ${r.segments.join('/')}` }
const normalName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

type Op = { names: string[]; handlers: Array<{ ref: string; cap: number }>; declared: EndpointSym[] }

export function linkHttp<P extends { id: string }>(code: CodeSym[], endpoints: EndpointSym[], items: Array<Item<P>>, seams: P): Array<Item<P>> {
  const endpoint = new Map(endpoints.map((e) => [`${e.producer}:${e.local_id}`, e]))
  const ops = new Map<string, Op>()
  const op = (qualified: string) => ops.get(operationKey(qualified)) ?? ops.set(operationKey(qualified), { names: [], handlers: [], declared: [] }).get(operationKey(qualified))!
  const out: Array<Item<P>> = []
  const emit = (rel: Rel) => out.push({ rel: { ...rel, origin: 'contract_match' }, producer: seams })

  // Code routes: an endpoint's `exposes` of the code that handles it.
  for (const { rel, producer } of items) {
    if (rel.type !== 'exposes' || rel.resolution !== 'resolved' || !rel.source.symbol || !rel.target?.symbol) continue
    const e = endpoint.get(`${producer.id}:${rel.source.symbol}`)
    if (!e) continue
    const o = op(e.qualified_name), handler = refOf(producer.id, rel.target.symbol)
    if (!o.names.includes(e.qualified_name)) o.names.push(e.qualified_name)
    if (!o.handlers.some((h) => h.ref === handler)) o.handlers.push({ ref: handler, cap: 1 })
  }
  // Declared endpoints: the symbols of an API description; one that code serves is the same operation, one a unique operationId names is served by that function.
  const functions = new Map<string, string[]>()
  for (const c of code) if (c.kind === 'function' || c.kind === 'method') functions.set(normalName(c.name), [...(functions.get(normalName(c.name)) ?? []), refOf(c.producer, c.local_id)])
  const declared = endpoints.filter((e) => e.producer === 'build').sort((a, b) => (a.path === b.path ? a.range.start_byte - b.range.start_byte : a.path < b.path ? -1 : 1))
  for (const d of declared) {
    const o = op(d.qualified_name)
    o.declared.push(d)
    if (!o.names.includes(d.qualified_name)) o.names.push(d.qualified_name)
  }
  for (const d of declared) {
    const o = op(d.qualified_name), site = { path: d.path, range: d.range }, source = { symbol: refOf(d.producer, d.local_id) }
    const id = /^operationId: (.+)$/.exec(d.signature ?? '')?.[1]
    const served = o.handlers.filter((h) => h.cap === 1)
    if (served.length) { for (const h of served) emit({ type: 'exposes', origin: 'contract_match', source, site, resolution: 'resolved', target: { symbol: h.ref }, detail: { rule: 'openapi_path', endpoint: d.qualified_name, confidence: '1' } }); continue }
    const named = id ? functions.get(normalName(id)) ?? [] : []
    if (named.length === 1) {
      if (!o.handlers.some((h) => h.ref === named[0])) o.handlers.push({ ref: named[0]!, cap: OPERATION_ID })
      emit({ type: 'exposes', origin: 'contract_match', source, site, resolution: 'resolved', target: { symbol: named[0]! }, detail: { rule: 'openapi_operation_id', endpoint: d.qualified_name, operation_id: id!, confidence: String(OPERATION_ID) } })
      continue
    }
    emit({ type: 'exposes', origin: 'contract_match', source, site, resolution: 'unresolved', reason: 'unknown_name', detail: { rule: 'openapi_path', endpoint: d.qualified_name, why: 'declared_without_handler', ...(id ? { operation_id: id } : {}) } })
  }

  // Clients: an outbound call of an endpoint, to the handler of the operation it names.
  for (const { rel, producer } of items) {
    if (rel.type !== 'dispatches_to' || rel.resolution !== 'resolved' || rel.detail?.direction !== 'outbound' || !rel.source.symbol || !rel.target?.symbol) continue
    const client = endpoint.get(`${producer.id}:${rel.target.symbol}`)
    if (!client) continue
    const base = { type: 'dispatches_to' as const, origin: 'contract_match' as const, source: { symbol: refOf(producer.id, rel.source.symbol) }, site: rel.site }
    const me = refOf(producer.id, rel.source.symbol), prefixUnknown = rel.detail.prefix_unknown === 'true'
    const scored = [...ops.values()].map((o) => { const best = o.names.map((n) => ({ n, s: score(client.qualified_name, n) })).sort((a, b) => b.s - a.s || (a.n < b.n ? -1 : 1))[0]; return { o, endpoint: best?.n ?? '', score: best?.s ?? 0 } }).filter((m) => m.score > 0)
    const top = Math.max(0, ...scored.map((m) => m.score))
    // A client whose base is unknown matches by the end of its path alone, so it is linked only when one endpoint ends so.
    const pool = prefixUnknown ? scored : scored.filter((m) => m.score === top)
    const detail = { rule: 'http_route', path: pathOf(client.qualified_name), ...(prefixUnknown ? { prefix_unknown: 'true' } : {}) }
    if (!pool.length) { emit({ ...base, resolution: 'unresolved', reason: 'unknown_name', detail }); continue }
    const handlers = [...new Map(pool.flatMap((m) => m.o.handlers.map((h) => [h.ref, { ...h, via: m }] as const)).filter(([r]) => r !== me)).values()]
    if (!handlers.length) { emit({ ...base, resolution: 'unresolved', reason: 'not_indexed', detail: { ...detail, endpoint: pool[0]!.endpoint, why: 'declared_without_handler' } }); continue }
    const confidence = (m: { score: number }, h: { cap: number }) => Math.min(m.score, h.cap, prefixUnknown ? PREFIX_UNKNOWN : 1)
    if (handlers.length === 1) {
      const h = handlers[0]!
      emit({ ...base, resolution: 'resolved', target: { symbol: h.ref }, detail: { ...detail, endpoint: h.via.endpoint, confidence: String(confidence(h.via, h)) } })
      continue
    }
    emit({ ...base, resolution: 'ambiguous', candidates: handlers.slice(0, CAP).map((h) => h.ref), detail: { ...detail, endpoint: pool[0]!.endpoint, confidence: String(Math.max(...handlers.map((h) => confidence(h.via, h)))), ...(handlers.length > CAP ? { more: String(handlers.length - CAP) } : {}) } })
  }
  return out
}
