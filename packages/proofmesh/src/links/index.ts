// Cross-repository links (A7): facts of one member snapshot that reach into another, sealed in a workspace link file (A28).
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ProofmeshError } from '../core/errors.js'
import { canonicalJson, sha256, sha256File } from '../core/hash.js'
import { EvidenceStore } from '../evidence/store.js'
import { readSql } from '../core/schemas.js'
import { Catalog, type LinkFileRecord } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'

export const LINK_FORMAT_VERSION = '0.2'
/** Each rule's version, and the link format's, join the link file's identity: a changed rule or format seals a new file. */
export const RULES = { http_route: '3', messaging: '1', package: '1', service_name: '1', service_registry: '1', cloud_deploy: '1', cloud_messaging: '1' } as const
export const linkPath = (dataDir: string, id: string) => path.join(dataDir, 'links', `${id}.db`)

type Member = { repository_id: string; snapshot_id: string; name: string; db: Database.Database; registry?: Registry }
type Target = { repository_id: string; symbol_id: string | null; confidence: number }
/** ambiguous: the fact matched several members equally well, so even a link with one target is a candidate. */
type Link = { type: string; rule: keyof typeof RULES; source_repository_id: string; source_symbol_id: string; source_assertion_id: string; targets: Target[]; ambiguous?: boolean }

/** One caller a service registry grants (A7): its name, and optionally the repository or service it is. */
export type RegistryEntry = { name: string; repository?: string; service?: string }
type Registry = { path: string; entries: RegistryEntry[] }
const REGISTRY_FIELDS = new Set(['name', 'repository', 'service'])
const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2')

/**
 * The callers a registry file lists: every YAML list item, either a bare name or a mapping of `name` and optional `repository` and
 * `service`, under any top-level key. Items without a name are skipped.
 */
// shortcut: flat block lists only (no anchors, flow collections or multi-line scalars); take a YAML parser if registries outgrow that.
export function parseRegistry(text: string): RegistryEntry[] {
  const entries: Array<Partial<RegistryEntry>> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '')
    const item = /^\s*-\s+(.*)$/.exec(line)
    const field = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(item ? item[1]! : line)
    if (item && !field) entries.push({ name: unquote(item[1]!) })
    else if (item) entries.push({})
    // A field belongs to the item above it only when indented; a top-level key such as `clients:` starts the list.
    if (field && (item || /^\s/.test(line)) && REGISTRY_FIELDS.has(field[1]!) && field[2]!.trim() && entries.length) entries[entries.length - 1]![field[1] as keyof RegistryEntry] = unquote(field[2]!)
  }
  return entries.filter((e): e is RegistryEntry => !!e.name)
}

/** How well a registry entry names a repository: 1 when one of its identities is the repository's name, 0.8 when one matches as a service name does, else 0. */
export function registryScore(entry: RegistryEntry, repositoryName: string): number {
  const ids = [entry.repository, entry.service, entry.name].filter((x): x is string => !!x)
  return ids.includes(repositoryName) ? 1 : ids.some((id) => serviceMatches(id, repositoryName)) ? 0.8 : 0
}

/**
 * service_registry: each caller a member's registry grants, from the member that is that caller to the registry's member. The registry
 * entry, not a code fact, is the link's source: its id is `<path>#<name>`. An entry no member is stays a boundary on the registry's
 * member; an entry whose best match is the registry's own repository says nothing across repositories.
 */
