import fs from 'node:fs'
import path from 'node:path'
import { hardenDatabase } from '../core/busy.js'
import Database from 'better-sqlite3'
import { canonicalJson, sha256 } from '../core/hash.js'
import type { AnalyzeResponse, InitializeResponse } from '../core/generated.js'
import { AdapterProtocolError } from './adapter-host.js'

/** One file's answer to analyze: its symbols, the relationships sited in it, and its file result. */
export type FileFacts = { symbols: AnalyzeResponse['symbols']; relationships: AnalyzeResponse['relationships']; file_result: AnalyzeResponse['file_results'][number] | null }
type Unit = NonNullable<InitializeResponse['units']>[number]

/** Everything an adapter's per-file facts may depend on besides the files of their units (A16). */
export type KeyInputs = {
  repository: string
  adapter: unknown
  analysisMode: string
  config: unknown
  externalInputs: string[]
  configs: Array<{ path: string; hash: string }>
  sources: string[]
  units: Unit[] | undefined
  hashOf: (path: string) => string | undefined
}

/**
 * The cache key of each source file: the keys of every unit that lists it, where a unit's key covers its id, its files' contents, the
 * keys of the units it depends on, and the adapter's identity, configuration files and external inputs. The id lets an adapter name an
 * input that file contents cannot show, such as the set of module paths an import may resolve among. A file in no unit is keyed by every
 * source, so an adapter that declares no units reanalyses everything on any change.
 */
export function fileKeys(k: KeyInputs): Map<string, string> {
  const global = sha256(canonicalJson({ repository: k.repository, adapter: k.adapter, analysis_mode: k.analysisMode, config: k.config, external_inputs: k.externalInputs, configs: [...k.configs].sort((a, b) => (a.path < b.path ? -1 : 1)).map((c) => [c.path, c.hash]) }))
  const contents = (files: string[]) => [...new Set(files)].sort().map((p) => [p, k.hashOf(p) ?? null])
  const byId = new Map((k.units ?? []).map((u) => [u.id, u]))
  // Keys are memoised by id, so two units with one id would share the first one's key and replay one file's facts for another.
  if (byId.size !== (k.units ?? []).length) throw new AdapterProtocolError('two units have the same id')
  const unitKey = new Map<string, string>()
  const keyOf = (id: string, visiting: Set<string>): string => {
    const known = unitKey.get(id)
    if (known) return known
    const unit = byId.get(id)
    if (!unit) throw new AdapterProtocolError(`unit ${id} is named as a dependency but not declared`)
    if (visiting.has(id)) throw new AdapterProtocolError(`units depend on each other in a cycle through ${id}`)
    visiting.add(id)
    const key = sha256(canonicalJson({ global, id, files: contents(unit.files), depends_on: [...new Set(unit.depends_on ?? [])].sort().map((d) => keyOf(d, visiting)) }))
    visiting.delete(id)
    unitKey.set(id, key)
    return key
  }
  const unitsOfFile = new Map<string, string[]>()
  for (const u of k.units ?? []) for (const f of u.files) unitsOfFile.set(f, [...(unitsOfFile.get(f) ?? []), keyOf(u.id, new Set())])
  const whole = sha256(canonicalJson({ global, files: contents(k.sources) }))
  return new Map(k.sources.map((p) => [p, sha256(canonicalJson({ path: p, units: [...(unitsOfFile.get(p) ?? [whole])].sort() }))]))
}

/** Splits an analyze answer by file; a fact for a file that was not asked about would be cached under the wrong key, so it is refused. */
export function splitByFile(response: AnalyzeResponse, paths: string[]): Map<string, FileFacts> {
  const out = new Map<string, FileFacts>(paths.map((p) => [p, { symbols: [], relationships: [], file_result: null }]))
  const of = (p: string, what: string) => {
    const f = out.get(p)
    if (!f) throw new AdapterProtocolError(`analyze returned ${what} for ${p}, which it was not asked to analyse; facts that span files belong in the workspace answer`)
    return f
  }
  for (const s of response.symbols) of(s.path, 'a symbol').symbols.push(s)
  for (const r of response.relationships) of(r.site.path, 'a relationship').relationships.push(r)
  for (const fr of response.file_results) of(fr.path, 'a file result').file_result = fr
  return out
}

/** Reassembles per-file facts in file order, the order a clean index writes them, so incremental and clean seal the same rows. */
export function assemble(files: FileFacts[]): AnalyzeResponse {
  return {
    symbols: files.flatMap((f) => f.symbols),
    relationships: files.flatMap((f) => f.relationships),
    file_results: files.flatMap((f) => (f.file_result ? [f.file_result] : [])),
    diagnostics: [],
  }
}

/** Per-file analyze answers by key, in `<dataDir>/cache/facts.db`. Rows a published index of the repository did not use are pruned. */
export class FactCache {
  private readonly db: Database.Database

  constructor(dataDir: string) {
    fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true })
    this.db = new Database(path.join(dataDir, 'cache', 'facts.db'))
    hardenDatabase(this.db)
    this.db.exec('create table if not exists fact (key text primary key, repository text not null, adapter text not null, facts text not null)')
  }

  get(key: string): FileFacts | undefined {
    const row = this.db.prepare('select facts from fact where key = ?').get(key) as { facts: string } | undefined
    return row ? (JSON.parse(row.facts) as FileFacts) : undefined
  }

  /** Whether facts are cached under the key, without reading them. */
  has(key: string): boolean {
    return !!this.db.prepare('select 1 from fact where key = ?').get(key)
  }

  put(repository: string, adapter: string, rows: Array<[string, FileFacts]>): void {
    const insert = this.db.prepare('insert or replace into fact (key, repository, adapter, facts) values (?, ?, ?, ?)')
    this.db.transaction(() => { for (const [key, facts] of rows) insert.run(key, repository, adapter, JSON.stringify(facts)) })()
  }

  prune(repository: string, adapter: string, keep: Iterable<string>): void {
    this.db.transaction(() => {
      this.db.exec('create temp table if not exists keep (key text primary key); delete from keep')
      const add = this.db.prepare('insert or ignore into keep (key) values (?)')
      for (const key of keep) add.run(key)
      this.db.prepare('delete from fact where repository = ? and adapter = ? and key not in (select key from keep)').run(repository, adapter)
    })()
  }

  close(): void {
    this.db.close()
  }
}
