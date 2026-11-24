// Fails when a production dependency of any workspace package carries a license outside policy/licenses.json.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const policy = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'licenses.json'), 'utf8'))
const allowed = new Set(policy.allowed)
const report = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--prod', '--json', '--recursive'], { encoding: 'utf8', maxBuffer: 64 << 20 }))
const ok = (expr) => {
  const e = expr.replace(/[()]/g, '').trim()
  if (/\s+OR\s+/i.test(e)) return e.split(/\s+OR\s+/i).some(ok)
  if (/\s+AND\s+/i.test(e)) return e.split(/\s+AND\s+/i).every(ok)
  return allowed.has(e)
}
const bad = []
let count = 0
for (const [license, pkgs] of Object.entries(report)) {
  for (const p of pkgs) {
    count++
    if (p.name.startsWith('@proofmesh/') || p.name === 'proofmesh') continue
    if (!ok(license) && !policy.exceptions[p.name]) bad.push(`${p.name}@${(p.versions ?? [p.version]).join(',')}: ${license}`)
  }
}
if (bad.length) { console.error(`license policy violations:\n  ${bad.join('\n  ')}`); process.exit(1) }
console.log(`licenses ok: ${count} production packages checked`)
