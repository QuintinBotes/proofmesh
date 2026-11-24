// Builds the OCI image locally when docker is available; otherwise reports it as unverified. Never pushes.
import { spawnSync } from 'node:child_process'
import { git, root, version } from './lib.mjs'

const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
if (docker.status !== 0) { console.log('unverified: docker not available, the image was not built'); process.exit(0) }
const tag = `proofmesh:${version()}`
const r = spawnSync('docker', ['build', '--label', `org.opencontainers.image.revision=${git('rev-parse', 'HEAD')}`, '--label', `org.opencontainers.image.version=${version()}`, '-t', tag, root], { stdio: 'inherit' })
process.exit(r.status ?? 1)
