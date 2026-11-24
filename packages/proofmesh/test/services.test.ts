import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cli, tmpDir, tool } from './helpers.js'

describe('A17 a downstream service is a symbol, and clients relate to it with calls_service', () => {
  it('survives indexing and answers find_symbols, get_relationships and analyze_impact', () => {
    const repo = tmpDir('pm-svc-')
    fs.writeFileSync(path.join(repo, 'client.ts'), 'export class Client {}\n')
    const d = tmpDir()
    const env = { PROOFMESH_TS_ADAPTER: path.join(import.meta.dirname, 'fake-adapters', 'service.mjs') }
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args], env).status).toBe(0)
    const call = (name: string, input: Record<string, unknown>) => tool(d, name, input) as any
    const service = call('find_symbols', { text: 'Billing', kinds: ['service'] }).data.symbols
    expect(service.map((s: any) => [s.kind, s.qualified_name])).toEqual([['service', 'BillingService']])
    const rels = call('get_relationships', { subject_id: service[0].id, direction: 'in', types: ['calls_service'] }).data.relationships
    expect(rels.map((r: any) => [r.type, r.resolution, r.other.qualified_name])).toEqual([['calls_service', 'resolved', 'Client']])
    expect(call('analyze_impact', { subject_ids: [service[0].id] }).data.dependents.map((x: any) => x.qualified_name)).toEqual(['Client'])
  }, 120000)
})
