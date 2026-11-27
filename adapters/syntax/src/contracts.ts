// Schema-first contracts (FR400, FR401): protobuf services and messages, and GraphQL SDL types and root fields, read from captured
// text by a small tokenizer, never compiled or fetched. The build adapter reads `.proto`, `.graphql` and `.gql` files with these; the
// TypeScript adapter reads `gql` tagged templates with graphqlDocument.
// shortcut: proto2 groups, GraphQL code-first schemas (decorators, builder APIs) and the legacy comma form of `implements` are not read;
// take a Tree-sitter grammar when contracts outgrow this.
import { ParseError } from './jvm.js'

/** A declaration at [start, end) of the text: an `endpoint` (`grpc <package>.<Service>/<Method>`, `graphql <Root>.<field>`) or a type. */
export type Contract = { kind: 'endpoint' | 'message' | 'class' | 'interface' | 'enum' | 'type_alias'; name: string; qualified_name: string; start: number; end: number; signature: string | null }
/** A root field an operation selects, as the endpoint it calls, at the field's name. */
export type Operation = { endpoint: string; start: number; end: number }
type Token = { v: string; at: number; end: number; string?: boolean }

const NAME = /^[A-Za-z_]/
const MAX_NESTING = 200
const isName = (t: Token | undefined) => !!t && !t.string && NAME.test(t.v)

/** Names, numbers, strings and the punctuation a language allows; whitespace, commas and comments are skipped. */
function lex(text: string, comment: RegExp, punct: RegExp, word: RegExp): Token[] {
  const out: Token[] = []
  for (let i = 0; i < text.length;) {
    const c = text[i]!
    if (/[\s,]/.test(c)) { i++; continue }
    comment.lastIndex = i
    const m = comment.exec(text)
    if (m) {
      if (m[0].startsWith('/*') && !m[0].endsWith('*/')) throw new ParseError('unterminated comment', i)
      i += m[0].length
      continue
    }
    if (c === '"' || c === "'") {
      const block = text.startsWith('"""', i)
      let j = i + (block ? 3 : 1)
      while (j < text.length && (block ? !text.startsWith('"""', j) : text[j] !== c && text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1
      if (block ? j >= text.length : text[j] !== c) throw new ParseError('unterminated string', i)
      j += block ? 3 : 1
      out.push({ v: text.slice(i, j), at: i, end: j, string: true })
      i = j
      continue
    }
    word.lastIndex = i
    const w = word.exec(text)![0]
    if (w.length === 1 && !/[\w]/.test(w) && !punct.test(w)) throw new ParseError(`unexpected character ${JSON.stringify(w)}`, i)
    out.push({ v: w, at: i, end: i + w.length })
    i += w.length
  }
  return out
}

/** The index of the token that closes the bracket at `open`; throws when the text ends first. */
function closing(toks: Token[], open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' }
  const stack: string[] = []
  for (let i = open; i < toks.length; i++) {
    const t = toks[i]!
    if (t.string) continue
    if (pairs[t.v]) stack.push(pairs[t.v]!)
    else if (t.v === stack.at(-1)) { stack.pop(); if (!stack.length) return i }
    else if (/^[)}\]]$/.test(t.v)) throw new ParseError(`unexpected "${t.v}"`, t.at)
  }
  throw new ParseError(`"${toks[open]!.v}" is never closed`, toks[open]!.at)
}

/**
 * A `.proto` file: each rpc of a service is an endpoint `grpc <package>.<Service>/<Method>` at the rpc statement, and each message, nested
 * ones under their parent, a `message` symbol named `<package>.<Message>`. Options, `go_package` included, never change a name.
 */
