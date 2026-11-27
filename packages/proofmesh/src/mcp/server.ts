import http from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { asProofmeshError, ProofmeshError } from '../core/errors.js'
import { randomToken } from '../core/hash.js'
import { log } from '../core/log.js'
import { loadSchema } from '../core/schemas.js'
import { LEAN, PROFILE, runTool, TOOLS, type ToolName } from '../query/tools.js'

/** Sent to every client at initialize, so an agent knows when the graph beats reading files. */
const INSTRUCTIONS = [
  'Proofmesh answers structural questions about the indexed repositories from a sealed snapshot, with evidence for every fact: where a symbol is declared, what calls it and what it implements, the framework wiring between code (dependency injection, routes, message handlers, tables, feature flags, jobs), who owns it, and what a change could affect.',
  'Use it instead of text search for those questions. Start with find_symbols. Then call get_relationships, which returns only calls unless you name the types you need, such as registered_as, exposes, consumes, handles, maps_to or evaluates_flag.',
  'find_symbols, get_symbol, get_relationships, trace_paths, analyze_impact and find_tests answer in lean text: a header, one `name path:line` row per result, then `# ` lines for this answer\'s limitations and `# more: cursor <c>` for the next page. A row ending `inferred` rests on a convention or a name match, not on a compiler or an index; check it before acting on it. Pass envelope compact or full for JSON with ids, evidence and totals. In place of a symbol id, pass { name, path }: the name a row shows and the file that declares it (an outbound row\'s path is its call site, not the callee\'s file); find_symbols include_ids true adds id= to its rows.',
  'Use trace_paths for questions that take several hops and analyze_impact for what a change could break.',
  'Each answer states its limits, including unresolved sites; read them before concluding that something does not exist.',
  'Prefer Proofmesh for call paths through interfaces and dependency injection, framework wiring (routes, handlers, jobs, flags, tables), ownership and impact. Prefer text search for string literals, configuration values and files outside the indexed languages.',
  'When several repositories are registered, call list_repositories first and pass the id as repository_id.',
  'The other tools answer in JSON; after the first answer from a snapshot, those answers on this connection are compact: coverage and standing limitations are left out; pass envelope "full" to see them again. Outbound get_relationships lists code in the repository; pass include_external true for framework and library calls.',
  'Pass include_tests false to find_symbols and get_relationships when only production code matters.',
  'Inbound get_relationships on an implementation includes calls to the interface or base member it implements, marked via (dispatch in a lean row); its boundaries list unresolved sites that call the subject\'s name first and count them. For C#, references (types, property reads and writes, constants, object creation) answer who uses a declaration without calling it.',
  'For a SQL statement from a query report, call find_query_source; for how much code depends on an external library, call get_external_usage; for which entity properties an endpoint reads, call get_property_reads with the endpoint. Those are in the data profile; list_queries names every tool and the profile that lists it.',
  'Every JSON envelope names the snapshot commit and branch, and a lean header names the snapshot and says whether it is current (ask workspace_status or envelope compact for its commit and branch); check them against the branch you care about before trusting an answer, and ask for freshness "strict" when the answer must match the working tree now.',
].join(' ')

const NAMES = [...new Set(Object.values(PROFILE)), 'all']
/** The tool profiles `--tools` names, comma-separated (FR421); core when it names none. */
export function toolProfiles(option = 'core'): string[] {
  const names = option.split(','), unknown = names.filter((n) => !NAMES.includes(n))
  if (unknown.length) throw new ProofmeshError('INVALID_ARGUMENT', `unknown tool profile ${unknown.join(', ')}; --tools takes ${NAMES.join(', ')}, comma-separated`)
  return names
}

/** A field's description is the detail --tools all and list_queries give; the core listing keeps every field and leaves it out (FR420). */
const brief = (schema: unknown, key = ''): unknown =>
  Array.isArray(schema) ? schema.map((s) => brief(s))
  : schema && typeof schema === 'object' ? Object.fromEntries(Object.entries(schema).flatMap(([k, v]) => key !== 'properties' && ['description', 'title', '$id', '$schema'].includes(k) ? [] : [[k, brief(v, k)]]))
  : schema

