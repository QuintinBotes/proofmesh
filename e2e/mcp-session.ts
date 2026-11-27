import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { CLI } from './view'

type Envelope = { snapshot: { id: string } | null; data: any; limitations: string[] }

/** One `proofmesh mcp --tools all` session over stdio, as an agent holds it: newline-delimited JSON-RPC, answers as compact JSON. */
export async function mcpSession(dataDir: string): Promise<{ call: (tool: string, args?: Record<string, unknown>) => Promise<Envelope>; close: () => void }> {
  const child = spawn(process.execPath, [CLI, '--data-dir', dataDir, 'mcp', '--tools', 'all'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const waiting = new Map<number, (m: any) => void>()
  readline.createInterface({ input: child.stdout! }).on('line', (line) => { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id) })
  let n = 0
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve) => { const id = ++n; waiting.set(id, resolve); child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proofmesh-e2e', version: '0' } })
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await rpc('tools/call', { name: tool, arguments: { envelope: 'compact', ...args } })
    if (r.error || r.result.isError) throw new Error(`${tool}: ${JSON.stringify(r.error ?? r.result.content)}`)
    return r.result.structuredContent as Envelope
  }
  return { call, close: () => { child.kill() } }
}
