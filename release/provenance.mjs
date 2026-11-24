// An in-toto statement with a SLSA v1 provenance predicate for the packed tarballs: subjects by hash, the commit and lockfile as materials.
// The builder is this machine; keyless CI provenance is the release path, see docs/proofmesh/release.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { git, out, root, sha256, tarballs } from './lib.mjs'

const files = tarballs()
if (!files.length) { console.error('nothing to attest: run pnpm release:pack first'); process.exit(1) }
const statement = {
  _type: 'https://in-toto.io/Statement/v1',
  subject: files.map((f) => ({ name: path.basename(f), digest: { sha256: sha256(f) } })),
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      buildType: 'https://proofmesh.dev/build/local-pnpm-pack/v1',
      externalParameters: { commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') },
      internalParameters: { node: process.version, pnpm: 'from packageManager field' },
      resolvedDependencies: [
        { uri: `git+file://${root}@${git('rev-parse', 'HEAD')}`, digest: { gitCommit: git('rev-parse', 'HEAD') } },
        { name: 'pnpm-lock.yaml', digest: { sha256: sha256(path.join(root, 'pnpm-lock.yaml')) } },
      ],
    },
    runDetails: { builder: { id: `local://${os.hostname()}` }, metadata: { invocationId: `${process.pid}-${Date.now()}`, finishedOn: new Date().toISOString() } },
  },
}
fs.writeFileSync(path.join(out, 'provenance.intoto.json'), JSON.stringify(statement, null, 2) + '\n')
console.log(`provenance: ${files.length} subjects, builder ${statement.predicate.runDetails.builder.id}`)
