// Structural search with ast-grep's pattern syntax over the shipped Tree-sitter grammars (#37, FR1060 to FR1062): its syntax and
// its smart matching, reimplemented here, with no dependency on its code. One request on stdin, one reply on stdout, then exit.
// A pattern and a file are only parsed, never run; the parent kills this process at its deadline, and the scan stops there itself.
import { Parser, type Node } from 'web-tree-sitter'
import { byteOffsets, language } from './common.js'

/** ast-grep's language names, the grammar each is read with, and the character ast-grep puts for `$` where `$` is no identifier character. */
const LANGUAGES: Record<string, { grammar: string; expando: string }> = {
  typescript: { grammar: 'typescript', expando: '$' }, tsx: { grammar: 'tsx', expando: '$' }, javascript: { grammar: 'tsx', expando: '$' },
  python: { grammar: 'python', expando: 'µ' }, go: { grammar: 'go', expando: 'µ' }, rust: { grammar: 'rust', expando: 'µ' },
  java: { grammar: 'java', expando: '$' }, c: { grammar: 'c', expando: '𐀀' }, cpp: { grammar: 'cpp', expando: '𐀀' },
  csharp: { grammar: 'csharp', expando: 'µ' }, ruby: { grammar: 'ruby', expando: 'µ' }, kotlin: { grammar: 'kotlin', expando: 'µ' },
  scala: { grammar: 'scala', expando: '$' }, swift: { grammar: 'swift', expando: 'µ' }, bash: { grammar: 'bash', expando: '$' }, hcl: { grammar: 'hcl', expando: 'µ' },
}
const ERROR_KIND = 65535

type MetaVar = { t: 'capture'; name: string; named: boolean } | { t: 'dropped'; named: boolean } | { t: 'multi' } | { t: 'multicapture'; name: string }
type P = { k: 'var'; mv: MetaVar } | { k: 'leaf'; text: string; named: boolean; kind: number; type: string } | { k: 'node'; kind: number; type: string; children: P[] }
type Env = { single: Map<string, Node>; multi: Map<string, Node[]> }
/** Smart strictness only ever skips a candidate node, never a pattern node, so these are the outcomes of one comparison. */
type One = 'both' | 'skip_cand' | 'no'

const validFirst = (c: string | undefined) => !!c && /^[A-Z_]$/.test(c)
const validAll = (s: string) => /^[A-Z_0-9]*$/.test(s)
/** `$A`, `$$A` (also unnamed nodes), `$_` (no capture), `$$$A` and `$$$` (any number of nodes), as ast-grep reads them. */
function metaVar(src: string, meta: string): MetaVar | null {
  const ellipsis = meta.repeat(3)
  if (src === ellipsis) return { t: 'multi' }
  if (src.startsWith(ellipsis)) {
    const rest = src.slice(ellipsis.length)
    if (!validFirst(rest[0]) || !validAll(rest)) return null
    return rest.startsWith('_') ? { t: 'multi' } : { t: 'multicapture', name: rest }
  }
  if (!src.startsWith(meta)) return null
  let rest = src.slice(meta.length), named = true
  if (rest.startsWith(meta)) { rest = rest.slice(meta.length); named = false }
  if (!validFirst(rest[0]) || !validAll(rest)) return null
  return rest.startsWith('_') ? { t: 'dropped', named } : { t: 'capture', name: rest, named }
}

/** ast-grep's pre-processing: `$` before a capital, `_` or as `$$$` becomes the expando character where `$` is no identifier character. */
function preProcess(query: string, expando: string): string {
  if (expando === '$') return query
  let out = '', dollars = 0
  for (const c of query) {
    if (c === '$') { dollars++; continue }
    out += (/[A-Z_]/.test(c) || dollars === 3 ? expando : '$').repeat(dollars) + c
    dollars = 0
  }
  return out + (dollars === 3 ? expando : '$').repeat(dollars)
}

function convert(n: Node, meta: string): P {
  const mv = metaVar(n.text, meta)
  if (mv) return { k: 'var', mv }
  if (n.childCount === 0) return { k: 'leaf', text: n.text, named: n.isNamed, kind: n.typeId, type: n.type }
  return { k: 'node', kind: n.typeId, type: n.type, children: n.children.filter((c) => !c.isMissing).map((c) => convert(c, meta)) }
}

