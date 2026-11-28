/**
 * query_graph (FR960 to FR965): a bounded, read-only subset of openCypher over one sealed snapshot, for questions the typed tools do
 * not answer in one call. The text is parsed into a typed plan and run by a small interpreter over fixed prepared statements: no SQL is
 * ever built from the query, its parameters or its names. Writes, procedures and file access have no syntax here and are refused by
 * name before anything runs; each variable-length pattern needs an upper bound, and those bounds together may not pass the query's
 * max_depth (FR2400); rows, time and bytes are the server's.
 */
import type Database from 'better-sqlite3'
import { ProofmeshError } from '../core/errors.js'
import { basisOf, inferredSql } from './basis.js'
import { leanName, leanRow, quote } from './lean.js'
import { isTestCode, isTestPath, parseRoles, rolesSql } from './tests.js'
import { hasSites } from '../meshstore/order.js'

/** Node labels: the symbol kinds of the snapshot format, plus file and external. A file whose module symbol exists is also a module. */
export const LABELS = ['function', 'class', 'method', 'interface', 'type_alias', 'variable', 'module', 'struct', 'enum', 'property', 'field', 'constructor', 'namespace', 'project', 'package', 'endpoint', 'table', 'message', 'channel', 'job', 'feature_flag', 'config_key', 'team', 'service', 'resource', 'output', 'module_call', 'file', 'external']
/** Relationship types: the assertion types of the snapshot format (a test holds both lists to it). */
export const REL_TYPES = ['calls', 'imports', 'contains', 'inherits', 'implements', 'overrides', 'references', 'injects', 'registered_as', 'exposes', 'maps_to', 'runs', 'dispatches_to', 'handles', 'publishes', 'consumes', 'sends_to', 'listens_on', 'evaluates_flag', 'reads_config', 'depends_on', 'depends_on_package', 'owned_by', 'calls_service', 'renders', 'uses_hook', 'provides_context', 'uses_context', 'mentions']
/** Clauses that write, call procedures or read files: refused by name wherever they appear outside a string. */
const REFUSED = ['CREATE', 'MERGE', 'SET', 'DELETE', 'DETACH', 'REMOVE', 'CALL', 'LOAD', 'FOREACH', 'DROP']
const UNSUPPORTED = ['UNWIND', 'UNION', 'USE', 'CASE', 'SHORTESTPATH', 'ALLSHORTESTPATHS']
const KEYWORDS = new Set(['MATCH', 'OPTIONAL', 'WHERE', 'WITH', 'RETURN', 'ORDER', 'BY', 'SKIP', 'LIMIT', 'DISTINCT', 'AS', 'AND', 'OR', 'XOR', 'NOT', 'IN', 'STARTS', 'ENDS', 'CONTAINS', 'IS', 'NULL', 'TRUE', 'FALSE', 'ASC', 'DESC', 'ASCENDING', 'DESCENDING'])
const FUNCTIONS = ['count', 'collect', 'type', 'labels', 'size', 'tolower', 'toupper']
const MAX_NESTING = 40

const bad = (message: string, detail = 'query_refused') => new ProofmeshError('INVALID_ARGUMENT', message, { detail })
/** A syntax error inside a parenthesis may only mean it was not a pattern; a refusal is never retried as an expression. */
const syntax = (message: string) => bad(message, 'query_syntax')

// ---------- values ----------
export type Param = string | number | boolean | null | Array<string | number | boolean | null>
type Site = { path: string; line: number; evidence: string[] }
class GNode {
  constructor(readonly id: string, readonly labels: string[], readonly props: Map<string, Val>, readonly ids: string[], readonly evidence: string | null) {}
  get name(): string { return String(this.props.get('name_shown')) }
}
class GRel {
  site?: Site
  constructor(readonly id: string, readonly type: string, readonly src: string, readonly dst: string, readonly props: Map<string, Val>) {}
}
class GPath { constructor(readonly nodes: GNode[], readonly rels: GRel[]) {} }
type Val = null | boolean | number | string | GNode | GRel | GPath | Val[]
type Binding = Map<string, Val>
/** Whether any relationship a row was matched through is inferred (#10); carried beside the variables under a name no query can write. */
const INFERRED = ' inferred'

// ---------- syntax ----------
type Tok = { k: 'id' | 'num' | 'str' | 'param' | 'op'; v: string; at: number; quoted?: boolean }
type Expr =
  | { k: 'lit'; v: Val }
  | { k: 'param'; name: string }
  | { k: 'var'; name: string }
  | { k: 'prop'; of: Expr; key: string }
  | { k: 'not'; e: Expr }
  | { k: 'neg'; e: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'isnull'; e: Expr; not: boolean }
  | { k: 'list'; items: Expr[] }
  | { k: 'call'; fn: string; args: Expr[]; distinct: boolean; star: boolean }
  | { k: 'pattern'; p: Pattern }
  | { k: 'exists'; p: Pattern; where?: Expr }
type NodeP = { v: string; labels: string[]; props: Array<[string, Expr]> }
type RelP = { v: string; types: string[]; dir: 'out' | 'in' | 'both'; varlen: boolean; min: number; max: number; props: Array<[string, Expr]> }
type Pattern = { path?: string; nodes: NodeP[]; rels: RelP[] }
type Item = { e: Expr; name: string }
type Projection = { k: 'with' | 'return'; distinct: boolean; items: Item[]; order: Array<{ e: Expr; desc: boolean }>; skip?: Expr; limit?: Expr; where?: Expr }
type Clause = { k: 'match'; optional: boolean; patterns: Pattern[]; where?: Expr } | Projection
export type GraphQuery = { clauses: Clause[]; params: Record<string, Param> }

const OPS = ['->', '<-', '..', '<>', '<=', '>=', '=~', '!=']
function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  const word = /[A-Za-z_][A-Za-z0-9_]*/y, num = /\d+(?:\.\d+)?/y
  const sticky = (re: RegExp, i: number) => { re.lastIndex = i; return re.exec(src)?.[0] }
  let i = 0
  while (i < src.length) {
    const c = src[i]!, at = i
    if (/\s/.test(c)) { i++; continue }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === "'" || c === '"') {
      let v = ''
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] !== '\\') { v += src[i]; continue }
        const e = src[++i]
        v += e === 'n' ? '\n' : e === 't' ? '\t' : (e ?? '')
      }
      if (i >= src.length) throw syntax(`a string opened at character ${at} is not closed`)
      out.push({ k: 'str', v, at }); i++; continue
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      if (end < 0) throw syntax(`a name quoted at character ${at} is not closed`)
      // The interpreter's own names start with a space, so no query name may.
      if (/^\s/.test(src.slice(i + 1, end))) throw syntax(`a name quoted at character ${at} starts with a space`)
      out.push({ k: 'id', v: src.slice(i + 1, end), at, quoted: true }); i = end + 1; continue
    }
    const w = sticky(word, i), n = w ? undefined : sticky(num, i)
    if (w) { out.push({ k: 'id', v: w, at }); i += w.length; continue }
    if (n) { out.push({ k: 'num', v: n, at }); i += n.length; continue }
    if (c === '$') {
      const p = sticky(word, i + 1)
      if (!p) throw syntax(`a parameter at character ${at} has no name`)
      out.push({ k: 'param', v: p, at }); i += p.length + 1; continue
    }
    const op = OPS.find((o) => src.startsWith(o, i)) ?? ('()[]{}:,.|*-<>=+;'.includes(c) ? c : undefined)
    if (!op) throw syntax(`unexpected character ${JSON.stringify(c)} at ${at}`)
    out.push({ k: 'op', v: op, at }); i += op.length
  }
  // Refused by name before parsing, so a write is never half-read as something else; a property named like one (n.set) is a property.
  for (const [j, t] of out.entries()) {
    const up = t.v.toUpperCase()
    if (t.k === 'id' && !t.quoted && REFUSED.includes(up) && out[j - 1]?.v !== '.') {
      throw bad(`query_graph is read-only: ${up} is refused. It answers MATCH, OPTIONAL MATCH, WHERE, WITH, RETURN, ORDER BY, SKIP and LIMIT over the snapshot, and nothing that writes, calls a procedure or reads a file.`, 'query_write_refused')
    }
  }
  return out
}

