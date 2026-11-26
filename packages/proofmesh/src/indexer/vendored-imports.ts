// An import of a package Go vendors resolves as an external package (FR294): the package's files are excluded by rule, so nothing in the
// snapshot can be its target, but the module that owns it is named by vendor/modules.txt and the row says it is vendored.
import path from 'node:path'
import type { AnalyzeResponse } from '../core/generated.js'
import type { Discovered } from './discovery.js'

type Rel = AnalyzeResponse['relationships'][number]
const dirOf = (p: string) => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p))

/** The module paths a vendor/modules.txt lists: its `# module version` lines. */
const modulesOf = (text: string): string[] => text.split('\n').flatMap((l) => { const m = /^# (\S+) /.exec(l); return m ? [m[1]!] : [] })

export function vendoredGoImports<T extends { rel: Rel }>(items: T[], discovered: Discovered[], read: (file: string) => string): T[] {
  const vendored = discovered.filter((d) => d.status === 'excluded' && d.detail === 'vendored:go_vendor')
  const roots = vendored.filter((d) => path.posix.basename(d.path) === 'modules.txt').map((d) => dirOf(d.path))
  if (!roots.length) return items
  // A vendor directory's packages, by import path, and the modules its modules.txt names.
  const packages = new Map(roots.map((r) => [r, new Set<string>()]))
  for (const d of vendored.filter((v) => v.path.endsWith('.go'))) {
    const root = roots.filter((r) => d.path.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]
    if (root) packages.get(root)!.add(dirOf(d.path).slice(root.length + 1))
  }
  const modules = new Map(roots.map((r) => [r, modulesOf(read(`${r}/modules.txt`)).sort((a, b) => b.length - a.length)]))
  // The vendor directory that serves a file is the nearest one beside a parent directory of it.
  const serving = (file: string) => roots.filter((r) => { const parent = dirOf(r); return !parent || file.startsWith(`${parent}/`) }).sort((a, b) => b.length - a.length)[0]
  return items.map((i) => {
    const { rel } = i
    const importPath = rel.detail?.module
    if (rel.type !== 'imports' || rel.resolution !== 'unresolved' || !rel.site.path.endsWith('.go') || !importPath) return i
    const root = serving(rel.site.path)
    if (root === undefined || !packages.get(root)!.has(importPath)) return i
    const owner = modules.get(root)!.find((m) => importPath === m || importPath.startsWith(`${m}/`)) ?? importPath
    const { reason: _reason, ...rest } = rel
    return { ...i, rel: { ...rest, resolution: 'resolved_external', target: { external: { module: `go:${owner}`, name: importPath } }, detail: { ...rel.detail, rule: 'go_vendor', vendored: 'true' } } }
  })
}
