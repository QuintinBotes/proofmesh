// Pure readers of JVM build files for the build adapter (FR151 to FR160): a Maven pom.xml as a small bounded XML tree, and Gradle
// settings, build scripts and version catalogs as text. Nothing here runs, evaluates or resolves anything outside the text it is given.
export class ParseError extends Error { constructor(message: string, readonly offset: number) { super(message) } }

// ---- XML ----

/** An element with where it sits; `text` is its own character data, entities decoded (the five predefined ones and numeric references only). */
export type XNode = { name: string; start: number; end: number; text: string; children: XNode[] }
const MAX_DEPTH = 200
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m)))

/** The root element of an XML document. A DOCTYPE is skipped and never expanded, so no entity can grow the text. */
export function parseXml(text: string): XNode {
  const stack: XNode[] = []
  let root: XNode | undefined, i = 0
  const skipTo = (marker: string, what: string) => { const e = text.indexOf(marker, i); if (e < 0) throw new ParseError(`unterminated ${what}`, i); i = e + marker.length }
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    const chunk = text.slice(i, lt < 0 ? text.length : lt)
    if (stack.length) stack.at(-1)!.text += decode(chunk)
    else if (chunk.trim()) throw new ParseError('text outside the root element', i)
    if (lt < 0) break
    i = lt
    if (text.startsWith('<!--', i)) { i += 4; skipTo('-->', 'comment') }
    else if (text.startsWith('<![CDATA[', i)) { const from = i + 9; i = from; skipTo(']]>', 'CDATA section'); if (stack.length) stack.at(-1)!.text += text.slice(from, i - 3) }
    else if (text.startsWith('<?', i)) skipTo('?>', 'processing instruction')
    else if (text.startsWith('<!', i)) { let depth = 0; for (i += 2; i < text.length && !(text[i] === '>' && !depth); i++) { if (text[i] === '[') depth++; else if (text[i] === ']') depth-- } if (i >= text.length) throw new ParseError('unterminated declaration', lt); i++ }
    else if (text.startsWith('</', i)) {
      const m = /^<\/([^\s>]+)\s*>/.exec(text.slice(i, i + 300))
      if (!m) throw new ParseError('malformed closing tag', i)
      const open = stack.pop()
      if (!open) throw new ParseError(`unexpected </${m[1]}>`, i)
      if (open.name !== m[1]) throw new ParseError(`expected </${open.name}>, found </${m[1]}>`, i)
      i += m[0].length
      open.end = i
    } else {
      const m = /^<([^\s/>!?]+)/.exec(text.slice(i, i + 300))
      if (!m) throw new ParseError('malformed tag', i)
      const node: XNode = { name: m[1]!, start: i, end: 0, text: '', children: [] }
      i += m[0].length
      for (;;) {
        while (i < text.length && text[i] !== '>' && text[i] !== '"' && text[i] !== "'" && !(text[i] === '/' && text[i + 1] === '>')) i++
        if (i >= text.length) throw new ParseError(`unterminated <${node.name}>`, node.start)
        if (text[i] === '"' || text[i] === "'") { const e = text.indexOf(text[i]!, i + 1); if (e < 0) throw new ParseError('unterminated attribute value', i); i = e + 1; continue }
        break
      }
      const parent = stack.at(-1)
      if (parent) parent.children.push(node)
      else if (root) throw new ParseError('a second root element', node.start)
      else root = node
      if (text[i] === '/') { i += 2; node.end = i }
      else { i++; stack.push(node); if (stack.length > MAX_DEPTH) throw new ParseError(`elements nested deeper than ${MAX_DEPTH}`, node.start) }
    }
  }
  if (stack.length) throw new ParseError(`<${stack.at(-1)!.name}> is never closed`, stack.at(-1)!.start)
  if (!root) throw new ParseError('no root element', 0)
  return root
}

const child = (n: XNode | undefined, name: string) => n?.children.find((c) => c.name === name)
const textOf = (n: XNode | undefined) => (n ? n.text.trim() || undefined : undefined)

type At = { start: number; end: number }
export type Pom = {
  groupId?: string; artifactId?: string; version?: string; artifact?: XNode
  parent?: { groupId?: string; artifactId?: string; version?: string; relativePath?: string }
  properties: Record<string, string>
  modules: Array<{ value: string } & At>
  dependencies: Array<{ groupId?: string; artifactId?: string; version?: string } & At>
  managed: Record<string, string>
}