class Parser {
  private i = 0
  private depth = 0
  private anon = 0
  /** The upper bounds of the variable-length relationships parsed so far, summed over the whole query (FR2400). */
  private hops = 0
  private scope: string[] = []
  readonly params = new Set<string>()
  constructor(private readonly src: string, private readonly toks: Tok[], private readonly bound: number) {}

  private peek(o = 0): Tok | undefined { return this.toks[this.i + o] }
  private where(): string { const t = this.peek(); return t ? `at character ${t.at} (${JSON.stringify(t.v)})` : 'at the end of the query' }
  private isKw(kw: string, o = 0): boolean { const t = this.peek(o); return !!t && t.k === 'id' && !t.quoted && t.v.toUpperCase() === kw }
  private kw(kw: string): boolean { if (!this.isKw(kw)) return false; this.i++; return true }
  private needKw(kw: string): void { if (!this.kw(kw)) throw syntax(`expected ${kw} ${this.where()}`) }
  private isOp(op: string, o = 0): boolean { const t = this.peek(o); return !!t && t.k === 'op' && t.v === op }
  private op(op: string): boolean { if (!this.isOp(op)) return false; this.i++; return true }
  private need(op: string): void { if (!this.op(op)) throw syntax(`expected ${op} ${this.where()}`) }
  private name(what: string): string {
    const t = this.peek()
    if (!t || t.k !== 'id' || (!t.quoted && KEYWORDS.has(t.v.toUpperCase()))) throw syntax(`expected ${what} ${this.where()}`)
    this.i++
    return t.v
  }
  private varName(): string | undefined { const t = this.peek(); return t?.k === 'id' && (t.quoted || !KEYWORDS.has(t.v.toUpperCase())) ? (this.i++, t.v) : undefined }
  private int(what: string): number {
    const t = this.peek()
    if (t?.k !== 'num' || t.v.includes('.')) throw syntax(`expected ${what} as a whole number ${this.where()}`)
    this.i++
    return Number(t.v)
  }

  query(): Clause[] {
    const clauses: Clause[] = []
    while (this.peek() && !this.isOp(';')) {
      const t = this.peek()!, up = t.k === 'id' ? t.v.toUpperCase() : ''
      if (this.kw('OPTIONAL')) { this.needKw('MATCH'); clauses.push(this.match(true)) }
      else if (this.kw('MATCH')) clauses.push(this.match(false))
      else if (this.kw('WITH')) clauses.push(this.projection('with'))
      else if (this.kw('RETURN')) { clauses.push(this.projection('return')); break }
      else if (UNSUPPORTED.includes(up)) throw bad(`${up} is not supported by query_graph; it takes MATCH, OPTIONAL MATCH, WHERE, WITH, RETURN, ORDER BY, SKIP and LIMIT, with count and collect`)
      else throw syntax(`expected MATCH, OPTIONAL MATCH, WITH or RETURN ${this.where()}`)
    }
    this.op(';')
    if (this.peek()) throw syntax(`RETURN must be the last clause; unexpected ${this.where()}`)
    if (clauses.at(-1)?.k !== 'return') throw syntax('a query must end with RETURN')
    if (clauses[0]?.k !== 'match') throw syntax('a query must start with MATCH')
    return clauses
  }

  private match(optional: boolean): Clause {
    const patterns = [this.pattern(false)]
    while (this.op(',')) patterns.push(this.pattern(false))
    return { k: 'match', optional, patterns, ...(this.kw('WHERE') ? { where: this.expr() } : {}) }
  }

  private introduce(v: string): void { if (!v.startsWith(' ') && !this.scope.includes(v)) this.scope.push(v) }

  /** A pattern. In a predicate (`inWhere`) it may name only variables already bound, as openCypher requires. */
  private pattern(inWhere: boolean): Pattern {
    let path: string | undefined
    if (!inWhere && this.peek()?.k === 'id' && this.isOp('=', 1)) { path = this.name('a path name'); this.i++ }
    const nodes = [this.node(inWhere)], rels: RelP[] = []
    while (this.isOp('-') || this.isOp('<-')) { rels.push(this.rel(inWhere)); nodes.push(this.node(inWhere)) }
    if (path) { if (this.scope.includes(path)) throw syntax(`${path} is already bound`); this.introduce(path) }
    return { ...(path ? { path } : {}), nodes, rels }
  }

  private local(v: string | undefined, inWhere: boolean): string {
    if (v === undefined) return ` _${this.anon++}`
    if (inWhere && !this.scope.includes(v)) throw syntax(`a pattern in WHERE may only use variables bound before it; ${v} is not`)
    this.introduce(v)
    return v
  }

  private node(inWhere: boolean): NodeP {
    this.need('(')
    const v = this.local(this.varName(), inWhere), labels: string[] = []
    if (this.op(':')) {
      do labels.push(this.name('a label')); while (this.op('|'))
      if (this.isOp(':')) throw syntax('a node takes one label, or alternatives as :a|b')
    }
    const unknown = labels.filter((l) => !LABELS.includes(l))
    if (unknown.length) throw bad(`unknown node label ${unknown.join(', ')}; the labels are ${LABELS.join(', ')}`)
    const props = this.props()
    this.need(')')
    return { v, labels, props }
  }

  private rel(inWhere: boolean): RelP {
    const left = this.op('<-')
    if (!left) this.need('-')
    let v: string | undefined, types: string[] = [], varlen = false, min = 1, max = 1, props: Array<[string, Expr]> = []
    if (this.op('[')) {
      v = this.varName()
      if (this.op(':')) do { this.op(':'); types.push(this.name('a relationship type')) } while (this.op('|'))
      const unknown = types.filter((t) => !REL_TYPES.includes(t))
      if (unknown.length) throw bad(`unknown relationship type ${unknown.join(', ')}; the types are ${REL_TYPES.join(', ')}`)
      if (this.op('*')) {
        varlen = true
        let upper: number | undefined
        if (this.peek()?.k === 'num') min = this.int('a lower bound')
        if (this.op('..')) upper = this.peek()?.k === 'num' ? this.int('an upper bound') : undefined
        else if (this.peek(-1)?.k === 'num') upper = min
        if (upper === undefined) throw bad(`a variable-length relationship needs an upper bound of at most ${this.bound}, such as *1..${this.bound}; an unbounded one is refused before it runs`, 'query_unbounded')
        if (upper > this.bound) throw bad(`the variable-length relationship's upper bound ${upper} is above ${this.bound}, the most this query may follow under its max_depth (at most 12); it is refused before it runs`, 'query_unbounded')
        if (min > upper) throw syntax(`the lower bound ${min} is above the upper bound ${upper}`)
        this.hops += upper
        if (this.hops > this.bound) throw bad(`the variable-length relationships of this query follow up to ${this.hops} hops together, above ${this.bound}, its max_depth; lower their upper bounds or raise limits.max_depth (at most 12). It is refused before it runs`, 'query_unbounded')
        max = upper
      }
      props = this.props()
      this.need(']')
    }
    const right = this.op('->')
    if (!right) this.need('-')
    if (left && right) throw syntax('a relationship points one way, or neither: <-[]- , -[]-> or -[]-')
    return { v: this.local(v, inWhere), types, dir: left ? 'in' : right ? 'out' : 'both', varlen, min, max, props }
  }

  private props(): Array<[string, Expr]> {
    const out: Array<[string, Expr]> = []
    if (!this.op('{')) return out
    if (!this.op('}')) {
      do { const k = this.name('a property name'); this.need(':'); out.push([k, this.expr()]) } while (this.op(','))
      this.need('}')
    }
    return out
  }

