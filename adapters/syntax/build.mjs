// Bundles the adapter and copies each pinned grammar and its tags query beside it, with a manifest of where each came from.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const here = path.dirname(new URL(import.meta.url).pathname)
const require = createRequire(path.join(here, 'package.json'))
// language: grammar package, its wasm file, and the tags query (the package's own, or ours where it ships none or a poor one)
const GRAMMARS = {
  python: ['tree-sitter-python', 'tree-sitter-python.wasm'],
  java: ['tree-sitter-java', 'tree-sitter-java.wasm'],
  go: ['tree-sitter-go', 'tree-sitter-go.wasm'],
  rust: ['tree-sitter-rust', 'tree-sitter-rust.wasm'],
  // The package's query treats every identifier that is not a local as a call, which needs local analysis this tier has not got.
  ruby: ['tree-sitter-ruby', 'tree-sitter-ruby.wasm', 'queries/ruby.scm'],
  php: ['tree-sitter-php', 'tree-sitter-php.wasm'],
  c: ['tree-sitter-c', 'tree-sitter-c.wasm'],
  cpp: ['tree-sitter-cpp', 'tree-sitter-cpp.wasm'],
  bash: ['tree-sitter-bash', 'tree-sitter-bash.wasm', 'queries/bash.scm'],
  scala: ['tree-sitter-scala', 'tree-sitter-scala.wasm'],
  kotlin: ['@tree-sitter-grammars/tree-sitter-kotlin', 'tree-sitter-kotlin.wasm', 'queries/kotlin.scm'],
  // The Terraform adapter walks the HCL tree itself, so its grammar needs no tags query.
  hcl: ['@tree-sitter-grammars/tree-sitter-hcl', 'tree-sitter-hcl.wasm', null],
  // The fallback floor under the TypeScript and C# adapters (FR310): one query each, and the TSX grammar reads JavaScript and JSX as well.
  typescript: ['tree-sitter-typescript', 'tree-sitter-typescript.wasm', 'queries/typescript.scm'],
  tsx: ['tree-sitter-typescript', 'tree-sitter-tsx.wasm', 'queries/typescript.scm'],
  csharp: ['tree-sitter-c-sharp', 'tree-sitter-c_sharp.wasm', 'queries/csharp.scm'],
  // These packages ship no WebAssembly: grammars/rebuild.mjs builds it from their source, and it is checked here against built.json.
  swift: ['tree-sitter-swift', null, 'queries/swift.scm'],
  sql: ['@derekstride/tree-sitter-sql', null, 'queries/sql.scm'],
  // The syntax tier walks a Prisma schema's tree itself, so its grammar needs no tags query.
  prisma: ['tree-sitter-prisma', null, null],
}
const built = JSON.parse(fs.readFileSync(path.join(here, 'grammars', 'built.json'), 'utf8')).grammars
const licenses = new Set(JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'policy', 'licenses.json'), 'utf8')).allowed)
const dist = path.join(here, 'dist')
fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(path.join(dist, 'grammars'), { recursive: true })
const manifest = {}
for (const [language, [pkg, wasm, ownTags]] of Object.entries(GRAMMARS)) {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`))
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  // The grammar is shipped compiled, so its package is a devDependency that pnpm check:licenses does not see.
  if (!licenses.has(meta.license)) throw new Error(`${pkg}@${meta.version} is licensed ${meta.license}, which policy/licenses.json does not allow`)
  const bytes = fs.readFileSync(wasm ? path.join(dir, wasm) : path.join(here, 'grammars', `${language}.wasm`))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (!wasm && (built[language]?.sha256 !== sha256 || built[language]?.version !== meta.version)) throw new Error(`grammars/${language}.wasm is not the build of ${pkg}@${meta.version} that grammars/built.json records; run grammars/rebuild.mjs`)
  fs.writeFileSync(path.join(dist, 'grammars', `${language}.wasm`), bytes)
  // The compiled grammar is a copy of the package's work, so its license text ships beside it (NFR013).
  const license = [path.join(here, 'grammars', `${language}.LICENSE`), ...['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'].map((f) => path.join(dir, f))].find((f) => fs.existsSync(f))
  if (!license) throw new Error(`${pkg}@${meta.version} has no license file to ship with its grammar`)
  fs.copyFileSync(license, path.join(dist, 'grammars', `${language}.LICENSE`))
  // Our queries/<language>.structure.scm, where there is one, adds imports and heritage to the package's own query (FR115, FR116).
  const structure = path.join(here, 'queries', `${language}.structure.scm`)
  const extra = !ownTags && ownTags !== null && fs.existsSync(structure)
  if (ownTags !== null) fs.writeFileSync(path.join(dist, 'grammars', `${language}.scm`), fs.readFileSync(ownTags ? path.join(here, ownTags) : path.join(dir, 'queries', 'tags.scm'), 'utf8') + (extra ? '\n' + fs.readFileSync(structure, 'utf8') : ''))
  manifest[language] = { package: pkg, version: meta.version, license: meta.license, sha256, tags: ownTags === null ? null : ownTags ? 'proofmesh' : extra ? `${pkg}+proofmesh` : pkg }
}
fs.writeFileSync(path.join(dist, 'grammars', 'grammars.json'), JSON.stringify(manifest, null, 2) + '\n')
for (const entry of ['main', 'terraform', 'python', 'build']) {
  await build({ entryPoints: [path.join(here, 'src', `${entry}.ts`)], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: path.join(dist, `${entry}.mjs`), external: ['web-tree-sitter'], logLevel: 'warning' })
}
