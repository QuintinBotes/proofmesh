import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CLI } from './helpers.js'

export async function mcpClient(dataDir: string): Promise<Client> {
  const client = new Client({ name: 'proofmesh-tests', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, '--data-dir', dataDir, 'mcp'], stderr: 'pipe' }))
  return client
}