export function registryLinks(members: Array<Pick<Member, 'repository_id' | 'name' | 'registry'>>): Link[] {
  const links: Link[] = []
  for (const m of members) {
    const seen = new Set<string>()
    for (const e of m.registry?.entries ?? []) {
      if (seen.has(e.name)) continue
      seen.add(e.name)
      const scored = members.map((o) => ({ member: o, repository_id: o.repository_id, confidence: registryScore(e, o.name) })).filter((c) => c.confidence > 0)
      const top = Math.max(0, ...scored.map((c) => c.confidence)), callers = scored.filter((c) => c.confidence === top)
      if (callers.some((c) => c.member === m)) continue
      const entry = { type: 'calls_service', rule: 'service_registry' as const, source_symbol_id: `${m.registry!.path}#${e.name}`, source_assertion_id: `service_registry:${m.repository_id}:${m.registry!.path}#${e.name}` }
      if (!callers.length) links.push({ ...entry, source_repository_id: m.repository_id, targets: [] })
      for (const c of callers) links.push({ ...entry, source_repository_id: c.repository_id, targets: [{ repository_id: m.repository_id, symbol_id: null, confidence: c.confidence }], ambiguous: callers.length > 1 })
    }
  }
  return links
}

/** A member's registry as its snapshot captured it, never the working tree, so the link file is reproducible. */
function readRegistry(m: Member, store: EvidenceStore, registryPath: string): Registry {
  const row = m.db.prepare("select content_hash from file where path = ? and disposition = 'indexed'").get(registryPath) as { content_hash: string } | undefined
  if (!row) throw new ProofmeshError('STALE_INPUT', `the service registry ${registryPath} of ${m.name} is not in its snapshot ${m.snapshot_id}; run "proofmesh index ${m.name}" to capture it`, { repository: m.name, path: registryPath })
  return { path: registryPath, entries: parseRegistry(captured(store, row.content_hash, `service registry ${registryPath} of ${m.name}`).toString('utf8')) }
}

/** A file's bytes as a member's snapshot captured them, refused when the evidence store lost them or they no longer match their hash. */
function captured(store: EvidenceStore, hash: string, what: string): Buffer {
  const { integrity, content } = store.verify(hash)
  if (!content) throw new ProofmeshError(integrity.status === 'failed' ? 'INTEGRITY_FAILURE' : 'EVIDENCE_UNAVAILABLE', `the captured ${what} ${integrity.status === 'failed' ? 'does not match its hash' : 'is missing from the evidence store'}`)
  return content
}

type CloudKind = { role: 'hosting' | 'messaging'; nameAt: string }
const kinds = (role: CloudKind['role'], nameAt: string, ...types: string[]) => types.map((t) => [t, { role, nameAt }] as const)
/**
 * The resources A35 links, by Terraform type or Pulumi token, with the path of the attribute that names each, as `literals` keys it. A
 * Pulumi token is keyed lower-cased without `-` and `_`, so one row serves `azure-native.web.WebApp` (TypeScript), `azure_native.web.WebApp`
 * (Python) and `azurenative.web.WebApp` (C#).
 */
