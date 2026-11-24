import { ProofmeshError } from '../core/errors.js'
import { Catalog } from '../meshstore/catalog.js'
import { clone } from '../discover/index.js'

export function runClone(dataDir: string, rest: string[], take: (args: string[], flag: string) => string | undefined, has: (args: string[], flag: string) => boolean, by: string): number {
  const opts = [...rest]
  const into = take(opts, '--into'), workspace = take(opts, '--workspace'), add = has(opts, '--add')
  if (!opts[0] || !into || (workspace && !add)) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh clone <owner/repo> --into <dir> [--add [--workspace NAME]]')
  const dir = clone(opts[0], into)
  console.log(`cloned ${opts[0]} into ${dir}`)
  if (!add) return 0
  const catalog = Catalog.open(dataDir)
  try {
    const repo = catalog.addRepository(dir)
    console.log(`registered ${repo.name} as ${repo.id}; index it with: proofmesh index ${repo.id}`)
    if (workspace) { catalog.addToWorkspace(workspace, [repo.id], by); console.log(`added to workspace ${workspace}`) }
  } finally {
    catalog.close()
  }
  return 0
}
