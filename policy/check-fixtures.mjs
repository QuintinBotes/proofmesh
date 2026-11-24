// pnpm check:fixtures (FR075): every fixture and the eval samples carry a PROVENANCE.md naming their origin and Apache-2.0,
// and the leak scan finds nothing in the files git tracks under fixtures/ and bench/. Usage: node policy/check-fixtures.mjs [root]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanFiles } from '../release/leak-scan.mjs'

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
// Project-authored material says so; anything else names where it came from on an Origin line.
const ORIGIN = /^(Project-authored for Proofmesh|Origin: \S)/m
const dirs = [
  ...fs.readdirSync(path.join(root, 'fixtures'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `fixtures/${d.name}`),
  ...(fs.existsSync(path.join(root, 'bench', 'eval', 'samples')) ? ['bench/eval/samples'] : []),
]
const problems = []
for (const dir of dirs) {
  const file = path.join(root, dir, 'PROVENANCE.md')
  if (!fs.existsSync(file)) { problems.push(`${dir}: PROVENANCE.md is missing`); continue }
  const text = fs.readFileSync(file, 'utf8')
  if (!ORIGIN.test(text)) problems.push(`${dir}: PROVENANCE.md names no origin (a line starting "Project-authored for Proofmesh" or "Origin: ")`)
  if (!/\bApache-2\.0\b/.test(text)) problems.push(`${dir}: PROVENANCE.md does not state Apache-2.0`)
}
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'fixtures', 'bench'], { encoding: 'utf8' }).split('\0').filter(Boolean)
for (const h of scanFiles(root, tracked)) problems.push(`${h.file}:${h.line}  leak scan, ${h.what}: ${h.text}`)
if (problems.length) {
  console.error(`FR075 fixtures: ${problems.length} problems\n${problems.join('\n')}`)
  process.exit(1)
}
console.log(`FR075 fixtures ok: ${dirs.length} directories name their origin and Apache-2.0; leak scan clean over ${tracked.length} tracked files in fixtures/ and bench/`)
