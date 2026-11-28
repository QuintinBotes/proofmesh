// Reading a SARIF 2.1.0 file another analyser wrote (#30, FR1900): its results, each at a repository file and line. Proofmesh runs no analyser.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ProofmeshError } from '../core/errors.js'

export type FlowStep = { unresolved_location?: true; flow: number; thread: number; step: number; uri: string | null; path: string | null; line: number | null; end_line: number | null; column: number | null; end_column: number | null }
export type Flow = { total_steps: number; steps: FlowStep[] }
export type Finding = { flow?: Flow; tool: string; rule: string; level: string; message: string; path: string; line: number | null; end_line: number | null; rank: number | null; precision: string | null }
export type Unattached = { tool: string; rule: string; uri: string; line: number | null; reason: 'outside_repository' | 'not_in_snapshot' | 'no_location' }

type Rule = { id?: string; defaultConfiguration?: { level?: string }; properties?: { precision?: string } }
type Artifact = { uri?: string; uriBaseId?: string; index?: number }
type Location = { physicalLocation?: { artifactLocation?: Artifact; region?: { startLine?: number; endLine?: number; startColumn?: number; endColumn?: number } } }
type Result = {
  ruleId?: string; ruleIndex?: number; rule?: { id?: string; index?: number }; level?: string; rank?: number; message?: { text?: string }
  locations?: Location[]
  codeFlows?: Array<{ threadFlows?: Array<{ locations?: Array<{ location?: Location }> }> }>
}
type Run = { artifacts?: Array<{ location?: Artifact }>; originalUriBaseIds?: Record<string, Artifact>; tool?: { driver?: { name?: string; version?: string; semanticVersion?: string; rules?: Rule[] } }; results?: Result[] }

/** Resolve producer URI bases without opening network resources or guessing the location of an unknown base. */
function flowLocation(artifact: Artifact | undefined, run: Run, root: string) {
  const loc = artifact?.uri === undefined && artifact?.index !== undefined ? run.artifacts?.[artifact.index]?.location : artifact
  const uri = loc?.uri ?? null
  if (!uri) return { uri, path: null, ...(artifact?.index !== undefined ? { unresolved_location: true as const } : {}) }
  const seen = new Set<string>(), parts = [uri]
  let base = loc?.uriBaseId
  try {
    while (base && !/^[a-z][a-z0-9+.-]*:/i.test(parts.at(-1)!)) {
      const parent: Artifact | undefined = Object.hasOwn(run.originalUriBaseIds ?? {}, base) ? run.originalUriBaseIds![base] : undefined
      if (!parent?.uri || seen.has(base)) return { uri, path: null, unresolved_location: true as const }
      seen.add(base)
      parts.push(parent.uri)
      base = parent.uriBaseId
    }
    const url = parts.reverse().reduce((parent, segment) => new URL(segment, parent), pathToFileURL(root + path.sep))
    return { uri, path: url.protocol === 'file:' ? relative(root, url.href) : null }
  } catch { return { uri, path: null, unresolved_location: true as const } }
}

function reportedFlow(result: Result, run: Run, root: string): Flow | undefined {
  if (!result.codeFlows?.length) return undefined
  const steps: FlowStep[] = []
  let total = 0
  for (const [f, flow] of result.codeFlows.entries()) for (const [t, thread] of (flow.threadFlows ?? []).entries()) {
    const locations = thread.locations ?? []
    total += locations.length
    for (let i = 0; i < locations.length && steps.length < 256; i++) {
      const physical = locations[i]?.location?.physicalLocation, artifact = physical?.artifactLocation, region = physical?.region
      const position = (n?: number) => n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : null
      steps.push({ flow: f + 1, thread: t + 1, step: i + 1, ...flowLocation(artifact, run, root), line: position(region?.startLine), end_line: position(region?.endLine ?? region?.startLine), column: position(region?.startColumn), end_column: position(region?.endColumn) })
    }
  }
  return { total_steps: total, steps }
}

/**
 * The results of every run, deduplicated by tool, rule and location; `indexed` says whether a repository-relative path is a file of the
 * snapshot. A result with no file, outside `root`, or in a file the snapshot does not hold is returned unattached with its reason.
 */
export function readSarif(file: string, root: string, indexed: (rel: string) => boolean): { tools: string[]; findings: Finding[]; unattached: Unattached[] } {
  // shortcut: the whole file is parsed at once, so a SARIF file of several hundred MB needs that much memory; stream it if one appears.
  let sarif: { version?: string; runs?: Run[] }
  try { sarif = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not a SARIF 2.1.0 file: ${(e as Error).message}`) }
  if (sarif?.version !== '2.1.0' || !Array.isArray(sarif.runs)) throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not a SARIF 2.1.0 file: it needs "version": "2.1.0" and a runs array`)
  const tools: string[] = [], findings: Finding[] = [], unattached: Unattached[] = [], seen = new Set<string>()
  // A run, rule list or result of the wrong shape is the file's fault, not Proofmesh's.
  try { for (const r of sarif.runs) {
    const driver = r.tool?.driver ?? {}, rules = driver.rules ?? []
    const tool = `${driver.name ?? 'unnamed analyser'} ${driver.semanticVersion ?? driver.version ?? ''}`.trim()
    tools.push(tool)
    for (const x of r.results ?? []) {
      const ruleOf = rules[x.ruleIndex ?? x.rule?.index ?? -1] ?? rules.find((u) => u.id === (x.ruleId ?? x.rule?.id))
      const rule = x.ruleId ?? x.rule?.id ?? ruleOf?.id ?? 'unnamed rule'
      const loc = x.locations?.[0]?.physicalLocation, uri = loc?.artifactLocation?.uri, line = loc?.region?.startLine ?? null
      const rel = uri === undefined ? null : relative(root, uri)
      const key = JSON.stringify([tool, rule, rel ?? uri, line])
      if (seen.has(key)) continue
      seen.add(key)
      const reason = uri === undefined ? 'no_location' : rel === null ? 'outside_repository' : !indexed(rel) ? 'not_in_snapshot' : null
      if (reason) { unattached.push({ tool, rule, uri: uri ?? '', line, reason }); continue }
      // SARIF's default level is warning (SARIF 2.1.0, 3.27.10).
      const flow = reportedFlow(x, r, root)
      findings.push({ ...(flow ? { flow } : {}), tool, rule, level: x.level ?? ruleOf?.defaultConfiguration?.level ?? 'warning', message: x.message?.text ?? '', path: rel!, line, end_line: loc?.region?.endLine ?? line, rank: typeof x.rank === 'number' && x.rank >= 0 ? x.rank : null, precision: ruleOf?.properties?.precision ?? null })
    }
  } } catch (e) { if (e instanceof TypeError) throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not a SARIF 2.1.0 file: ${e.message}`); throw e }
  return { tools, findings, unattached }
}

/** The repository-relative path of an artifact URI, or null outside the repository. */
function relative(root: string, uri: string): string | null {
  // shortcut: a relative URI is read against the root whatever its uriBaseId, so a base originalUriBaseIds puts elsewhere reads wrong; resolve bases when an analyser writes one.
  let abs: string
  try { abs = uri.startsWith('file:') ? fileURLToPath(uri) : path.resolve(root, decodeURIComponent(uri)) } catch { return null }
  const inside = (p: string) => { const rel = path.relative(root, p).split(path.sep).join('/'); return rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel) ? rel : null }
  // The registered root is a real path, so a URI through a symlink to it (/var and /private/var on macOS) is read as its real path.
  try { return inside(abs) ?? inside(fs.realpathSync(abs)) } catch { return null }
}
