import fs from 'node:fs'
import { ProofmeshError } from '../core/errors.js'
import { check } from '../core/schemas.js'
import type { Catalog } from '../meshstore/catalog.js'

/** The adapters a conventions file has a section for; each section is stored in that adapter's configuration for the repository. */
const SECTIONS = ['csharp'] as const

/**
 * `proofmesh repo conventions <repository> [<file> | --clear]`: registers the types only the repository can name. The file is data, so
 * registering it runs nothing; it becomes part of the adapter configuration, which is part of snapshot identity, so the next index applies it.
 */
export function runConventions(catalog: Catalog, args: string[]): number {
  const [target, file] = args
  if (!target) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh repo conventions <repository> [<file.json> | --clear]')
  const repo = catalog.resolveRepository(target)
  if (!file) {
    const current = Object.fromEntries(SECTIONS.map((s) => [s, catalog.adapterConfig(repo.id, s).conventions]).filter(([, v]) => v !== undefined))
    console.log(Object.keys(current).length ? JSON.stringify({ schema_version: '0.1', ...current }, null, 2) : `no conventions registered for ${repo.name}`)
    return 0
  }
  let conventions: Record<string, unknown> = {}
  if (file !== '--clear') {
    let parsed: unknown
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not a readable JSON file: ${(e as Error).message}`) }
    const problem = check('conventions/0.1.schema.json', parsed)
    if (problem) throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not a conventions file 0.1: ${problem}`)
    conventions = parsed as Record<string, unknown>
  }
  for (const section of SECTIONS) {
    const { extensions: _installed, conventions: _old, ...stored } = catalog.adapterConfig(repo.id, section)
    catalog.setAdapterConfig(repo.id, section, conventions[section] === undefined ? stored : { ...stored, conventions: conventions[section] })
  }
  console.log(file === '--clear' ? `conventions cleared for ${repo.name}` : `conventions registered for ${repo.name}; the next index applies them`)
  return 0
}