/** The pattern as ast-grep's `--debug-query=pattern` prints it. */
export function dump(p: P, depth = 0): string {
  const pad = '  '.repeat(depth)
  if (p.k === 'var') {
    const m = p.mv
    return `${pad}MetaVar ${m.t === 'capture' ? `$${m.name}` : m.t === 'multicapture' ? `$$$${m.name}` : m.t === 'multi' ? '$$$' : '$_'}\n`
  }
  if (p.k === 'leaf') return `${pad}${p.named ? `${p.type} ${p.text}` : p.text}\n`
  return `${pad}${p.type}\n${p.children.map((c) => dump(c, depth + 1)).join('')}`
}

/** A kind with no name, such as Go's statement terminator; web-tree-sitter's `type` reads it as ERROR, so it is told by its id. */
const nameless = (n: Node) => n.typeId !== ERROR_KIND && n.tree.language.types[n.typeId] === ''
/** One child at the root, or two where the second is missing or nameless (Go's `$A = 0`): the pattern is that child. */
const single = (n: Node) => n.childCount === 1 || (n.childCount === 2 && (n.child(1)!.isMissing || nameless(n.child(1)!)))

export type Compiled = { pattern: P; texts: string[] } | { error: string; tree: string }
export async function compile(source: string, lang: string): Promise<Compiled> {
  const spec = LANGUAGES[lang]
  if (!spec) return { error: `no grammar for ${lang}`, tree: '' }
  const parser = new Parser()
  parser.setLanguage(await language(spec.grammar))
  const tree = parser.parse(preProcess(source, spec.expando))!
  try {
    const root = tree.rootNode
    if (root.childCount === 0) return { error: `No AST root is detected. Please check the pattern source \`${source}\`.`, tree: '' }
    let node = root
    while (single(node)) node = node.child(0)!
    const pattern = convert(node, spec.expando)
    // Only an error the parser placed refuses the pattern: a root that reports one it never placed parses as ast-grep reads it.
    const errors = parseErrors(root)
    if (errors.length) return { error: `the pattern does not parse as ${lang}: ${errors.join('; ')}`, tree: dump(pattern) }
    if (!single(root)) return { error: `Multiple AST nodes are detected. Please check the pattern source \`${source}\`.`, tree: dump(pattern) }
    if (pattern.k === 'var' && (pattern.mv.t === 'multi' || pattern.mv.t === 'multicapture')) return { error: `Standalone multi meta variable \`${source}\` is invalid. Use \`$VAR\` or wrap \`$$$VAR\` in a larger pattern.`, tree: dump(pattern) }
    return { pattern, texts: [...new Set(fixedTexts(pattern))] }
  } finally { tree.delete(); parser.delete() }
}

function parseErrors(root: Node): string[] {
  const out: string[] = []
  const at = (n: Node) => `${n.startPosition.row + 1}:${n.startPosition.column + 1}`
  const walk = (n: Node) => {
    if (out.length >= 5) return
    if (n.isMissing) out.push(`missing ${JSON.stringify(n.type)} at ${at(n)}`)
    else if (n.isError) out.push(`syntax error at ${at(n)} in ${JSON.stringify(n.text.slice(0, 60))}`)
    else for (const c of n.children) walk(c)
  }
  walk(root)
  return out
}

/** Text every match holds: a named leaf matches only its own text, and a keyword only itself, so a file without one cannot match. */
function fixedTexts(p: P): string[] {
  if (p.k === 'leaf') return p.named || (p.type === p.text && /^[A-Za-z_]\w*$/.test(p.text)) ? [p.text] : []
  return p.k === 'node' ? p.children.flatMap(fixedTexts) : []
}

// ---------- matching: ast-grep's smart strictness ----------
const kindMatches = (goal: number, cand: number) => goal === cand || goal === ERROR_KIND