const CLOUD = new Map<string, CloudKind>([
  ...kinds('hosting', 'name', 'azurerm_linux_web_app', 'azurerm_windows_web_app', 'azurerm_app_service', 'azurerm_container_app', 'azurerm_linux_function_app', 'azurerm_windows_function_app',
    'azurerm_function_app', 'aws_ecs_service', 'google_cloud_run_service', 'google_cloud_run_v2_service', 'helm_release', 'azurenative.web.webapp', 'azure.appservice.linuxwebapp',
    'azure.appservice.windowswebapp', 'azure.appservice.appservice', 'azure.appservice.linuxfunctionapp', 'azure.appservice.windowsfunctionapp', 'azure.appservice.functionapp',
    'azure.containerapp.app', 'aws.lambda.function', 'aws.ecs.service', 'gcp.cloudrun.service', 'gcp.cloudrunv2.service', 'kubernetes.helm.v3.release'),
  ...kinds('hosting', 'functionname', 'aws_lambda_function'),
  ...kinds('hosting', 'family', 'aws_ecs_task_definition', 'aws.ecs.taskdefinition'),
  ...kinds('hosting', 'servicename', 'aws_apprunner_service', 'aws.apprunner.service'),
  ...kinds('hosting', 'containerappname', 'azurenative.app.containerapp'),
  ...kinds('hosting', 'metadata.name', 'kubernetes_deployment', 'kubernetes_deployment_v1', 'kubernetes.apps.v1.deployment'),
  ...kinds('messaging', 'name', 'azurerm_servicebus_topic', 'azurerm_servicebus_queue', 'azurerm_servicebus_subscription', 'azurerm_eventhub', 'aws_sns_topic', 'aws_sqs_queue', 'kafka_topic',
    'google_pubsub_topic', 'google_pubsub_subscription', 'azure.servicebus.topic', 'azure.servicebus.queue', 'azure.servicebus.subscription', 'azure.eventhub.eventhub', 'aws.sns.topic',
    'aws.sqs.queue', 'kafka.topic', 'gcp.pubsub.topic', 'gcp.pubsub.subscription'),
  ...kinds('messaging', 'topicname', 'confluent_kafka_topic', 'confluentcloud.kafkatopic', 'azurenative.servicebus.topic'),
  ...kinds('messaging', 'queuename', 'azurenative.servicebus.queue'),
  ...kinds('messaging', 'subscriptionname', 'azurenative.servicebus.subscription'),
  ...kinds('messaging', 'eventhubname', 'azurenative.eventhub.eventhub'),
])
const IMAGE_KEYS = new Set(['image', 'imageuri', 'dockerimagename'])
/** The repository an image reference names: `registry.example/team/orders-api:1.2` and `orders-api@sha256:...` both name `orders-api`. */
export const imageRepository = (image: string) => image.replace(/@.*$/, '').split('/').pop()!.replace(/:.*$/, '')

/** A quoted string starting at `i`: where it ends, its text, and whether it interpolates (`${...}` or `%{...}`). */
function quoted(s: string, i: number): { end: number; value: string; interpolates: boolean } {
  const q = s[i]!, close = q !== '`' && s.startsWith(q.repeat(3), i) ? q.repeat(3) : q
  let j = i + close.length, value = '', interpolates = false
  while (j < s.length && !s.startsWith(close, j)) {
    // A plain string cannot cross a line; one that seems to was misread, so it is no literal.
    if (s[j] === '\n' && close === q && q !== '`') return { end: j, value, interpolates: true }
    if (s[j] === '\\') { value += s[j + 1] ?? ''; j += 2; continue }
    if ((s[j] === '$' || s[j] === '%') && s[j + 1] === '{') {
      interpolates = true
      for (let depth = 0; j < s.length; j++) if (s[j] === '{') depth++; else if (s[j] === '}' && --depth === 0) break
      j++
      continue
    }
    value += s[j++]
  }
  return { end: Math.min(j + close.length, s.length), value, interpolates }
}

/**
 * The literal strings a resource's block assigns, in each language that declares resources: HCL `key = "v"`, TypeScript `key: "v"`, Python
 * `key="v"`, C# `Key = "v"`. Each is keyed by its path inside the block: the keys of the objects, calls and HCL blocks around it, then its
 * own, lower-cased without `_`, such as `name` or `template.container.image`. A string that interpolates (`${}`, an f-string, `$"..."`) or
 * is only part of an expression is not a literal and is left out.
 */
