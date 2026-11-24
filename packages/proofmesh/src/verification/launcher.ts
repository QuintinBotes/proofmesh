// The host-side launcher (D07, FR046): the only code that runs an approved recipe. The MCP and query layers never import it; a
// test enforces that boundary. It consumes the approval before running, exports the snapshot's captured files into a disposable
// directory, never the repository, and signs what happened.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ProofmeshError } from '../core/errors.js'
import { EvidenceStore } from '../evidence/store.js'
import { Catalog, type Verification } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'
import { bindingHash, signRecord, type Binding, type RunRecord } from './binding.js'

export type RunOptions = { container?: string }

export async function runVerification(dataDir: string, id: string, opts: RunOptions = {}): Promise<Verification> {
  const catalog = Catalog.open(dataDir)
  try {
    const v = catalog.verification(id)
    if (!v) throw new ProofmeshError('NOT_FOUND', `no verification ${id}`)
    const binding = v.binding as Binding
    if (v.state !== 'approved') throw new ProofmeshError(v.state === 'prepared' ? 'APPROVAL_REQUIRED' : 'APPROVAL_INVALID', `verification ${id} is ${v.state}; only an approved one runs, once`)
    if (bindingHash(binding) !== v.binding_hash || !catalog.consumeVerification(id, v.binding_hash)) throw new ProofmeshError('APPROVAL_INVALID', `verification ${id} does not match what was approved`)
    if (opts.container && spawnSync('docker', ['--version'], { stdio: 'ignore' }).status !== 0) throw new ProofmeshError('DEPENDENCY_UNAVAILABLE', 'docker is not on PATH; run without --container, or install it')

    const dir = path.join(dataDir, 'verification', id), work = path.join(dir, 'work')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(work, { recursive: true })
    exportSnapshot(catalog, v.snapshot_id, work)
    const r = binding.recipe, cwd = path.join(work, r.cwd)
    if (!path.resolve(cwd).startsWith(work)) throw new ProofmeshError('APPROVAL_INVALID', 'the working directory leaves the disposable workspace')
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
    for (const k of r.env_allow) if (process.env[k] !== undefined) env[k] = process.env[k]!
    const argv = opts.container
      ? ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--memory', `${r.max_memory_mb}m`, '--tmpfs', '/tmp', '-v', `${work}:/work`, '-w', path.posix.join('/work', r.cwd), ...r.env_allow.flatMap((k) => (env[k] !== undefined ? ['-e', k] : [])), opts.container, ...r.command]
      : r.command
    const started = new Date().toISOString()
    const outcome = await execute(argv, cwd, env, r.timeout_s * 1000, r.max_output_kb * 1024, path.join(dir, 'output.log'))
    const record: RunRecord = {
      vr_id: id, binding_hash: v.binding_hash, sandbox: opts.container ? 'container' : 'process', container: opts.container ?? null, started, ended: new Date().toISOString(),
      exit_code: outcome.code, signal: outcome.signal, timed_out: outcome.timedOut, output_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'output.log'))).digest('hex'), truncated: outcome.truncated,
    }
    catalog.finishVerification(id, outcome.timedOut || outcome.error ? 'failed' : 'finished', signRecord(dataDir, record), outcome.error ?? (outcome.timedOut ? `timed out after ${r.timeout_s} s` : null))
    fs.rmSync(work, { recursive: true, force: true })
    return catalog.verification(id)!
  } finally {
    catalog.close()
  }
}

/** The snapshot's captured files, as the evidence store holds them: a fresh copy that the run may change and that is discarded. */
function exportSnapshot(catalog: Catalog, snapshotId: string, into: string): void {
  const snapshot = catalog.snapshot(snapshotId)
  if (!snapshot) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', `snapshot ${snapshotId} is gone; prepare the verification again`)
  const db = openSnapshot(catalog, snapshot), store = new EvidenceStore(catalog.dataDir)
  try {
    for (const f of db.prepare('select path, content_hash from file where content_hash is not null').all() as Array<{ path: string; content_hash: string }>) {
      const bytes = store.read(f.content_hash)
      if (!bytes) throw new ProofmeshError('EVIDENCE_UNAVAILABLE', `the captured content of ${f.path} is missing from the evidence store`)
      const target = path.join(into, f.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, bytes)
    }
  } finally {
    db.close()
  }
}

function execute(argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number, maxBytes: number, log: string): Promise<{ code: number | null; signal: string | null; timedOut: boolean; truncated: boolean; error?: string }> {
  return new Promise((resolve) => {
    const out = fs.openSync(log, 'w')
    let written = 0, truncated = false, timedOut = false
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const sink = (chunk: Buffer) => {
      if (written >= maxBytes) { truncated = true; return }
      const slice = chunk.subarray(0, maxBytes - written)
      fs.writeSync(out, slice); written += slice.length
      if (slice.length < chunk.length) truncated = true
    }
    child.stdout.on('data', sink); child.stderr.on('data', sink)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); fs.closeSync(out); resolve({ code: null, signal: null, timedOut, truncated, error: e.message }) })
    child.on('close', (code, signal) => { clearTimeout(timer); fs.closeSync(out); resolve({ code, signal, timedOut, truncated }) })
  })
}
