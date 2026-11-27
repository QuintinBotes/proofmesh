import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { check, loadSchema } from '../src/core/schemas.js'
import { TOOLS } from '../src/query/tools.js'
import { cli, indexedDataDir } from './helpers.js'
import { mcpClient } from './mcp-client.js'

let d: string
let core: Client
beforeAll(async () => {
  ;({ dataDir: d } = await indexedDataDir())
  core = await mcpClient(d)
}, 120000)
afterAll(async () => { await core?.close() })

const CORE = ['find_symbols', 'get_symbol', 'get_relationships', 'analyze_impact', 'trace_paths', 'find_tests', 'search_sources', 'read_evidence', 'workspace_status', 'list_repositories']
/** Every field a tool's input schema declares, at any depth, with its type and the fields it requires. */
const fields = (s: unknown): unknown => {
  if (Array.isArray(s)) return s.map(fields)
  if (!s || typeof s !== 'object') return s
  return Object.fromEntries(Object.entries(s).filter(([k]) => !['description', 'title', '$id', '$schema'].includes(k)).map(([k, v]) => [k, k === 'properties' ? Object.fromEntries(Object.entries(v as object).map(([p, x]) => [p, fields(x)])) : fields(v)]))
}

describe('FR420 the core tool profile is the default and its tools/list fits in 20,000 bytes', () => {
  it('FR420 with no options, tools/list is at most 20,000 bytes of JSON and holds the core tools and list_queries', async () => {
    const { tools } = await core.listTools()
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThanOrEqual(20000)
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining([...CORE, 'list_queries']))
    expect(tools.length).toBeLessThan(TOOLS.length)
  })

  it('FR420 a core tool keeps its description and every field its input schema declares; only per-field prose is left out', async () => {
    const { tools } = await core.listTools()
    for (const t of tools) {
      const schema = loadSchema(`tools/${t.name}.input.schema.json`)
      expect(t.description, t.name).toBe(schema.description)
      expect(fields(t.inputSchema), t.name).toEqual(fields(schema))
    }
  })
})

describe('FR421 named profiles are chosen with --tools', () => {
  it('FR421 --tools all lists every tool exactly as the schema files declare it, with full descriptions', async () => {
    const all = await mcpClient(d, '--tools', 'all')
    try {
      const { tools } = await all.listTools()
      expect(tools.map((t) => t.name)).toEqual([...TOOLS])
      for (const t of tools) {
        const schema = loadSchema(`tools/${t.name}.input.schema.json`)
        expect(t).toEqual({ name: t.name, description: schema.description, inputSchema: schema })
      }
    } finally { await all.close() }
  })

  it('FR421 --tools core,data adds the table, property and query-source tools; claims holds claims and verification', async () => {
    const both = await mcpClient(d, '--tools', 'core,data'), claims = await mcpClient(d, '--tools', 'claims')
    try {
      const names = (await both.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining([...CORE, 'get_table_reach', 'get_property_reads', 'find_query_source']))
      expect(names).not.toContain('verify_claim')
      expect((await claims.listTools()).tools.map((t) => t.name).sort()).toEqual(['get_claims', 'get_verification', 'prepare_verification', 'verify_claim'])
    } finally { await both.close(); await claims.close() }
  })

  it('FR421 an unknown profile is refused at start, naming the profiles', () => {
    const r = cli(['--data-dir', d, 'mcp', '--tools', 'core,nope'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/INVALID_ARGUMENT: unknown tool profile nope; --tools takes core, data, claims, extra, all/)
  })
})

describe('FR422 list_queries lists every tool and its profile', () => {
  it('FR422 under the core profile, list_queries names every tool, loaded or not, with its profile, and says how to load the others', async () => {
    const r = await core.callTool({ name: 'list_queries', arguments: { envelope: 'full' } })
    expect(r.isError).toBeFalsy()
    const env = r.structuredContent as { data: { tools: Array<{ name: string; profile: string }> }; limitations: string[] }
    expect(check('tools/list_queries.data.schema.json', env.data)).toBeUndefined()
    expect(env.data.tools.map((t) => t.name)).toEqual([...TOOLS])
    for (const name of CORE) expect(env.data.tools.find((t) => t.name === name)?.profile).toBe('core')
    expect(env.data.tools.find((t) => t.name === 'get_table_reach')?.profile).toBe('data')
    expect(env.data.tools.find((t) => t.name === 'verify_claim')?.profile).toBe('claims')
    expect(env.limitations.join(' ')).toMatch(/--tools <profile\[,profile\]>.*--tools all/)
  })
})

describe('FR423 a tool outside the loaded profiles fails with the profile that has it', () => {
  it('FR423 calling verify_claim and get_table_reach under core is INVALID_ARGUMENT naming claims and data', async () => {
    for (const [name, profile] of [['verify_claim', 'claims'], ['get_table_reach', 'data'], ['list_snapshots', 'extra']] as const) {
      const r = await core.callTool({ name, arguments: {} })
      expect(r.isError, name).toBe(true)
      expect(check('error.schema.json', r.structuredContent), name).toBeUndefined()
      const { error } = r.structuredContent as { error: { code: string; message: string; details: { profile: string } } }
      expect(error.code, name).toBe('INVALID_ARGUMENT')
      expect(error.details.profile, name).toBe(profile)
      expect(error.message, name).toContain(`--tools core,${profile}`)
    }
  })
})
