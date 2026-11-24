import { buildLinkFile } from '../links/index.js'
import type { Catalog } from '../meshstore/catalog.js'

/** `proofmesh workspace link <name>`: seals the workspace's link file, or reports the one its members already have. */
export function runWorkspaceLink(catalog: Catalog, dataDir: string, workspace: string): number {
  const { record, created, counts } = buildLinkFile(catalog, dataDir, workspace)
  console.log(`link file ${record.id} ${created ? 'sealed' : 'unchanged'} for workspace ${workspace}`)
  for (const m of record.members) console.log(`  ${catalog.repository(m.repository_id).name}  ${m.snapshot_id}`)
  const types = Object.keys(counts)
  if (!types.length) console.log('  no cross-repository facts to link')
  for (const t of types) console.log(`  ${t}: ${Object.entries(counts[t]!).map(([r, n]) => `${n} ${r}`).join(', ')}`)
  return 0
}
