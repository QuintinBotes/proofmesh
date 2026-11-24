// Evidence bundles (FR032, FR052): a directory of query envelopes and the evidence they cite, every file hashed in a manifest,
// so `proofmesh bundle check` verifies it with nothing but the directory. Source bytes go in only when the person says so.
import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256 } from '../core/hash.js'
import { ProofmeshError } from '../core/errors.js'
import { BUNDLE_FORMAT_VERSION, check } from '../core/schemas.js'
import { Catalog } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'
import { EvidenceStore } from '../evidence/store.js'
import { runTool } from '../query/tools.js'
import { queryHash } from '../query/cursor.js'

export type Query = { tool: string; input: Record<string, unknown> }
type EvidenceRow = { id: string; path: string; start_line: number; end_line: number; start_byte: number; end_byte: number; object_hash: string }

export function exportBundle(dataDir: string, repositoryIdOrPath: string, out: string, queries: Query[], includeSource: boolean, writer: string): { dir: string; manifest: Record<string, unknown> } {
  if (fs.existsSync(out)) throw new ProofmeshError('INVALID_ARGUMENT', `${out} already exists`)
  const catalog = Catalog.open(dataDir)
  try {
    const repo = catalog.repository(repositoryIdOrPath)
    const snapshot = catalog.currentSnapshot(repo.id)
    if (!snapshot) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', 'no published snapshot for this repository; run "proofmesh index" first', { detail: 'none' })
    const envelopes = (queries.length ? queries : [{ tool: 'workspace_status', input: {} }]).map((q) => ({ q, env: runTool(dataDir, q.tool, { ...q.input, repository_id: repo.id, snapshot_id: snapshot.id }) }))
    const ids = [...new Set(envelopes.flatMap((e) => e.env.evidence_ids))].sort()
    const db = openSnapshot(catalog, snapshot), store = new EvidenceStore(dataDir)
    try {
      fs.mkdirSync(path.join(out, 'queries'), { recursive: true })
      if (includeSource) fs.mkdirSync(path.join(out, 'evidence'))
      const queryEntries = envelopes.map(({ q, env }, i) => {
        const file = `queries/${i + 1}.json`, text = JSON.stringify(env, null, 2) + '\n'
        fs.writeFileSync(path.join(out, file), text)
        return { tool: q.tool, input_hash: queryHash(q.tool, q.input), query_id: env.query_id, file, sha256: sha256(text) }
      })
      const evidence = ids.map((id) => {
        const e = db.prepare('select e.id, f.path, e.start_line, e.end_line, e.start_byte, e.end_byte, e.object_hash from evidence e join file f on f.id = e.file_id where e.id = ?').get(id) as EvidenceRow | undefined
        if (!e) throw new ProofmeshError('NOT_FOUND', `evidence ${id} is not in snapshot ${snapshot.id}`)
        const content = store.read(e.object_hash)
        if (!content || sha256(content) !== e.object_hash) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `evidence object ${e.object_hash} is missing or corrupt`, { detail: 'missing' })
        const slice = content.subarray(e.start_byte, e.end_byte)
        const file = includeSource ? `evidence/${id}.txt` : null
        if (file) fs.writeFileSync(path.join(out, file), slice)
        return { ...e, slice_sha256: sha256(slice), file }
      })
      const body = {
        schema_version: BUNDLE_FORMAT_VERSION, bundle_id: `pmb_${sha256(`${snapshot.id}\n${queryEntries.map((q) => q.sha256).join('\n')}`).slice(0, 24)}`, created_at: new Date().toISOString(), writer,
        snapshot: { id: snapshot.id, repository_id: snapshot.repository_id, analysis_mode: snapshot.analysis_mode, identity_hash: snapshot.identity_hash },
        queries: queryEntries, evidence,
      }
      const manifest = { ...body, manifest_sha256: sha256(canonicalJson(body)) }
      const problem = check(`bundle-format/${BUNDLE_FORMAT_VERSION}.schema.json`, manifest)
      if (problem) throw new ProofmeshError('INTERNAL_ERROR', `bundle manifest ${problem}`)
      fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
      return { dir: out, manifest }
    } finally {
      db.close()
    }
  } finally {
    catalog.close()
  }
}

export type CheckResult = { ok: boolean; verified: string[]; failed: string[]; unverifiable: string[] }

/** Verifies a bundle with nothing but its directory: the manifest's own hash, every query file, and every evidence slice it carries. */
export function checkBundle(dir: string): CheckResult {
  const r: CheckResult = { ok: true, verified: [], failed: [], unverifiable: [] }
  const fail = (what: string) => { r.failed.push(what); r.ok = false }
  const manifestFile = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestFile)) { fail('manifest.json is missing'); return r }
  let manifest: Record<string, any>
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { fail('manifest.json is not JSON'); return r }
  const problem = check(`bundle-format/${BUNDLE_FORMAT_VERSION}.schema.json`, manifest)
  if (problem) { fail(`manifest ${problem}`); return r }
  const { manifest_sha256, ...body } = manifest
  if (sha256(canonicalJson(body)) === manifest_sha256) r.verified.push('manifest'); else fail('manifest hash does not match its content')
  const fileHash = (rel: string): string | undefined => { const p = path.join(dir, rel); return fs.existsSync(p) ? sha256(fs.readFileSync(p)) : undefined }
  for (const q of manifest.queries as Array<{ file: string; sha256: string; tool: string }>) {
    const h = fileHash(q.file)
    if (h === q.sha256) r.verified.push(q.file); else fail(h ? `${q.file} does not match its hash` : `${q.file} is missing`)
  }
  for (const e of manifest.evidence as Array<{ id: string; file: string | null; slice_sha256: string }>) {
    if (!e.file) { r.unverifiable.push(`${e.id}: source not included; only its hash is recorded`); continue }
    const h = fileHash(e.file)
    if (h === e.slice_sha256) r.verified.push(e.file); else fail(h ? `${e.file} does not match its hash` : `${e.file} is missing`)
  }
  return r
}
