import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CLI } from './helpers.js'

/** A stdio MCP client of `proofmesh mcp`, with any options after it (`--tools all`). */
export async function mcpClient(dataDir: string, ...options: string[]): Promise<Client> {
  const client = new Client({ name: 'proofmesh-tests', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, '--data-dir', dataDir, 'mcp', ...options], stderr: 'pipe' }))
  return client
}
