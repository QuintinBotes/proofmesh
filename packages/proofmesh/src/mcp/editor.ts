import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProofmeshError } from '../core/errors.js'
import type { Envelope } from '../core/generated.js'
import { check, loadSchema } from '../core/schemas.js'
import { EvidenceStore } from '../evidence/store.js'
import { indexRepository } from '../indexer/coordinator.js'
import { BUILT_IN, Registry } from '../indexer/languages.js'
import { Catalog, initDataDir } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'

const typescript = BUILT_IN.find(spec => spec.id === 'typescript')!
const registry = new Registry([{ ...typescript, config: () => ({ captured_only: true }) }])
const reads = new Set(['find_symbols', 'get_symbols_at', 'get_symbol', 'get_relationships', 'trace_paths', 'analyze_impact', 'find_tests', 'read_evidence', 'get_symbol_card'])
export const editorTools = ['apply_edit', 'discard_edit'] as const
type Control = (typeof editorTools)[number]
type Edit = NonNullable<Envelope['edit']>
type View = { dir: string; dataDir: string; snapshot: string; edit: Edit }
type BufferInput = { snapshot_id: string; path: string; base_hash: string; content: string }

export function editorListing(name: Control) {
  const inputSchema = loadSchema(`mcp/${name}.json`) as { type: 'object'; description: string }
  return { name, description: inputSchema.description, inputSchema }
}

function materialize(dataDir: string, root: string, args: BufferInput): string {
  const catalog = Catalog.open(dataDir)
  try {
    const base = catalog.snapshot(args.snapshot_id)
    if (!base) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `No published snapshot named ${args.snapshot_id}`)
    const db = openSnapshot(catalog, base)
    try {
      const target = db.prepare("select content_hash, language from file where path = ? and disposition = 'indexed'").get(args.path) as { content_hash: string; language: string } | undefined
      if (target?.language !== 'typescript' || registry.sourceLanguage(args.path) !== 'typescript') throw new ProofmeshError('INVALID_ARGUMENT', 'Choose an indexed TypeScript file in the named snapshot')
      if (target.content_hash !== args.base_hash) throw new ProofmeshError('STALE_INPUT', 'The supplied hash differs from the sealed file. Read its evidence and rebase the buffer before applying it.', { path: args.path, snapshot_id: base.id, expected_hash: target.content_hash })
      const store = new EvidenceStore(dataDir)
      const files = db.prepare("select path, content_hash from file where disposition = 'indexed' and content_hash is not null order by path").iterate() as Iterable<{ path: string; content_hash: string }>
      for (const file of files) {
        const name = path.posix.basename(file.path)
        if (!registry.sourceLanguage(name) && !(name.endsWith('.json') && registry.configOwner(name))) continue
        const parts = file.path.split('/')
        if (path.win32.isAbsolute(file.path) || /[\\\0]/.test(file.path) || parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) {
          throw new ProofmeshError('INTEGRITY_FAILURE', 'A captured file has an invalid repository-relative path')
        }
        const { content, integrity } = store.verify(file.content_hash)
        if (!content) throw new ProofmeshError(integrity.status === 'failed' ? 'INTEGRITY_FAILURE' : 'EVIDENCE_UNAVAILABLE', `Cannot reconstruct ${file.path} from verified snapshot bytes`)
        const dest = path.join(root, ...parts)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, file.path === args.path ? args.content : content, { flag: 'wx', mode: 0o600 })
      }
      return base.repository_id
    } finally { db.close() }
  } finally { catalog.close() }
}

/** A stdio connection owns its private snapshots. A failed replacement leaves the last usable revision intact. */
export class EditorSession {
  private view?: View
  private revision = 0
  private building = false
  private readonly dirs = new Set<string>()
  private readonly closed = new AbortController()
  constructor(private readonly baseDir: string) {}

  private remove(dir: string) {
    fs.rmSync(dir, { recursive: true, force: true })
    this.dirs.delete(dir)
  }

  close() {
    this.closed.abort()
    this.view = undefined
    for (const dir of this.dirs) this.remove(dir)
  }

  async control(name: Control, input: Record<string, unknown>, signal: AbortSignal) {
    const problem = check(`mcp/${name}.json`, input)
    if (problem) throw new ProofmeshError('INVALID_ARGUMENT', problem)
    if (this.building) throw new ProofmeshError('BUSY', 'An edit is being indexed on this connection')
    const previous = this.view
    if (name === 'discard_edit') {
      if (previous) this.remove(previous.dir)
      this.view = undefined
      return { discarded: !!previous, ...(previous ? { edit: previous.edit } : {}) }
    }
    const args = input as BufferInput
    if (previous && (args.snapshot_id !== previous.edit.base_snapshot_id || args.path !== previous.edit.path)) throw new ProofmeshError('INVALID_ARGUMENT', 'Discard the active edit before editing another file or base snapshot')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofmesh-edit-'))
    this.dirs.add(dir)
    this.building = true
    try {
      const root = path.join(dir, 'source'), dataDir = path.join(dir, 'data')
      fs.mkdirSync(root)
      const repository_id = materialize(this.baseDir, root, args)
      initDataDir(dataDir)
      const local = Catalog.open(dataDir)
      let repo: string
      try { repo = local.addRepository(root).id } finally { local.close() }
      const stop = AbortSignal.any([signal, this.closed.signal])
      const indexed = await indexRepository(dataDir, repo, undefined, registry, undefined, false, { signal: stop })
      if (stop.aborted) throw new ProofmeshError('CANCELLED', 'The editor disconnected or cancelled the request')
      if (indexed.counts.failed || indexed.partial) throw new ProofmeshError('ADAPTER_UNSUPPORTED', 'The TypeScript adapter could not complete the edited project')
      const edit = { repository_id, base_snapshot_id: args.snapshot_id, base_hash: args.base_hash, path: args.path, revision: ++this.revision }
      this.view = { dir, dataDir, snapshot: indexed.snapshotId, edit }
      if (previous) this.remove(previous.dir)
      return { edit, snapshot_id: indexed.snapshotId }
    } catch (e) {
      this.remove(dir)
      throw e
    } finally { this.building = false }
  }

  route(name: string, args: Record<string, unknown>) {
    if (this.building) throw new ProofmeshError('BUSY', 'Wait for apply_edit to return its revision before querying it')
    const view = this.view
    if (!view) return undefined
    if (!reads.has(name) || args.freshness === 'strict' || args.include_workspace === true) throw new ProofmeshError('INVALID_ARGUMENT', 'This operation needs the published repository. Discard the edit or open another connection.')
    if (args.repository_id != null && args.repository_id !== view.edit.repository_id) throw new ProofmeshError('INVALID_ARGUMENT', 'The active edit belongs to another repository')
    if (args.snapshot_id != null && args.snapshot_id !== view.edit.base_snapshot_id && args.snapshot_id !== view.snapshot) throw new ProofmeshError('STALE_INPUT', 'The requested snapshot differs from the active edit and its base')
    return { dataDir: view.dataDir, args: { ...args, repository_id: undefined, snapshot_id: view.snapshot }, edit: view.edit }
  }
}
