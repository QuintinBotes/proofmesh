// A CycloneDX 1.5 SBOM of the production dependencies pnpm reports, written to release/out/sbom.cdx.json. No network.
import fs from 'node:fs'
import path from 'node:path'
import { git, licenseReport, out, readJson, root, sha256, tarballs, version } from './lib.mjs'

const components = []
for (const [license, pkgs] of Object.entries(licenseReport())) {
  for (const p of pkgs) for (const v of p.versions ?? [p.version]) {
    if (p.name.startsWith('@proofmesh/') || p.name === 'proofmesh') continue
    components.push({ type: 'library', 'bom-ref': `pkg:npm/${p.name}@${v}`, name: p.name, version: v, purl: `pkg:npm/${p.name}@${v}`, licenses: [{ license: /^[A-Za-z0-9.+-]+$/.test(license) ? { id: license } : { expression: license } }] })
  }
}
components.sort((a, b) => (a['bom-ref'] < b['bom-ref'] ? -1 : 1))
const v = version()
const bom = {
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  metadata: { timestamp: new Date().toISOString(), tools: [{ name: 'proofmesh release/sbom.mjs', version: v }], component: { type: 'application', 'bom-ref': `pkg:npm/proofmesh@${v}`, name: 'proofmesh', version: v, purl: `pkg:npm/proofmesh@${v}`, licenses: [{ license: { id: 'Apache-2.0' } }], properties: [{ name: 'vcs:revision', value: git('rev-parse', 'HEAD') }], hashes: tarballs().map((t) => ({ alg: 'SHA-256', content: sha256(t) })) } },
  components,
  dependencies: [{ ref: `pkg:npm/proofmesh@${v}`, dependsOn: components.map((c) => c['bom-ref']) }],
}
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'sbom.cdx.json'), JSON.stringify(bom, null, 2) + '\n')
console.log(`sbom: ${components.length} components, ${path.relative(root, path.join(out, 'sbom.cdx.json'))}`)
