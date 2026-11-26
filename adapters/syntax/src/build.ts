// The build adapter (FR124 to FR129, FR151 to FR160, FR240 to FR249): the module graph of JavaScript, Go, Rust, Python, PHP, Ruby, Maven, Gradle, Bazel and Buck, read from manifests as captured text and never by running
// a build tool, package manager or script (FR079). A package.json that names a package and a go.mod are `project` symbols; each file
// is contained by the project of its nearest enclosing manifest; a project depends_on the projects in the repository that its
// manifests name (package.json dependencies, tsconfig references, go.mod requires satisfied by go.work or a local replace) and
// depends_on_package the packages outside it. Facts span files, so all of them are answered by `workspace`, never cached.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { byteOffsets, send, type Range } from './common.js'
import { parseStarlark, type SNode, type StarlarkFile } from './starlark.js'
import { parseToml, type JNode } from './toml.js'
import { ParseError, catalogLookup, parseXml, readBuildScript, readCatalog, readPom, readSettings, type Catalog, type GradleDep, type Pom, type XNode } from './jvm.js'

const VERSION = '0.1.0'
type Ref = { symbol: string } | { file: string } | { external: { module: string; name: string } }
type Fact = Record<string, unknown>
type Manifest = { path: string; dir: string; text: string; at: Uint32Array; lines: number[] }
type Eco = 'npm' | 'go' | 'maven' | 'gradle' | 'cargo' | 'python' | 'composer' | 'gem' | 'bazel' | 'buck'
type Project = { id: string; eco: Eco; manifest: Manifest; dir: string; name: string; range: Range }

/** `strict` is plain JSON (composer.json): no comments and no trailing comma; otherwise JSONC, as a tsconfig is. */
function parseJson(text: string, strict = false): JNode {
  let i = 0
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++
      if (strict) return
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
        if (text[i] === ',') { i++; if (strict) { skip(); if (text[i] === close) throw new ParseError('trailing comma', i - 1) } continue }
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

/** Bazel and Buck rules that run an action or only name files, so a target of one is no build unit and no project. */
const NOT_UNITS = /(^|_)genrule$|^(filegroup|alias|config_setting|test_suite|package_group|exports_files|platform|toolchain|constraint_setting|constraint_value|export_file|remote_file)$/

/** One `add_dependency` of a gemspec; `name` is absent when the first argument is not a string literal. */
type GemDep = { start: number; end: number; name?: string; version: string; versionExpression?: string; dev: boolean; source: string }

/** A name loaded from a `.bzl` file of this repository is a macro this adapter does not expand; one loaded from another repository is taken for the rule it names. */
const isMacro = (file: StarlarkFile, name: string) => { const from = file.loaded.get(name); return from !== undefined && !/^@[^/]/.test(from) }

const RUBY_STRING = /^(['"])((?:(?!\1)[^\\])*)\1$/
/** A gemspec is Ruby, so only its declarative lines are read, as patterns: `s.name = "x"` and `s.add_dependency "y", "~> 1"`. Any other form is named, not guessed. */
function readGemspec(text: string): { name?: { value: string; start: number; end: number }; deps: GemDep[] } {
  const out: { name?: { value: string; start: number; end: number }; deps: GemDep[] } = { deps: [] }
  let offset = 0, block = false
  for (const raw of text.split('\n')) {
    const lineStart = offset
    offset += raw.length + 1
    // `=begin` and `=end` at the start of a line fence a block comment.
    if (block) { if (/^=end(\s|$)/.test(raw)) block = false; continue }
    if (/^=begin(\s|$)/.test(raw)) { block = true; continue }
    // A comment runs to the end of the line unless the `#` is inside a string; `quoted` marks the characters inside one.
    let quote = '', cut = raw.length
    const quoted: boolean[] = []
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]!
      quoted[i] = !!quote
      if (quote) { if (c === '\\') quoted[++i] = true; else if (c === quote) quote = '' } else if (c === '"' || c === "'") quote = c; else if (c === '#') { cut = i; break }
    }
    const line = raw.slice(0, cut).trimEnd()
    const literal = (arg: string) => { const m = RUBY_STRING.exec(arg.trim()); return m && !(m[1] === '"' && m[2]!.includes('#{')) ? m[2]! : undefined }
    const nameMatch = /^(\s*)\w+\.name\s*=\s*(.+)$/.exec(line)
    if (nameMatch && !out.name) {
      const value = literal(nameMatch[2]!)
      if (value) out.name = { value, start: lineStart + nameMatch[1]!.length, end: lineStart + line.length }
      continue
    }
    // The call may be anywhere on the line (in a block or a loop), but not inside a string.
    const dep = /\b\w+\.add_(runtime_|development_)?dependency\b\s*\(?\s*(.*?)\)?\s*(?:\}|\bend\b)?\s*$/.exec(line)
    if (!dep || quoted[dep.index]) continue
    const argText = dep[2]!
    // Arguments split on commas outside strings.
    const args: string[] = []
    let current = '', q = ''
    for (let i = 0; i < argText.length; i++) {
      const c = argText[i]!
      if (q) { current += c; if (c === '\\') current += argText[++i] ?? ''; else if (c === q) q = '' } else if (c === '"' || c === "'") { q = c; current += c } else if (c === ',') { args.push(current); current = '' } else current += c
    }
    args.push(current)
    const rest = args.slice(1).map((a) => a.trim()).filter(Boolean)
    const versions = rest.map(literal)
    const start = lineStart + dep.index, end = lineStart + line.length
    out.deps.push({ start, end, name: literal(args[0] ?? ''), version: versions.every((v) => v !== undefined) ? versions.join(', ') : '', ...(versions.some((v) => v === undefined) ? { versionExpression: rest.join(', ') } : {}), dev: dep[1] === 'development_', source: line.trim() })
  }
  return out
}

