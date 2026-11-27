// Schema-first seams inside one repository (FR403 to FR405): a protobuf RPC or a GraphQL root field, declared in a contract, is linked to
// the code that implements it and the code that calls it, whatever language each is written in. Like the HTTP seams, the pass runs once
// over every adapter's facts, writes only `contract_match` rows (which read as inferred, FR181) and adds no relationship type.
//
// What it reads:
//   - declarations: the `grpc <package>.<Service>/<Method>` and `graphql <Root>.<field>` endpoints a contract declares (the build adapter's
//     `.proto`, `.graphql` and `.gql` files, and SDL in a TypeScript `gql` template), that is every such endpoint no code rule names;
//   - gRPC servers by the supertypes generated code gives them: a type that embeds, extends or implements `UnimplementedSServer`,
//     `SServicer`, `SImplBase`, `SBase` or `ISServer` of a declared service S, and its method named like an RPC (any case);
//   - gRPC clients by the stubs generated code gives them: in a file that constructs `SStub`, `NewSClient`, `SClient` or
//     `SGrpc.new*Stub(...)`, a call named like an RPC of S (any case, or with C#'s `Async`);
//   - GraphQL resolvers and operations from the TypeScript adapter's `exposes` (graphql_resolver_map) and outbound `dispatches_to`
//     (graphql_operation) of a `graphql` endpoint.
// What it writes:
//   - declared endpoint -> implementation, `exposes`, rule grpc_server or graphql_resolver_map; a declaration nothing implements is an
//     unresolved `exposes` (`declared_without_handler`), never a guess;
//   - caller -> declared endpoint, `dispatches_to`, rule grpc_client or graphql_operation; an operation of a field no contract declares is an
//     unresolved `dispatches_to` (`unknown_name`) with the field; one several contracts declare is `ambiguous`.
// shortcut: a gRPC call is recognised only for a service the repository declares, so a stub of an undeclared service links nothing and
// reports nothing; read the stub module's name if those calls must be listed.
import type { AnalyzeResponse } from '../core/generated.js'
import { CAP, type Sym } from './constrained/common.js'
import type { EndpointSym, Qualified } from './seams-http.js'

type Rel = AnalyzeResponse['relationships'][number]
type Item<P> = { rel: Rel; producer: P }

/** Bump when the rules change what they link: it is part of a snapshot's identity, so an older snapshot is never reused. */
export const SCHEMA_SEAMS_VERSION = '1'
/** A contract endpoint's name, which the HTTP seams leave alone. */
export const isContract = (qualified: string) => /^(grpc|graphql) /.test(qualified)