/** Two nodes match exactly when they are one node, have the same text where either is a leaf, or the same kind and children. */
function exact(g: Node, c: Node): boolean {
  if (g.id === c.id) return true
  if (g.namedChildCount === 0 || c.namedChildCount === 0) return g.text === c.text
  if (g.typeId !== c.typeId || g.childCount !== c.childCount) return false
  const gc = g.children, cc = c.children
  return gc.every((x, i) => exact(x, cc[i]!))
}
function bind(env: Env, name: string, n: Node): boolean {
  const had = env.single.get(name)
  if (had && !exact(had, n)) return false
  env.single.set(name, n)
  return true
}
function bindMulti(env: Env, name: string, nodes: Node[]): boolean {
  const had = env.multi.get(name)
  if (had) {
    const a = had.filter((n) => n.isNamed), b = nodes.filter((n) => n.isNamed)
    if (a.length !== b.length || !a.every((n, i) => exact(n, b[i]!))) return false
  }
  env.multi.set(name, nodes)
  return true
}
function leafVar(mv: MetaVar, c: Node, env: Env): boolean {
  if (mv.t === 'capture') return !(mv.named && !c.isNamed) && bind(env, mv.name, c)
  if (mv.t === 'dropped') return !(mv.named && !c.isNamed)
  if (mv.t === 'multicapture') return bindMulti(env, mv.name, [c])
  return true
}
function ellipsis(env: Env, name: string | null, nodes: Node[], skippedAnonymous: number): boolean {
  return name === null || bindMulti(env, name, nodes.slice(0, Math.max(0, nodes.length - skippedAnonymous)))
}
const ellipsisName = (p: P): string | null | undefined => (p.k !== 'var' ? undefined : p.mv.t === 'multi' ? null : p.mv.t === 'multicapture' ? p.mv.name : undefined)

function matchOne(goal: P, c: Node, env: Env): One {
  if (goal.k === 'leaf') {
    if (kindMatches(goal.kind, c.typeId) && (!goal.named || goal.text === c.text)) return 'both'
    return c.isExtra || !c.isNamed ? 'skip_cand' : 'no'
  }
  if (goal.k === 'var') return c.isExtra ? 'skip_cand' : leafVar(goal.mv, c, env) ? 'both' : 'no'
  if (!kindMatches(goal.kind, c.typeId)) return 'no'
  return matchList(goal.children, c.children, env) ? 'both' : 'no'
}

type Cur = { g: number; c: number }
/** ast-grep's match of a pattern's children against a node's: ellipses take nodes until the next pattern child matches, never backtracking. */
function matchList(goals: P[], cands: Node[], env: Env): boolean {
  const s: Cur = { g: 0, c: 0 }
  if (!cands.length) return false
  for (;;) {
    const e = mayEllipsis(goals, cands, s, env)
    if (e === null) return false
    if (e === 'return') return true
    if (e === 'continue') continue
    const m = singleSkippingTrivia(goals, cands, s, env)
    if (m === null) return false
    if (s.g < goals.length) { s.g++; s.c++ }
    // Smart strictness skips whatever the node holds after the last pattern child.
    if (s.g >= goals.length) return true
    if (s.c >= cands.length) return false
  }
}
function mayEllipsis(goals: P[], cands: Node[], s: Cur, env: Env): 'return' | 'continue' | 'fall' | null {
  if (s.g >= goals.length) return 'return'
  const name = ellipsisName(goals[s.g]!)
  if (name === undefined) return 'fall'
  const matched: Node[] = []
  s.g++
  if (s.g >= goals.length) { const ok = ellipsis(env, name, [...matched, ...cands.slice(s.c)], 0); s.c = cands.length; return ok ? 'return' : null }
  let skipped = 0
  while (goals[s.g]!.k === 'leaf' && !(goals[s.g] as { named: boolean }).named) {
    s.g++; skipped++
    if (s.g >= goals.length) { const ok = ellipsis(env, name, [...matched, ...cands.slice(s.c)], skipped); s.c = cands.length; return ok ? 'return' : null }
  }
  if (ellipsisName(goals[s.g]!) !== undefined) {
    matched.push(cands[s.c++]!)
    if (s.c >= cands.length) return null
    return ellipsis(env, name, matched, skipped) ? 'continue' : null
  }
  for (;;) {
    // A probe on a copy of the bindings, so a failed probe binds nothing.
    const probe: Env = { single: new Map(env.single), multi: new Map(env.multi) }
    if (matchOne(goals[s.g]!, cands[s.c]!, probe) === 'both') return ellipsis(env, name, matched, skipped) ? 'fall' : null
    matched.push(cands[s.c++]!)
    if (s.c >= cands.length) return null
  }
}
function singleSkippingTrivia(goals: P[], cands: Node[], s: Cur, env: Env): 'fall' | null {
  for (;;) {
    if (s.c >= cands.length) {
      // Out of nodes: a match only if every pattern child left is an ellipsis.
      while (s.g < goals.length && ellipsisName(goals[s.g]!) !== undefined) s.g++
      return s.g >= goals.length ? 'fall' : null
    }
    const r = matchOne(goals[s.g]!, cands[s.c]!, env)
    if (r === 'both') return 'fall'
    if (r === 'no') return null
    s.c++
  }
}

