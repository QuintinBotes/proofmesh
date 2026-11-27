import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from '../core/hash.js'
import { ProofmeshError } from '../core/errors.js'
import { EXCLUDED_DIRS, discover, type Discovered } from './discovery.js'
import { BUILT_IN_REGISTRY, type Registry } from './languages.js'
import { CENSUS_VERSION } from './census.js'
import { isDoc } from './doc-links.js'

/** Files excluded for where they sit, under a path git ignores or a default excluded directory, are build output and local state (A21). */
const LOCATION_RULES = new Set<string | null>(['gitignore', ...EXCLUDED_DIRS.map((d) => `**/${d}/**`)])
const isLocationRule = (detail: string | null) => LOCATION_RULES.has(detail) || !!detail?.startsWith('build_output:')

/**
 * The repository part of snapshot identity: every discovered path with its content hash when captured, or its disposition. Files
 * excluded for their location stay in the inventory but not here, so a build writing its output never makes a snapshot stale (A21).
 */
/** A captured file's disposition detail stays out of the hash, except a revoked SCIP grant: the census names it, so the snapshot that does is a different one (A38). */
export const manifestHash = (discovered: Discovered[], hashOf: (p: string) => string | undefined, censusVersion: string = CENSUS_VERSION): string =>
  sha256(`census ${censusVersion}\n` + discovered.filter((d) => !(d.status === 'excluded' && isLocationRule(d.detail)))
    // A file flagged generated is a different snapshot from the same file unflagged: a .gitattributes edit changes no captured content (FR299).
    .map((d) => `${d.path}\t${hashOf(d.path) ?? '-'}\t${d.status === 'capture' ? (d.detail?.startsWith('scip_revoked:') ? `capture:${d.detail}` : 'capture') + (d.generated ? ':generated' : '') : `${d.status}:${d.detail}${d.generated ? ':generated' : ''}`}`).join('\n'))

export type Change = { path: string; change: 'added' | 'modified' | 'deleted' }

/** The working tree as the indexer would capture it now. A file that vanishes while it is read makes the tree unstable. */
export function workingTree(root: string, registry: Registry = BUILT_IN_REGISTRY): { manifest: string; hashes: Map<string, string> } {
  const discovered = discover(root, registry)
  const hashes = new Map<string, string>()
  for (const d of discovered) {
    if (d.status !== 'capture' && !isDoc(d)) continue
    try {
      hashes.set(d.path, sha256(fs.readFileSync(path.join(root, d.path))))
    } catch {
      throw new ProofmeshError('UNSTABLE_WORKTREE', `${d.path} changed while the working tree was read; retry when it is quiet`, { detail: 'file_vanished', path: d.path })
    }
  }
  return { manifest: manifestHash(discovered, (p) => hashes.get(p)), hashes }
}

/** Captured files that differ between a snapshot (path to content hash, null when its content was not kept) and the tree now. */
export function changes(captured: Map<string, string | null>, now: Map<string, string>): Change[] {
  const out: Change[] = []
  for (const [p, hash] of now) {
    if (!captured.has(p)) out.push({ path: p, change: 'added' })
    else if (captured.get(p) !== hash) out.push({ path: p, change: 'modified' })
  }
  for (const p of captured.keys()) if (!now.has(p)) out.push({ path: p, change: 'deleted' })
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** Captured files whose content changed between capture and the end of analysis (FR013). */
export function unstable(root: string, captured: Array<{ path: string; hash: string }>): string[] {
  return captured.filter((c) => {
    try {
      return sha256(fs.readFileSync(path.join(root, c.path))) !== c.hash
    } catch {
      return true
    }
  }).map((c) => c.path)
}
