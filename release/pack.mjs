// Packs the three npm tarballs into release/out from built artifacts; publishes nothing.
// The C# adapter's Release build is staged into the core package's dist so a packed install finds it beside the CLI.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { git, out, PACKAGES, root, sha256 } from './lib.mjs'

const built = ['packages/proofmesh/dist/cli.mjs', 'packages/proofmesh/dist/schemas/envelope.schema.json', 'packages/proofmesh/dist/observatory/index.html', 'adapters/typescript/dist/main.mjs', 'adapters/syntax/dist/python.mjs']
const missing = built.filter((f) => !fs.existsSync(path.join(root, f)))
if (missing.length) { console.error(`run pnpm build first; missing: ${missing.join(', ')}`); process.exit(1) }
const csharp = path.join(root, 'adapters/csharp/bin/Release/net10.0')
if (fs.existsSync(path.join(csharp, 'Proofmesh.Adapter.CSharp.dll'))) fs.cpSync(csharp, path.join(root, 'packages/proofmesh/dist/adapters/csharp'), { recursive: true })
else console.error('warning: the C# adapter is not built (dotnet build adapters/csharp -c Release); the package ships without it')
fs.mkdirSync(out, { recursive: true })
for (const f of fs.readdirSync(out)) if (f.endsWith('.tgz')) fs.unlinkSync(path.join(out, f))
for (const pkg of PACKAGES) execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: path.join(root, pkg), stdio: 'ignore' })
const files = fs.readdirSync(out).filter((f) => f.endsWith('.tgz')).sort()
const manifest = { commit: git('rev-parse', 'HEAD'), packed_at: new Date().toISOString(), tarballs: files.map((f) => ({ file: f, sha256: sha256(path.join(out, f)), bytes: fs.statSync(path.join(out, f)).size })) }
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
for (const t of manifest.tarballs) console.log(`${t.sha256}  ${t.file}  ${t.bytes} bytes`)
