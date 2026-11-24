// Scans a directory for things a public export must not carry (D12): email addresses, hosts not on the allow list, secret-looking
// tokens, private keys, and every word of an optional deny list a person keeps outside this repository. Exit 1 with every hit listed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ALLOWED_HOSTS = new Set(JSON.parse(fs.readFileSync(path.join(here, 'leak-allow.json'), 'utf8')).hosts)
const PATTERNS = [
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['generic secret assignment', /\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/gi],
]
const HOST = /https?:\/\/([A-Za-z0-9.-]+)/g

export function scan(dir, denyList = []) {
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else files.push(path.relative(dir, p))
    }
  }
  walk(dir)
  return scanFiles(dir, files, denyList)
}

/** The same checks over a list of files relative to root, such as the ones git tracks. */
export function scanFiles(root, files, denyList = []) {
  const hits = []
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(root, rel))
    if (bytes.subarray(0, 8192).includes(0)) continue
    const text = bytes.toString('utf8')
    const lineOf = (i) => text.slice(0, i).split('\n').length
    for (const [what, re] of PATTERNS) for (const m of text.matchAll(re)) if (!(what === 'email address' && /(^|@)(example\.(com|org)|noreply\.github\.com)$/.test(m[0].split('@')[1]))) hits.push({ file: rel, line: lineOf(m.index), what, text: m[0].slice(0, 60) })
    for (const m of text.matchAll(HOST)) if (!ALLOWED_HOSTS.has(m[1].toLowerCase())) hits.push({ file: rel, line: lineOf(m.index), what: 'host not on the allow list', text: m[1] })
    for (const word of denyList) { const i = text.toLowerCase().indexOf(word.toLowerCase()); if (i >= 0) hits.push({ file: rel, line: lineOf(i), what: 'deny-list word', text: word }) }
  }
  return hits
}

export const readDenyList = (file) => (file ? fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [])

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dir = args.find((a) => !a.startsWith('--'))
  const deny = args.includes('--deny-list') ? args[args.indexOf('--deny-list') + 1] : undefined
  if (!dir) { console.error('usage: node release/leak-scan.mjs <dir> [--deny-list <file>]'); process.exit(2) }
  const hits = scan(path.resolve(dir), readDenyList(deny))
  for (const h of hits) console.error(`${h.file}:${h.line}  ${h.what}: ${h.text}`)
  if (hits.length) { console.error(`${hits.length} hits`); process.exit(1) }
  console.log('leak scan: clean')
}
