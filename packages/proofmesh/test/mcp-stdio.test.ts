import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CLI, cli, tmpDir } from './helpers.js'

const frame = (message: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`

describe('proofmesh mcp over stdio', () => {
  it('FR720 exits 0 when its client closes stdin (stdin closes), after answering what it was sent', () => {
    const d = tmpDir()
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
    const input = frame({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proofmesh-tests', version: '0' } } })
      + frame({ method: 'notifications/initialized' }) + frame({ id: 2, method: 'tools/list', params: {} })
    // spawnSync closes stdin once the input is written, as a client does to stop a stdio server.
    const r = spawnSync(process.execPath, [CLI, '--data-dir', d, 'mcp'], { input, encoding: 'utf8', timeout: 20_000 })
    expect(r.stderr).not.toMatch(/unsettled top-level await/)
    expect(r.signal).toBeNull()
    expect(r.status).toBe(0)
    const ids = r.stdout.trim().split('\n').map((l) => JSON.parse(l)).map((m) => m.id)
    expect(ids).toEqual([1, 2])
  })
})