/** A tool as tools/list shows it: as its schema file declares it under --tools all, else briefly, to keep the list small. */
function listing(name: ToolName, full: boolean) {
  const schema = loadSchema(`tools/${name}.input.schema.json`)
  const description = String(schema.description ?? name)
  if (full) return { name, description, inputSchema: schema as { type: 'object' } }
  const inputSchema = brief(schema) as { type: 'object'; properties: Record<string, Record<string, unknown>> }
  // envelope is the one field whose default differs over MCP, so its first sentence stays: the answer is lean text (FR100).
  const envelope = (schema.properties as Record<string, { description?: string }> | undefined)?.envelope?.description
  if (envelope) inputSchema.properties.envelope!.description = envelope.split(/(?<=\.)\s/)[0]
  return { name, description, inputSchema }
}

/** One tool surface for every transport, so stdio and HTTP clients see the same tools and envelopes. */
function createServer(dataDir: string, version: string, profiles: string[]): Server {
  const full = profiles.includes('all'), loaded = (name: ToolName) => full || profiles.includes(PROFILE[name])
  const server = new Server({ name: 'proofmesh', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })
  // One connection, one agent context: the snapshot-wide parts of an envelope are sent once per snapshot, then left out.
  const session = { fullSent: new Set<string>() }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.filter(loaded).map((name) => listing(name, full)),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    log('debug', 'tool call', { tool: req.params.name })
    try {
      // A call cancelled before its handler starts is not run; the SDK sends nothing for a cancelled request, as MCP requires.
      const args = (req.params.arguments ?? {}) as Record<string, unknown>
      const name = req.params.name as ToolName, profile = Object.hasOwn(PROFILE, name) ? PROFILE[name] : undefined
      // A tool of a profile not loaded is refused by name, never answered as if it did not exist (FR423).
      if (profile && !loaded(name)) throw new ProofmeshError('INVALID_ARGUMENT', `${name} is in the ${profile} tool profile, which this server was not started with; start proofmesh mcp with --tools core,${profile} or --tools all`, { detail: 'tool_not_loaded', profile })
      // The query tools answer lean unless a client names compact or full; a lean answer is its text alone (FR099).
      const envelope = runTool(dataDir, req.params.name, LEAN.has(req.params.name) && args.envelope === undefined ? { ...args, envelope: 'lean' } : args, session, extra.signal)
      if (envelope.text !== undefined) return { content: [{ type: 'text', text: envelope.text }] }
      return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope as unknown as Record<string, unknown> }
    } catch (e) {
      const err = asProofmeshError(e).toJSON()
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(err) }], structuredContent: err }
    }
  })
  return server
}

/** MCP over stdio. stdout carries protocol frames only; logs go to stderr. */
export async function serveStdio(dataDir: string, version: string, profiles = ['core']): Promise<void> {
  await createServer(dataDir, version, profiles).connect(new StdioServerTransport())
  log('info', 'mcp server ready', { dataDir })
}

/**
 * MCP over Streamable HTTP on loopback only. Every request needs the bearer token printed at start, and the Host and
 * Origin must be this server's, so a web page cannot reach it through DNS rebinding. Stateless: a fresh transport per request.
 */
export async function serveHttp(dataDir: string, version: string, port: number, profiles = ['core']): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  const token = randomToken()
  let actual = port
  const httpServer = http.createServer(async (req, res) => {
    const deny = (status: number, message: string) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message } })) }
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') return deny(404, 'not found')
    if (req.headers.authorization !== `Bearer ${token}`) return deny(401, 'missing or wrong bearer token')
    const hosts = [`127.0.0.1:${actual}`, `localhost:${actual}`]
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: hosts, allowedOrigins: hosts.map((h) => `http://${h}`) })
    const server = createServer(dataDir, version, profiles)
    res.on('close', () => { transport.close(); server.close() })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      if (!res.headersSent) deny(500, asProofmeshError(e).message)
    }
  })
  await new Promise<void>((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, '127.0.0.1', () => resolve()) })
  actual = (httpServer.address() as { port: number }).port
  log('info', 'mcp http server ready', { dataDir, port: actual })
  return { url: `http://127.0.0.1:${actual}/mcp`, token, close: () => new Promise((r) => httpServer.close(() => r())) }
}
