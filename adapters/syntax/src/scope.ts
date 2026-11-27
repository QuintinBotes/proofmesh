// What a Go, Java, Rust or PHP call site says about its callee beyond the name (FR171 to FR176): the qualifier written before it, whether that
// qualifier is a variable declared in scope (which then hides a package or type of the same name), and whether the call is `new`.
// The core binds the name from these facts and the module graph; this file only reads syntax.
import type { Node } from 'web-tree-sitter'

export type CallFacts = Record<string, string>

const before = (a: Node, b: Node) => a.endIndex <= b.startIndex
const names = (n: Node | null | undefined, type = 'identifier'): string[] => (n ? n.namedChildren.filter((c) => c.type === type).map((c) => c.text) : [])

/** The identifiers a Go declaration statement introduces. */
function goDeclared(n: Node): string[] {
  if (n.type === 'short_var_declaration') return names(n.childForFieldName('left'))
  if (n.type === 'var_declaration' || n.type === 'const_declaration') return n.descendantsOfType(['var_spec', 'const_spec']).flatMap((s) => s!.childrenForFieldName('name').map((c) => c!.text))
  return []
}
function goParameters(list: Node | null): string[] {
  return (list?.namedChildren ?? []).flatMap((p) => p.type === 'parameter_declaration' || p.type === 'variadic_parameter_declaration' ? p.childrenForFieldName('name').map((c) => c!.text) : [])
}

/** Whether `name` is declared by a variable, parameter or field in scope at `at`, for the languages whose locals hide a package or type. */
export function declaredLocally(lang: 'go' | 'java', name: string, at: Node): boolean {
  for (let child: Node = at, parent = at.parent; parent; child = parent, parent = parent.parent) {
    if (lang === 'go') {
      if (parent.type === 'statement_list' || parent.type === 'source_file') {
        if (parent.type === 'statement_list' && parent.namedChildren.some((s) => before(s, child) && goDeclared(s).includes(name))) return true
      } else if (parent.type === 'function_declaration' || parent.type === 'method_declaration' || parent.type === 'func_literal') {
        if ([parent.childForFieldName('parameters'), parent.childForFieldName('receiver'), parent.childForFieldName('result')].some((l) => l?.type === 'parameter_list' && goParameters(l).includes(name))) return true
      } else if (parent.type === 'range_clause') { /* the range expression sits in the clause; its variables are the loop's */ }
      else if (parent.type === 'for_statement') {
        const clause = parent.namedChildren.find((c) => c.type === 'range_clause' || c.type === 'for_clause')
        if (clause && clause !== child && (names(clause.childForFieldName('left')).includes(name) || goDeclared(clause.childForFieldName('initializer') ?? clause)?.includes(name))) return true
      } else if (['if_statement', 'switch_statement', 'type_switch_statement', 'expression_switch_statement'].includes(parent.type)) {
        const init = parent.childForFieldName('initializer')
        if (init && init !== child && goDeclared(init).includes(name)) return true
        if (parent.type === 'type_switch_statement' && parent.childForFieldName('alias')?.text === name) return true
      }
    } else {
      if (parent.type === 'block' || parent.type === 'switch_block_statement_group' || parent.type === 'constructor_body') {
        if (parent.namedChildren.some((s) => s.type === 'local_variable_declaration' && before(s, child) && s.namedChildren.some((v) => v.type === 'variable_declarator' && v.childForFieldName('name')?.text === name))) return true
      } else if (parent.type === 'method_declaration' || parent.type === 'constructor_declaration' || parent.type === 'lambda_expression') {
        const list = parent.childForFieldName('parameters')
        if (list?.type === 'identifier' ? list.text === name : (list?.namedChildren ?? []).some((p) => (p.type === 'formal_parameter' || p.type === 'spread_parameter' ? (p.childForFieldName('name') ?? p.namedChildren.find((c) => c.type === 'variable_declarator')?.childForFieldName('name'))?.text : p.type === 'identifier' ? p.text : undefined) === name)) return true
      } else if (parent.type === 'for_statement') {
        if (parent.childrenForFieldName('init').some((i) => i?.type === 'local_variable_declaration' && i.namedChildren.some((v) => v.type === 'variable_declarator' && v.childForFieldName('name')?.text === name))) return true
      } else if (parent.type === 'enhanced_for_statement') {
        if (parent.childForFieldName('name')?.text === name) return true
      } else if (parent.type === 'catch_clause') {
        if (parent.namedChildren.some((c) => c.type === 'catch_formal_parameter' && c.childForFieldName('name')?.text === name)) return true
      } else if (parent.type === 'resource') {
        if (parent.childForFieldName('name')?.text === name) return true
      } else if (parent.type === 'class_body') {
        if (parent.namedChildren.some((f) => f.type === 'field_declaration' && f.namedChildren.some((v) => v.type === 'variable_declarator' && v.childForFieldName('name')?.text === name))) return true
      }
    }
  }
  return false
}