  private projection(k: 'with' | 'return'): Projection {
    const distinct = this.kw('DISTINCT'), items: Item[] = []
    if (this.op('*')) items.push(...this.scope.map((v) => ({ e: { k: 'var' as const, name: v }, name: v })))
    else do {
      const from = this.peek()?.at ?? this.src.length, e = this.expr()
      const alias = this.kw('AS') ? this.name('a name after AS') : undefined
      if (k === 'with' && !alias && e.k !== 'var') throw syntax('an expression in WITH needs a name: WITH <expression> AS <name>')
      items.push({ e, name: alias ?? (e.k === 'var' ? e.name : this.src.slice(from, this.peek()?.at ?? this.src.length).trim().replace(/,$/, '').trim()) })
    } while (this.op(','))
    for (const it of items) if (it.e.k !== 'call' || !['count', 'collect'].includes(it.e.fn)) if (hasAggregate(it.e)) throw syntax('count and collect must be a whole WITH or RETURN item')
    const named = [...this.scope, ...items.map((it) => it.name)]
    const order: Projection['order'] = []
    if (this.kw('ORDER')) {
      this.needKw('BY')
      const before = this.scope
      this.scope = named
      do { const e = this.expr(); const desc = this.kw('DESC') || this.kw('DESCENDING'); if (!desc) this.kw('ASC') || this.kw('ASCENDING'); order.push({ e, desc }) } while (this.op(','))
      this.scope = before
    }
    const skip = this.kw('SKIP') ? this.count('SKIP') : undefined
    const limit = this.kw('LIMIT') ? this.count('LIMIT') : undefined
    this.scope = items.map((it) => it.name)
    const where = k === 'with' && this.kw('WHERE') ? this.expr() : undefined
    return { k, distinct, items, order, ...(skip ? { skip } : {}), ...(limit ? { limit } : {}), ...(where ? { where } : {}) }
  }

  private count(what: string): Expr {
    const t = this.peek()
    if (t?.k === 'param') { this.i++; this.params.add(t.v); return { k: 'param', name: t.v } }
    return { k: 'lit', v: this.int(`${what}'s count`) }
  }

  expr(): Expr {
    if (++this.depth > MAX_NESTING) throw bad(`the query nests deeper than ${MAX_NESTING} levels`)
    try { return this.or() } finally { this.depth-- }
  }
  private or(): Expr { let l = this.xor(); while (this.kw('OR')) l = { k: 'bin', op: 'or', l, r: this.xor() }; return l }
  private xor(): Expr { let l = this.and(); while (this.kw('XOR')) l = { k: 'bin', op: 'xor', l, r: this.and() }; return l }
  private and(): Expr { let l = this.not(); while (this.kw('AND')) l = { k: 'bin', op: 'and', l, r: this.not() }; return l }
  private not(): Expr {
    if (!this.kw('NOT')) return this.comparison()
    if (++this.depth > MAX_NESTING) throw bad(`the query nests deeper than ${MAX_NESTING} levels`)
    try { return { k: 'not', e: this.not() } } finally { this.depth-- }
  }
  private comparison(): Expr {
    let l = this.additive()
    for (;;) {
      if (this.isOp('=~')) throw bad('=~ (regular expressions) is not supported by query_graph; use STARTS WITH, ENDS WITH or CONTAINS')
      const op = ['=', '<>', '!=', '<=', '>=', '<', '>'].find((o) => this.isOp(o))
      if (op) { this.i++; l = { k: 'bin', op: op === '!=' ? '<>' : op, l, r: this.additive() }; continue }
      if (this.kw('STARTS')) { this.needKw('WITH'); l = { k: 'bin', op: 'starts', l, r: this.additive() }; continue }
      if (this.kw('ENDS')) { this.needKw('WITH'); l = { k: 'bin', op: 'ends', l, r: this.additive() }; continue }
      if (this.kw('CONTAINS')) { l = { k: 'bin', op: 'contains', l, r: this.additive() }; continue }
      if (this.kw('IN')) { l = { k: 'bin', op: 'in', l, r: this.additive() }; continue }
      if (this.kw('IS')) { const not = this.kw('NOT'); this.needKw('NULL'); l = { k: 'isnull', e: l, not }; continue }
      return l
    }
  }
  private additive(): Expr {
    let l = this.unary()
    for (;;) {
      const op = ['+', '-'].find((o) => this.isOp(o))
      if (!op) return l
      this.i++
      l = { k: 'bin', op, l, r: this.unary() }
    }
  }
  private unary(): Expr { return this.op('-') ? { k: 'neg', e: this.unary() } : this.postfix() }
  private postfix(): Expr {
    let e = this.primary()
    while (this.op('.')) e = { k: 'prop', of: e, key: this.name('a property name') }
    return e
  }
  private primary(): Expr {
    const t = this.peek()
    if (!t) throw syntax('the query ends where an expression was expected')
    if (t.k === 'num') { this.i++; return { k: 'lit', v: Number(t.v) } }
    if (t.k === 'str') { this.i++; return { k: 'lit', v: t.v } }
    if (t.k === 'param') { this.i++; this.params.add(t.v); return { k: 'param', name: t.v } }
    if (this.kw('TRUE')) return { k: 'lit', v: true }
    if (this.kw('FALSE')) return { k: 'lit', v: false }
    if (this.kw('NULL')) return { k: 'lit', v: null }
    if (this.op('[')) {
      const items: Expr[] = []
      if (!this.op(']')) { do items.push(this.expr()); while (this.op(',')); this.need(']') }
      return { k: 'list', items }
    }
    if (this.isOp('(')) {
      // A parenthesis opens a pattern predicate when a relationship follows its node; otherwise it groups an expression.
      const at = this.i, hops = this.hops
      try {
        const p = this.pattern(true)
        if (p.rels.length) return { k: 'pattern', p }
      } catch (e) {
        if ((e as ProofmeshError).details?.detail !== 'query_syntax') throw e
      }
      this.i = at
      this.hops = hops
      this.need('(')
      const e = this.expr()
      this.need(')')
      return e
    }
    if (this.isKw('EXISTS') && this.isOp('{', 1)) {
      // EXISTS { [MATCH] pattern [WHERE ...] }: true when the pattern matches; the variables it names are its own.
      this.i += 2
      const outer = this.scope
      this.scope = [...outer]
      try {
        this.kw('MATCH')
        const p = this.pattern(false), where = this.kw('WHERE') ? this.expr() : undefined
        this.need('}')
        return { k: 'exists', p, ...(where ? { where } : {}) }
      } finally {
        this.scope = outer
      }
    }
    if (t.k === 'id' && this.isOp('(', 1)) {
      const fn = t.v.toLowerCase()
      if (!FUNCTIONS.includes(fn)) throw bad(`unknown function ${t.v}; query_graph has ${FUNCTIONS.map((f) => f.replace('tolower', 'toLower').replace('toupper', 'toUpper')).join(', ')}`)
      this.i += 2
      if (fn === 'count' && this.op('*')) { this.need(')'); return { k: 'call', fn, args: [], distinct: false, star: true } }
      const distinct = this.kw('DISTINCT'), args: Expr[] = []
      if (!this.op(')')) { do args.push(this.expr()); while (this.op(',')); this.need(')') }
      if (args.length !== 1) throw syntax(`${t.v} takes one argument`)
      if ((fn === 'count' || fn === 'collect') && hasAggregate(args[0]!)) throw syntax(`${t.v} cannot hold another count or collect`)
      return { k: 'call', fn, args, distinct, star: false }
    }
    const v = this.varName()
    if (v !== undefined) {
      if (!this.scope.includes(v)) throw syntax(`variable ${v} is not defined`)
      return { k: 'var', name: v }
    }
    throw syntax(`expected an expression ${this.where()}`)
  }
}

