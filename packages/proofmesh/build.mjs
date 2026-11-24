// Bundles the CLI and copies the schemas and the built Observatory next to it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, 'dist')
fs.rmSync(dist, { recursive: true, force: true })
await build({
  entryPoints: [path.join(here, 'src/cli/main.ts')], outfile: path.join(dist, 'cli.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['better-sqlite3', '@proofmesh/adapter-typescript'], logLevel: 'warning',
  banner: { js: "import { createRequire as __pmCreateRequire } from 'node:module'; const require = __pmCreateRequire(import.meta.url);" },
})
// The SCIP adapter runs as its own process, like every adapter (A24).
await build({ entryPoints: [path.join(here, 'src/scip/adapter.ts')], outfile: path.join(dist, 'scip-adapter.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning' })
fs.cpSync(path.resolve(here, '../../schemas'), path.join(dist, 'schemas'), { recursive: true })
const observatory = path.resolve(here, '../../apps/observatory/dist')
if (fs.existsSync(path.join(observatory, 'index.html'))) fs.cpSync(observatory, path.join(dist, 'observatory'), { recursive: true })
console.log(`built ${path.relative(process.cwd(), dist)}`)
