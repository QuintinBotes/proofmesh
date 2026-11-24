// The build adapter (FR124 to FR129): the module graph of JavaScript and Go, read from manifests as captured text and never by running
// a build tool, package manager or script (FR079). A package.json that names a package and a go.mod are `project` symbols; each file
// is contained by the project of its nearest enclosing manifest; a project depends_on the projects in the repository that its
// manifests name (package.json dependencies, tsconfig references, go.mod requires satisfied by go.work or a local replace) and
// depends_on_package the packages outside it. Facts span files, so all of them are answered by `workspace`, never cached.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { byteOffsets, send, type Range } from './common.js'

const VERSION = '0.1.0'
type Ref = { symbol: string } | { file: string } | { external: { module: string; name: string } }
type Fact = Record<string, unknown>
type Manifest = { path: string; dir: string; text: string; at: Uint32Array; lines: number[] }
type Project = { id: string; eco: 'npm' | 'go'; manifest: Manifest; dir: string; name: string; range: Range }

/** A node of a JSON document with where it sits; comments and trailing commas are allowed, as tsconfig.json allows them. */
type JNode = { kind: 'object' | 'array' | 'string' | 'other'; start: number; end: number; value?: string; members?: Array<{ key: string; start: number; value: JNode }>; items?: JNode[] }
class ParseError extends Error { constructor(message: string, readonly offset: number) { super(message) } }

function parseJson(text: string): JNode {
  let i = 0
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++
      if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i++ }
      else if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); if (e < 0) throw new ParseError('unterminated comment', i); i = e + 2 }
      else return
    }
  }
  const string = (): JNode => {
    const start = i++
    while (i < text.length && text[i] !== '"') { if (text[i] === '\n') throw new ParseError('unterminated string', start); i += text[i] === '\\' ? 2 : 1 }
    if (i >= text.length) throw new ParseError('unterminated string', start)
    i++
    let value: string
    try { value = JSON.parse(text.slice(start, i)) } catch { throw new ParseError('invalid string', start) }
    return { kind: 'string', start, end: i, value }
  }
  const value = (): JNode => {
    skip()
    const c = text[i]
    if (c === '"') return string()
    if (c === '{' || c === '[') {
      const start = i++, close = c === '{' ? '}' : ']'
      const node: JNode = c === '{' ? { kind: 'object', start, end: 0, members: [] } : { kind: 'array', start, end: 0, items: [] }
      for (;;) {
        skip()
        if (text[i] === close) { i++; break }
        if (c === '{') {
          if (text[i] !== '"') throw new ParseError(`expected a property name, found ${text[i] ?? 'the end'}`, i)
          const key = string()
          skip()
          if (text[i] !== ':') throw new ParseError(`expected ":" after "${key.value}"`, i)
          i++
          node.members!.push({ key: key.value!, start: key.start, value: value() })
        } else node.items!.push(value())
        skip()
        if (text[i] === ',') { i++; continue }
        if (text[i] === close) { i++; break }
        throw new ParseError(`expected "," or "${close}", found ${text[i] ?? 'the end'}`, i)
      }
      node.end = i
      return node
    }
    const start = i
    while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++
    const token = text.slice(start, i)
    if (!/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)$/.test(token)) throw new ParseError(token ? `unexpected ${JSON.stringify(token)}` : `unexpected ${text[i] ?? 'end of file'}`, start)
    return { kind: 'other', start, end: i }
  }
  const root = value()
  skip()
  if (i < text.length) throw new ParseError('content after the document', i)
  return root
}

const member = (n: JNode | undefined, key: string) => n?.kind === 'object' ? n.members!.find((m) => m.key === key) : undefined
const strings = (n: JNode | undefined) => (n?.kind === 'array' ? n.items!.flatMap((x) => (x.kind === 'string' ? [x.value!] : [])) : [])

/** One go.mod or go.work directive, with where it is written. A block's lines are directives of the block's keyword. */
type Directive = { keyword: string; args: string[]; start: number; end: number }