const hasAggregate = (e: Expr): boolean =>
  e.k === 'call' ? ['count', 'collect'].includes(e.fn) || e.args.some(hasAggregate)
  : e.k === 'bin' ? hasAggregate(e.l) || hasAggregate(e.r)
  : e.k === 'not' || e.k === 'neg' || e.k === 'isnull' ? hasAggregate(e.e)
  : e.k === 'prop' ? hasAggregate(e.of)
  : e.k === 'list' ? e.items.some(hasAggregate)
  : false

/** Parses and checks a query, refusing writes, procedures, unbounded or too-deep paths and unknown names before anything runs. */
export function parseGraphQuery(text: string, params: Record<string, Param>, maxDepth: number): GraphQuery {
  const p = new Parser(text, tokenize(text), maxDepth)
  const clauses = p.query()
  const missing = [...p.params].filter((n) => !Object.hasOwn(params, n))
  if (missing.length) throw bad(`parameter${missing.length === 1 ? '' : 's'} ${missing.map((m) => `$${m}`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not given in params`)
  return { clauses, params }
}

// ---------- the graph, read through fixed statements ----------
class Stop { constructor(readonly reason: 'timeout') {} }
const SYMBOL_COLS = (db: Database.Database) => `s.id, s.kind, s.name, s.qualified_name, s.start_line, s.end_line, s.signature, s.stable_key, s.evidence_id, s.file_id, ${rolesSql(db)} as roles, f.path`
type SymRow = { id: string; kind: string; name: string; qualified_name: string; start_line: number; end_line: number; signature: string | null; stable_key: string; evidence_id: string; file_id: string; roles: string | null; path: string }
type FileRow = { id: string; path: string; language: string | null; disposition: string }
type ARow = { id: string; type: string; source_id: string; target_id: string; origin: string; resolution: string; detail: string | null }
const RESOLVED = "resolution in ('resolved', 'resolved_external')"
const SYM_ORDER = 'order by f.path, s.start_line, s.start_byte, s.id'

class Graph {
  private readonly nodes = new Map<string, GNode | null>()
  private readonly scans = new Map<string, GNode[]>()
  private readonly hops = new Map<string, Array<[GRel, GNode]>>()
  private readonly s: Record<string, Database.Statement>
  private steps = 0
  constructor(private readonly db: Database.Database, private readonly deadline: number) {
    const sym = `select ${SYMBOL_COLS(db)} from symbol s join file f on f.id = s.file_id`, a = 'select id, type, source_id, target_id, origin, resolution, detail from assertion'
    // Relationships come in the order of their sites where the snapshot records them (format 0.10), as get_relationships lists them.
    const order = hasSites(db) ? 'order by site_path, site_byte, id' : 'order by id'
    const p = (sql: string) => db.prepare(sql)
    this.s = {
      symbol: p(`${sym} where s.id = ?`), file: p('select id, path, language, disposition from file where id = ?'), external: p('select id, module, name from external_symbol where id = ?'),
      modules: p("select id from symbol where file_id = ? and kind = 'module' order by id"),
      symAll: p(`${sym} where s.kind <> 'module' ${SYM_ORDER}`), symKind: p(`${sym} where s.kind = ? ${SYM_ORDER}`), symPath: p(`${sym} where f.path = ? and s.kind <> 'module' ${SYM_ORDER}`),
      symName: p(`${sym} where s.name = ? and s.kind <> 'module' ${SYM_ORDER}`), symQname: p(`${sym} where s.qualified_name = ? and s.kind <> 'module' ${SYM_ORDER}`),
      fileAll: p('select id, path, language, disposition from file order by path'), filePath: p('select id, path, language, disposition from file where path = ?'),
      extAll: p('select id, module, name from external_symbol order by module, name, id'), extName: p('select id, module, name from external_symbol where name = ? order by module, id'),
      outAll: p(`${a} where source_id = ? and ${RESOLVED} ${order}`), outType: p(`${a} where source_id = ? and type = ? and ${RESOLVED} ${order}`),
      inAll: p(`${a} where target_id = ? and ${RESOLVED} ${order}`), inType: p(`${a} where target_id = ? and type = ? and ${RESOLVED} ${order}`),
      rankingSymbols: p("select id from symbol where kind <> 'module'"),
      rankingFiles: p('select id from file'), rankingExternals: p('select id from external_symbol'),
      rankingAliases: p("select id from symbol where file_id = ? and kind = 'module'"),
      rankingUsers: p(`select case when s.kind = 'module' then s.file_id else coalesce(s.id, f.id, x.id) end as source,
        ${inferredSql()} as inferred from assertion a
        left join symbol s on s.id = a.source_id left join file f on f.id = a.source_id left join external_symbol x on x.id = a.source_id
        where a.target_id = ? and a.type in (?, ?) and ${RESOLVED}`),
      site: p('select e.id, f.path, e.start_line from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by f.path, e.start_byte'),
    }
  }

  /** Every read of the graph passes here, so a query that runs past its deadline stops wherever it is. */
  tick(): void { if (++this.steps % 128 === 0 && Date.now() > this.deadline) throw new Stop('timeout') }

  private symbolNode(r: SymRow): GNode {
    const roles = parseRoles(r.roles)
    const props = new Map<string, Val>([['id', r.id], ['kind', r.kind], ['name', r.name], ['qualified_name', r.qualified_name], ['path', r.path], ['line', r.start_line], ['end_line', r.end_line], ['signature', r.signature], ['key', r.stable_key], ['test', isTestCode(r.path, null, roles)], ['name_shown', leanName({ kind: r.kind, name: r.name, qualified_name: r.qualified_name, path: r.path })]])
    return new GNode(r.id, [r.kind], props, [r.id], r.evidence_id)
  }
  private fileNode(r: FileRow, includeModules = true): GNode {
    const modules = includeModules ? (this.s.modules!.all(r.id) as Array<{ id: string }>).map((m) => m.id) : []
    const props = new Map<string, Val>([['id', r.id], ['kind', 'file'], ['name', r.path.slice(r.path.lastIndexOf('/') + 1)], ['path', r.path], ['line', 1], ['language', r.language], ['disposition', r.disposition], ['test', isTestPath(r.path)], ['name_shown', r.path]])
    return new GNode(r.id, modules.length ? ['file', 'module'] : ['file'], props, [r.id, ...modules], null)
  }
  private cache(id: string, make: () => GNode | null): GNode | null {
    if (!this.nodes.has(id)) this.nodes.set(id, make())
    return this.nodes.get(id)!
  }

  /** The node an id names. A file and its module symbol are one node, the file, as in the other tools (FR090). */
  node(id: string): GNode | null {
    return this.cache(id, () => this.readNode(id, true))
  }

  /** Ranking compares canonical nodes by place without caching every candidate or loading file aliases. */
  readNode(id: string, includeModules: boolean): GNode | null {
    if (id.startsWith('file_')) { const f = this.s.file!.get(id) as FileRow | undefined; return f ? this.fileNode(f, includeModules) : null }
    if (id.startsWith('ext_')) {
      const x = this.s.external!.get(id) as { id: string; module: string; name: string } | undefined
      return x ? new GNode(x.id, ['external'], new Map<string, Val>([['id', x.id], ['kind', 'external'], ['name', x.name], ['module', x.module], ['name_shown', x.name]]), [x.id], null) : null
    }
    const s = this.s.symbol!.get(id) as SymRow | undefined
    return !s ? null : s.kind === 'module' ? this.node(s.file_id) : this.symbolNode(s)
  }

  *rankingTargets(internal: boolean): Generator<{ id: string }> {
    yield* this.s.rankingSymbols!.iterate() as Iterable<{ id: string }>
    if (!internal) {
      yield* this.s.rankingFiles!.iterate() as Iterable<{ id: string }>
      yield* this.s.rankingExternals!.iterate() as Iterable<{ id: string }>
    }
  }

  *incomingUsers(id: string, types: string[], check: () => void): Generator<IncomingUser> {
    const read = (raw: string) => this.s.rankingUsers!.iterate(raw, types[0], types[1] ?? types[0]) as Iterable<IncomingUser>
    yield* read(id)
    if (id.startsWith('file_')) {
      for (const alias of this.s.rankingAliases!.iterate(id) as Iterable<{ id: string }>) { check(); yield* read(alias.id) }
    }
  }