// shortcut: a tokenizer, not a parser: an HCL heredoc is read as code, and a value on the line after its key is missed; take each language's parser if resource blocks outgrow that.
export function literals(block: string, hcl: boolean): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = []
  // One frame per open bracket: the key it is the value of, and the key awaiting a value inside it (fresh until anything but a string follows).
  const frames: Array<{ key: string | null; pending: string | null; fresh: boolean }> = [{ key: null, pending: null, fresh: false }]
  const top = () => frames[frames.length - 1]!
  const norm = (k: string) => k.toLowerCase().replace(/_/g, '')
  const word = /[A-Za-z_]\w*/y
  const skip = (j: number) => { while (j < block.length && ' \t\r'.includes(block[j]!)) j++; return j }
  const assigns = (j: number) => (block[j] === '=' && !'=>'.includes(block[j + 1] ?? '')) || (block[j] === ':' && block[j + 1] !== ':')
  const ends = (j: number) => j >= block.length || ',)]};\n#'.includes(block[j]!) || block.startsWith('//', j)
  // HCL: the first word of a line, which names the block a `{` on that line opens, as `metadata` does in `metadata {`.
  let head: string | null = null
  let i = 0
  const string = (at: number, interpolates: boolean) => {
    const s = quoted(block, at), j = skip(s.end), f = top()
    i = s.end
    if (assigns(j)) { f.pending = norm(s.value); f.fresh = true; i = j + 1; return }
    // The outermost bracket is the resource's own block or call, so paths start inside it.
    if (f.pending && f.fresh && !interpolates && !s.interpolates && ends(j)) out.push({ path: [...frames.slice(2).map((x) => x.key), f.pending].filter(Boolean).join('.'), value: s.value })
    f.fresh = false
  }
  while (i < block.length) {
    const c = block[i]!
    if (c === '\n') { if (hcl) { top().pending = null; head = null } i++; continue }
    if (' \t\r'.includes(c)) { i++; continue }
    if (c === '#' || block.startsWith('//', i)) { const e = block.indexOf('\n', i); i = e < 0 ? block.length : e; continue }
    if (block.startsWith('/*', i)) { const e = block.indexOf('*/', i + 2); i = e < 0 ? block.length : e + 2; continue }
    if ('"\'`'.includes(c)) { string(i, false); continue }
    // C# `$"..."` interpolates; `@"..."` is verbatim.
    const csharp = /^[$@]{1,2}"/.exec(block.slice(i, i + 3))
    if (csharp) { string(i + csharp[0].length - 1, csharp[0].includes('$')); continue }
    word.lastIndex = i
    const w = word.exec(block)?.[0]
    if (w) {
      i += w.length
      // A Python string prefix: an f-string interpolates.
      if (/^[rbuf]{1,2}$/i.test(w) && '"\''.includes(block[i] ?? '')) { string(i, /f/i.test(w)); continue }
      const j = skip(i)
      if (assigns(j)) { top().pending = norm(w); top().fresh = true; i = j + 1; continue }
      if (hcl) head ??= w
      top().fresh = false
      continue
    }
    if ('([{'.includes(c)) {
      const f = top()
      frames.push({ key: f.pending ?? (hcl && c === '{' ? head : null), pending: null, fresh: false })
      f.pending = null; f.fresh = false; head = null
    } else if (')]}'.includes(c)) {
      if (frames.length > 1) frames.pop()
      top().pending = null; top().fresh = false
    } else if (c === ',' || c === ';') top().pending = null
    else top().fresh = false
    i++
  }
  return out
}

type CloudResource = { symbol_id: string; role: CloudKind['role']; names: string[] }
/**
 * The hosting and messaging resources a member declares, each with the literal names its block gives it, read from the bytes its snapshot
 * captured, never the working tree (A35): the attribute that names it, a Pulumi resource's logical name, and a hosting resource's images.
 */