/** What a pom declares, as written: `${...}` is left for the caller to resolve against the parent chain. */
export function readPom(root: XNode): Pom {
  if (root.name !== 'project') throw new ParseError(`the root element is <${root.name}>, not <project>`, root.start)
  const parent = child(root, 'parent')
  const dep = (d: XNode) => ({ groupId: textOf(child(d, 'groupId')), artifactId: textOf(child(d, 'artifactId')), version: textOf(child(d, 'version')), start: d.start, end: d.end })
  const managed: Record<string, string> = {}
  for (const d of child(child(root, 'dependencyManagement'), 'dependencies')?.children ?? []) { const x = dep(d); if (x.groupId && x.artifactId && x.version) managed[`${x.groupId}:${x.artifactId}`] = x.version }
  return {
    groupId: textOf(child(root, 'groupId')), artifactId: textOf(child(root, 'artifactId')), version: textOf(child(root, 'version')), artifact: child(root, 'artifactId'),
    parent: parent && { groupId: textOf(child(parent, 'groupId')), artifactId: textOf(child(parent, 'artifactId')), version: textOf(child(parent, 'version')), relativePath: child(parent, 'relativePath') ? (textOf(child(parent, 'relativePath')) ?? '') : undefined },
    properties: Object.fromEntries((child(root, 'properties')?.children ?? []).map((p) => [p.name, p.text.trim()])),
    modules: (child(root, 'modules')?.children ?? []).filter((m) => m.name === 'module' && m.text.trim()).map((m) => ({ value: m.text.trim(), start: m.start, end: m.end })),
    dependencies: (child(root, 'dependencies')?.children ?? []).filter((d) => d.name === 'dependency').map(dep),
    managed,
  }
}

// ---- Gradle ----

/**
 * The script with every comment blanked (`code`) and also every string's content blanked (`skeleton`), both the same length as the
 * text so offsets agree. A string that is not closed on its line ends there, as a quote typed in a comment-free script rarely spans lines.
 */
export function maskScript(text: string): { code: string; skeleton: string } {
  const code = text.split(''), skeleton = text.split('')
  const blankAt = (a: number, b: number, both: boolean) => { for (let k = a; k < b; k++) if (text[k] !== '\n') { if (both) code[k] = ' '; skeleton[k] = ' ' } }
  for (let i = 0; i < text.length;) {
    if (text.startsWith('//', i)) { let e = text.indexOf('\n', i); if (e < 0) e = text.length; blankAt(i, e, true); i = e }
    else if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); if (e < 0) throw new ParseError('unterminated comment', i); blankAt(i, e + 2, true); i = e + 2 }
    else if (text[i] === '"' || text[i] === "'") {
      const q = text.startsWith(text[i]!.repeat(3), i) ? text[i]!.repeat(3) : text[i]!
      let j = i + q.length
      for (; j < text.length; j++) { if (text[j] === '\\' && q.length === 1) { j++; continue } if (text.startsWith(q, j)) break; if (text[j] === '\n' && q.length === 1) break }
      blankAt(i + q.length, Math.min(j, text.length), false)
      i = Math.min(j + (text.startsWith(q, j) ? q.length : 0), text.length)
    } else i++
  }
  return { code: code.join(''), skeleton: skeleton.join('') }
}

/** The body ranges of every `name ... {` block in the skeleton, braces matched. */
function bodies(skeleton: string, name: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const re = new RegExp(`(?:^|[\\s;{}])${name.source}[^{\\n]*\\{`, 'g')
  for (let m = re.exec(skeleton); m; m = re.exec(skeleton)) {
    let depth = 1, j = m.index + m[0].length
    for (; j < skeleton.length && depth; j++) { if (skeleton[j] === '{') depth++; else if (skeleton[j] === '}') depth-- }
    out.push([m.index + m[0].length, j])
  }
  return out
}