  /** Candidates for an unbound node: read by the most selective property given, then matched in full by the caller. */
  *scan(labels: string[], props: Map<string, Val>): Generator<GNode> {
    // Read whole and kept, so a pattern that scans inside another scan (MATCH (a), (b)) neither re-reads nor reuses a busy statement.
    const key = JSON.stringify([labels, ['id', 'qualified_name', 'path', 'name'].map((k) => props.get(k) ?? null)])
    let nodes = this.scans.get(key)
    if (!nodes) { nodes = [...this.read(labels, props)]; this.scans.set(key, nodes) }
    for (const n of nodes) { this.tick(); yield n }
  }

  private *read(labels: string[], props: Map<string, Val>): Generator<GNode> {
    const str = (k: string) => { const v = props.get(k); return typeof v === 'string' ? v : undefined }
    const id = str('id')
    if (id !== undefined) { const n = this.node(id); if (n) yield n; return }
    const any = !labels.length
    if (any || labels.some((l) => l !== 'file' && l !== 'external' && l !== 'module')) {
      const kinds = labels.filter((l) => l !== 'file' && l !== 'external' && l !== 'module')
      const q = str('qualified_name'), path = str('path'), name = str('name')
      const rows = q !== undefined ? this.s.symQname!.all(q) : path !== undefined ? this.s.symPath!.all(path) : name !== undefined ? this.s.symName!.all(name)
        : kinds.length === 1 ? this.s.symKind!.all(kinds[0]) : this.s.symAll!.all()
      for (const r of rows as SymRow[]) { this.tick(); yield this.cache(r.id, () => this.symbolNode(r))! }
    }
    // A file has no qualified_name, and an external symbol neither that nor a path: a node named by them is never read from those tables.
    if ((any || labels.includes('file') || labels.includes('module')) && !props.has('qualified_name')) {
      const path = str('path')
      for (const r of (path !== undefined ? this.s.filePath!.all(path) : this.s.fileAll!.all()) as FileRow[]) { this.tick(); yield this.cache(r.id, () => this.fileNode(r))! }
    }
    if ((any || labels.includes('external')) && !props.has('qualified_name') && !props.has('path')) {
      const name = str('name')
      for (const x of (name !== undefined ? this.s.extName!.all(name) : this.s.extAll!.all()) as Array<{ id: string }>) { this.tick(); const n = this.node(x.id); if (n) yield n }
    }
  }

  private rel(a: ARow): GRel | null {
    const src = this.node(a.source_id), dst = this.node(a.target_id)
    if (!src || !dst) return null
    return new GRel(a.id, a.type, src.id, dst.id, new Map<string, Val>([['id', a.id], ['type', a.type], ['resolution', a.resolution], ['origin', a.origin], ['basis', basisOf(a) ?? null]]))
  }

  /** One hop from a node: the resolved relationships it is the source (out) or the target (in) of, with the node at the other end. */
  *hop(x: GNode, types: string[], dir: 'out' | 'in' | 'both'): Generator<[GRel, GNode]> {
    for (const h of this.adjacent(x, types, dir)) { this.tick(); yield h }
  }

  private adjacent(x: GNode, types: string[], dir: 'out' | 'in' | 'both'): Array<[GRel, GNode]> {
    // Kept for the query, so a search that passes a node again (a cycle, a pattern per file) reads its relationships once.
    const key = `${x.id}\0${dir}\0${types.join(',')}`
    let out = this.hops.get(key)
    if (!out) {
      out = []
      for (const side of dir === 'both' ? (['out', 'in'] as const) : [dir]) {
        const all = side === 'out' ? this.s.outAll! : this.s.inAll!, typed = side === 'out' ? this.s.outType! : this.s.inType!
        for (const id of x.ids) {
          for (const a of (types.length ? types.flatMap((t) => typed.all(id, t)) : all.all(id)) as ARow[]) {
            this.tick()
            const r = this.rel(a)
            if (r) out.push([r, this.node(side === 'out' ? r.dst : r.src)!])
          }
        }
      }
      this.hops.set(key, out)
    }
    return out
  }

  /**
   * A variable-length hop, breadth first: each node reached once, at its shortest distance, with the relationships that reached it.
   * With `target` (the far end is already bound) it looks only for that node and stops once it has it.
   */
  *reach(start: GNode, types: string[], dir: 'out' | 'in' | 'both', min: number, max: number, ok: ((r: GRel) => boolean) | null, target?: string): Generator<{ node: GNode; rels: GRel[] }> {
    const seen = new Set<string>(min === 0 ? [start.id] : [])
    if (min === 0 && (target === undefined || target === start.id)) { yield { node: start, rels: [] }; if (target !== undefined) return }
    // Each reached node keeps the hop that reached it; the relationships of its path are read back only for a node that is yielded.
    type Reached = { node: GNode; rel?: GRel; prev?: Reached }
    const rels = (e: Reached) => { const out: GRel[] = []; for (let x: Reached | undefined = e; x?.rel; x = x.prev) out.unshift(x.rel); return out }
    let frontier: Reached[] = [{ node: start }]
    for (let d = 1; d <= max && frontier.length; d++) {
      const next: Reached[] = []
      for (const f of frontier) {
        for (const [r, n] of this.adjacent(f.node, types, dir)) {
          this.tick()
          if (seen.has(n.id) || (ok && !ok(r))) continue
          seen.add(n.id)
          const e: Reached = { node: n, rel: r, prev: f }
          next.push(e)
          if (d >= min && (target === undefined || n.id === target)) { yield { node: n, rels: rels(e) }; if (target !== undefined) return }
        }
      }
      frontier = next
    }
  }

  /** Where a relationship was seen: its first evidence, as get_relationships shows it. */
  site(r: GRel): Site {
    if (!r.site) {
      const rows = this.s.site!.all(r.id) as Array<{ id: string; path: string; start_line: number }>
      r.site = { path: rows[0]?.path ?? '', line: rows[0]?.start_line ?? 0, evidence: rows.map((e) => e.id) }
      r.props.set('path', r.site.path)
      r.props.set('line', r.site.line)
    }
    return r.site
  }
}

// ---------- evaluation ----------
type Run = { g: Graph; params: Record<string, Param>; maxRows: number; stop: 'max_rows' | 'timeout' | null; aggregateCut: boolean }

const isEntity = (v: Val): v is GNode | GRel | GPath => v instanceof GNode || v instanceof GRel || v instanceof GPath
/** A value as a grouping and DISTINCT key. */
const keyOf = (v: Val): string =>
  v instanceof GNode ? `n:${v.id}` : v instanceof GRel ? `r:${v.id}` : v instanceof GPath ? `p:${v.rels.map((r) => r.id).join('>')}`
  : Array.isArray(v) ? `[${v.map(keyOf).join(',')}]` : JSON.stringify(v)
/** Equality with openCypher's null: comparing with null is null. */
function equal(a: Val, b: Val): boolean | null {
  if (a === null || b === null) return null
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    let out: boolean | null = true
    for (const [i, x] of a.entries()) { const e = equal(x, b[i]!); if (e === false) return false; if (e === null) out = null }
    return out
  }
  return isEntity(a) || isEntity(b) ? keyOf(a) === keyOf(b) : a === b
}
/** Order of values: null last, then numbers, strings, booleans, nodes by place, relationships by site, lists. */
function compare(g: Graph, a: Val, b: Val): number {
  const rank = (v: Val) => (v === null ? 9 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : v instanceof GNode ? 3 : v instanceof GRel ? 4 : 5)
  const ra = rank(a), rb = rank(b)
  if (ra !== rb) return ra - rb
  if (typeof a === 'number') return a - (b as number)
  if (typeof a === 'string' || typeof a === 'boolean') return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0
  const place = (v: Val) => v instanceof GNode ? `${String(v.props.get('path') ?? '')}\0${String(v.props.get('line') ?? 0).padStart(9, '0')}\0${v.name}\0${v.id}`
    : v instanceof GRel ? `${g.site(v).path}\0${String(g.site(v).line).padStart(9, '0')}\0${v.id}` : keyOf(v)
  const pa = place(a), pb = place(b)
  return pa < pb ? -1 : pa > pb ? 1 : 0
}
const truthy = (v: Val): boolean => v === true