/** An operand written as identifiers joined by dots, or null for anything else (a call result, an index, a literal). */
function chain(n: Node | null): string | null {
  if (!n) return null
  if (n.type === 'identifier' || n.type === 'this' || n.type === 'super') return n.text
  if (n.type === 'selector_expression') { const o = chain(n.childForFieldName('operand')); return o && n.childForFieldName('field') ? `${o}.${n.childForFieldName('field')!.text}` : null }
  if (n.type === 'field_access') { const o = chain(n.childForFieldName('object')); return o && n.childForFieldName('field') ? `${o}.${n.childForFieldName('field')!.text}` : null }
  if (n.type === 'parenthesized_expression' && n.namedChildCount === 1) return chain(n.namedChildren[0]!)
  return null
}

/** The facts of one call: `callee` is the name node, `call` the call expression (a Go call_expression, a Java method_invocation or object_creation_expression). */
export function callFacts(lang: string, call: Node, callee: Node): CallFacts {
  // A Rust path call names its qualifier as written before the last `::` (FR501).
  if (lang === 'rust') {
    let fn = call.childForFieldName('function')
    // A turbofish (`a::f::<T>()`) belongs to the callee, so the qualifier is the path inside it (FR601).
    if (fn?.type === 'generic_function') fn = fn.childForFieldName('function')
    const path = fn?.type === 'scoped_identifier' ? fn.childForFieldName('path') : null
    // Spaces matter inside `<T as Trait>`, so only those around `::` go.
    return path ? { qualifier: path.text.replace(/\s*::\s*/g, '::').replace(/\s+/g, ' ') } : {}
  }
  // A PHP call names the namespace before the last `\` (`\` alone for the global one) or the scope before `::`, as written (FR851).
  if (lang === 'php') {
    const target = call.type === 'object_creation_expression' ? call.namedChildren[0] : call.childForFieldName(call.type === 'scoped_call_expression' ? 'scope' : 'function')
    const written = target?.text.replace(/\s/g, '') ?? ''
    const qualifier = call.type === 'scoped_call_expression' ? written : target?.type === 'qualified_name' ? written.slice(0, written.lastIndexOf('\\')) || '\\' : ''
    return { ...(call.type === 'object_creation_expression' ? { form: 'new' } : {}), ...(qualifier ? { qualifier } : {}) }
  }
  if (lang !== 'go' && lang !== 'java') return {}
  if (call.type === 'object_creation_expression') {
    let type = call.childForFieldName('type')
    if (type?.type === 'generic_type') type = type.namedChildren[0] ?? null
    const qualifier = type?.type === 'scoped_type_identifier' ? type.text.replace(/\s/g, '').replace(/\.[^.]*$/, '') : ''
    return { form: 'new', ...(qualifier ? { qualifier } : {}) }
  }
  let operand: Node | null
  if (lang === 'go') {
    let fn = call.childForFieldName('function')
    while (fn?.type === 'parenthesized_expression' && fn.namedChildCount === 1) fn = fn.namedChildren[0]!
    operand = fn?.type === 'selector_expression' ? fn.childForFieldName('operand') : null
    if (fn?.type !== 'selector_expression') return declaredLocally('go', callee.text, call) ? { shadowed: 'local' } : {}
  } else {
    operand = call.childForFieldName('object')
    if (!operand) return {}
  }
  const q = chain(operand)
  if (q === null) return { receiver: 'expression' }
  const first = q.split('.')[0]!
  return { qualifier: q, ...(first !== 'this' && first !== 'super' && declaredLocally(lang, first, call) ? { shadowed: 'local' } : {}) }
}
