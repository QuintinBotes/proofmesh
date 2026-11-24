// `proofmesh observe`: a person imports runtime observations from a metrics file in the Proofmesh schema (A9, A30). Nothing connects anywhere.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProofmeshError } from '../core/errors.js'
import { check } from '../core/schemas.js'
import type { Catalog, PropertyReadInput } from '../meshstore/catalog.js'

type ObservationsFile = { schema_version?: string; source: string; window: { from: string; to: string }; repository?: string; counts: Array<{ subject: { kind: string; name: string }; metric: string; value: number }>; property_reads?: PropertyReadInput[] }

/** Reads and validates an observations file of any supported version; the schema checks shape, and the window's dates are checked here because formats are not validated. */
export function readObservations(file: string): ObservationsFile {
  let json: ObservationsFile
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not a JSON file: ${(e as Error).message}`) }
  const version = ['0.1', '0.2', '0.3'].includes(String(json?.schema_version)) ? String(json.schema_version) : '0.3'
  const problem = check(`observations/${version}.schema.json`, json)
  if (problem) throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not an observations file (schema ${version}): ${problem}`)
  const from = Date.parse(json.window.from), to = Date.parse(json.window.to)
  if (Number.isNaN(from) || Number.isNaN(to)) throw new ProofmeshError('INVALID_ARGUMENT', `${file}: window.from and window.to must be RFC 3339 date-times`)
  if (from > to) throw new ProofmeshError('INVALID_ARGUMENT', `${file}: window.from is after window.to`)
  return json
}

export function observe(catalog: Catalog, opts: string[]): number {
  if (opts[0] === 'validate' && opts[1]) {
    const file = path.resolve(opts[1]), json = readObservations(file)
    const kinds = (json.property_reads ?? []).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.read_kind ?? 'application']: (acc[r.read_kind ?? 'application'] ?? 0) + 1 }), {})
    console.log(`${file} is a valid observations ${json.schema_version ?? '0.3'} file: ${json.counts.length} counts, ${json.property_reads?.length ?? 0} property reads${Object.keys(kinds).length ? ` (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}, window ${json.window.from} to ${json.window.to}, source ${json.source}`)
    return 0
  }
  if (opts[0] === 'import' && opts[1] && opts[2]) {
    const repo = catalog.repository(opts[1]), file = path.resolve(opts[2])
    const json = readObservations(file)
    if (json.repository && json.repository !== repo.name && json.repository !== repo.id) throw new ProofmeshError('INVALID_ARGUMENT', `${file} names repository ${json.repository}, not ${repo.name}`)
    const r = catalog.importObservations(repo.id, json, os.userInfo().username)
    const reads = json.property_reads?.length ?? 0
    console.log(`${r.written} observations imported for ${repo.name} from ${json.source}, window ${json.window.from} to ${json.window.to}${reads ? ` (${reads} property reads)` : ''}${r.replaced ? `, replacing ${r.replaced}` : ''}`)
    console.log('Observations are reported beside static facts as what was observed in that window, never as load derived from code, and never join snapshot identity.')
    return 0
  }
  if (opts[0] === 'list' && opts[1]) {
    const repo = catalog.repository(opts[1])
    const groups = new Map<string, { count: number; by: string; at: string }>()
    for (const o of [...catalog.observations(repo.id), ...catalog.allPropertyReads(repo.id)]) {
      const k = `${o.source}  ${o.window_from} to ${o.window_to}`
      const g = groups.get(k) ?? { count: 0, by: o.imported_by, at: o.imported_at }
      g.count++; groups.set(k, g)
    }
    if (!groups.size) console.log(`no observations imported for ${repo.name}`)
    for (const [k, g] of groups) console.log(`${k}  ${g.count} counts  by ${g.by} at ${g.at}`)
    return 0
  }
  throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh observe import <repository> <file.json> | observe list <repository> | observe validate <file.json>')
}
