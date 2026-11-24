import { execSync } from 'node:child_process'
import path from 'node:path'

/** Tests spawn the adapters and the CLI as real processes, so all of them must be built first. */
export default function setup(): void {
  const root = path.resolve(import.meta.dirname, '..', '..', '..')
  execSync('pnpm --filter @proofmesh/adapter-typescript build && pnpm --filter @proofmesh/adapter-syntax build && pnpm --filter proofmesh build', { cwd: root, stdio: 'inherit' })
  execSync('dotnet build adapters/csharp -c Release -nologo -v:q', { cwd: root, stdio: 'inherit' })
}
