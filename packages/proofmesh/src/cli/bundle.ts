import os from 'node:os'
import path from 'node:path'
import { ProofmeshError } from '../core/errors.js'
import { checkBundle, exportBundle, type Query } from '../bundle/bundle.js'

const USAGE = 'usage: proofmesh bundle export <repository> --out <dir.pmb> [--query <json>]... [--include-source] | bundle check <dir.pmb>'

export function runBundle(dataDir: string, rest: string[], take: (args: string[], flag: string) => string | undefined, has: (args: string[], flag: string) => boolean): number {
  const opts = [...rest]
  if (opts[0] === 'export' && opts[1]) {
    const out = take(opts, '--out'), includeSource = has(opts, '--include-source')
    if (!out) throw new ProofmeshError('INVALID_ARGUMENT', USAGE)
    const queries: Query[] = []
    for (let q = take(opts, '--query'); q; q = take(opts, '--query')) {
      let parsed: Query
      try { parsed = JSON.parse(q) } catch { throw new ProofmeshError('INVALID_ARGUMENT', `--query takes JSON {"tool": ..., "input": {...}}; got ${q}`) }
      if (typeof parsed.tool !== 'string' || typeof parsed.input !== 'object' || parsed.input === null) throw new ProofmeshError('INVALID_ARGUMENT', '--query takes JSON {"tool": ..., "input": {...}}')
      queries.push(parsed)
    }
    const { manifest } = exportBundle(dataDir, opts[1], path.resolve(out), queries, includeSource, `proofmesh by ${os.userInfo().username}`)
    const evidence = manifest.evidence as unknown[]
    console.log(`bundle ${manifest.bundle_id} written to ${path.resolve(out)}: ${(manifest.queries as unknown[]).length} queries, ${evidence.length} evidence items${includeSource ? ' with source, as you consented' : ', hashes only (add --include-source to include the source bytes)'}`)
    console.log(`check it anywhere with: proofmesh bundle check ${path.resolve(out)}`)
    return 0
  }
  if (opts[0] === 'check' && opts[1]) {
    const r = checkBundle(path.resolve(opts[1]))
    for (const f of r.failed) console.log(`FAILED  ${f}`)
    for (const u of r.unverifiable) console.log(`unverifiable  ${u}`)
    console.log(`${r.ok ? 'ok' : 'FAILED'}: ${r.verified.length} verified, ${r.failed.length} failed, ${r.unverifiable.length} unverifiable`)
    return r.ok ? 0 : 1
  }
  throw new ProofmeshError('INVALID_ARGUMENT', USAGE)
}
