// A reader of Bazel and Buck build files for the build adapter (FR246 to FR249): the top-level calls of a BUILD, BUILD.bazel or BUCK file
// as a small expression tree with where each piece sits. A build file is code, so only what a literal gives is read: nothing is evaluated,
// a macro is not expanded, and a name bound to a value is an opaque `other` node the caller names as dynamic.
import { ParseError } from './jvm.js'

export type SNode =
  | { kind: 'string'; value: string; start: number; end: number }
  | { kind: 'list'; items: SNode[]; start: number; end: number }
  | { kind: 'dict'; entries: Array<{ key: SNode; value: SNode }>; start: number; end: number }
  | { kind: 'call'; name: string; args: Array<{ name?: string; value: SNode }>; start: number; end: number }
  | { kind: 'concat'; parts: SNode[]; start: number; end: number }
  | { kind: 'other'; start: number; end: number }

export type StarlarkFile = {
  /** The calls written at the top level of the file, in order. */
  calls: Array<Extract<SNode, { kind: 'call' }>>
  /** Names a `load(...)` brings in, each with the label it is loaded from: a call to one is a macro or rule defined elsewhere, which is not expanded. */
  loaded: Map<string, string>
  /** Where a `for`, `if` or `def` statement starts: what it holds is not read. */
  compound: number[]
}

type Tok = { t: 'id' | 'str' | 'num' | 'op' | 'nl'; text: string; start: number; end: number; value?: string; indented?: boolean }
const OPS3 = ['**=', '//=', '>>=', '<<=']
const OPS2 = ['==', '!=', '<=', '>=', '**', '//', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '->', '<<', '>>']
const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '0': '\0' }
const MAX_DEPTH = 100
const WORD_OPS = new Set(['if', 'else', 'in', 'not', 'and', 'or', 'is', 'for', 'lambda'])
const BLOCK = new Set(['for', 'if', 'def', 'else', 'elif', 'while', 'try', 'except', 'with', 'class'])

function lex(text: string): Tok[] {
  const toks: Tok[] = []
  let i = 0, depth = 0, lineStart = true
  while (i < text.length) {
    const c = text[i]!
    if (c === '\n') { if (depth === 0) toks.push({ t: 'nl', text: '\n', start: i, end: i + 1 }); i++; lineStart = true; continue }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (c === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) { i += text[i + 1] === '\n' ? 2 : 3; continue }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue }
    const start = i
    const indented = lineStart && depth === 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')
    lineStart = false
    const quote = /^[rRbB]{0,2}(['"])/.exec(text.slice(i, i + 3))
    if (quote) {
      const raw = /[rR]/.test(text.slice(i, i + quote[0].length - 1))
      i += quote[0].length - 1
      const q = text[i]!, triple = text.startsWith(q.repeat(3), i)
      i += triple ? 3 : 1
      let value = ''
      for (;;) {
        if (i >= text.length) throw new ParseError('unterminated string', start)
        if (triple ? text.startsWith(q.repeat(3), i) : text[i] === q) { i += triple ? 3 : 1; break }
        if (text[i] === '\n' && !triple) throw new ParseError('unterminated string', start)
        if (text[i] === '\\' && !raw) { const n = text[i + 1] ?? ''; value += Object.hasOwn(ESC, n) ? ESC[n] : '\\' + n; i += 2; continue }
        value += text[i++]
      }
      toks.push({ t: 'str', text: text.slice(start, i), start, end: i, value, indented })
      continue
    }
    if (/[A-Za-z_]/.test(c)) { while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) i++; toks.push({ t: 'id', text: text.slice(start, i), start, end: i, indented }); continue }
    if (/[0-9]/.test(c)) { while (i < text.length && /[\w.]/.test(text[i]!)) i++; toks.push({ t: 'num', text: text.slice(start, i), start, end: i, indented }); continue }
    const op = OPS3.find((o) => text.startsWith(o, i)) ?? OPS2.find((o) => text.startsWith(o, i)) ?? c
    if (!/[()[\]{},.:;=+\-*/%<>|&^~!@]/.test(c)) throw new ParseError(`unexpected character ${JSON.stringify(c)}`, i)
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) { depth--; if (depth < 0) throw new ParseError(`unbalanced ${JSON.stringify(c)}`, i) }
    i += op.length
    toks.push({ t: 'op', text: op, start, end: i, indented })
  }
  if (depth > 0) throw new ParseError('a bracket is never closed', text.length)
  return toks
}