function parseGoFile(text: string): Directive[] {
  const out: Directive[] = []
  let block: string | undefined, blockAt = 0, offset = 0
  const lines = text.split('\n')
  lines.forEach((raw) => {
    const lineStart = offset
    offset += raw.length + 1
    // A comment runs to the end of the line, and a quoted token may hold `//`.
    const tokens: Array<{ text: string; start: number; end: number }> = []
    for (let i = 0; i < raw.length;) {
      if (/\s/.test(raw[i]!)) { i++; continue }
      if (raw.startsWith('//', i)) break
      const start = i
      if (raw[i] === '"' || raw[i] === '`') { const q = raw[i]!; i++; while (i < raw.length && raw[i] !== q) i += q === '"' && raw[i] === '\\' ? 2 : 1; i++; tokens.push({ text: raw.slice(start + 1, i - 1), start, end: Math.min(i, raw.length) }); continue }
      if (raw[i] === '(' || raw[i] === ')') { tokens.push({ text: raw[i]!, start, end: ++i }); continue }
      while (i < raw.length && !/[\s()]/.test(raw[i]!) && !raw.startsWith('//', i)) i++
      tokens.push({ text: raw.slice(start, i), start, end: i })
    }
    if (!tokens.length) return
    const at = (t: { start: number; end: number }) => ({ start: lineStart + t.start, end: lineStart + t.end })
    if (block) {
      if (tokens[0]!.text === ')') { block = undefined; return }
      out.push({ keyword: block, args: tokens.map((t) => t.text), ...at({ start: tokens[0]!.start, end: tokens.at(-1)!.end }) })
    } else if (tokens.length === 2 && tokens[1]!.text === '(') { block = tokens[0]!.text; blockAt = lineStart }
    else out.push({ keyword: tokens[0]!.text, args: tokens.slice(1).map((t) => t.text), ...at({ start: tokens[0]!.start, end: tokens.at(-1)!.end }) })
  })
  if (block) throw new ParseError(`the ${block} block opened here is never closed`, blockAt)
  return out
}

let workspace = ''
let manifests: string[] = []
const results = new Map<string, { status: 'ok' | 'failed'; detail?: string }>()
let computed: { symbols: Fact[]; relationships: Fact[] } | undefined

const dirOf = (p: string) => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p))
const lineOf = (m: Manifest, offset: number) => { let lo = 0, hi = m.lines.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (m.lines[mid]! <= offset) lo = mid; else hi = mid - 1 } return lo + 1 }
const rangeOf = (m: Manifest, start: number, end: number): Range => ({ start_byte: m.at[start]!, end_byte: Math.max(m.at[end]!, m.at[start]! + 1), start_line: lineOf(m, start), end_line: lineOf(m, Math.max(end - 1, start)) })
/** A path as a manifest in `dir` writes it, as a path from the repository root; one that leaves the repository starts with `..`. */
const resolveFrom = (dir: string, p: string) => path.posix.normalize(path.posix.join(dir || '.', p.replace(/\\/g, '/'))).replace(/^\.$/, '').replace(/\/$/, '')
const outside = (p: string) => p === '..' || p.startsWith('../') || path.posix.isAbsolute(p)