function evaluate(run: Run, e: Expr, b: Binding): Val {
  switch (e.k) {
    case 'lit': return e.v
    case 'param': return run.params[e.name] ?? null
    case 'var': return b.get(e.name) ?? null
    case 'prop': {
      const o = evaluate(run, e.of, b)
      if (o instanceof GRel && (e.key === 'path' || e.key === 'line')) run.g.site(o)
      return o instanceof GNode || o instanceof GRel ? (e.key === 'name_shown' ? null : o.props.get(e.key) ?? null) : null
    }
    case 'not': { const v = evaluate(run, e.e, b); return typeof v === 'boolean' ? !v : null }
    case 'neg': { const v = evaluate(run, e.e, b); return typeof v === 'number' ? -v : null }
    case 'isnull': { const isNull = evaluate(run, e.e, b) === null; return e.not ? !isNull : isNull }
    case 'list': return e.items.map((x) => evaluate(run, x, b))
    case 'pattern':
    case 'exists': {
      for (const m of matchPattern(run, e.p, b, new Set())) if (e.k === 'pattern' || !e.where || truthy(evaluate(run, e.where, m))) return true
      return false
    }
    case 'call': {
      const v = evaluate(run, e.args[0]!, b)
      if (e.fn === 'type') return v instanceof GRel ? v.type : null
      if (e.fn === 'labels') return v instanceof GNode ? [...v.labels] : null
      if (e.fn === 'size') return Array.isArray(v) || typeof v === 'string' ? v.length : null
      if (e.fn === 'tolower') return typeof v === 'string' ? v.toLowerCase() : null
      if (e.fn === 'toupper') return typeof v === 'string' ? v.toUpperCase() : null
      throw bad(`${e.fn} is allowed only as a whole WITH or RETURN item`)
    }
    case 'bin': {
      if (e.op === 'and' || e.op === 'or' || e.op === 'xor') {
        const l = evaluate(run, e.l, b)
        if (e.op === 'and' && l === false) return false
        if (e.op === 'or' && l === true) return true
        const r = evaluate(run, e.r, b)
        const lb = typeof l === 'boolean' ? l : null, rb = typeof r === 'boolean' ? r : null
        if (e.op === 'and') return rb === false ? false : lb === null || rb === null ? null : true
        if (e.op === 'or') return rb === true ? true : lb === null || rb === null ? null : false
        return lb === null || rb === null ? null : lb !== rb
      }
      const l = evaluate(run, e.l, b), r = evaluate(run, e.r, b)
      switch (e.op) {
        case '=': return equal(l, r)
        case '<>': { const q = equal(l, r); return q === null ? null : !q }
        case '<': case '<=': case '>': case '>=': {
          if (l === null || r === null || typeof l !== typeof r || (typeof l !== 'number' && typeof l !== 'string')) return null
          const c = compare(run.g, l, r)
          return e.op === '<' ? c < 0 : e.op === '<=' ? c <= 0 : e.op === '>' ? c > 0 : c >= 0
        }
        case 'starts': case 'ends': case 'contains':
          if (typeof l !== 'string' || typeof r !== 'string') return null
          return e.op === 'starts' ? l.startsWith(r) : e.op === 'ends' ? l.endsWith(r) : l.includes(r)
        case 'in': {
          if (!Array.isArray(r)) return null
          let out: boolean | null = false
          for (const x of r) { const q = equal(l, x); if (q === true) return true; if (q === null) out = null }
          return out
        }
        case '+':
          if (typeof l === 'number' && typeof r === 'number') return l + r
          if (typeof l === 'string' && typeof r === 'string') return l + r
          if (Array.isArray(l)) return [...l, ...(Array.isArray(r) ? r : [r])]
          return null
        case '-': return typeof l === 'number' && typeof r === 'number' ? l - r : null
      }
      return null
    }
  }
}

const propsOf = (run: Run, props: Array<[string, Expr]>, b: Binding) => new Map(props.map(([k, e]) => [k, evaluate(run, e, b)]))
function nodeFits(n: GNode, labels: string[], props: Map<string, Val>): boolean {
  if (labels.length && !labels.some((l) => n.labels.includes(l))) return false
  for (const [k, v] of props) if (k === 'name_shown' || equal(n.props.get(k) ?? null, v) !== true) return false
  return true
}
function relFits(run: Run, r: GRel, props: Map<string, Val>): boolean {
  for (const [k, v] of props) {
    if (k === 'path' || k === 'line') run.g.site(r)
    if (equal(r.props.get(k) ?? null, v) !== true) return false
  }
  return true
}
const withVal = (b: Binding, k: string, v: Val): Binding => {
  const out = new Map(b)
  out.set(k, v)
  const rels = Array.isArray(v) ? v : [v]
  if (rels.some((r) => r instanceof GRel && r.props.get('basis') === 'inferred')) out.set(INFERRED, true)
  return out
}
/** The binding with node pattern `np` bound to `n`, or null when `n` does not fit it or the variable holds another node. */
function bindNode(run: Run, np: NodeP, n: GNode, b: Binding): Binding | null {
  const held = b.get(np.v)
  if (held !== undefined) return held instanceof GNode && held.id === n.id ? b : null
  return nodeFits(n, np.labels, propsOf(run, np.props, b)) ? withVal(b, np.v, n) : null
}

/** The node to start a pattern from: one already bound, else the one named most narrowly. */
function anchorOf(p: Pattern, b: Binding): number {
  const score = (np: NodeP) => {
    if (b.get(np.v) instanceof GNode) return 0
    const keys = np.props.map(([k]) => k)
    return keys.includes('id') ? 1 : keys.includes('qualified_name') || keys.includes('path') ? 2 : keys.includes('name') ? 3 : np.labels.length ? 4 : 5
  }
  let best = 0
  for (const [i, np] of p.nodes.entries()) if (score(np) < score(p.nodes[best]!)) best = i
  return best
}

type Step = { rel: number; from: number; to: number; reverse: boolean }
const flip = (d: RelP['dir']): RelP['dir'] => (d === 'out' ? 'in' : d === 'in' ? 'out' : 'both')

function* matchPattern(run: Run, p: Pattern, b0: Binding, used: Set<string>): Generator<Binding> {
  const a = anchorOf(p, b0), steps: Step[] = []
  for (let i = a; i < p.rels.length; i++) steps.push({ rel: i, from: i, to: i + 1, reverse: false })
  for (let i = a - 1; i >= 0; i--) steps.push({ rel: i, from: i + 1, to: i, reverse: true })
  const np = p.nodes[a]!, held = b0.get(np.v)
  const starts = held instanceof GNode ? [held] : held !== undefined ? [] : run.g.scan(np.labels, propsOf(run, np.props, b0))
  for (const n of starts) {
    const b = bindNode(run, np, n, b0)
    if (b) yield* walk(run, p, steps, 0, b, used)
  }
}