export function parseStarlark(text: string): StarlarkFile {
  const toks = lex(text)
  const file: StarlarkFile = { calls: [], loaded: new Map(), compound: [] }
  let p = 0
  const peek = () => toks[p]
  const isOp = (s: string) => peek()?.t === 'op' && peek()!.text === s
  const at = () => peek()?.start ?? text.length
  const expect = (s: string) => { if (!isOp(s)) throw new ParseError(`expected ${JSON.stringify(s)}, found ${peek() ? JSON.stringify(peek()!.text) : 'the end'}`, at()); return toks[p++]! }

  function primary(depth: number): SNode {
    if (depth > MAX_DEPTH) throw new ParseError('nested too deeply', at())
    const tok = peek()
    if (!tok || tok.t === 'nl') throw new ParseError('expected an expression', at())
    let node: SNode
    if (tok.t === 'str') {
      // Adjacent string literals are one string.
      let value = '', end = tok.end
      while (peek()?.t === 'str') { value += peek()!.value; end = peek()!.end; p++ }
      node = { kind: 'string', value, start: tok.start, end }
    } else if (tok.t === 'num') { p++; node = { kind: 'other', start: tok.start, end: tok.end } }
    else if (tok.t === 'id') {
      p++
      node = { kind: 'other', start: tok.start, end: tok.end }
      if (isOp('(')) node = call(tok, depth)
    } else if (tok.text === '[') {
      p++
      const items: SNode[] = []
      let comprehension = false
      while (!isOp(']')) {
        items.push(expr(depth + 1))
        if (peek()?.t === 'id' && peek()!.text === 'for') { comprehension = true; while (!isOp(']')) { if (!peek()) throw new ParseError('a bracket is never closed', text.length); skipBracketed() } break }
        if (isOp(',')) p++
        else if (!isOp(']')) throw new ParseError(`expected "," or "]", found ${peek() ? JSON.stringify(peek()!.text) : 'the end'}`, at())
      }
      const end = expect(']').end
      node = comprehension ? { kind: 'other', start: tok.start, end } : { kind: 'list', items, start: tok.start, end }
    } else if (tok.text === '{') {
      p++
      const entries: Array<{ key: SNode; value: SNode }> = []
      let comprehension = false
      while (!isOp('}')) {
        const key = expr(depth + 1)
        expect(':')
        entries.push({ key, value: expr(depth + 1) })
        if (peek()?.t === 'id' && peek()!.text === 'for') { comprehension = true; while (!isOp('}')) { if (!peek()) throw new ParseError('a bracket is never closed', text.length); skipBracketed() } break }
        if (isOp(',')) p++
        else if (!isOp('}')) throw new ParseError(`expected "," or "}", found ${peek() ? JSON.stringify(peek()!.text) : 'the end'}`, at())
      }
      const end = expect('}').end
      node = comprehension ? { kind: 'other', start: tok.start, end } : { kind: 'dict', entries, start: tok.start, end }
    } else if (tok.text === '(') {
      p++
      const inner = isOp(')') ? { kind: 'other', start: tok.start, end: tok.end } as SNode : expr(depth + 1)
      // A tuple, or a parenthesised expression with more in it, is read only as far as its first element's kind.
      let tuple = false
      while (isOp(',')) { tuple = true; p++; if (!isOp(')')) expr(depth + 1) }
      const end = expect(')').end
      node = tuple ? { kind: 'other', start: tok.start, end } : { ...inner, start: tok.start, end }
    } else if (tok.t === 'op' && ['-', '+', '~', '*', '**'].includes(tok.text)) { p++; const inner = primary(depth + 1); node = { kind: 'other', start: tok.start, end: inner.end } }
    else throw new ParseError(`unexpected ${JSON.stringify(tok.text)}`, tok.start)
    // Attribute access and indexing make the value opaque.
    while (isOp('.') || isOp('[') || (isOp('(') && node.kind !== 'other')) {
      if (isOp('.')) { p++; if (peek()?.t !== 'id') throw new ParseError('expected a name after "."', at()); const id = toks[p++]!; node = { kind: 'other', start: node.start, end: id.end }; if (isOp('(')) node = call({ ...id, text: id.text }, depth, true, node.start) }
      else if (isOp('[')) { p++; expr(depth + 1); while (isOp(':')) { p++; if (!isOp(']')) expr(depth + 1) } node = { kind: 'other', start: node.start, end: expect(']').end } }
      else break
    }
    return node
  }
  /** Skips one token, and the bracketed group it opens. */
  function skipBracketed() {
    const t = toks[p++]!
    if (t.t === 'op' && '([{'.includes(t.text)) { let d = 1; while (d && p < toks.length) { const n = toks[p++]!; if (n.t === 'op' && '([{'.includes(n.text)) d++; else if (n.t === 'op' && ')]}'.includes(n.text)) d-- } }
  }
  function call(name: Tok, depth: number, method = false, start = name.start): SNode {
    expect('(')
    const args: Array<{ name?: string; value: SNode }> = []
    while (!isOp(')')) {
      if (peek()?.t === 'id' && toks[p + 1]?.t === 'op' && toks[p + 1]!.text === '=') { const n = toks[p]!.text; p += 2; args.push({ name: n, value: expr(depth + 1) }) }
      else args.push({ value: expr(depth + 1) })
      if (peek()?.t === 'id' && peek()!.text === 'for') { while (!isOp(')')) { if (!peek()) throw new ParseError('a bracket is never closed', text.length); skipBracketed() } break }
      if (isOp(',')) p++
      else if (!isOp(')')) throw new ParseError(`expected "," or ")", found ${peek() ? JSON.stringify(peek()!.text) : 'the end'}`, at())
    }
    const end = expect(')').end
    // A method call (`"x".format(...)`) is a value, not a rule.
    return method ? { kind: 'other', start, end } : { kind: 'call', name: name.text, args, start, end }
  }
  /** Operands joined by operators. `+` joins lists and selects, which concatenate; any other operator makes the value opaque. */
  function expr(depth: number): SNode {
    const first = primary(depth)
    const parts = [first]
    let opaque = false, concat = false
    for (;;) {
      const t = peek()
      if (!t) break
      if (t.t === 'op' && t.text === '+') { p++; parts.push(primary(depth)); concat = true; continue }
      if ((t.t === 'op' && ['-', '*', '/', '//', '%', '|', '&', '^', '<<', '>>', '==', '!=', '<', '>', '<=', '>=', '**'].includes(t.text)) || (t.t === 'id' && WORD_OPS.has(t.text) && !(t.text === 'for'))) {
        p++; opaque = true
        if (t.text === 'lambda') { while (peek() && !isOp(':')) p++; if (isOp(':')) p++ }
        if (t.text === 'not' && peek()?.t === 'id' && peek()!.text === 'in') p++
        if (t.text === 'is' && peek()?.t === 'id' && peek()!.text === 'not') p++
        parts.push(primary(depth)); continue
      }
      break
    }
    if (parts.length === 1) return first
    const end = parts.at(-1)!.end
    return opaque ? { kind: 'other', start: first.start, end } : { kind: 'concat', parts: concat ? parts : [first], start: first.start, end }
  }

  while (p < toks.length) {
    const t = toks[p]!
    if (t.t === 'nl') { p++; continue }
    // Whatever is indented under a compound statement is not read.
    if (t.indented) { while (p < toks.length && toks[p]!.t !== 'nl') p++; continue }
    if (t.t === 'id' && BLOCK.has(t.text)) { file.compound.push(t.start); while (p < toks.length && toks[p]!.t !== 'nl') p++; continue }
    const e = expr(0)
    if (e.kind === 'call') {
      if (e.name === 'load') for (const a of e.args.slice(1)) { if (a.value.kind === 'string' && e.args[0]?.value.kind === 'string') file.loaded.set(a.name ?? a.value.value, e.args[0].value.value) }
      else file.calls.push(e)
    } else if (isOp('=') || (peek()?.t === 'op' && /^[-+*/%|&^]=$/.test(peek()!.text))) { p++; expr(0) }
    if (peek() && peek()!.t !== 'nl' && !isOp(';')) throw new ParseError(`unexpected ${JSON.stringify(peek()!.text)}`, at())
    if (isOp(';')) p++
  }
  return file
}
