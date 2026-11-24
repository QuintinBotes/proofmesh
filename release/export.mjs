// The publication gate's export (D12): the Proofmesh paths only, as one commit in a fresh repository, then the leak scan over it.
// It creates no remote. A person reviews the export and decides what happens next.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDenyList, scan } from './leak-scan.mjs'
import { git, root } from './lib.mjs'

export const EXPORTED = ['packages', 'adapters', 'apps', 'schemas', 'fixtures', 'e2e', 'policy', 'specs', 'docs/proofmesh', 'bench', 'release', 'scripts', 'Dockerfile', '.dockerignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'vitest.config.ts', '.gitignore', '.prettierrc.json', 'global.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'MAINTAINERS.md', 'SECURITY.md', 'THREAT_MODEL.md', 'COMPATIBILITY.md', 'ROADMAP.md', 'CHANGELOG.md']

export function exportTree(outDir, denyFile) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`)
  fs.mkdirSync(outDir, { recursive: true })
  const files = git('ls-files', '-z', '--', ...EXPORTED.filter((p) => fs.existsSync(path.join(root, p)))).split('\0').filter(Boolean)
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(outDir, f)), { recursive: true }); fs.copyFileSync(path.join(root, f), path.join(outDir, f)) }
  // The exported tree has no legacy paths, so verify drops the legacy check; the open-source files move to the root.
  const pkg = JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'))
  pkg.scripts.verify = pkg.scripts.verify.replace(/ && pnpm check:legacy$/, '')
  delete pkg.scripts['check:legacy']
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  const oss = path.join(outDir, 'docs/proofmesh/oss')
  if (fs.existsSync(oss)) { for (const f of fs.readdirSync(oss)) fs.renameSync(path.join(oss, f), path.join(outDir, f)); fs.rmdirSync(oss) }
  const g = (...a) => execFileSync('git', ['-C', outDir, ...a], { stdio: 'ignore' })
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('-c', 'user.name=Proofmesh export', '-c', 'user.email=export@example.com', 'commit', '-q', '-m', `Proofmesh ${pkg.version ?? ''} export of ${git('rev-parse', '--short', 'HEAD')}`.trim())
  return { files: files.length, hits: scan(outDir, readDenyList(denyFile)) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const outDir = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : undefined
  const deny = args.includes('--deny-list') ? path.resolve(args[args.indexOf('--deny-list') + 1]) : undefined
  if (!outDir) { console.error('usage: node release/export.mjs --out <empty dir> [--deny-list <file>]'); process.exit(2) }
  const { files, hits } = exportTree(outDir, deny)
  console.log(`exported ${files} files to ${outDir} as one commit; no remote was created`)
  for (const h of hits) console.error(`${h.file}:${h.line}  ${h.what}: ${h.text}`)
  if (hits.length) { console.error(`leak scan: ${hits.length} hits; review them before any publication`); process.exit(1) }
  console.log('leak scan: clean. Next: a person reviews the export (fixtures, docs, screenshots) and clears every line before a remote exists.')
}