function cloudResources(m: Member, store: EvidenceStore): CloudResource[] {
  const out: CloudResource[] = [], files = new Map<string, Buffer>()
  for (const r of q<{ id: string; signature: string; path: string; object_hash: string; start_byte: number; end_byte: number }>(m.db, `select s.id, s.signature, f.path, e.object_hash, e.start_byte, e.end_byte from symbol s join evidence e on e.id = s.evidence_id join file f on f.id = e.file_id where s.kind = 'resource' and s.signature like 'resource "%'`)) {
    const type = r.signature.slice('resource "'.length, -1), pulumi = type.includes('.')
    const kind = CLOUD.get(pulumi ? type.toLowerCase().replace(/[-_]/g, '') : type)
    if (!kind) continue
    if (!files.has(r.object_hash)) files.set(r.object_hash, captured(store, r.object_hash, `file ${r.path} of ${m.name}`))
    const block = files.get(r.object_hash)!.subarray(r.start_byte, r.end_byte).toString('utf8')
    const values = literals(block, r.path.endsWith('.tf'))
    const names = values.filter((v) => v.path === kind.nameAt).map((v) => v.value)
    const logical = pulumi ? /^[^(]*\(\s*(["'`])([^"'`\\$]*)\1\s*[,)]/.exec(block)?.[2] : undefined
    if (logical) names.push(logical)
    if (kind.role === 'hosting') names.push(...values.filter((v) => IMAGE_KEYS.has(v.path.split('.').pop()!)).map((v) => imageRepository(v.value)))
    out.push({ symbol_id: r.id, role: kind.role, names: names.filter(Boolean) })
  }
  return out
}

/** A route as `VERB path`, lower-cased, trimmed of slashes, with each `{param}` a wildcard segment. */
export function route(qualified: string): { verb: string; segments: string[] } {
  const [verb = '', ...rest] = qualified.split(' ')
  return { verb: verb.toUpperCase(), segments: rest.join(' ').toLowerCase().replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map((s) => (s.startsWith('{*') ? '{*}' : s.startsWith('{') ? '{}' : s)) }
}

/** How well a client route matches a server route: 1 exact, 0.9 a literal where the server has a parameter, 0.6 the client path is a suffix of the server's, 0 none or when no literal segment matched literally. */
export function routeScore(client: string, server: string): number {
  const c = route(client), s = route(server)
  // A catch-all route (`{*path}`) accepts anything and so names no operation; it never counts as a match.
  if (s.segments.includes('{*}') || s.segments.length < c.segments.length) return 0
  const tail = s.segments.slice(s.segments.length - c.segments.length)
  let score = s.segments.length === c.segments.length ? 1 : 0.6
  // The same path under another verb is still the same operation in most APIs (a POST-only API read through a client's "get" wrapper), with less certainty.
  if (c.verb !== s.verb && s.verb !== 'ANY' && c.verb !== 'ANY') score = Math.min(score, 0.8)
  // A match made only of parameter segments (`{a}/{b}` against `rates/add`) is no evidence: one literal must match literally.
  let literal = c.segments.length === 0
  for (const [i, seg] of tail.entries()) {
    const want = c.segments[i]!
    if (seg === want) { literal ||= seg !== '{}'; continue }
    if (seg === '{}') { score = Math.min(score, 0.9); continue }
    return 0
  }
  return literal ? score : 0
}

/** Whether a downstream service name names a repository: case-insensitive, without `Service`, `.Api`, `-api` and `_api` suffixes. */
export function serviceMatches(service: string, repositoryName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/(service|[.\-_]api)$/i, '').replace(/[^a-z0-9]/g, '')
  return norm(service) === norm(repositoryName)
}

const q = <T>(db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[]
type Fact = { assertion_id: string; source_id: string; name: string }
type Sym = { id: string; qualified_name: string }

/** The link rules over the members: each outbound fact of one member against what the other members declare. */
function matchAll(members: Member[], store: EvidenceStore): Link[] {
  const links: Link[] = []
  const others = (m: Member) => members.filter((o) => o !== m)
  const bestOf = (scored: Target[]): Target[] => {
    const top = Math.max(0, ...scored.map((t) => t.confidence))
    return scored.filter((t) => t.confidence === top)
  }
  // What each member declares, read once: a large member's assertion table is too big to scan per fact.
  const exposed = new Map(members.map((m) => [m, q<Sym>(m.db, "select distinct s.id, s.qualified_name from assertion a join symbol s on s.id = a.source_id where a.type = 'exposes' and s.kind = 'endpoint'")]))
  const projects = new Map(members.map((m) => {
    const byName = new Map<string, Sym[]>()
    for (const p of q<Sym>(m.db, "select id, qualified_name from symbol where kind in ('project', 'package')")) (byName.get(p.qualified_name.toLowerCase()) ?? byName.set(p.qualified_name.toLowerCase(), []).get(p.qualified_name.toLowerCase())!).push(p)
    return [m, byName]
  }))
  const resources = new Map(members.map((m) => [m, cloudResources(m, store)]))
  for (const m of members) {
    // http_route: an outbound HTTP client fact to an endpoint another member exposes.
    const own = exposed.get(m)!
    for (const f of q<Fact>(m.db, "select a.id as assertion_id, a.source_id, t.qualified_name as name from assertion a join symbol t on t.id = a.target_id where a.type = 'dispatches_to' and t.kind = 'endpoint' and json_extract(a.detail, '$.direction') = 'outbound'")) {
      if (own.some((e) => routeScore(f.name, e.qualified_name) === 1)) continue
      const scored = others(m).flatMap((o) => exposed.get(o)!.map((e) => ({ repository_id: o.repository_id, symbol_id: e.id, confidence: routeScore(f.name, e.qualified_name) })).filter((t) => t.confidence > 0))
      links.push({ type: 'calls_endpoint', rule: 'http_route', source_repository_id: m.repository_id, source_symbol_id: f.source_id, source_assertion_id: f.assertion_id, targets: bestOf(scored) })
    }
    // messaging: a channel a member publishes to, to the same channel another member consumes.
    const ownConsumed = new Set(q<Sym>(m.db, "select t.qualified_name from assertion a join symbol t on t.id = a.target_id where a.type = 'consumes' and t.kind = 'channel'").map((s) => s.qualified_name))
    for (const f of q<Fact & { channel_id: string }>(m.db, "select min(a.id) as assertion_id, t.id as channel_id, t.id as source_id, t.qualified_name as name from assertion a join symbol t on t.id = a.target_id where a.type = 'publishes' and t.kind = 'channel' group by t.id")) {
      if (ownConsumed.has(f.name)) continue
      const scored = others(m).flatMap((o) => q<Sym>(o.db, "select distinct t.id, t.qualified_name from assertion a join symbol t on t.id = a.target_id where a.type = 'consumes' and t.kind = 'channel' and t.qualified_name = ?", f.name).map((c) => ({ repository_id: o.repository_id, symbol_id: c.id, confidence: 1 })))
      links.push({ type: 'messages', rule: 'messaging', source_repository_id: m.repository_id, source_symbol_id: f.channel_id, source_assertion_id: f.assertion_id, targets: scored })
    }
    // package: a package reference to the member project that builds that package.
    const ownProjects = projects.get(m)!
    for (const f of q<Fact>(m.db, "select a.id as assertion_id, a.source_id, x.name from assertion a join external_symbol x on x.id = a.target_id where a.type = 'depends_on_package'")) {
      if (ownProjects.has(f.name.toLowerCase())) continue
      const scored = others(m).flatMap((o) => (projects.get(o)!.get(f.name.toLowerCase()) ?? []).map((p) => ({ repository_id: o.repository_id, symbol_id: p.id, confidence: 0.9 })))
      links.push({ type: 'depends_on_package', rule: 'package', source_repository_id: m.repository_id, source_symbol_id: f.source_id, source_assertion_id: f.assertion_id, targets: scored })
    }
    // service_name: a named downstream service to the member repository that is that service.
    for (const f of q<Fact>(m.db, "select a.id as assertion_id, a.source_id, t.qualified_name as name from assertion a join symbol t on t.id = a.target_id where a.type = 'calls_service' and t.kind = 'service'")) {
      if (serviceMatches(f.name, m.name)) continue
      const scored = others(m).filter((o) => serviceMatches(f.name, o.name)).map((o) => ({ repository_id: o.repository_id, symbol_id: null, confidence: 0.7 }))
      links.push({ type: 'calls_service', rule: 'service_name', source_repository_id: m.repository_id, source_symbol_id: f.source_id, source_assertion_id: f.assertion_id, targets: scored })
    }
    // A resource that names its own member is declared where it is deployed or used, which needs no link (A35); one that names nothing in the
    // workspace is no boundary either, since infrastructure names much that no member is.
    const across = (best: Target[]) => best.length > 0 && !best.some((t) => t.repository_id === m.repository_id)
    // cloud_deploy: a hosting resource to the member its name, or the repository of its container image, names. No assertion declares a
    // resource, so the source assertion is named after the rule and the resource, as a registry entry's is.
    for (const r of resources.get(m)!.filter((x) => x.role === 'hosting')) {
      const score = (o: Member) => Math.max(0, ...r.names.map((n) => (n.toLowerCase() === o.name.toLowerCase() ? 0.9 : serviceMatches(n, o.name) ? 0.7 : 0)))
      const best = bestOf(members.map((o) => ({ repository_id: o.repository_id, symbol_id: null, confidence: score(o) })).filter((t) => t.confidence > 0))
      if (across(best)) links.push({ type: 'deploys', rule: 'cloud_deploy', source_repository_id: m.repository_id, source_symbol_id: r.symbol_id, source_assertion_id: `cloud_deploy:${r.symbol_id}`, targets: best })
    }
    // cloud_messaging: a channel a member publishes or consumes, without its `kafka:`-style prefix, to the messaging resource with that name.
    for (const f of q<Fact>(m.db, "select min(a.id) as assertion_id, t.id as source_id, t.qualified_name as name from assertion a join symbol t on t.id = a.target_id where a.type in ('publishes', 'consumes') and t.kind = 'channel' group by t.id, a.type")) {
      const channel = f.name.replace(/^[^:]*:/, '')
      const best = bestOf(members.flatMap((o) => resources.get(o)!.filter((r) => r.role === 'messaging').map((r) => ({ repository_id: o.repository_id, symbol_id: r.symbol_id, confidence: r.names.includes(channel) ? 1 : r.names.some((n) => n.toLowerCase() === channel.toLowerCase()) ? 0.9 : 0 }))).filter((t) => t.confidence > 0))
      if (across(best)) links.push({ type: 'uses_resource', rule: 'cloud_messaging', source_repository_id: m.repository_id, source_symbol_id: f.source_id, source_assertion_id: f.assertion_id, targets: best })
    }
  }
  return [...links, ...registryLinks(members)]
}

/** Seals the link file of a workspace's current member snapshots, or returns the one already sealed for the same identity. */
export function buildLinkFile(catalog: Catalog, dataDir: string, workspace: string): { record: LinkFileRecord; created: boolean; counts: Record<string, Record<string, number>> } {
  const ws = catalog.workspace(workspace)
  if (ws.members.length < 2) throw new ProofmeshError('INVALID_ARGUMENT', `workspace ${workspace} needs at least two repositories to link`)
  const members: Member[] = ws.members.sort().map((repository_id) => {
    const snap = catalog.currentSnapshot(repository_id)
    if (!snap) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `no published snapshot for ${catalog.repository(repository_id).name}; run "proofmesh index" first`, { detail: 'none' })
    return { repository_id, snapshot_id: snap.id, name: catalog.repository(repository_id).name, db: openSnapshot(catalog, snap) }
  })
  try {
    // The registries a workspace names are inputs too: naming another one must seal another file.
    const registries = catalog.workspaceRegistries(workspace), store = new EvidenceStore(dataDir)
    for (const m of members) { const p = registries.get(m.repository_id); if (p !== undefined) m.registry = readRegistry(m, store, p) }
    const identity = canonicalJson({ format: LINK_FORMAT_VERSION, members: members.map((m) => ({ repository_id: m.repository_id, snapshot_id: m.snapshot_id })), rules: RULES, ...(registries.size ? { registries: Object.fromEntries(registries) } : {}) })
    const id = `link_${sha256(identity).slice(0, 24)}`
    const existing = catalog.linkFile(id)
    if (existing) { openLinkFile(catalog, existing).close(); return { record: existing, created: false, counts: countLinks(catalog, existing) } }
    const links = matchAll(members, store)
    const staging = path.join(dataDir, 'staging', id, 'links.db')
    fs.rmSync(path.dirname(staging), { recursive: true, force: true })
    fs.mkdirSync(path.dirname(staging), { recursive: true })
    const db = new Database(staging)
    db.exec(readSql(`link-format/${LINK_FORMAT_VERSION}.sql`))
    const meta = db.prepare('insert into meta (key, value) values (?, ?)')
    for (const [k, v] of Object.entries({ format_version: LINK_FORMAT_VERSION, link_file_id: id, workspace, identity, rules: JSON.stringify(RULES), sealed_at: new Date().toISOString() })) meta.run(k, v)
    const member = db.prepare('insert into member (repository_id, snapshot_id, name) values (?, ?, ?)')
    const link = db.prepare('insert into link (id, type, rule, source_repository_id, source_symbol_id, source_assertion_id, target_repository_id, target_symbol_id, confidence, resolution, reason) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const candidate = db.prepare('insert into link_candidate (link_id, target_repository_id, target_symbol_id, confidence) values (?, ?, ?, ?)')
    db.transaction(() => {
      for (const m of members) member.run(m.repository_id, m.snapshot_id, m.name)
      for (const l of links) {
        // One fact can be the source of links of several rules, as a published channel is of messaging and cloud_messaging.
        const linkId = `lk_${sha256(canonicalJson({ id, a: l.source_assertion_id, r: l.source_repository_id, rule: l.rule })).slice(0, 24)}`
        const [only] = l.targets
        if (l.targets.length === 1 && !l.ambiguous) link.run(linkId, l.type, l.rule, l.source_repository_id, l.source_symbol_id, l.source_assertion_id, only!.repository_id, only!.symbol_id, only!.confidence, 'resolved', null)
        else if (l.targets.length === 0) link.run(linkId, l.type, l.rule, l.source_repository_id, l.source_symbol_id, l.source_assertion_id, null, null, 1, 'unresolved', 'no_match')
        else {
          link.run(linkId, l.type, l.rule, l.source_repository_id, l.source_symbol_id, l.source_assertion_id, null, null, only!.confidence, 'candidate', 'ambiguous')
          for (const t of l.targets) candidate.run(linkId, t.repository_id, t.symbol_id, t.confidence)
        }
      }
    })()
    db.pragma('journal_mode = DELETE')
    db.close()
    const digest = sha256File(staging)
    fs.chmodSync(staging, 0o444)
    const target = linkPath(dataDir, id)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(staging, target)
    fs.rmSync(path.dirname(staging), { recursive: true, force: true })
    catalog.recordLinkFile({ id, workspace, digest, members: members.map((m) => ({ repository_id: m.repository_id, snapshot_id: m.snapshot_id })) })
    const record = catalog.linkFile(id)!
    return { record, created: true, counts: countLinks(catalog, record) }
  } finally {
    for (const m of members) m.db.close()
  }
}

/** Opens a sealed link file read-only, refusing one that no longer matches its recorded digest. */
const verified = new Set<string>()
/** Open a sealed link file read only; its digest is verified the first time this process opens it, as snapshots are. */
export function openLinkFile(catalog: Catalog, record: LinkFileRecord): Database.Database {
  const file = linkPath(catalog.dataDir, record.id)
  if (!fs.existsSync(file)) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `link file ${record.id} is missing from the data directory`, { detail: 'missing' })
  if (!verified.has(record.id)) {
    if (sha256File(file) !== record.digest) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `link file ${record.id} does not match its recorded digest`, { detail: 'digest_mismatch' })
    verified.add(record.id)
  }
  const db = new Database(file, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

function countLinks(catalog: Catalog, record: LinkFileRecord): Record<string, Record<string, number>> {
  const db = openLinkFile(catalog, record)
  try {
    const out: Record<string, Record<string, number>> = {}
    for (const r of q<{ type: string; resolution: string; n: number }>(db, 'select type, resolution, count(*) as n from link group by type, resolution order by type, resolution')) (out[r.type] ??= {})[r.resolution] = r.n
    return out
  } finally {
    db.close()
  }
}