let workspace = '', repositoryRoot = ''
let manifests: string[] = []
const results = new Map<string, { status: 'ok' | 'failed'; detail?: string; partial?: boolean }>()
let computed: { symbols: Fact[]; relationships: Fact[] } | undefined
/** Why a file reports partial, in the workspace response. */
const diagnostics: Array<{ level: 'warning'; message: string; path: string }> = []

const MAX_EXPANDED = 4096, MAX_SUBSTITUTIONS = 256
const dirOf = (p: string) => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p))
const lineOf = (m: Manifest, offset: number) => { let lo = 0, hi = m.lines.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (m.lines[mid]! <= offset) lo = mid; else hi = mid - 1 } return lo + 1 }
const rangeOf = (m: Manifest, start: number, end: number): Range => ({ start_byte: m.at[start]!, end_byte: Math.max(m.at[end]!, m.at[start]! + 1), start_line: lineOf(m, start), end_line: lineOf(m, Math.max(end - 1, start)) })
/** A path as a manifest in `dir` writes it, as a path from the repository root; one that leaves the repository starts with `..`. */
const resolveFrom = (dir: string, p: string) => path.posix.normalize(path.posix.join(dir || '.', p.replace(/\\/g, '/'))).replace(/^\.$/, '').replace(/\/$/, '')
/** An absolute path is not relative to a manifest: inside the repository it names that directory, outside it names nothing here. */
const absoluteTarget = (written: string) => {
  const w = written.replace(/\\/g, '/')
  if (!path.posix.isAbsolute(w)) return undefined
  const real = (p: string) => { try { return fs.realpathSync(p).replace(/\\/g, '/') } catch { return p.replace(/\\/g, '/') } }
  const roots = [...new Set([repositoryRoot, workspace].filter(Boolean).flatMap((r) => [r.replace(/\\/g, '/'), real(r)]))].map((r) => r.replace(/\/$/, ''))
  const n = path.posix.normalize(w)
  for (const t of [n, real(n)]) for (const r of roots) if (t === r || t.startsWith(`${r}/`)) return t.slice(r.length + 1)
  return n
}
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
  const poms = new Map<string, { m: Manifest; pom: Pom; project?: Project }>()
  const settings: Array<{ m: Manifest; notes: string[]; projects: Map<string, Project> }> = []
  const gradleBuilds: Array<{ m: Manifest; deps: GradleDep[]; notes: string[] }> = []
  const catalogs = new Map<string, Catalog>()
  const cargos = new Map<string, { m: Manifest; root: JNode; project?: Project }>()
  const pys: Array<{ m: Manifest; root: JNode; project?: Project }> = []
  const composers: Array<{ m: Manifest; root: JNode; project: Project }> = []
  const gems: Array<{ m: Manifest; project: Project; deps: GemDep[] }> = []
  const builds: Array<{ m: Manifest; file: StarlarkFile; eco: 'bazel' | 'buck'; targets: Array<{ project: Project; call: Extract<SNode, { kind: 'call' }> }>; others: Array<{ label: string; call: Extract<SNode, { kind: 'call' }> }> }> = []
  const partial = (file: string, reason: string) => { results.set(file, { ...results.get(file)!, partial: true }); if (!diagnostics.some((d) => d.path === file && d.message === reason)) diagnostics.push({ level: 'warning', message: reason, path: file }) }
  const declare = (p: Omit<Project, 'id'>, idSuffix = '') => {
    const project = { ...p, id: `project:${p.manifest.path}${idSuffix}` }
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
      } else if (base === 'pom.xml') {
        const root = parseXml(m.text), pom = readPom(root)
        const entry: { m: Manifest; pom: Pom; project?: Project } = { m, pom }
        poms.set(file, entry)
        // The group and version a pom does not state are its parent's, as Maven reads them.
        const g = pom.groupId ?? pom.parent?.groupId
        if (!ignored && g && pom.artifactId && pom.artifact) entry.project = declare({ eco: 'maven', manifest: m, dir: m.dir, name: `${g}:${pom.artifactId}`, range: rangeOf(m, pom.artifact.start, pom.artifact.end) })
      } else if (base === 'settings.gradle' || base === 'settings.gradle.kts') {
        const { includes, notes } = readSettings(m.text)
        const entry = { m, notes, projects: new Map<string, Project>() }
        settings.push(entry)
        if (!ignored) for (const inc of includes) if (!entry.projects.has(inc.path)) entry.projects.set(inc.path, declare({ eco: 'gradle', manifest: m, dir: resolveFrom(m.dir, inc.path.slice(1).replace(/:/g, '/')), name: inc.path, range: rangeOf(m, inc.start, inc.end) }, `#${inc.path}`))
      } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
        const { deps, notes } = readBuildScript(m.text)
        if (!ignored) gradleBuilds.push({ m, deps, notes })
      } else if (base === 'libs.versions.toml') {
        if (!ignored && path.posix.basename(m.dir) === 'gradle') catalogs.set(dirOf(m.dir), readCatalog(m.text))
      } else if (base === 'Cargo.toml') {
        const root = parseToml(m.text), name = member(member(root, 'package')?.value, 'name')
        const entry: { m: Manifest; root: JNode; project?: Project } = { m, root }
        if (!ignored) {
          if (name?.value.kind === 'string' && name.value.value) entry.project = declare({ eco: 'cargo', manifest: m, dir: m.dir, name: name.value.value, range: rangeOf(m, name.start, name.value.end) })
          cargos.set(m.dir, entry)
        }
      } else if (base === 'pyproject.toml') {
        const root = parseToml(m.text)
        const name = member(member(root, 'project')?.value, 'name') ?? member(member(member(root, 'tool')?.value, 'poetry')?.value, 'name')
        const entry: { m: Manifest; root: JNode; project?: Project } = { m, root }
        if (!ignored) {
          if (name?.value.kind === 'string' && name.value.value) entry.project = declare({ eco: 'python', manifest: m, dir: m.dir, name: name.value.value, range: rangeOf(m, name.start, name.value.end) })
          pys.push(entry)
        }
      } else if (base.endsWith('.gemspec')) {
        const { name, deps } = readGemspec(m.text)
        if (!ignored && name) gems.push({ m, deps, project: declare({ eco: 'gem', manifest: m, dir: m.dir, name: name.value, range: rangeOf(m, name.start, name.end) }) })
      } else if (base === 'BUILD' || base === 'BUILD.bazel' || base === 'BUCK') {
        const file = parseStarlark(m.text), eco = base === 'BUCK' ? 'buck' as const : 'bazel' as const
        const entry: (typeof builds)[number] = { m, file, eco, targets: [], others: [] }
        for (const call of file.calls) {
          const name = call.args.find((a) => a.name === 'name')?.value
          if (name?.kind !== 'string' || isMacro(file, call.name)) continue
          const label = `//${m.dir}:${name.value}`
          // A rule that only runs an action, or names files, is not a build unit: it is read, never run, and is not a project.
          if (NOT_UNITS.test(call.name)) entry.others.push({ label, call })
          else if (!ignored) entry.targets.push({ project: declare({ eco, manifest: m, dir: m.dir, name: label, range: rangeOf(m, name.start, name.end) }, `#${name.value}${entry.targets.some((t) => t.project.name === label) ? `@${name.start}` : ''}`), call })
        }
        if (!ignored) builds.push(entry)
      } else {
        const root = parseJson(m.text, base === 'composer.json')
        if (base === 'composer.json') {
          const name = member(root, 'name')
          if (!ignored && name?.value.kind === 'string' && name.value.value) composers.push({ m, root, project: declare({ eco: 'composer', manifest: m, dir: m.dir, name: name.value.value, range: rangeOf(m, name.start, name.value.end) }) })
        } else if (base === 'package.json') {
          const name = member(root, 'name')
          if (!ignored && name?.value.kind === 'string' && name.value.value) declare({ eco: 'npm', manifest: m, dir: m.dir, name: name.value.value, range: rangeOf(m, name.start, name.value.end) })
          if (!ignored) npm.set(m.dir, { m, root })
        } else if (!ignored) tsconfigs.push({ m, root })
      }
      results.set(file, { status: 'ok' })
    } catch (e) { fail(file, e, m, base.startsWith('go.') ? `invalid_${base.replace('.', '_')}` : base === 'pom.xml' ? 'invalid_xml' : base === 'Cargo.toml' || base === 'pyproject.toml' ? 'invalid_toml' : /^(BUILD|BUILD\.bazel|BUCK)$/.test(base) ? 'invalid_starlark' : /gradle|toml/.test(base) ? 'invalid_gradle' : 'invalid_json') }
  }

  // Every captured file, in a fixed order.
  const files: string[] = []
  const manifestSet = new Set(manifests)
  const list = (dir: string) => {
    for (const e of fs.readdirSync(path.join(workspace, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = dir ? `${dir}/${e.name}` : e.name
      if (e.isDirectory()) list(rel)
      else if (e.isFile()) files.push(rel)
    }
  }
  list('')

  // The nearest project at or above a directory, the files' container; both ecosystems in one directory, Go first.
  const byDir = new Map<string, Project[]>()
  // A Bazel or Buck target owns the files it names, not its whole directory, so it is no container by directory.
  for (const p of projects) if (p.eco !== 'bazel' && p.eco !== 'buck') byDir.set(p.dir, [...(byDir.get(p.dir) ?? []), p])
  const projectAt = (dir: string): Project | undefined => {
    for (let d = dir; ; d = dirOf(d)) { const p = byDir.get(d)?.[0]; if (p) return p; if (!d) return undefined }
  }
  const exactAt = (dir: string, eco?: Eco) => byDir.get(dir)?.find((p) => !eco || p.eco === eco)

  const rel = (type: string, source: Project, site: Range, manifest: Manifest, extra: Fact): Fact => ({ type, origin: 'configuration_adapter', source: { symbol: source.id }, site: { path: manifest.path, range: site }, ...extra })
  /** `extra` is detail every outcome carries: a Gradle fact says it was read from a script by pattern. */
  const dependsOn = (source: Project, site: Range, manifest: Manifest, candidates: Project[], missing: Record<string, string>, extra: Record<string, string> = {}): Fact => {
    const more = Object.keys(extra).length ? { detail: extra } : {}
    if (candidates.length === 1) return rel('depends_on', source, site, manifest, { resolution: 'resolved', target: { symbol: candidates[0]!.id }, ...more })
    if (candidates.length) return rel('depends_on', source, site, manifest, { resolution: 'ambiguous', candidates: candidates.map((c) => c.id), ...more })
    return rel('depends_on', source, site, manifest, { resolution: 'unresolved', reason: 'dependency_missing', detail: { ...missing, ...extra } })
  }
  const external = (source: Project, site: Range, manifest: Manifest, ecosystem: string, name: string, version: string, extra: Record<string, string> = {}): Fact => {
    const detail = { ...(version ? { version } : {}), ...extra }
    return rel('depends_on_package', source, site, manifest, { resolution: 'resolved_external', target: { external: { module: ecosystem, name } }, ...(Object.keys(detail).length ? { detail } : {}) })
  }
  /** A dependency no static read can name: kept as an unresolved row at its line, never dropped and never guessed, and its file reports partial. */
  const dynamic = (source: Project, site: Range, manifest: Manifest, detail: Record<string, string>): Fact => {
    partial(manifest.path, `a dependency of ${source.name} cannot be read statically (${Object.values(detail).join(' ')})`)
    return rel('depends_on_package', source, site, manifest, { resolution: 'unresolved', reason: 'dynamic_specifier', detail })
  }
  const pathDependency = (source: Project, site: Range, manifest: Manifest, name: string, written: string, from: string, eco: Eco, extra: Record<string, string> = {}) => {
    const target = absoluteTarget(written) ?? resolveFrom(from, written)
    const hit = outside(target) ? undefined : exactAt(target, eco)
    return dependsOn(source, site, manifest, hit && hit !== source ? [hit] : [], { name, path: written }, extra)
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

  // Maven: a module a pom lists must have a pom; a dependency is a project of the repository by groupId:artifactId, else a package.
  const pomAt = (dir: string) => poms.get(dir ? `${dir}/pom.xml` : 'pom.xml')
  /** The pom a pom names as parent: its relativePath (default ../pom.xml) when that pom is in the repository. */
  const parentOf = (e: { m: Manifest; pom: Pom }) => {
    const rp = e.pom.parent?.relativePath
    if (!e.pom.parent || rp === '') return undefined
    const target = resolveFrom(e.m.dir, rp ?? '../pom.xml')
    return outside(target) ? undefined : poms.get(target.endsWith('.xml') ? target : target ? `${target}/pom.xml` : 'pom.xml')
  }
  /** `${...}` resolved against the pom's own properties, then its parents', and the project.* names; a cycle or an unknown name is left as written. */
  const interpolate = (e: { m: Manifest; pom: Pom }, s: string): string => {
    const lookup = (key: string): string | undefined => {
      const own = e.pom
      const project: Record<string, string | undefined> = { 'project.groupId': own.groupId ?? own.parent?.groupId, 'project.artifactId': own.artifactId, 'project.version': own.version ?? own.parent?.version, 'project.parent.groupId': own.parent?.groupId, 'project.parent.version': own.parent?.version }
      project['pom.groupId'] = project['project.groupId']; project['pom.version'] = project['project.version']; project['pom.artifactId'] = project['project.artifactId']
      if (Object.hasOwn(project, key)) return project[key]
      for (let p: typeof e | undefined = e, n = 0; p && n < 20; p = parentOf(p), n++) if (Object.hasOwn(p.pom.properties, key)) return p.pom.properties[key]
      return undefined
    }
    // Each name expands through the names it holds, so a cycle, or a chain that fans out past the caps, leaves the value as written and the file partial.
    let substitutions = 0
    const expand = (text: string, via: string[]): string => text.replace(/\$\{([^}]+)\}/g, (whole, key: string) => {
      const value = lookup(key)
      if (value === undefined) return whole
      if (via.includes(key) || ++substitutions > MAX_SUBSTITUTIONS) throw new Error('cap')
      const out = expand(value, [...via, key])
      if (out.length > MAX_EXPANDED) throw new Error('cap')
      return out
    })
    try { return expand(s, []) } catch (err) {
      if ((err as Error).message !== 'cap') throw err
      partial(e.m.path, `a \${...} expression cycles or expands past ${MAX_EXPANDED} characters, so it is left as written`)
      return s
    }
  }
  const managedVersion = (e: { m: Manifest; pom: Pom }, key: string): string | undefined => {
    for (let p: typeof e | undefined = e, n = 0; p && n < 20; p = parentOf(p), n++) if (p.pom.managed[key]) return interpolate(p, p.pom.managed[key]!)
    return undefined
  }
  /** A dependency only test sources, or only the run time, can use says so: `detail.scope` is `test` or `runtime`; the compile scope says nothing. */
  const scopeOf = (scope?: string): Record<string, string> => { const s = scope?.trim(); const k = !s ? '' : /^test|Test/.test(s) ? 'test' : /^runtime/i.test(s) ? 'runtime' : ''; return k ? { scope: k } : {} }
  const mavenProjects = projects.filter((x) => x.eco === 'maven')
  for (const e of poms.values()) {
    const source = e.project
    if (!source) continue
    for (const mod of e.pom.modules) {
      const written = mod.value.replace(/\\/g, '/'), target = resolveFrom(e.m.dir, written)
      const found = outside(target) ? undefined : poms.get(target.endsWith('.xml') ? target : target ? `${target}/pom.xml` : 'pom.xml')
      // A listed module with a pom is declared by that pom; one without is missing.
      if (!found?.project) relationships.push(dependsOn(source, rangeOf(e.m, mod.start, mod.end), e.m, [], { module: written }))
    }
    for (const d of e.pom.dependencies) {
      const site = rangeOf(e.m, d.start, d.end)
      const group = d.groupId && interpolate(e, d.groupId), artifact = d.artifactId && interpolate(e, d.artifactId)
      if (!group || !artifact || group.includes('${') || artifact.includes('${')) { relationships.push(dynamic(source, site, e.m, { ...(d.artifactId ? { artifactId: d.artifactId } : {}), ...(d.groupId ? { groupId: d.groupId } : {}) })); continue }
      const name = `${group}:${artifact}`
      const named = mavenProjects.filter((x) => x.name === name && x !== source)
      if (named.length) { relationships.push(dependsOn(source, site, e.m, named, { name }, scopeOf(d.scope))); continue }
      const raw = d.version ?? managedVersion(e, name), version = raw && interpolate(e, raw)
      relationships.push(external(source, site, e.m, 'maven', name, version && !version.includes('${') ? version : '', version?.includes('${') ? { version_expression: version } : {}))
    }
  }

  // Gradle: a build script belongs to the project of its directory in the nearest settings script that includes one there. Only declarative
  // statements are read, each marked inferred, and anything else is named dynamic; a script is never evaluated (FR079).
  const INFERRED = { inferred: 'gradle_script_pattern' }
  for (const s of settings) for (const n of new Set(s.notes)) partial(s.m.path, `settings not read: ${n}`)
  for (const { m, deps, notes } of gradleBuilds) {
    const owner = settings.filter((s) => [...s.projects.values()].some((p) => p.dir === m.dir)).sort((a, b) => b.m.dir.length - a.m.dir.length)[0]
    const source = owner && [...owner.projects.values()].find((p) => p.dir === m.dir)
    if (!owner || !source) { partial(m.path, 'no settings script includes a project in this directory, so its dependencies are not read'); continue }
    for (const n of new Set(notes)) partial(m.path, `build script not read: ${n}`)
    const catalog = catalogs.get(owner.m.dir)
    const coordinate = (group: string, name: string, version: string | undefined, site: Range) => relationships.push(external(source, site, m, 'maven', `${group}:${name}`, version ?? '', INFERRED))
    for (const dep of deps) {
      const site = rangeOf(m, dep.start, dep.end)
      if (dep.kind === 'coordinate') coordinate(dep.group, dep.name, dep.version, site)
      else if (dep.kind === 'project') relationships.push(dependsOn(source, site, m, [owner.projects.get(dep.path)].filter((p): p is Project => !!p && p !== source), { path: dep.path }, { ...INFERRED, ...scopeOf(dep.configuration) }))
      else if (dep.kind === 'catalog') {
        const libs = catalogLookup(catalog, dep.alias)
        if (libs) for (const l of libs) coordinate(l.group, l.name, l.version, site)
        else relationships.push(dynamic(source, site, m, { configuration: dep.configuration, source: `libs.${dep.alias}`, ...INFERRED }))
      } else relationships.push(dynamic(source, site, m, { configuration: dep.configuration, source: dep.source.slice(dep.configuration.length).trim(), ...INFERRED }))
    }
  }

  const strOf = (n: JNode | undefined) => (n?.kind === 'string' ? n.value : undefined)
  const isTrue = (m: Manifest, n: JNode | undefined) => n?.kind === 'other' && m.text.slice(n.start, n.end) === 'true'

  // Cargo: a crate is a package.json-like named manifest; a `path` dependency is a project of the repository, any other a crate. A `workspace = true`
  // dependency takes its spec from `[workspace.dependencies]` of the nearest workspace root that lists the crate in `members` and not in `exclude`.
  const cargoRoots = [...cargos.values()].filter((e) => member(e.root, 'workspace'))
  const wsGlobs = (e: { m: Manifest; root: JNode }, key: string) => strings(member(member(e.root, 'workspace')?.value, key)?.value).map((g) => globRegex(path.posix.join(e.m.dir || '.', g)))
  const cargoWorkspace = (e: { m: Manifest }) => cargoRoots.filter((r) => r.m.dir === e.m.dir || (wsGlobs(r, 'members').some((re) => re.test(e.m.dir)) && !wsGlobs(r, 'exclude').some((re) => re.test(e.m.dir)))).sort((a, b) => b.m.dir.length - a.m.dir.length)[0]
  const CARGO_SECTIONS: Array<[string, Record<string, string>]> = [['dependencies', {}], ['dev-dependencies', { scope: 'test' }], ['build-dependencies', { scope: 'build' }]]
  for (const p of projects.filter((x) => x.eco === 'cargo')) {
    const e = cargos.get(p.dir)!, ws = cargoWorkspace(e)
    const tables: Array<{ table: JNode; scope: Record<string, string> }> = []
    const target = member(e.root, 'target')?.value
    for (const holder of [e.root, ...(target?.kind === 'object' ? target.members!.map((t) => t.value) : [])]) for (const [key, scope] of CARGO_SECTIONS) { const t = member(holder, key)?.value; if (t?.kind === 'object') tables.push({ table: t, scope }) }
    for (const { table, scope } of tables) for (const dep of table.members!) {
      const site = rangeOf(e.m, dep.start, dep.value.end)
      let spec = dep.value, base = e.m.dir
      if (spec.kind === 'object' && isTrue(e.m, member(spec, 'workspace')?.value)) {
        const inherited = ws && member(member(member(ws.root, 'workspace')?.value, 'dependencies')?.value, dep.key)
        if (!ws || !inherited) { relationships.push(dependsOn(p, site, e.m, [], { name: dep.key }, scope)); continue }
        spec = inherited.value; base = ws.m.dir
      }
      const written = strOf(member(spec, 'path')?.value), real = strOf(member(spec, 'package')?.value) ?? dep.key
      if (written !== undefined) relationships.push(pathDependency(p, site, e.m, real, written, base, 'cargo', scope))
      else relationships.push(external(p, site, e.m, 'cargo', real, spec.kind === 'string' ? spec.value! : strOf(member(spec, 'version')?.value) ?? '', scope))
    }
  }

  // Python: PEP 621 `[project]`, Poetry `[tool.poetry]` and uv `[tool.uv]`. A uv `workspace = true` source names a member of the workspace and a `path` source a
  // directory; every other dependency is a PyPI package. A `dynamic` dependency list is named, not read.
  const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, '-')
  const uv = (e: { root: JNode }) => member(member(e.root, 'tool')?.value, 'uv')?.value
  const uvRoots = pys.filter((e) => member(uv(e), 'workspace'))
  const uvWorkspace = (e: { m: Manifest }) => uvRoots.filter((r) => r.m.dir === e.m.dir || (strings(member(member(uv(r), 'workspace')?.value, 'members')?.value).some((g) => globRegex(path.posix.join(r.m.dir || '.', g)).test(e.m.dir)) && !strings(member(member(uv(r), 'workspace')?.value, 'exclude')?.value).some((g) => globRegex(path.posix.join(r.m.dir || '.', g)).test(e.m.dir)))).sort((a, b) => b.m.dir.length - a.m.dir.length)[0]
  for (const e of pys) {
    const p = e.project
    if (!p) continue
    const root = uvWorkspace(e)
    // Without any workspace table a `workspace = true` source can only mean a named project of the repository.
    const pool = root ? pys.filter((x) => x.project && uvWorkspace(x) === root).map((x) => x.project!) : uvRoots.length ? [] : pys.flatMap((x) => (x.project ? [x.project] : []))
    const sources = (name: string) => [e, root].flatMap((x) => { const s = x && member(uv(x), 'sources')?.value; const hit = s?.kind === 'object' ? s.members!.find((k) => norm(k.key) === norm(name)) : undefined; return hit ? [{ spec: hit.value, owner: x! }] : [] })[0]
    const depend = (name: string, version: string, site: Range) => {
      const src = sources(name)
      if (isTrue(src?.owner.m ?? e.m, member(src?.spec, 'workspace')?.value)) return dependsOn(p, site, e.m, pool.filter((x) => norm(x.name) === norm(name) && x !== p), { name })
      const written = strOf(member(src?.spec, 'path')?.value)
      if (written !== undefined) return pathDependency(p, site, e.m, name, written, src!.owner.m.dir, 'python')
      return external(p, site, e.m, 'pypi', name, version)
    }
    const requirements = (list: JNode | undefined) => {
      for (const item of list?.kind === 'array' ? list.items! : []) {
        if (item.kind !== 'string') continue
        const site = rangeOf(e.m, item.start, item.end), req = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*([^;]*?)\s*(?:;.*)?$/.exec(item.value!)
        relationships.push(req ? depend(req[1]!, req[2]!, site) : dynamic(p, site, e.m, { requirement: item.value! }))
      }
    }
    const project = member(e.root, 'project')?.value
    requirements(member(project, 'dependencies')?.value)
    for (const g of [member(project, 'optional-dependencies')?.value, member(e.root, 'dependency-groups')?.value]) for (const x of g?.kind === 'object' ? g.members! : []) requirements(x.value)
    requirements(member(uv(e), 'dev-dependencies')?.value)
    const dyn = member(project, 'dynamic')?.value
    for (const item of dyn?.kind === 'array' ? dyn.items! : []) if (item.kind === 'string' && /^(dependencies|optional-dependencies)$/.test(item.value!)) relationships.push(dynamic(p, rangeOf(e.m, item.start, item.end), e.m, { field: item.value! }))
    const poetry = member(member(e.root, 'tool')?.value, 'poetry')?.value
    const groups = member(poetry, 'group')?.value
    for (const table of [member(poetry, 'dependencies')?.value, member(poetry, 'dev-dependencies')?.value, ...(groups?.kind === 'object' ? groups.members!.map((g) => member(g.value, 'dependencies')?.value) : [])]) {
      for (const dep of table?.kind === 'object' ? table.members! : []) {
        if (dep.key === 'python') continue
        const site = rangeOf(e.m, dep.start, dep.value.end), v = dep.value
        const written = strOf(member(v, 'path')?.value)
        if (written !== undefined) relationships.push(pathDependency(p, site, e.m, dep.key, written, e.m.dir, 'python'))
        else relationships.push(external(p, site, e.m, 'pypi', dep.key, v.kind === 'string' ? v.value! : strOf(member(v, 'version')?.value) ?? ''))
      }
    }
  }

  // Composer: `require` and `require-dev` name packages; one a `path` repository of the manifest brings from a project of the repository is a depends_on. The
  // `autoload` psr-4 and psr-0 maps are recorded as reads_config rows whose detail names the prefix and the directory, for resolution to read.
  const PLATFORM = /^(php|hhvm|php-64bit|php-ipv6|php-zts|php-debug|ext-.+|lib-.+|composer|composer-plugin-api|composer-runtime-api)$/
  for (const { m, root, project } of composers) {
    const repos = member(root, 'repositories')?.value
    const local = (repos?.kind === 'array' ? repos.items! : repos?.kind === 'object' ? repos.members!.map((x) => x.value) : []).flatMap((r) => (strOf(member(r, 'type')?.value) === 'path' && strOf(member(r, 'url')?.value) !== undefined ? [globRegex(resolveFrom(m.dir, strOf(member(r, 'url')?.value)!))] : []))
    for (const section of ['require', 'require-dev']) {
      const deps = member(root, section)?.value
      for (const dep of deps?.kind === 'object' ? deps.members! : []) {
        if (dep.value.kind !== 'string' || PLATFORM.test(dep.key)) continue
        const site = rangeOf(m, dep.start, dep.value.end)
        const named = composers.filter((c) => c.project.name === dep.key && c.project !== project && local.some((re) => re.test(c.project.dir)))
        relationships.push(named.length ? dependsOn(project, site, m, named.map((c) => c.project), { name: dep.key }) : external(project, site, m, 'composer', dep.key, dep.value.value!))
      }
    }
    for (const key of ['autoload', 'autoload-dev']) for (const kind of ['psr-4', 'psr-0']) {
      const map = member(member(root, key)?.value, kind)?.value
      for (const entry of map?.kind === 'object' ? map.members! : []) {
        const dirs = entry.value.kind === 'array' ? entry.value.items! : [entry.value]
        for (const d of dirs) {
          if (d.kind !== 'string') continue
          const dir = resolveFrom(m.dir, d.value!), written = dir ? `${dir}/` : ''
          relationships.push(rel('reads_config', project, rangeOf(m, entry.start, d.end), m, { resolution: 'resolved_external', target: { external: { module: 'composer-autoload', name: `${kind}:${entry.key}=>${written}` } }, detail: { autoload: kind, prefix: entry.key, path: written, ...(key === 'autoload-dev' ? { dev: 'true' } : {}) } }))
        }
      }
    }
  }

  // Ruby: a gemspec is code, so its `name` and `add_dependency` lines are read as patterns and every fact says so; any other form is named dynamic.
  const GEM = { inferred: 'gemspec_pattern' }
  for (const { m, project, deps } of gems) {
    for (const d of deps) {
      const site = rangeOf(m, d.start, d.end)
      if (!d.name) { relationships.push(dynamic(project, site, m, { source: d.source, ...GEM })); continue }
      const scope: Record<string, string> = d.dev ? { scope: 'development' } : {}
      const named = gems.filter((g) => g.project.name === d.name && g.project !== project)
      if (named.length) relationships.push(dependsOn(project, site, m, named.map((g) => g.project), { name: d.name }, { ...GEM, ...scope }))
      else relationships.push(external(project, site, m, 'gem', d.name, d.version, { ...GEM, ...scope, ...(d.versionExpression ? { version_expression: d.versionExpression } : {}) }))
    }
  }

  // Bazel and Buck: a target is a rule call with a literal name, labelled by its package (the directory of its build file) and its name. `deps` are read
  // with every `select()` branch, `srcs`, `hdrs` and `exported_headers` with `glob` expanded against the captured files. A macro, a loop, a condition or a
  // value computed from a name is not expanded: it is named, and the build file reports partial.
  const buildDirs = new Set(files.filter((f) => /^(BUILD|BUILD\.bazel|BUCK)$/.test(path.posix.basename(f))).map(dirOf))
  const targetsBy = new Map<string, Project[]>()
  for (const b of builds) for (const t of b.targets) targetsBy.set(b.eco + t.project.name, [...(targetsBy.get(b.eco + t.project.name) ?? []), t.project])
  const notUnits = new Set(builds.flatMap((b) => b.others.map((o) => b.eco + o.label)))
  const leaves = (n: SNode, condition?: string): Array<{ node: SNode; condition?: string }> => {
    if (n.kind === 'list') return n.items.flatMap((i) => leaves(i, condition))
    if (n.kind === 'concat') return n.parts.flatMap((i) => leaves(i, condition))
    const table = n.kind === 'call' && n.name === 'select' ? n.args[0]?.value : undefined
    if (table?.kind === 'dict') return table.entries.flatMap((e) => leaves(e.value, e.key.kind === 'string' ? e.key.value : 'dynamic'))
    return [{ node: n, ...(condition !== undefined ? { condition } : {}) }]
  }
  /** The label a dependency names, as `//package:name`, or the whole label when it is another repository's. */
  const labelOf = (raw: string, pkg: string, eco: 'bazel' | 'buck'): string | undefined => {
    let r = raw
    if (eco === 'buck') { const cell = /^([\w.-]*)(\/\/.*)$/.exec(r); if (cell) { if (cell[1] && cell[1] !== 'root') return undefined; r = cell[2]! } }
    else if (r.startsWith('@//')) r = r.slice(1)
    else if (r.startsWith('@')) return undefined
    if (r.startsWith(':')) return `//${pkg}:${r.slice(1)}`
    if (r.startsWith('//')) { const [p, n] = r.slice(2).split(':'); return `//${p}:${n ?? path.posix.basename(p!)}` }
    return `//${pkg}:${r}`
  }
  const globFiles = (call: Extract<SNode, { kind: 'call' }>, pkg: string): string[] | undefined => {
    const arg = (n: string, i: number) => call.args.find((a) => a.name === n)?.value ?? (n === 'include' || n === 'exclude' ? call.args.filter((a) => !a.name)[i]?.value : undefined)
    const lists = (n: SNode | undefined) => (n ? leaves(n) : [])
    const include = lists(arg('include', 0)), exclude = lists(arg('exclude', 1))
    if ([...include, ...exclude].some((l) => l.node.kind !== 'string')) return undefined
    const re = (l: Array<{ node: SNode }>) => l.map((x) => globRegex(path.posix.join(pkg || '.', (x.node as { value: string }).value)))
    const inc = re(include), exc = re(exclude)
    return files.filter((f) => {
      if (pkg && !f.startsWith(`${pkg}/`)) return false
      // A directory with its own build file is another package, and a glob stops at it.
      for (let d = dirOf(f); d !== pkg && d; d = dirOf(d)) if (buildDirs.has(d)) return false
      return inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f))
    })
  }
  const fileSet = new Set(files)
  for (const b of builds) {
    const { m, file, eco } = b
    if (file.compound.length) partial(m.path, 'a for, if or def statement is not read, so the targets it creates are not declared')
    for (const call of file.calls) {
      if (isMacro(file, call.name)) partial(m.path, `${call.name} is a macro loaded from a .bzl file and is not expanded, so the targets it creates are not declared`)
      else if (call.args.some((a) => a.name === 'name' && a.value.kind !== 'string')) partial(m.path, `a ${call.name} call with a name that is not a literal declares no target`)
    }
    for (const { project, call } of b.targets) {
      const arg = (n: string) => call.args.find((a) => a.name === n)?.value
      for (const key of ['deps', 'exported_deps']) {
        const node = arg(key)
        for (const leaf of node ? leaves(node) : []) {
          const site = rangeOf(m, leaf.node.start, leaf.node.end), extra: Record<string, string> = leaf.condition !== undefined ? { condition: leaf.condition } : {}
          if (leaf.node.kind !== 'string') { relationships.push(dynamic(project, site, m, { field: key, ...extra })); continue }
          const raw = leaf.node.value, label = labelOf(raw, m.dir, eco)
          if (!label) { relationships.push(external(project, site, m, eco, raw, '', extra)); continue }
          const found = targetsBy.get(eco + label) ?? []
          if (notUnits.has(eco + label) || (found.length === 1 && found[0] === project)) continue
          relationships.push(dependsOn(project, site, m, found.filter((x) => x !== project), { label: raw }, extra))
        }
      }
      const owned = new Set<string>()
      for (const key of ['srcs', 'hdrs', 'exported_headers']) {
        const node = arg(key)
        for (const leaf of node ? leaves(node) : []) {
          const n = leaf.node
          if (n.kind === 'string') {
            const raw = n.value, rest = raw.startsWith('//') ? raw.slice(2).replace(':', '/') : raw.startsWith(':') ? raw.slice(1) : raw
            const f = raw.startsWith('//') ? rest : path.posix.join(m.dir || '.', rest).replace(/^\.\//, '')
            if (fileSet.has(f) && !manifestSet.has(f)) owned.add(f)
          } else if (n.kind === 'call' && n.name === 'glob') {
            const hit = globFiles(n, m.dir)
            if (hit) for (const f of hit) owned.add(f)
            else partial(m.path, `a glob of ${project.name} has a pattern that is not a literal, so its files are not read`)
          } else partial(m.path, `${key} of ${project.name} is not a literal list, so its files are not read`)
        }
      }
      for (const f of [...owned].sort()) relationships.push({ type: 'contains', origin: 'configuration_adapter', source: { symbol: project.id }, site: { path: m.path, range: project.range }, resolution: 'resolved', target: { file: f } })
    }
  }

  // Each captured file, nearest project first; the core attaches it to its module symbol, and skips a file that has none.
  for (const rel of files) {
    const p = manifestSet.has(rel) ? undefined : projectAt(dirOf(rel))
    if (p) relationships.push({ type: 'contains', origin: 'configuration_adapter', source: { symbol: p.id }, site: { path: p.manifest.path, range: p.range }, resolution: 'resolved', target: { file: rel } })
  }
  return { symbols, relationships }
}

const fileResult = (file: string) => {
  const r = results.get(file) ?? { status: 'ok' as const }
  return r.status === 'ok'
    ? { path: file, status: 'ok', capabilities: { text: 'complete', syntax: 'complete', symbols: r.partial ? 'partial' : 'complete' } }
    : { path: file, status: 'failed', detail: r.detail, capabilities: { text: 'complete', syntax: 'failed' } }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: req.id, result })
  try {
    if (req.method === 'initialize') {
      workspace = req.params.workspace
      repositoryRoot = req.params.repository_root ?? ''
      manifests = req.params.files.filter((f: { language: string }) => f.language === 'build').map((f: { path: string }) => f.path)
      reply({ adapter: { id: 'build', version: VERSION, protocol_version: '1.0', languages: ['build'], toolchain: {} }, capabilities: { syntax: true, symbols: true, resolved_calls: false }, external_inputs: [] })
    } else if (req.method === 'workspace') {
      computed ??= compute()
      reply({ ...computed, file_results: manifests.map(fileResult), diagnostics })
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
