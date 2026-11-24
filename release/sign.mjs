// Signs every tarball, the SBOM and the provenance with an SSH key named by PROOFMESH_SIGNING_KEY (ssh-keygen -Y). The key never lives in the repository.
// Writes <file>.sig beside each file and allowed_signers so release/verify.mjs can check them.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { out } from './lib.mjs'

export const NAMESPACE = 'proofmesh-release'
export const artifacts = () => fs.readdirSync(out).filter((f) => f.endsWith('.tgz') || f === 'sbom.cdx.json' || f === 'provenance.intoto.json').sort()
const key = process.env.PROOFMESH_SIGNING_KEY
if (!key || !fs.existsSync(key)) { console.error('set PROOFMESH_SIGNING_KEY to the path of an SSH private key; nothing was signed'); process.exit(1) }
const files = artifacts()
if (!files.length) { console.error('nothing to sign in release/out'); process.exit(1) }
for (const f of files) execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', NAMESPACE, path.join(out, f)], { stdio: 'ignore' })
const pub = execFileSync('ssh-keygen', ['-y', '-f', key], { encoding: 'utf8' }).trim()
fs.writeFileSync(path.join(out, 'allowed_signers'), `proofmesh namespaces="${NAMESPACE}" ${pub}\n`)
console.log(`signed ${files.length} files with ${pub.split(' ')[0]}; verify with pnpm release:verify`)