const refOf = (producer: string, local: string) => `${producer}:${local}`
/** The last name of a written type or callee, without type arguments: `pb.UnimplementedOrdersServer` is `UnimplementedOrdersServer`. */
const lastName = (written: string) => written.replace(/<.*$/s, '').split('.').at(-1)!.trim()
/** The service names `name` can be once a generated prefix and suffix are taken off: `UnimplementedOrdersServer` can be `Orders`. */
const services = (name: string, prefixes: string[], suffixes: string[]) => prefixes.flatMap((p) => suffixes.filter((x) => name.length > p.length + x.length && name.startsWith(p) && name.endsWith(x)).map((x) => name.slice(p.length, name.length - x.length)))
/** The supertypes generated server code gives an implementation of service S: Go, Python, Java, C# and TypeScript (grpc-js, ts-proto). */
const serverOf = (base: string) => services(base, ['', 'Unimplemented', 'Unsafe', 'I'], ['Server', 'Servicer', 'ImplBase', 'Base'])
/** What constructs a client of service S: Python `SStub`, Go `NewSClient`, C# and TypeScript `SClient`, Kotlin `SCoroutineStub`, Java `SGrpc.newBlockingStub`. */
const stubOf = (callee: string, qualifier: string | undefined) => /^new(?:Blocking|Future)?Stub$/.test(callee) ? services(lastName(qualifier ?? ''), [''], ['Grpc']) : services(callee, ['', 'New'], ['Client', 'Stub', 'CoroutineStub'])
/** `grpc shop.v1.Orders/GetOrder`: the service's own name and the method. */
const rpcOf = (qualified: string) => { const [service, method] = qualified.slice('grpc '.length).split('/'); return { service: lastName(service!), method: method! } }
const bare = (name: string) => name.replace(/\(.*$/s, '')

export function linkSchemas<P extends { id: string }>(code: Sym[], endpoints: EndpointSym[], items: Array<Item<P>>, seams: P): Array<Qualified<P>> {
  const out: Array<Qualified<P>> = []
  const emit = (rel: Rel) => out.push({ rel: { ...rel, origin: 'contract_match' }, producer: seams, qualified: true })
  const contracts = new Map(endpoints.filter((e) => isContract(e.qualified_name)).map((e) => [refOf(e.producer, e.local_id), e]))
  if (!contracts.size) return out
  const symbols = new Map(code.map((c) => [refOf(c.producer, c.local_id), c]))

  // Endpoints a code rule names, a resolver's or an operation's; every other contract endpoint is a declaration.
  const resolvers = new Map<string, Array<{ ref: string; rule: string }>>()
  const operations: Array<{ rel: Rel; from: string; endpoint: EndpointSym }> = []
  const named = new Set<string>()
  for (const { rel, producer } of items) {
    if (rel.resolution !== 'resolved' || !rel.source.symbol || !rel.target?.symbol) continue
    if (rel.type === 'exposes') {
      const key = refOf(producer.id, rel.source.symbol), e = contracts.get(key)
      if (!e) continue
      named.add(key)
      resolvers.set(e.qualified_name, [...(resolvers.get(e.qualified_name) ?? []), { ref: refOf(producer.id, rel.target.symbol), rule: rel.detail?.rule ?? 'graphql_resolver_map' }])
    } else if (rel.type === 'dispatches_to' && rel.detail?.direction === 'outbound') {
      const key = refOf(producer.id, rel.target.symbol), e = contracts.get(key)
      if (!e) continue
      named.add(key)
      operations.push({ rel, from: refOf(producer.id, rel.source.symbol), endpoint: e })
    }
  }
  const declared = [...contracts].filter(([k]) => !named.has(k)).map(([, e]) => e).sort((a, b) => (a.path === b.path ? a.range.start_byte - b.range.start_byte : a.path < b.path ? -1 : 1))
  const byName = new Map<string, EndpointSym[]>()
  for (const d of declared) byName.set(d.qualified_name, [...(byName.get(d.qualified_name) ?? []), d])
  const rpcs = new Map<string, EndpointSym[]>()
  for (const d of declared) if (d.qualified_name.startsWith('grpc ')) { const s = rpcOf(d.qualified_name).service; rpcs.set(s, [...(rpcs.get(s) ?? []), d]) }

  // gRPC servers: the types whose supertype is a declared service's generated base.
  const implementers = new Map<string, Array<{ type: Sym; base: string }>>()
  if (rpcs.size) for (const { rel, producer } of items) {
    if ((rel.type !== 'inherits' && rel.type !== 'implements') || !rel.source.symbol) continue
    const type = symbols.get(refOf(producer.id, rel.source.symbol))
    const written = rel.detail?.name ?? (rel.target?.symbol ? symbols.get(refOf(producer.id, rel.target.symbol))?.name : undefined)
    if (!type || !written) continue
    for (const s of serverOf(lastName(written))) if (rpcs.has(s)) implementers.set(s, [...(implementers.get(s) ?? []), { type, base: written }])
  }
  const methodsOf = new Map<string, Sym[]>()
  if (implementers.size) for (const c of code) {
    if (c.kind !== 'method' && c.kind !== 'function') continue
    const owner = bare(c.qualified_name).replace(/\.[^.:]+$/, '')
    const key = refOf(c.producer, owner)
    methodsOf.set(key, [...(methodsOf.get(key) ?? []), c])
  }

  for (const d of declared) {
    const site = { path: d.path, range: d.range }, source = { symbol: refOf(d.producer, d.local_id) }, grpc = d.qualified_name.startsWith('grpc ')
    const found: Array<{ ref: string; detail: Record<string, string> }> = []
    if (grpc) {
      const { service, method } = rpcOf(d.qualified_name)
      for (const { type, base } of implementers.get(service) ?? []) {
        for (const m of methodsOf.get(refOf(type.producer, bare(type.qualified_name))) ?? []) {
          if (bare(m.name).toLowerCase() === method.toLowerCase()) found.push({ ref: refOf(m.producer, m.local_id), detail: { rule: 'grpc_server', endpoint: d.qualified_name, base } })
        }
      }
    } else for (const r of resolvers.get(d.qualified_name) ?? []) found.push({ ref: r.ref, detail: { rule: r.rule, endpoint: d.qualified_name } })
    const targets = [...new Map(found.map((f) => [f.ref, f])).values()]
    for (const t of targets) emit({ type: 'exposes', origin: 'contract_match', source, site, resolution: 'resolved', target: { symbol: t.ref }, detail: t.detail })
    if (!targets.length) emit({ type: 'exposes', origin: 'contract_match', source, site, resolution: 'unresolved', reason: 'unknown_name', detail: { rule: grpc ? 'grpc_server' : 'graphql_resolver_map', endpoint: d.qualified_name, why: 'declared_without_handler' } })
  }

  /** A caller linked to the declarations of one endpoint: the one, or ambiguous between several. */
  const call = (from: string, site: Rel['site'], decls: EndpointSym[], detail: Record<string, string>) => {
    const refs = [...new Set(decls.map((x) => refOf(x.producer, x.local_id)))]
    const base = { type: 'dispatches_to' as const, origin: 'contract_match' as const, source: { symbol: from }, site }
    if (refs.length === 1) emit({ ...base, resolution: 'resolved', target: { symbol: refs[0]! }, detail })
    else emit({ ...base, resolution: 'ambiguous', candidates: refs.slice(0, CAP), detail: { ...detail, ...(refs.length > CAP ? { more: String(refs.length - CAP) } : {}) } })
  }
  // GraphQL operations: to the field's declaration, or a boundary with the field when no contract declares it.
  for (const o of operations) {
    const decls = byName.get(o.endpoint.qualified_name) ?? [], detail = { rule: o.rel.detail?.rule ?? 'graphql_operation', endpoint: o.endpoint.qualified_name }
    if (decls.length) call(o.from, o.rel.site, decls, detail)
    else emit({ type: 'dispatches_to', origin: 'contract_match', source: { symbol: o.from }, site: o.rel.site, resolution: 'unresolved', reason: 'unknown_name', detail: { ...detail, field: o.endpoint.name } })
  }
  // gRPC clients: a call named like an RPC, in a file that constructs that service's stub.
  if (!rpcs.size) return out
  const callee = ({ rel, producer }: Item<P>) => rel.detail?.callee ?? (rel.target?.symbol ? symbols.get(refOf(producer.id, rel.target.symbol))?.name : undefined)
  const calls = items.filter((i) => i.rel.type === 'calls' && i.rel.source.symbol)
  const stubs = new Map<string, Map<string, string>>()
  for (const i of calls) {
    const c = callee(i)
    if (!c) continue
    for (const s of stubOf(bare(c), i.rel.detail?.qualifier)) if (rpcs.has(s)) (stubs.get(i.rel.site.path) ?? stubs.set(i.rel.site.path, new Map()).get(i.rel.site.path)!).set(s, bare(c))
  }
  const linked = new Set<string>()
  for (const i of calls) {
    const mine = stubs.get(i.rel.site.path), c = mine && callee(i)
    if (!c) continue
    const from = refOf(i.producer.id, i.rel.source.symbol!), name = bare(c).toLowerCase()
    for (const [s, stub] of mine!) {
      const named = rpcs.get(s)!.filter((d) => { const m = rpcOf(d.qualified_name).method.toLowerCase(); return name === m || name === `${m}async` })
      const key = `${from}|${s}|${name}`
      if (!named.length || linked.has(key)) continue
      linked.add(key)
      call(from, i.rel.site, named, { rule: 'grpc_client', endpoint: named[0]!.qualified_name, stub })
    }
  }
  return out
}
