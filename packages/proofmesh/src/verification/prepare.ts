// Preparing a verification (FR043, FR044) runs nothing: it pins what an approval would bind and returns it for a person to read.
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { ProofmeshError } from '../core/errors.js'
import { derivedId } from '../core/hash.js'
import type { Catalog } from '../meshstore/catalog.js'
import { bindingHash, type Binding, type Recipe } from './binding.js'

export const ENABLED = 'verification_enabled'

export function requireEnabled(catalog: Catalog): void {
  if (catalog.setting(ENABLED) !== 'on') throw new ProofmeshError('SCOPE_DENIED', 'verification execution is disabled in this data directory; a person enables it with: proofmesh verification enable', { detail: 'verification_disabled' })
}

const version = (cmd: string) => { const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim().split('\n')[0]! : null }

export function prepare(catalog: Catalog, repositoryId: string, snapshotId: string, input: Partial<Recipe> & { command: string[]; expires_in_s?: number }, by: string) {
  requireEnabled(catalog)
  const recipe: Recipe = { command: input.command, cwd: input.cwd ?? '.', env_allow: input.env_allow ?? [], network: 'none', timeout_s: input.timeout_s ?? 600, max_memory_mb: input.max_memory_mb ?? 2048, max_output_kb: input.max_output_kb ?? 1024 }
  if (recipe.cwd.split('/').includes('..')) throw new ProofmeshError('INVALID_ARGUMENT', 'cwd stays inside the workspace')
  const expires_at = new Date(Date.now() + (input.expires_in_s ?? 900) * 1000).toISOString()
  // The toolchain is read once here, so the approval names what will run; it is not the repository's code.
  const binding: Binding = { repository_id: repositoryId, snapshot_id: snapshotId, recipe, toolchain: { node: process.version, dotnet: version('dotnet') }, workspace: 'a fresh copy of the snapshot\'s captured files, deleted after the run', filesystem: 'read-write inside that copy only; nothing of the repository is mounted', expires_at }
  const hash = bindingHash(binding)
  return catalog.prepareVerification({ id: derivedId('vr', 24, hash, by, Date.now()), repository_id: repositoryId, snapshot_id: snapshotId, binding, binding_hash: hash, prepared_by: by, expires_at })
}

export const approver = () => os.userInfo().username