export function protoContracts(text: string): Contract[] {
  const toks = lex(text, /\/\/[^\n]*|\/\*[\s\S]*?(\*\/|$)/y, /^[{}()[\]<>;=:.+\-/]$/, /[A-Za-z_][\w.]*|-?\d[\w.+-]*|\S/y)
  const out: Contract[] = []
  let pkg = ''
  // What each open brace is: a message, a service, or something that names nothing (an enum, a oneof, an option value).
  const scopes: Array<{ kind: 'message' | 'service' | 'other'; name: string; at: number; decl?: Contract }> = []
  const qualify = (name: string) => [pkg, ...scopes.filter((s) => s.kind === 'message').map((s) => s.name), name].filter(Boolean).join('.')
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!, name = toks[i + 1], open = toks[i + 2]
    if (t.string) continue
    if (t.v === '}') { const s = scopes.pop(); if (!s) throw new ParseError('unexpected "}"', t.at); if (s.decl) s.decl.end = t.end; continue }
    if (t.v === '{') { scopes.push({ kind: 'other', name: '', at: t.at }); continue }
    // Only a keyword that starts a statement declares: a field may be named `message`.
    if ((i > 0 && !/^[;{}]$/.test(toks[i - 1]!.v)) || !isName(name)) continue
    if (t.v === 'package' && !scopes.length) pkg = name!.v
    else if ((t.v === 'message' || t.v === 'service') && open?.v === '{') {
      const decl: Contract | undefined = t.v === 'message' ? { kind: 'message', name: name!.v, qualified_name: qualify(name!.v), start: t.at, end: open.end, signature: null } : undefined
      if (decl) out.push(decl)
      scopes.push({ kind: t.v, name: name!.v, at: open.at, ...(decl ? { decl } : {}) })
      i += 2
    } else if (t.v === 'rpc' && scopes.at(-1)?.kind === 'service' && open?.v === '(') {
      // rpc Name ( [stream] Request ) returns ( [stream] Response ) followed by `;` or an options block.
      const req = closing(toks, i + 2)
      if (toks[req + 1]?.v !== 'returns' || toks[req + 2]?.v !== '(') throw new ParseError(`rpc ${name!.v} has no returns clause`, t.at)
      const res = closing(toks, req + 2), after = toks[res + 1]?.v
      const end = after === '{' ? closing(toks, res + 1) : after === ';' ? res + 1 : res
      const words = (a: number, b: number) => toks.slice(a + 1, b).map((x) => x.v).join(' ')
      const service = qualify(scopes.at(-1)!.name)
      out.push({ kind: 'endpoint', name: `${service}/${name!.v}`, qualified_name: `grpc ${service}/${name!.v}`, start: t.at, end: toks[end]!.end, signature: `rpc ${name!.v}(${words(i + 2, req)}) returns (${words(req + 2, res)})` })
      i = end
    }
  }
  if (scopes.length) throw new ParseError('"{" is never closed', scopes[0]!.at)
  return out
}

const ROOTS: Record<string, string> = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' }
const TYPES: Record<string, Contract['kind']> = { type: 'class', input: 'class', interface: 'interface', enum: 'enum', union: 'type_alias', scalar: 'type_alias' }
const TOP = new Set([...Object.keys(TYPES), ...Object.keys(ROOTS), 'schema', 'extend', 'directive', 'fragment'])

/**
 * A GraphQL document. SDL: each type is a symbol named `<module>:<Type>`, as a file-scoped language names one (object and input types are classes), and each field of a root type
 * (Query, Mutation, Subscription, or the types a `schema` block names instead) is an endpoint `graphql <Root>.<field>` at the field.
 * Operations: each root field a query, mutation or subscription selects, through inline fragments and the document's own named
 * fragments, is an endpoint it calls, by the field's name and never its alias.
 */