function* walk(run: Run, p: Pattern, steps: Step[], k: number, b: Binding, used: Set<string>): Generator<Binding> {
  if (k === steps.length) { yield p.path ? withVal(b, p.path, pathOf(run, p, b)) : b; return }
  const s = steps[k]!, rp = p.rels[s.rel]!, from = b.get(p.nodes[s.from]!.v) as GNode, to = p.nodes[s.to]!
  const dir = s.reverse ? flip(rp.dir) : rp.dir, props = propsOf(run, rp.props, b), held = b.get(rp.v)
  if (!rp.varlen) {
    for (const [r, n] of run.g.hop(from, rp.types, dir)) {
      if (used.has(r.id) || !relFits(run, r, props) || (held !== undefined && !(held instanceof GRel && held.id === r.id))) continue
      const next = bindNode(run, to, n, held === undefined ? withVal(b, rp.v, r) : b)
      if (!next) continue
      used.add(r.id)
      try { yield* walk(run, p, steps, k + 1, next, used) } finally { used.delete(r.id) }
    }
    return
  }
  const end = b.get(to.v)
  for (const { node, rels } of run.g.reach(from, rp.types, dir, rp.min, rp.max, props.size ? (r) => relFits(run, r, props) : null, end instanceof GNode ? end.id : undefined)) {
    const list = s.reverse ? [...rels].reverse() : rels
    if (held !== undefined && keyOf(held) !== keyOf(list)) continue
    const next = bindNode(run, to, node, held === undefined ? withVal(b, rp.v, list) : b)
    if (next) yield* walk(run, p, steps, k + 1, next, used)
  }
}

/** A named path: its nodes in pattern order, with every hop of each variable-length relationship. */
function pathOf(run: Run, p: Pattern, b: Binding): GPath {
  const nodes = [b.get(p.nodes[0]!.v) as GNode], rels: GRel[] = []
  for (const rp of p.rels) {
    const v = b.get(rp.v)
    for (const r of (Array.isArray(v) ? v : [v]) as GRel[]) {
      const cur = nodes.at(-1)!
      rels.push(r)
      nodes.push(run.g.node(r.src === cur.id ? r.dst : r.src)!)
    }
  }
  return new GPath(nodes, rels)
}

function* matchClause(run: Run, c: Extract<Clause, { k: 'match' }>, input: Iterable<Binding>): Generator<Binding> {
  const introduced = c.patterns.flatMap((p) => [...p.nodes.map((n) => n.v), ...p.rels.map((r) => r.v), ...(p.path ? [p.path] : [])])
  for (const b of input) {
    let any = false
    const all = function* (i: number, cur: Binding, used: Set<string>): Generator<Binding> {
      if (i === c.patterns.length) { yield cur; return }
      for (const next of matchPattern(run, c.patterns[i]!, cur, used)) yield* all(i + 1, next, used)
    }
    for (const m of all(0, b, new Set())) {
      if (c.where && !truthy(evaluate(run, c.where, m))) continue
      any = true
      yield m
    }
    if (c.optional && !any) {
      const out = new Map(b)
      for (const v of introduced) if (!out.has(v)) out.set(v, null)
      yield out
    }
  }
}

/**
 * Rows are held only where the clause needs all of them (count, collect, ORDER BY, DISTINCT) and the final RETURN, and never more than
 * max_rows: a query that would hold more stops there and says max_rows cut it, as the other tools do.
 */
function* projectClause(run: Run, c: Projection, input: Iterable<Binding>): Generator<Binding> {
  const aggregating = c.items.some((it) => it.e.k === 'call' && (it.e.fn === 'count' || it.e.fn === 'collect'))
  const skip = countBound(run, c.skip) ?? 0, limit = countBound(run, c.limit)
  const project = (b: Binding, group?: Binding[]): Binding => {
    const out: Binding = new Map()
    for (const it of c.items) {
      if (group && it.e.k === 'call' && (it.e.fn === 'count' || it.e.fn === 'collect')) {
        const call = it.e
        const values = call.star ? group.map(() => true as Val) : group.map((g) => evaluate(run, call.args[0]!, g)).filter((v) => v !== null)
        const kept = call.distinct ? [...new Map(values.map((v) => [keyOf(v), v])).values()] : values
        out.set(it.name, call.fn === 'count' ? kept.length : kept)
      } else out.set(it.name, evaluate(run, it.e, b))
    }
    if ((group ?? [b]).some((g) => g.get(INFERRED))) out.set(INFERRED, true)
    return out
  }
  /** Takes rows from `rows` while there is room, and says why it stopped taking them. */
  const hold = function* <T>(rows: Iterable<T>): Generator<T> {
    let n = 0
    try {
      for (const r of rows) {
        if (n++ === run.maxRows) { run.stop ??= 'max_rows'; if (aggregating) run.aggregateCut = true; return }
        yield r
      }
    } catch (e) {
      if (!(e instanceof Stop)) throw e
      run.stop ??= e.reason
    }
  }
  let rows: Iterable<{ row: Binding; from: Binding }>
  if (aggregating) {
    const groups = new Map<string, Binding[]>()
    const keys = c.items.filter((it) => !(it.e.k === 'call' && (it.e.fn === 'count' || it.e.fn === 'collect')))
    for (const b of hold(input)) {
      const key = keys.map((it) => keyOf(evaluate(run, it.e, b))).join('\u0001')
      const group = groups.get(key)
      if (group) group.push(b)
      else groups.set(key, [b])
    }
    // Counting nothing still answers one row: count(*) of no rows is 0.
    if (!groups.size && !keys.length) groups.set('', [])
    rows = [...groups.values()].map((g) => ({ row: project(g[0] ?? new Map(), g), from: g[0] ?? new Map() }))
  } else {
    rows = (function* () { for (const b of input) yield { row: project(b), from: b } })()
  }
  if (c.distinct) {
    const seen = new Set<string>(), all = rows
    rows = (function* () { for (const r of all) { const k = c.items.map((it) => keyOf(r.row.get(it.name) ?? null)).join('\u0001'); if (!seen.has(k)) { seen.add(k); yield r } } })()
  }
  if (c.order.length) {
    const held = [...hold(rows)]
    const env = (r: { row: Binding; from: Binding }) => { const m = new Map(r.from); for (const [k, v] of r.row) m.set(k, v); return m }
    const keyed = held.map((r) => ({ r, keys: c.order.map((o) => evaluate(run, o.e, env(r))) }))
    keyed.sort((x, y) => { for (const [i, o] of c.order.entries()) { const d = compare(run.g, x.keys[i]!, y.keys[i]!); if (d) return o.desc ? -d : d } return 0 })
    rows = keyed.map((k) => k.r)
  }
  // The final RETURN's rows are capped by the caller, after SKIP, LIMIT and WHERE.
  let n = 0, out = 0
  for (const r of rows) {
    if (n++ < skip) continue
    if (limit !== undefined && out >= limit) return
    if (c.where && !truthy(evaluate(run, c.where, r.row))) continue
    out++
    yield r.row
  }
}

function countBound(run: Run, expr?: Expr): number | undefined {
  if (!expr) return undefined
  const value = evaluate(run, expr, new Map())
  if (typeof value !== 'number' || value < 0 || !Number.isInteger(value)) throw bad('SKIP and LIMIT take a whole number of at least 0')
  return value
}

type UserRanking = { target: string; users: string; internal: boolean; types: string[]; limit: Expr }

/** Recognize the grouped top-k query only when every clause has the semantics implemented below. */
function userRanking(q: GraphQuery): UserRanking | undefined {
  const [match, group, ret] = q.clauses
  if (q.clauses.length !== 3 || match?.k !== 'match' || group?.k !== 'with' || ret?.k !== 'return') return
  if (match.optional || match.patterns.length !== 1 || !match.where) return
  const pattern = match.patterns[0]!, [source, target] = pattern.nodes, [hop] = pattern.rels
  if (pattern.path || pattern.rels.length !== 1 || !source || !target || !hop || source.v === target.v) return
  if (source.labels.length || source.props.length || target.labels.length || target.props.length) return
  if (hop.dir !== 'out' || hop.varlen || hop.props.length || !hop.v.startsWith(' ') || !hop.types.length ||
      !hop.types.every(t => t === 'calls' || t === 'references')) return

  const variable = (e: Expr | undefined, name: string) => e?.k === 'var' && e.name === name
  let filter = match.where, internal = false
  if (filter.k === 'bin' && filter.op === 'and') {
    const key = filter.r
    if (key.k !== 'isnull' || !key.not || key.e.k !== 'prop' || key.e.key !== 'key' || !variable(key.e.of, target.v)) return
    internal = true
    filter = filter.l
  }
  if (filter.k !== 'bin' || filter.op !== '<>' || !variable(filter.l, source.v) || !variable(filter.r, target.v)) return
  if (group.distinct || group.where || group.skip || group.limit || group.order.length || group.items.length !== 2) return
  const [node, count] = group.items
  if (!node || !variable(node.e, target.v) || !count || node.name === count.name) return
  const call = count.e
  if (call.k !== 'call' || call.fn !== 'count' || !call.distinct || call.args.length !== 1 || !variable(call.args[0], source.v)) return
  if (!ret.limit || ret.skip || ret.distinct || ret.items.length !== 2 || ret.order.length !== 2) return
  if (!ret.items.every((item, i) => variable(item.e, item.name) && item.name === group.items[i]!.name)) return
  const [byCount, byNode] = ret.order
  if (!byCount?.desc || !variable(byCount.e, count.name) || !byNode || byNode.desc || !variable(byNode.e, node.name)) return
  return { target: node.name, users: count.name, internal, types: [...new Set(hop.types)], limit: ret.limit }
}