const quoted = (code: string, skeleton: string, from: number, to: number) => {
  const out: Array<{ value: string; start: number; end: number }> = []
  for (let i = from; i < to; i++) {
    const q = code[i]
    if ((q === '"' || q === "'") && skeleton[i] === q) { const e = skeleton.indexOf(q, i + 1); out.push({ value: code.slice(i + 1, e), start: i, end: e + 1 }); i = e }
  }
  return out
}
/** From `from` to the end of the statement: the balanced parentheses it opens, else the line, carried over a trailing comma. */
function statementEnd(skeleton: string, from: number): number {
  let i = from
  while (skeleton[i] === ' ' || skeleton[i] === '\t') i++
  if (skeleton[i] === '(') { let depth = 0; for (; i < skeleton.length; i++) { if (skeleton[i] === '(') depth++; else if (skeleton[i] === ')' && !--depth) return i + 1 } return skeleton.length }
  for (;;) { let e = skeleton.indexOf('\n', i); if (e < 0) return skeleton.length; if (!/[,(]\s*$/.test(skeleton.slice(i, e))) return e; i = e + 1 }
}

export type GradleInclude = { path: string } & At
/** `include` of a settings script: ":a", "a" and "a:b" are project paths. Anything else the script does to the build is a note. */
export function readSettings(text: string): { includes: GradleInclude[]; notes: string[] } {
  const { code, skeleton } = maskScript(text)
  const includes: GradleInclude[] = [], notes: string[] = []
  const re = /(?:^|[\s;{}])include(Flat|Build)?\b[ \t]*/g
  for (let m = re.exec(skeleton); m; m = re.exec(skeleton)) {
    const from = m.index + m[0].length, end = statementEnd(skeleton, from)
    if (m[1]) { notes.push(`include${m[1]}`); continue }
    const lits = quoted(code, skeleton, from, end)
    // Anything between the literals other than punctuation (a variable, a spread, a call) is not read.
    let rest = skeleton.slice(from, end)
    for (const l of lits) rest = rest.slice(0, l.start - from) + ' '.repeat(l.end - l.start) + rest.slice(l.end - from)
    if (/[A-Za-z_*]/.test(rest)) notes.push('include with a computed argument')
    for (const l of lits) includes.push({ path: l.value.startsWith(':') ? l.value : `:${l.value}`, start: l.start, end: l.end })
  }
  if (/\bprojectDir\b/.test(skeleton)) notes.push('projectDir assignment')
  if (/\bapply\s*\(?\s*from\b/.test(skeleton)) notes.push('apply from')
  return { includes, notes }
}

const CONFIGURATIONS = ['implementation', 'api', 'compileOnly', 'compileOnlyApi', 'runtimeOnly', 'testImplementation', 'testCompileOnly', 'testRuntimeOnly', 'annotationProcessor', 'testAnnotationProcessor', 'kapt', 'ksp', 'compile', 'runtime', 'testCompile', 'testRuntime', 'developmentOnly', 'debugImplementation', 'releaseImplementation', 'androidTestImplementation']
export type GradleDep =
  | ({ kind: 'coordinate'; configuration: string; group: string; name: string; version?: string } & At)
  | ({ kind: 'project'; configuration: string; path: string } & At)
  | ({ kind: 'catalog'; configuration: string; alias: string } & At)
  | ({ kind: 'dynamic'; configuration: string; source: string } & At)

/** The declarative dependency statements inside `dependencies { }` blocks, and what in the script could not be read. */
export function readBuildScript(text: string): { deps: GradleDep[]; notes: string[] } {
  const { code, skeleton } = maskScript(text)
  const deps: GradleDep[] = [], notes: string[] = []
  const shared = bodies(skeleton, /(?:allprojects|subprojects)/)
  const inside = (n: number, ranges: Array<[number, number]>) => ranges.some(([a, b]) => n >= a && n < b)
  if (shared.length) notes.push('allprojects or subprojects block')
  if (/\bapply\s*\(?\s*from\b/.test(skeleton)) notes.push('apply from')
  const blocks = bodies(skeleton, /dependencies/).filter(([a]) => !inside(a, shared))
  const re = new RegExp(`(?:^|[\\n;{])[ \\t]*(${CONFIGURATIONS.join('|')})\\b[ \\t]*`, 'g')
  for (let m = re.exec(skeleton); m; m = re.exec(skeleton)) {
    const at = m.index + m[0].indexOf(m[1]!)
    if (!inside(at, blocks) || inside(at, shared)) continue
    const from = m.index + m[0].length, end = statementEnd(skeleton, from), conf = m[1]!
    const args = code.slice(from, end), here = { start: at, end }
    let hit: RegExpExecArray | null
    if ((hit = /^\(?\s*(?:(?:enforced)?[pP]latform\(\s*)?(["'])([^"'$]+)\1/.exec(args)) && hit[2]!.split(':').length >= 2 && !/\s/.test(hit[2]!)) {
      const [group, name, version] = hit[2]!.split(':')
      deps.push({ kind: 'coordinate', configuration: conf, group: group!, name: name!, ...(version ? { version } : {}), ...here })
    } else if ((hit = /^\(?\s*group\s*[:=]\s*(["'])([^"'$]+)\1\s*,\s*name\s*[:=]\s*(["'])([^"'$]+)\3(?:\s*,\s*version\s*[:=]\s*(["'])([^"'$]+)\5)?/.exec(args))) {
      deps.push({ kind: 'coordinate', configuration: conf, group: hit[2]!, name: hit[4]!, ...(hit[6] ? { version: hit[6] } : {}), ...here })
    } else if ((hit = /^\(?\s*project\(\s*(?:path\s*[:=]\s*)?(["'])([^"'$]+)\1/.exec(args))) {
      deps.push({ kind: 'project', configuration: conf, path: hit[2]!.startsWith(':') ? hit[2]! : `:${hit[2]}`, ...here })
    } else if ((hit = /^\(?\s*(?:(?:enforced)?[pP]latform\(\s*)?libs\.([\w.-]+)/.exec(args))) {
      deps.push({ kind: 'catalog', configuration: conf, alias: hit[1]!, ...here })
    } else deps.push({ kind: 'dynamic', configuration: conf, source: `${conf} ${args.trim()}`.replace(/\s+/g, ' ').slice(0, 120), ...here })
  }
  return { deps, notes }
}

export type Library = { group: string; name: string; version?: string }
export type Catalog = { libraries: Map<string, Library>; bundles: Map<string, string[]> }
const normalise = (alias: string) => alias.replace(/[-_]/g, '.')

/** gradle/libs.versions.toml, one entry per line: `alias = "g:a:v"` and the inline-table forms. An entry over several lines is left out, so its alias reads as dynamic. */
export function readCatalog(text: string): Catalog {
  const versions = new Map<string, string>(), libraries = new Map<string, Library>(), bundles = new Map<string, string[]>()
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s+|\s+$/g, '')
    const head = /^\[([\w.-]+)\]$/.exec(line)
    if (head) { section = head[1]!; continue }
    const kv = /^([\w.-]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line)
    if (!kv || line.startsWith('#')) continue
    const [, key, value] = kv as unknown as [string, string, string]
    if (section === 'versions') { const v = /^"([^"]*)"$/.exec(value); if (v) versions.set(key, v[1]!) }
    else if (section === 'bundles') { const list = /^\[(.*)\]$/.exec(value); if (list) bundles.set(normalise(key), [...list[1]!.matchAll(/"([^"]+)"/g)].map((x) => normalise(x[1]!))) }
    else if (section === 'libraries') {
      const short = /^"([^":]+):([^":]+)(?::([^":]+))?"$/.exec(value)
      if (short) { libraries.set(normalise(key), { group: short[1]!, name: short[2]!, ...(short[3] ? { version: short[3] } : {}) }); continue }
      if (!value.startsWith('{')) continue
      const field = (k: string) => new RegExp(`(?:^|[{,\\s])${k}\\s*=\\s*"([^"]*)"`).exec(value)?.[1]
      const mod = field('module')?.split(':'), group = mod?.[0] ?? field('group'), name = mod?.[1] ?? field('name')
      const ref = /version\.ref\s*=\s*"([^"]*)"/.exec(value)?.[1] ?? /version\s*=\s*\{\s*ref\s*=\s*"([^"]*)"/.exec(value)?.[1]
      const version = ref ? versions.get(ref) : field('version')
      if (group && name) libraries.set(normalise(key), { group, name, ...(version ? { version } : {}) })
    }
  }
  return { libraries, bundles }
}
/** The libraries a `libs.<alias>` names: one, the members of a bundle, or none when the catalog does not say. */
export function catalogLookup(catalog: Catalog | undefined, alias: string): Library[] | undefined {
  if (!catalog) return undefined
  const key = normalise(alias)
  if (key.startsWith('bundles.')) { const members = catalog.bundles.get(key.slice(8))?.map((k) => catalog.libraries.get(k)); return members?.every(Boolean) ? (members as Library[]) : undefined }
  const lib = catalog.libraries.get(key)
  return lib ? [lib] : undefined
}
