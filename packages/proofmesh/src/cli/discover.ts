import { ProofmeshError } from '../core/errors.js'
import { discover } from '../discover/index.js'

export function runDiscover(dataDir: string, rest: string[], take: (args: string[], flag: string) => string | undefined, has: (args: string[], flag: string) => boolean): number {
  const opts = [...rest]
  const org = take(opts, '--org'), limit = take(opts, '--limit'), json = has(opts, '--json'), anchor = take(opts, '--anchor') ?? opts[0]
  if (!anchor || (limit !== undefined && !(Number(limit) > 0))) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh discover --anchor <repository> [--org ORG] [--limit N] [--json]')
  const d = discover(dataDir, anchor, { org, limit: limit ? Number(limit) : undefined })
  if (json) { console.log(JSON.stringify(d, null, 2)); return 0 }
  console.log(`${d.anchor.name} (${d.anchor.snapshot_id}): ${d.terms.length} terms searched${d.org ? ` within ${d.org}` : ' across GitHub'} through read-only gh queries`)
  if (!d.candidates.length) console.log('no related repositories found')
  for (const c of d.candidates) console.log(`${String(c.score).padStart(3)}  ${c.repository}  ${c.evidence.map((e) => `${e.kind} ${e.term} (${e.via === 'code_search' ? e.hits : e.via.replace('_', ' ')})`).join(', ')}`)
  for (const l of d.limitations) console.log(`limitation: ${l}`)
  console.log('Clone one with: proofmesh clone <owner/repo> --into <dir> [--add [--workspace NAME]]')
  return 0
}
