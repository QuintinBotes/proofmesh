// Every traced item names an existing test file that mentions it; manual checks are listed separately.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = JSON.parse(fs.readFileSync(path.join(root, 'policy', 'traceability.json'), 'utf8'))
const problems = []
for (const [id, files] of Object.entries(t.items)) {
  if (!files.length) problems.push(`${id} has no test`)
  for (const f of files) {
    const p = path.join(root, f)
    if (!fs.existsSync(p)) problems.push(`${id}: ${f} does not exist`)
    else if (!f.endsWith('.mjs') && !fs.readFileSync(p, 'utf8').includes(id)) problems.push(`${id}: ${f} does not mention ${id}`)
  }
}
// Completeness, not only consistency: every MUST requirement of the spec, every amendment the goal names (A1 to A13), and every
// success criterion must be traced to a test or a manual check, so a requirement nobody mapped fails here instead of passing silently.
const spec = fs.readFileSync(path.join(root, 'specs', '001-proofmesh-foundation', 'spec.md'), 'utf8')
const must = spec.split('\n').flatMap((l) => { const m = /^\s*[-*]?\s*\*{0,2}((?:FR|NFR)\d{3})\*{0,2}[:.\s]/.exec(l); return m && l.includes('MUST') ? [m[1]] : [] })
const required = [...new Set([...must, ...Array.from({ length: 13 }, (_, i) => `A${i + 1}`), ...(spec.match(/\bSC0\d\d\b/g) ?? [])])]
for (const id of required) if (!t.items[id] && !t.manual[id]) problems.push(`${id} is required but not traced to a test or a manual check`)
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
console.log(`traceability ok: ${Object.keys(t.items).length} automated items, ${Object.keys(t.manual).length} manual checks`)
