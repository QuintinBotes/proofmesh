import type Database from 'better-sqlite3'
import type { Catalog } from '../meshstore/catalog.js'
import { invalid, saveArtifact, validateIdentity } from './artifact.js'

type Span = { path: string; name: string; kind: string; start_line: number; end_line: number; sha256: string }
type Endpoint = Omit<Span, 'sha256'> & { id: string; key: string; evidence_id: string; start_byte: number; end_byte: number }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && !!v && !Array.isArray(v)
function span(v: unknown): v is Span {
  return record(v) && [v.path, v.kind, v.name].every((x) => typeof x === 'string' && x.length > 0 && x.length <= 2048)
    && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256)
    && typeof v.start_line === 'number' && Number.isSafeInteger(v.start_line) && v.start_line > 0
    && typeof v.end_line === 'number' && Number.isSafeInteger(v.end_line) && v.end_line >= v.start_line
}
export function importGenerates(catalog: Catalog, db: Database.Database, repository: string, snapshot: string, text: string) {
  let m: unknown
  try { m = JSON.parse(text) } catch { return invalid('Expected a JSON generation map.') }
  if (!record(m) || m.format !== 'proofmesh-generates/v1' || !Array.isArray(m.links) || m.links.length > 50000) return invalid('Unsupported generation map. Expected proofmesh-generates/v1 with up to 50,000 links.')
  if (typeof m.name !== 'string' || typeof m.producer !== 'string' || typeof m.revision !== 'string') return invalid('Supply a map name, producer and revision.')
  const id = { name: m.name, producer: m.producer, revision: m.revision }
  validateIdentity(db, id)
  const file = db.prepare('select id, content_hash from file where path=?')
  const symbol = db.prepare('select s.id,s.stable_key as key,s.evidence_id,s.start_byte,s.end_byte from symbol s where file_id=? and kind=? and name=? and start_line=? and end_line=? limit 2')
  function locate(s: Span): Endpoint | string {
    const f = file.get(s.path) as { id: string; content_hash: string } | undefined
    if (!f) return 'missing_file'
    if (f.content_hash !== s.sha256) return 'stale_content'
    const hits = symbol.all(f.id, s.kind, s.name, s.start_line, s.end_line) as Pick<Endpoint, 'id' | 'key' | 'evidence_id' | 'start_byte' | 'end_byte'>[]
    if (hits.length !== 1) return hits.length ? 'ambiguous_declaration' : 'missing_declaration'
    const { sha256: _hash, ...location } = s
    return { ...location, ...hits[0]! }
  }
  const links = m.links as unknown[]
  return catalog.db.transaction(() => {
    let mapped = 0, unplaced = 0
    const diagnostics: { link: number; side: string; reason: string }[] = []
    saveArtifact(catalog, repository, snapshot, 'generates', id, {})
    catalog.db.prepare('delete from generated_link where repository_id=? and snapshot_id=? and name=?').run(repository, snapshot, id.name)
    const add = catalog.db.prepare('insert or ignore into generated_link(repository_id,snapshot_id,name,source_id,target_id,source,target) values (?,?,?,?,?,?,?)')
    links.forEach((l, i) => {
      if (!record(l) || !span(l.source) || !span(l.target)) return invalid('Invalid source or target span at link ' + i)
      const source = locate(l.source), target = locate(l.target)
      if (typeof source === 'string' || typeof target === 'string') {
        unplaced++
        for (const [side, value] of [['source', source], ['target', target]] as const) {
          if (typeof value === 'string' && diagnostics.length < 20) diagnostics.push({ link: i, side, reason: value })
        }
      } else mapped += add.run(repository, snapshot, id.name, source.id, target.id, JSON.stringify(source), JSON.stringify(target)).changes
    })
    const report = { mapped, unplaced, repeated: links.length - mapped - unplaced, diagnostics }
    saveArtifact(catalog, repository, snapshot, 'generates', id, report)
    return { ...id, ...report }
  })()
}

export function generatedNavigation(catalog: Catalog, repository: string, snapshot: string, symbol: string) {
  const base = ' from generated_link l join producer_import p using(repository_id,snapshot_id,kind,name) where l.repository_id=? and l.snapshot_id=?'
  const rows = catalog.db.prepare("select 'generates' as direction,p.producer,p.revision,p.name as name,l.target as endpoint" + base + " and l.source_id=? union all select 'generated_from',p.producer,p.revision,p.name,l.source" + base + ' and l.target_id=? order by direction,name,endpoint')
    .all(repository, snapshot, symbol, repository, snapshot, symbol) as { direction: string; producer: string; revision: string; name: string; endpoint: string }[]
  return rows.map((r) => ({ ...r, endpoint: JSON.parse(r.endpoint) as Endpoint }))
}
