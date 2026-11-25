import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ProofmeshError } from '../src/core/errors.js'
import { BUNDLE_FORMAT_VERSION, check, ENVELOPE_VERSION, loadSchema } from '../src/core/schemas.js'
import { PROTOCOL_VERSION } from '../src/indexer/adapter-host.js'
import { LINK_FORMAT_VERSION } from '../src/links/index.js'
import { CATALOG_VERSION, initDataDir } from '../src/meshstore/catalog.js'
import { FORMAT_VERSION } from '../src/meshstore/snapshot.js'
import { TOOLS } from '../src/query/tools.js'
import { ROOT, tmpDir, tool } from './helpers.js'

// Fault injection: get_ecosystem answers whatever the test puts here, so a wrong answer can be produced on purpose.
const fault = vi.hoisted(() => ({ answer: undefined as unknown }))
vi.mock('../src/query/ecosystem.js', async (original) => ({ ...(await original<typeof import('../src/query/ecosystem.js')>()), getEcosystem: () => fault.answer }))

let d: string
beforeAll(() => { d = tmpDir(); initDataDir(d) })
const SRC = path.join(ROOT, 'packages', 'proofmesh', 'src')

/** Every source module an entry point loads, following relative imports, static and dynamic. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>(), todo = [path.join(SRC, entry)]
  while (todo.length) {
    const file = todo.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)\.js'/g)) todo.push(path.resolve(path.dirname(file), `${m[1]}.ts`))
  }
  return new Set([...seen].map((f) => path.relative(SRC, f)))
}

describe('FR036 read, management and execution capabilities are separate', () => {
  it('FR036 classifies every tool: index jobs, note proposals and prepared verifications manage, the rest read, and none executes', () => {
    const tools = (tool(d, 'list_queries', {}).data as { tools: Array<{ name: string; capability: string }> }).tools
    const named = (capability: string) => tools.filter((t) => t.capability === capability).map((t) => t.name).sort()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort())
    expect(named('management')).toEqual(['impact_completeness', 'prepare_verification', 'request_index', 'save_memory'])
    expect(named('execution')).toEqual([])
    expect(named('read')).toHaveLength(TOOLS.length - 4)
  })

  it('FR036 FR042 FR227 execution is reachable only from the CLI: neither server loads the launcher or scip run', () => {
    expect(reachable('mcp/server.ts')).toContain('query/tools.ts')
    expect(reachable('mcp/server.ts')).not.toContain('verification/launcher.ts')
    expect(reachable('http/server.ts')).not.toContain('verification/launcher.ts')
    expect(reachable('cli/main.ts')).toContain('verification/launcher.ts')
    expect(reachable('mcp/server.ts')).not.toContain('scip/run.ts')
    expect(reachable('http/server.ts')).not.toContain('scip/run.ts')
    expect(reachable('cli/main.ts')).toContain('scip/run.ts')
  })
})

describe('FR037 schemas are enforced on the way out, and a versioned contract manifest is published', () => {
  it('FR037 list_queries publishes the version of every public contract, each naming a schema that exists and fixes it', () => {
    const contract = (tool(d, 'list_queries', {}).data as { contract: Record<string, string | number> }).contract
    expect(contract).toEqual({ envelope: ENVELOPE_VERSION, snapshot_format: FORMAT_VERSION, link_format: LINK_FORMAT_VERSION, adapter_protocol: PROTOCOL_VERSION, bundle_format: BUNDLE_FORMAT_VERSION, catalog_migration: CATALOG_VERSION })
    const schemas = path.join(ROOT, 'schemas')
    expect((loadSchema('envelope.schema.json') as any).properties.schema_version.const).toBe(contract.envelope)
    expect((loadSchema(`bundle-format/${contract.bundle_format}.schema.json`) as any).properties.schema_version.const).toBe(contract.bundle_format)
    for (const file of [`snapshot-format/${contract.snapshot_format}.sql`, `link-format/${contract.link_format}.sql`, `catalog/${String(contract.catalog_migration).padStart(4, '0')}.sql`]) expect(fs.existsSync(path.join(schemas, file)), file).toBe(true)
  })

  it('FR037 an answer that breaks its envelope or data schema becomes a structured INTERNAL_ERROR, never a reply', () => {
    const refusal = (answer: unknown): ProofmeshError => {
      fault.answer = answer
      try { tool(d, 'get_ecosystem', { workspace: 'any' }) } catch (e) { return e as ProofmeshError } finally { fault.answer = undefined }
      throw new Error('the wrong answer was returned')
    }
    const envelope = refusal({ schema_version: ENVELOPE_VERSION, tool: 'get_ecosystem' })
    expect(envelope).toBeInstanceOf(ProofmeshError)
    expect(envelope.code).toBe('INTERNAL_ERROR')
    expect(envelope.message).toMatch(/^the get_ecosystem answer does not match its schema: /)
    expect(check('error.schema.json', envelope.toJSON())).toBeUndefined()
    // A whole, valid envelope whose data is another tool's: only the data schema can catch it.
    const other = tool(d, 'list_queries', {})
    expect(check('envelope.schema.json', { ...other, tool: 'get_ecosystem' })).toBeUndefined()
    const data = refusal({ ...other, tool: 'get_ecosystem' })
    expect([data.code, data.message.startsWith('the get_ecosystem answer does not match its schema: ')]).toEqual(['INTERNAL_ERROR', true])
  })
})

describe('FR076 public contracts are versioned with a documented compatibility and deprecation policy', () => {
  it('FR076 COMPATIBILITY.md states the version the code speaks for every public contract, with a policy for each', () => {
    const text = fs.readFileSync(path.join(ROOT, 'COMPATIBILITY.md'), 'utf8')
    const rows = new Map(text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Contract ')).map((l) => {
      const [name, version, policy] = l.split('|').slice(1, -1).map((c) => c.trim())
      return [name!, { version, policy: policy ?? '' }]
    }))
    const code: Record<string, string> = {
      'MCP envelope and tool schemas': ENVELOPE_VERSION, 'Adapter protocol': PROTOCOL_VERSION, 'Snapshot file format': FORMAT_VERSION,
      'Link file format': LINK_FORMAT_VERSION, 'Bundle format': BUNDLE_FORMAT_VERSION, Catalog: String(CATALOG_VERSION).padStart(4, '0'),
    }
    for (const [name, version] of Object.entries(code)) {
      expect(rows.get(name)?.version, name).toBe(version)
      expect(rows.get(name)!.policy.length, name).toBeGreaterThan(30)
    }
    expect(text).toContain('Deprecations are listed in CHANGELOG.md under the release that announces them.')
  })
})