/** Whether the pattern matches this node, the node being the whole match. A pattern that is one metavariable takes the node itself. */
export function matches(p: P, n: Node): boolean {
  const env: Env = { single: new Map(), multi: new Map() }
  if (p.k === 'var') return leafVar(p.mv, n, env)
  return matchOne(p, n, env) === 'both'
}

// ---------- the request ----------
/**
 * `symbols` are the file's symbols as [start byte, end byte, in scope (1 or 0)], innermost first: a match's symbol is the first that
 * holds it whole, and when `scoped`, a match counts only if that symbol is in scope.
 */
export type Request = { pattern: string; files: Array<{ text: string; language: string; symbols: Array<[number, number, number]>; scoped: boolean }>; skip: number; take: number; deadline: number; strict: boolean }
export type Match = { file: number; start_byte: number; end_byte: number; start_line: number; end_line: number; text: string; symbol: number | null }
export type Reply = { error: string; tree: string; language: string } | { matches: Match[]; total: number; files_searched: number; stopped: 'timeout' | null; failed_languages: Record<string, string> }

export async function search(req: Request): Promise<Reply> {
  await Parser.init()
  const compiled = new Map<string, Compiled>()
  const failed: Record<string, string> = {}
  const out: Match[] = []
  let total = 0, searched = 0, stopped: 'timeout' | null = null, visited = 0
  const late = () => Date.now() > req.deadline
  const parsers = new Map<string, Parser>()
  for (const [i, f] of req.files.entries()) {
    if (late()) { stopped = 'timeout'; break }
    let c = compiled.get(f.language)
    if (!c) { c = await compile(req.pattern, f.language); compiled.set(f.language, c) }
    if ('error' in c) {
      if (req.strict) return { error: c.error, tree: c.tree, language: f.language }
      failed[f.language] = c.error
      continue
    }
    searched++
    if (!c.texts.every((t) => f.text.includes(t))) continue
    let parser = parsers.get(f.language)
    if (!parser) { parser = new Parser(); parser.setLanguage(await language(LANGUAGES[f.language]!.grammar)); parsers.set(f.language, parser) }
    // Parsing stops at the deadline too: a huge or hostile file costs no more than the time asked for.
    const tree = parser.parse(f.text, null, { progressCallback: late as unknown as () => void })
    if (!tree) { stopped = 'timeout'; break }
    try {
      const p = c.pattern
      const kind = p.k === 'var' ? null : p.kind
      let at: Uint32Array | null = null
      const cursor = tree.walk()
      for (;;) {
        if ((++visited & 1023) === 0 && late()) { stopped = 'timeout'; break }
        if (kind === null || cursor.nodeTypeId === kind) {
          const n = cursor.currentNode
          if (matches(p, n)) {
            at ??= byteOffsets(f.text)
            const start = at[n.startIndex]!, end = at[n.endIndex]!
            const symbol = f.symbols.findIndex(([s, e]) => s <= start && end <= e)
            if (!f.scoped || f.symbols[symbol]?.[2]) {
              if (total >= req.skip && out.length < req.take) out.push({ file: i, start_byte: start, end_byte: end, start_line: n.startPosition.row + 1, end_line: n.endPosition.row + 1, text: n.text.split('\n')[0]!.trimEnd().slice(0, 120), symbol: symbol < 0 ? null : symbol })
              total++
            }
          }
        }
        if (cursor.gotoFirstChild()) continue
        while (!cursor.gotoNextSibling()) if (!cursor.gotoParent()) break
        if (cursor.currentDepth === 0) break
      }
      cursor.delete()
    } finally { tree.delete() }
    if (stopped) break
  }
  for (const p of parsers.values()) p.delete()
  if (req.files.length && !searched && Object.keys(failed).length) {
    const [lang, error] = Object.entries(failed)[0]!
    return { error, tree: (compiled.get(lang) as { tree: string }).tree, language: lang }
  }
  return { matches: out, total, files_searched: searched, stopped, failed_languages: failed }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  process.stdout.write(JSON.stringify(await search(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request)))
}