type IncomingUser = { source: string | null; inferred: number | null }

/** Count distinct sources in bounded pages. A hub larger than a page is rescanned above the last counted key. */
function distinctUsers(incoming: () => Iterable<IncomingUser>, target: string, tick: () => void) {
  const page = 512
  let lower: string | undefined, users = 0, inferred = false
  for (;;) {
    // After pruning, every encountered key through upper is retained. Larger keys belong to a later pass.
    let keys = new Set<string>(), upper: string | undefined
    for (const edge of incoming()) {
      tick()
      const id = edge.source
      if (!id || id === target || (lower !== undefined && id <= lower)) continue
      if (edge.inferred) inferred = true
      if (upper !== undefined && id >= upper) continue
      keys.add(id)
      if (keys.size === page * 2) {
        const first = [...keys].sort().slice(0, page)
        upper = first[page - 1]!
        keys = new Set(first)
      }
    }
    users += keys.size
    if (upper === undefined) return { users, inferred }
    lower = upper
  }
}

/** Stream indexed incoming assertions for each canonical target. Only candidate winners and one source page survive a scan. */
function* rankUsers(run: Run, plan: UserRanking, deadline: number): Generator<Binding> {
  const keep = Math.min(countBound(run, plan.limit)!, run.maxRows + 1)
  if (!keep) return
  const check = () => { if (Date.now() >= deadline) throw new Stop('timeout') }
  check()
  type Ranked = { node: GNode; users: number; inferred: boolean }
  const winners: Ranked[] = []
  for (const { id } of run.g.rankingTargets(plan.internal)) {
    check()
    const { users, inferred } = distinctUsers(() => run.g.incomingUsers(id, plan.types, check), id, check)
    const last = winners[keep - 1]
    if (!users || (last && last.users > users)) continue
    const node = run.g.readNode(id, false)!
    const index = winners.findIndex(other => users > other.users || (users === other.users && compare(run.g, node, other.node) < 0))
    if (index >= 0) winners.splice(index, 0, { node, users, inferred })
    else if (!last) winners.push({ node, users, inferred })
    if (winners.length > keep) winners.pop()
  }
  check()
  for (const { node, users, inferred } of winners) {
    yield new Map<string, Val>([[plan.target, node], [plan.users, users], [INFERRED, inferred]])
  }
}

// ---------- answers ----------
export type Cell = null | boolean | number | string | Cell[] | { [k: string]: Cell }
export type QueryRow = { values: Cell[]; inferred?: boolean }
export type QueryAnswer = { columns: string[]; rows: QueryRow[]; stop: 'max_rows' | 'timeout' | null; evidence: string[]; aggregateCut: boolean }

/** Runs a parsed query against a sealed snapshot opened read only, within max_rows and the deadline. */
export function runGraphQuery(db: Database.Database, q: GraphQuery, limits: { maxRows: number; deadline: number }): QueryAnswer {
  const run: Run = { g: new Graph(db, limits.deadline), params: q.params, maxRows: limits.maxRows, stop: null, aggregateCut: false }
  const ret = q.clauses.at(-1) as Projection
  let stream: Iterable<Binding> = [new Map()]
  const ranking = userRanking(q)
  if (ranking) stream = rankUsers(run, ranking, limits.deadline)
  else for (const c of q.clauses) stream = c.k === 'match' ? matchClause(run, c, stream) : projectClause(run, c, stream)
  const out: Binding[] = []
  try {
    for (const b of stream) {
      if (out.length === run.maxRows) { run.stop ??= 'max_rows'; break }
      out.push(b)
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e
    run.stop ??= e.reason
  }
  const evidence = new Set<string>()
  const cell = (v: Val): Cell => {
    if (v instanceof GNode) {
      if (v.evidence) evidence.add(v.evidence)
      const p = (k: string) => (v.props.get(k) ?? null) as Cell
      return v.labels[0] === 'external' ? { id: v.id, kind: 'external', name: v.name, module: p('module') }
        : { id: v.id, kind: v.labels.includes('file') ? 'file' : String(p('kind')), name: v.name, path: p('path'), line: p('line'), ...(v.props.has('key') ? { key: p('key') } : {}) }
    }
    if (v instanceof GRel) {
      const site = run.g.site(v)
      for (const e of site.evidence) evidence.add(e)
      return { id: v.id, type: v.type, from: v.src, to: v.dst, from_name: run.g.node(v.src)!.name, to_name: run.g.node(v.dst)!.name, path: site.path, line: site.line, basis: (v.props.get('basis') ?? null) as Cell }
    }
    if (v instanceof GPath) return { nodes: v.nodes.map(cell), relationships: v.rels.map(cell) }
    if (Array.isArray(v)) return v.map(cell)
    return v
  }
  const rows = out.map((b) => ({ values: ret.items.map((it) => cell(b.get(it.name) ?? null)), ...(b.get(INFERRED) ? { inferred: true } : {}) }))
  return { columns: ret.items.map((it) => it.name), rows, stop: run.stop, evidence: [...evidence], aggregateCut: run.aggregateCut }
}

/** A row as lean text: its first node, relationship or path as `name path:line`, the other columns as `column=value` tags (FR964). */
export function leanQueryRows(columns: string[], row: QueryRow): string[] {
  const isObj = (v: Cell): v is { [k: string]: Cell } => !!v && typeof v === 'object' && !Array.isArray(v)
  const short = (v: Cell): string => {
    if (Array.isArray(v)) return `[${v.map(short).join(',')}]`
    if (!isObj(v)) return typeof v === 'string' ? quote(v) : String(v)
    if ('nodes' in v) return `path(${(v.nodes as Cell[]).length - 1})`
    const name = String('from' in v ? v.from_name : v.name)
    return quote(v.path ? `${name === v.path ? '' : `${name} `}${String(v.path)}:${String(v.line)}` : name)
  }
  const first = row.values.findIndex(isObj)
  const tags = columns.flatMap((c, i) => (i === first ? [] : [`${quote(c)}=${short(row.values[i]!)}`]))
  const inferred = row.inferred ? ['inferred'] : []
  const v = row.values[first] ?? null
  if (!isObj(v)) return [[...tags, ...inferred].join(' ')]
  const nodeRow = (n: { [k: string]: Cell }, extra: string[]) =>
    n.kind === 'external' ? leanRow(String(n.name), null, null, ['external', ...extra]) : leanRow(String(n.name), n.path as string, n.line as number, [String(n.kind), ...extra])
  if ('nodes' in v) return (v.nodes as Array<{ [k: string]: Cell }>).map((n, j) => nodeRow(n, [...(j ? [`depth=${j}`] : tags), ...inferred]))
  if ('from' in v) return [leanRow(String(v.from_name), v.path as string, v.line as number, [String(v.type), ...tags, ...inferred])]
  return [nodeRow(v, [...tags, ...inferred])]
}
