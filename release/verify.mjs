// Verifies every signature in release/out against allowed_signers, and each tarball against manifest.json. Exit 1 on any failure.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { out, readJson, sha256 } from './lib.mjs'

const NAMESPACE = 'proofmesh-release'
const signers = path.join(out, 'allowed_signers')
if (!fs.existsSync(signers)) { console.error('no allowed_signers in release/out; run pnpm release:sign first'); process.exit(1) }
const failures = []
for (const f of fs.readdirSync(out).filter((f) => f.endsWith('.sig')).sort()) {
  const file = path.join(out, f.slice(0, -4))
  const r = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', 'proofmesh', '-n', NAMESPACE, '-s', path.join(out, f)], { input: fs.readFileSync(file), encoding: 'utf8' })
  if (r.status !== 0) failures.push(`${path.basename(file)}: signature does not verify`)
}
if (fs.existsSync(path.join(out, 'manifest.json'))) {
  for (const t of readJson(path.join(out, 'manifest.json')).tarballs) if (!fs.existsSync(path.join(out, t.file)) || sha256(path.join(out, t.file)) !== t.sha256) failures.push(`${t.file}: hash differs from manifest.json`)
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('verified: every signature and tarball hash')