/** `{a,b}` alternatives of a glob, expanded innermost first. */
const braces = (g: string): string[] => { const m = /\{([^{}]*)\}/.exec(g); return m ? m[1]!.split(',').flatMap((alt) => braces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length))) : [g] }
/** A workspaces glob as a pattern on a repository-relative directory: `*` stays within a segment, `**` crosses them (`a/**\/b` also matches `a/b`), `{x,y}` is either. */
const globRegex = (g: string) => new RegExp('^(?:' + braces(g.replace(/^\.\//, '').replace(/\/+$/, '')).map((one) => one.split(/(\*\*\/|\*\*|\*|\?)/).map((t) => (t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')).join('|') + ')$')

/** The `packages:` globs of a pnpm-workspace.yaml, read as lines: a list under the key, quotes optional, no other YAML. */
function pnpmPackages(text: string): string[] {
  const out: string[] = []
  let inList = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd()
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (/^packages\s*:\s*$/.test(line)) { inList = true; continue }
    const item = /^\s*-\s*(['"]?)(.*?)\1\s*$/.exec(line)
    if (inList && item) out.push(item[2]!)
    else if (!/^\s/.test(line)) inList = false
  }
  return out
}

function load(file: string): Manifest {
  const text = fs.readFileSync(path.join(workspace, file), 'utf8')
  const lines = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1)
  return { path: file, dir: dirOf(file), text, at: byteOffsets(text), lines }
}

function fail(file: string, e: unknown, manifest: Manifest | undefined, kind: string) {
  if (!(e instanceof ParseError)) throw e
  results.set(file, { status: 'failed', detail: `${kind}:line ${manifest ? lineOf(manifest, e.offset) : 1}: ${e.message}` })
}

function compute(): { symbols: Fact[]; relationships: Fact[] } {
  const symbols: Fact[] = [], relationships: Fact[] = []
  const projects: Project[] = []
  const npm = new Map<string, { m: Manifest; root: JNode }>()
  const tsconfigs: Array<{ m: Manifest; root: JNode }> = []
  const gos = new Map<string, { m: Manifest; directives: Directive[]; project?: Project }>()
  const works: Array<{ m: Manifest; directives: Directive[] }> = []
  const pnpm: Array<{ dir: string; patterns: string[] }> = []
  const declare = (p: Omit<Project, 'id'>) => {
    const project = { ...p, id: `project:${p.manifest.path}` }
    projects.push(project)
    symbols.push({ local_id: project.id, path: p.manifest.path, kind: 'project', name: p.name, qualified_name: p.name, range: p.range, signature: null })
    return project
  }

  for (const file of [...manifests].sort()) {
    const base = path.posix.basename(file)
    let m: Manifest | undefined
    try {
      m = load(file)
      // Fixtures and vendored copies are not part of the module graph; the file is still read, and fails if it does not parse.
      const ignored = /(^|\/)(testdata|vendor)\//.test(file)
      if (base === 'pnpm-workspace.yaml') pnpm.push({ dir: m.dir, patterns: pnpmPackages(m.text) })
      else if (base === 'go.mod' || base === 'go.work') {
        const directives = parseGoFile(m.text)
        if (ignored) { /* not a module of this repository */ }
        else if (base === 'go.work') works.push({ m, directives })
        else {
          const decl = directives.find((d) => d.keyword === 'module' && d.args[0])
          const entry: { m: Manifest; directives: Directive[]; project?: Project } = { m, directives }
          if (decl) entry.project = declare({ eco: 'go', manifest: m, dir: m.dir, name: decl.args[0]!, range: rangeOf(m, decl.start, decl.end) })
          gos.set(m.dir, entry)
        }
      } else {
        const root = parseJson(m.text)
        if (base === 'package.json') {
          const name = member(root, 'name')
          if (!ignored && name?.value.kind === 'string' && name.value.value) declare({ eco: 'npm', manifest: m, dir: m.dir, name: name.value.value, range: rangeOf(m, name.start, name.value.end) })
          if (!ignored) npm.set(m.dir, { m, root })
        } else if (!ignored) tsconfigs.push({ m, root })
      }
      results.set(file, { status: 'ok' })
    } catch (e) { fail(file, e, m, base.startsWith('go.') ? `invalid_${base.replace('.', '_')}` : 'invalid_json') }
  }

  // The nearest project at or above a directory, the files' container; both ecosystems in one directory, Go first.
  const byDir = new Map<string, Project[]>()
  for (const p of projects) byDir.set(p.dir, [...(byDir.get(p.dir) ?? []), p])
  const projectAt = (dir: string): Project | undefined => {
    for (let d = dir; ; d = dirOf(d)) { const p = byDir.get(d)?.[0]; if (p) return p; if (!d) return undefined }
  }
  const exactAt = (dir: string, eco?: Project['eco']) => byDir.get(dir)?.find((p) => !eco || p.eco === eco)

  const rel = (type: string, source: Project, site: Range, manifest: Manifest, extra: Fact): Fact => ({ type, origin: 'configuration_adapter', source: { symbol: source.id }, site: { path: manifest.path, range: site }, ...extra })
  const dependsOn = (source: Project, site: Range, manifest: Manifest, candidates: Project[], missing: Record<string, string>): Fact => {
    if (candidates.length === 1) return rel('depends_on', source, site, manifest, { resolution: 'resolved', target: { symbol: candidates[0]!.id } })
    if (candidates.length) return rel('depends_on', source, site, manifest, { resolution: 'ambiguous', candidates: candidates.map((c) => c.id) })
    return rel('depends_on', source, site, manifest, { resolution: 'unresolved', reason: 'dependency_missing', detail: missing })
  }
  const external = (source: Project, site: Range, manifest: Manifest, ecosystem: string, name: string, version: string): Fact =>
    rel('depends_on_package', source, site, manifest, { resolution: 'resolved_external', target: { external: { module: ecosystem, name } }, ...(version ? { detail: { version } } : {}) })
  const pathDependency = (source: Project, site: Range, manifest: Manifest, name: string, written: string, from: string, eco: Project['eco']) => {
    const target = resolveFrom(from, written)
    const hit = outside(target) ? undefined : exactAt(target, eco)
    return dependsOn(source, site, manifest, hit && hit !== source ? [hit] : [], { name, path: written })
  }

  // npm: a workspace member is a named package.json under a pattern of a root's `workspaces` or a pnpm-workspace.yaml's `packages`, minus its `!` patterns.
  const members = new Set<Project>()
  const lists = [...[...npm].map(([dir, { root }]) => { const ws = member(root, 'workspaces')?.value; return { dir, patterns: ws?.kind === 'array' ? strings(ws) : strings(member(ws, 'packages')?.value) } }), ...pnpm]
  for (const { dir, patterns } of lists) {
    const globs = (negated: boolean) => patterns.filter((g) => g.startsWith('!') === negated).map((g) => globRegex(path.posix.join(dir || '.', negated ? g.slice(1) : g)))
    const positive = globs(false), no = globs(true)
    for (const p of projects) if (p.eco === 'npm' && p.dir !== dir && positive.some((r) => r.test(p.dir)) && !no.some((r) => r.test(p.dir))) members.add(p)
  }
  // Without any workspace list a `workspace:` dependency can only mean a named package of the repository.
  const noList = !lists.some((l) => l.patterns.length)
  for (const p of projects.filter((x) => x.eco === 'npm')) {
    const { m, root } = npm.get(p.dir)!
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = member(root, section)?.value
      for (const dep of deps?.kind === 'object' ? deps.members! : []) {
        if (dep.value.kind !== 'string') continue
        const site = rangeOf(m, dep.start, dep.value.end), spec = dep.value.value!
        if (/^(file|link):/.test(spec)) {
          // A directory that is a project is a dependency on it; a tarball or a directory that is not one is a package, and a path outside the repository is missing.
          const written = spec.replace(/^(file|link):/, ''), target = resolveFrom(p.dir, written)
          if (!outside(target) && !exactAt(target, 'npm')) relationships.push(external(p, site, m, 'npm', dep.key, spec))
          else relationships.push(pathDependency(p, site, m, dep.key, written, p.dir, 'npm'))
          continue
        }
        const pool = noList && spec.startsWith('workspace:') ? projects.filter((x) => x.eco === 'npm') : [...members]
        const named = pool.filter((x) => x.name === dep.key)
        if (named.length || spec.startsWith('workspace:')) relationships.push(dependsOn(p, site, m, named.filter((x) => x !== p), { name: dep.key }))
        else relationships.push(external(p, site, m, 'npm', dep.key, spec))
      }
    }
  }
  // tsconfig references name the project of another directory.
  for (const { m, root } of tsconfigs) {
    const source = projectAt(m.dir)
    if (!source) continue
    const refs = member(root, 'references')?.value
    for (const ref of refs?.kind === 'array' ? refs.items! : []) {
      const written = member(ref, 'path')?.value
      if (written?.kind !== 'string') continue
      const target = resolveFrom(m.dir, written.value!.endsWith('.json') ? path.posix.dirname(written.value!) : written.value!)
      // The referenced directory's own project: one whose package.json names nothing leaves the edge unresolved, not attributed to an enclosing project.
      const hit = outside(target) ? undefined : exactAt(target)
      if (hit === source) continue
      relationships.push(dependsOn(source, rangeOf(m, ref.start, ref.end), m, hit ? [hit] : [], { path: written.value! }))
    }
  }

  // Go: a require is satisfied by a local replace, else by a module a go.work above it uses; any other is a package.
  const usedBy = (dir: string) => works.filter((w) => w.directives.some((d) => d.keyword === 'use' && d.args[0] && resolveFrom(dirOf(w.m.path), d.args[0]) === dir))
  for (const { m, directives, project } of gos.values()) {
    if (!project) continue
    const workspaces = usedBy(m.dir)
    // A local replacement is a path from the file that writes it: the module's go.mod, or a go.work above it.
    const local = new Map<string, { to: string; from: string }>()
    for (const [file, list] of [[m, directives] as const, ...workspaces.map((w) => [w.m, w.directives] as const)]) {
      for (const r of list.filter((d) => d.keyword === 'replace')) {
        const arrow = r.args.indexOf('=>'), to = r.args[arrow + 1]
        if (arrow > 0 && to && /^(\.\.?(\/|$)|\/)/.test(to) && !local.has(r.args[0]!)) local.set(r.args[0]!, { to, from: file.dir })
      }
    }
    const peers = workspaces.flatMap((w) => w.directives.filter((d) => d.keyword === 'use' && d.args[0]).map((d) => gos.get(resolveFrom(dirOf(w.m.path), d.args[0]!))?.project)).filter((p): p is Project => !!p && p !== project)
    for (const d of directives.filter((x) => x.keyword === 'require' && x.args[0])) {
      const name = d.args[0]!, site = rangeOf(m, d.start, d.end), replaced = local.get(name)
      if (replaced) { relationships.push(pathDependency(project, site, m, name, replaced.to, replaced.from, 'go')); continue }
      const named = peers.filter((p) => p.name === name)
      relationships.push(named.length ? dependsOn(project, site, m, named, { name }) : external(project, site, m, 'go', name, d.args[1] ?? ''))
    }
  }

  // Each captured file, nearest project first; the core attaches it to its module symbol, and skips a file that has none.
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(workspace, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = dir ? `${dir}/${e.name}` : e.name
      if (e.isDirectory()) { walk(rel); continue }
      const p = e.isFile() && !manifests.includes(rel) ? projectAt(dirOf(rel)) : undefined
      if (p) relationships.push({ type: 'contains', origin: 'configuration_adapter', source: { symbol: p.id }, site: { path: p.manifest.path, range: p.range }, resolution: 'resolved', target: { file: rel } })
    }
  }
  walk('')
  return { symbols, relationships }
}

const fileResult = (file: string) => {
  const r = results.get(file) ?? { status: 'ok' as const }
  return r.status === 'ok'
    ? { path: file, status: 'ok', capabilities: { text: 'complete', syntax: 'complete', symbols: 'complete' } }
    : { path: file, status: 'failed', detail: r.detail, capabilities: { text: 'complete', syntax: 'failed' } }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: req.id, result })
  try {
    if (req.method === 'initialize') {
      workspace = req.params.workspace
      manifests = req.params.files.filter((f: { language: string }) => f.language === 'build').map((f: { path: string }) => f.path)
      reply({ adapter: { id: 'build', version: VERSION, protocol_version: '1.0', languages: ['build'], toolchain: {} }, capabilities: { syntax: true, symbols: true, resolved_calls: false }, external_inputs: [] })
    } else if (req.method === 'workspace') {
      computed ??= compute()
      reply({ ...computed, file_results: manifests.map(fileResult), diagnostics: [] })
    } else if (req.method === 'analyze') {
      computed ??= compute()
      reply({ symbols: [], relationships: [], file_results: (req.params.paths as string[]).map(fileResult), diagnostics: [] })
    } else if (req.method === 'shutdown') {
      reply({})
      process.exit(0)
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: (e as Error).message } })
  }
})