export function graphqlDocument(text: string, module: string): { contracts: Contract[]; operations: Operation[] } {
  const toks = lex(text, /#[^\n\r]*/y, /^[!$&()[\]{}:=@|]$/, /[A-Za-z_]\w*|-?\d[\w.+-]*|\.\.\.|\S/y)
  const contracts: Contract[] = [], operations: Operation[] = []
  const roots = new Map(Object.values(ROOTS).map((r) => [r, r]))
  let schemaRoots = false
  const fields: Array<{ type: string; name: Token; end: number }> = []
  const fragments = new Map<string, { on: string; selection: number }>()
  const selections: Array<{ root: string; selection: number }> = []
  /** The index after a run of directives `@name(args)` from i. */
  const directives = (i: number) => { while (toks[i]?.v === '@') { i += 2; if (toks[i]?.v === '(') i = closing(toks, i) + 1 } return i }
  /** The index after a type reference: `Name` or `[Type]`, then `!`. */
  const typeRef = (i: number): number => { i = toks[i]?.v === '[' ? closing(toks, i) + 1 : i + 1; return toks[i]?.v === '!' ? i + 1 : i }
  for (let i = 0; i < toks.length;) {
    if (toks[i]!.string) { i++; continue }
    const extend = toks[i]!.v === 'extend'
    if (extend) i++
    const t = toks[i]
    if (!t) throw new ParseError('the document ends after "extend"', text.length)
    if (t.v === 'schema') {
      const open = directives(i + 1)
      if (toks[open]?.v !== '{') throw new ParseError('a schema block has no "{"', t.at)
      const close = closing(toks, open)
      if (!extend && !schemaRoots) { roots.clear(); schemaRoots = true }
      for (let j = open + 1; j + 2 <= close; j += 3) if (ROOTS[toks[j]!.v] && toks[j + 1]?.v === ':') roots.set(toks[j + 2]!.v, ROOTS[toks[j]!.v]!)
      i = close + 1
    } else if (TYPES[t.v]) {
      const name = toks[i + 1]
      if (!isName(name)) throw new ParseError(`${t.v} has no name`, t.at)
      let j = i + 2
      if (toks[j]?.v === 'implements') { j++; while (toks[j]?.v === '&' || (isName(toks[j]) && !TOP.has(toks[j]!.v))) j++ }
      j = directives(j)
      if (t.v === 'union' && toks[j]?.v === '=') { j++; if (toks[j]?.v === '|') j++; while (isName(toks[j])) { j++; if (toks[j]?.v !== '|') break; j++ } }
      else if (toks[j]?.v === '{') {
        const close = closing(toks, j)
        if (t.v !== 'enum') {
          for (let k = j + 1; k < close;) {
            if (toks[k]!.string) { k++; continue }
            const field = toks[k]!
            let e = k + 1
            if (toks[e]?.v === '(') e = closing(toks, e) + 1
            if (toks[e]?.v !== ':') throw new ParseError(`field ${field.v} has no type`, field.at)
            e = typeRef(e + 1)
            if (toks[e]?.v === '=') e = /^[{[]$/.test(toks[e + 1]?.v ?? '') ? closing(toks, e + 1) + 1 : e + 2
            e = directives(e)
            if (t.v === 'type') fields.push({ type: name!.v, name: field, end: toks[e - 1]!.end })
            k = e
          }
        }
        j = close + 1
      }
      if (!extend) contracts.push({ kind: TYPES[t.v]!, name: name!.v, qualified_name: `${module}:${name!.v}`, start: t.at, end: toks[j - 1]!.end, signature: null })
      i = j
    } else if (t.v === 'directive') {
      let j = i + 3
      if (toks[j]?.v === '(') j = closing(toks, j) + 1
      if (toks[j]?.v === 'repeatable') j++
      if (toks[j]?.v !== 'on') throw new ParseError('a directive definition has no locations', t.at)
      j++
      while (toks[j]?.v === '|' || (isName(toks[j]) && /^[A-Z_]+$/.test(toks[j]!.v))) j++
      i = j
    } else if (t.v === 'fragment') {
      const open = directives(i + 4)
      if (toks[i + 2]?.v !== 'on' || toks[open]?.v !== '{') throw new ParseError(`fragment ${toks[i + 1]?.v ?? ''} has no type condition or selection`, t.at)
      fragments.set(toks[i + 1]!.v, { on: toks[i + 3]!.v, selection: open })
      i = closing(toks, open) + 1
    } else if (ROOTS[t.v] || t.v === '{') {
      let open = i
      if (t.v !== '{') {
        open = isName(toks[i + 1]) ? i + 2 : i + 1
        if (toks[open]?.v === '(') open = closing(toks, open) + 1
        open = directives(open)
        if (toks[open]?.v !== '{') throw new ParseError(`the ${t.v} has no selection`, t.at)
      }
      selections.push({ root: ROOTS[t.v] ?? 'Query', selection: open })
      i = closing(toks, open) + 1
    } else throw new ParseError(`unexpected "${t.v}"`, t.at)
  }
  for (const f of fields) {
    const root = roots.get(f.type)
    if (root) contracts.push({ kind: 'endpoint', name: `${root}.${f.name.v}`, qualified_name: `graphql ${root}.${f.name.v}`, start: f.name.at, end: f.end, signature: text.slice(f.name.at, f.end).replace(/\s+/g, ' ') })
  }
  /** The fields a selection set selects at its own level, through the fragments that apply to its root type, each named one read once. */
  const rootFields = (open: number, root: string, seen: Set<string>, depth: number) => {
    // The reader recurses into fragments: nesting deeper than any real operation is refused, not left to overflow the stack.
    if (depth > MAX_NESTING) throw new ParseError(`fragments nest deeper than ${MAX_NESTING} levels`, toks[open]!.at)
    const close = closing(toks, open)
    for (let k = open + 1; k < close;) {
      const t = toks[k]!
      if (t.v === '...') {
        const next = toks[k + 1]
        if (next?.v === 'on' || next?.v === '@' || next?.v === '{') {
          const sel = directives(next.v === 'on' ? k + 3 : k + 1)
          if (toks[sel]?.v !== '{') throw new ParseError('an inline fragment has no selection', t.at)
          if (next.v !== 'on' || roots.get(toks[k + 2]!.v) === root) rootFields(sel, root, seen, depth + 1)
          k = closing(toks, sel) + 1
        } else {
          const f = next && fragments.get(next.v)
          if (f && !seen.has(next.v) && roots.get(f.on) === root) { seen.add(next.v); rootFields(f.selection, root, seen, depth + 1) }
          k = directives(k + 2)
        }
        continue
      }
      const aliased = toks[k + 1]?.v === ':', field = aliased ? toks[k + 2] : t
      if (!isName(field)) throw new ParseError(`unexpected "${field?.v ?? 'end'}" in a selection`, (field ?? t).at)
      let e = k + (aliased ? 3 : 1)
      if (toks[e]?.v === '(') e = closing(toks, e) + 1
      e = directives(e)
      if (toks[e]?.v === '{') e = closing(toks, e) + 1
      if (!field!.v.startsWith('__')) operations.push({ endpoint: `graphql ${root}.${field!.v}`, start: field!.at, end: field!.end })
      k = e
    }
  }
  for (const s of selections) rootFields(s.selection, s.root, new Set(), 0)
  return { contracts, operations }
}
