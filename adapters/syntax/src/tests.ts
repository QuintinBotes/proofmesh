// Test roles (FR192, FR193): which symbols are test entry points by the marker their framework uses, and which are test code without being one.
// Markers are syntax, so this reads the tree alone. A symbol is `test` for an entry point, `test_support` for test code that is none: the members
// of a Rust #[cfg(test)] module, the helpers of a test class. A symbol that is neither has no role.
import type { Node } from 'web-tree-sitter'

export type Def = { id: string; node: Node; qualified: string }
type Import = { node: Node; detail?: Record<string, string> }
const TEST = 'test', SUPPORT = 'test_support'

const within = (inner: Node, outer: Node) => outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex && outer !== inner
const name = (n: Node) => n.childForFieldName('name')?.text ?? ''
const last = (path: string) => path.split(/::|\./).at(-1) ?? ''

/**
 * The roles of a class-like marker language: an entry point is a test; a class holding one, or the language says is a test class, and every other
 * member of such a class, is test support.
 */
function classRoles(defs: Def[], o: { isClass: (d: Def) => boolean; isTestClass: (d: Def) => boolean; isEntry: (d: Def, owner: Def | undefined) => boolean }): Map<string, string[]> {
  const roles = new Map<string, string[]>()
  const ownerOf = (d: Def) => defs.filter((c) => o.isClass(c) && within(d.node, c.node)).sort((a, b) => b.node.startIndex - a.node.startIndex)[0]
  const entries = defs.filter((d) => !o.isClass(d) && o.isEntry(d, ownerOf(d)))
  const containers = defs.filter((c) => o.isClass(c) && (o.isTestClass(c) || entries.some((e) => within(e.node, c.node))))
  for (const c of containers) roles.set(c.id, [SUPPORT])
  for (const d of defs) {
    if (o.isClass(d)) continue
    if (entries.includes(d)) roles.set(d.id, [TEST])
    else if (containers.some((c) => within(d.node, c.node))) roles.set(d.id, [SUPPORT])
  }
  return roles
}

// Go: only a _test.go file is compiled as a test. A function is a test, benchmark or fuzz target by its name and its one testing parameter,
// an example by its name and no parameter; a method, TestMain and a name that continues in lower case ("Testing") are none.
const GO_KIND: Record<string, string> = { Test: 'T', Benchmark: 'B', Fuzz: 'F' }
function goRoles(file: string, defs: Def[], imports: Import[]): Map<string, string[]> {
  const roles = new Map<string, string[]>()
  if (!file.endsWith('_test.go')) return roles
  const pkg = imports.find((i) => i.detail?.module === 'testing')?.detail?.alias ?? 'testing'
  for (const d of defs) {
    if (d.node.type !== 'function_declaration') continue
    const n = name(d.node), prefix = /^(Test|Benchmark|Fuzz|Example)(?![a-z])/.exec(n)?.[1]
    if (!prefix) continue
    const params = d.node.childForFieldName('parameters')?.namedChildren.filter((p) => p.type === 'parameter_declaration') ?? []
    const ok = prefix === 'Example' ? params.length === 0 : params.length === 1 && params[0]!.childForFieldName('type')?.text === `*${pkg}.${GO_KIND[prefix]}`
    if (ok) roles.set(d.id, [TEST])
  }
  return roles
}

// Rust: #[test] and an attribute that ends in ::test (#[tokio::test]); a #[cfg(test)] item and everything in it is test support.
const rustAttributes = (n: Node) => {
  const out: Array<{ path: string; args: string }> = []
  for (let s = n.previousNamedSibling; s && (s.type === 'attribute_item' || s.type === 'line_comment' || s.type === 'block_comment'); s = s.previousNamedSibling) {
    const a = s.namedChildren.find((c) => c.type === 'attribute')
    if (a) out.push({ path: a.namedChildren[0]?.text ?? '', args: a.childForFieldName('arguments')?.text ?? '' })
  }
  return out
}
function rustRoles(defs: Def[]): Map<string, string[]> {
  const roles = new Map<string, string[]>()
  const support = defs.filter((d) => rustAttributes(d.node).some((a) => a.path === 'cfg' && /^\(\s*test\s*\)$/.test(a.args)))
  for (const d of defs) {
    const attrs = rustAttributes(d.node)
    if (d.node.type === 'function_item' && attrs.some((a) => a.path === 'test' || a.path === 'rstest' || a.path.endsWith('::test'))) roles.set(d.id, [TEST])
    else if (support.some((s) => s === d || within(d.node, s.node))) roles.set(d.id, [SUPPORT])
  }
  return roles
}

// Java and Kotlin: JUnit's and TestNG's annotations, by their simple name, through the import when the file names one (also under another name:
// a Kotlin `import org.junit.Test as T`), and a TestCase subclass's test* methods.
const TEST_ANNOTATIONS = new Set(['Test', 'ParameterizedTest', 'RepeatedTest', 'TestFactory', 'TestTemplate'])
const FRAMEWORK = /^(org\.junit|junit|org\.testng|kotlin\.test|io\.kotest)\./
/** The names a file's imports bind: the alias or the last segment, to the whole path. */
function importedNames(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?(?:\s+as\s+(\w+))?\s*;?\s*$/gm)) if (!m[0].includes('*')) out.set(m[2] ?? m[1]!.split('.').at(-1)!, m[1]!)
  return out
}
const isTestAnnotation = (written: string, bound: Map<string, string>) => {
  if (written.includes('.')) return TEST_ANNOTATIONS.has(last(written)) && FRAMEWORK.test(written)
  const path = bound.get(written)
  // A name the file imports from somewhere else is not JUnit's; one it does not import (a wildcard, the same package) is taken as written.
  return path !== undefined ? TEST_ANNOTATIONS.has(last(path)) && FRAMEWORK.test(path) : TEST_ANNOTATIONS.has(written)
}
function annotationNames(n: Node): string[] {
  const mods = n.namedChildren.find((c) => c.type === 'modifiers')
  if (!mods) return []
  return mods.namedChildren.flatMap((a) => {
    if (a.type === 'marker_annotation' || (a.type === 'annotation' && a.childForFieldName('name'))) return [a.childForFieldName('name')!.text]
    if (a.type !== 'annotation') return []
    // Kotlin: `@T` is a user_type, `@T(x)` a constructor_invocation of one.
    const t = a.namedChildren[0]
    return t ? [(t.type === 'constructor_invocation' ? t.namedChildren[0] : t)?.text ?? ''] : []
  })
}
function jvmRoles(lang: 'java' | 'kotlin', text: string, defs: Def[]): Map<string, string[]> {
  const bound = importedNames(text)
  const testCase = (d: Def) => (lang === 'java' ? /\bTestCase$/.test(d.node.childForFieldName('superclass')?.text.replace(/^extends\s+/, '').trim() ?? '') : d.node.namedChildren.some((c) => c.type === 'delegation_specifiers' && /\bTestCase\b/.test(c.text)))
  return classRoles(defs, {
    isClass: (d) => d.node.type === 'class_declaration',
    isTestClass: testCase,
    isEntry: (d, owner) => annotationNames(d.node).some((a) => isTestAnnotation(a, bound)) || (!!owner && testCase(owner) && /^test/.test(name(d.node)) && (d.node.type === 'method_declaration' || d.node.type === 'function_declaration')),
  })
}

// PHP (PHPUnit): a method of a class that extends a TestCase, named test*, tagged @test in its docblock, or carrying #[Test].
function phpRoles(defs: Def[]): Map<string, string[]> {
  const testCase = (d: Def) => (d.node.namedChildren.find((c) => c.type === 'base_clause')?.text ?? '').replace(/^extends\s*/, '').trim().split('\\').at(-1)!.endsWith('TestCase')
  return classRoles(defs, {
    isClass: (d) => d.node.type === 'class_declaration',
    isTestClass: testCase,
    isEntry: (d, owner) => {
      if (d.node.type !== 'method_declaration' || !owner || !testCase(owner)) return false
      const docblock = d.node.previousNamedSibling?.type === 'comment' ? d.node.previousNamedSibling.text : ''
      const attributes = d.node.childForFieldName('attributes')?.descendantsOfType('attribute').map((a) => a.namedChildren[0]?.text ?? '') ?? []
      return /^test/.test(name(d.node)) || /@test\b/.test(docblock) || attributes.some((a) => a.split('\\').at(-1) === 'Test')
    },
  })
}

// Swift (XCTest): a test* method without parameters of a class that inherits an XCTestCase; Swift Testing's @Test function.
function swiftRoles(defs: Def[]): Map<string, string[]> {
  const testCase = (d: Def) => d.node.namedChildren.some((c) => c.type === 'inheritance_specifier' && /(^|\.)\w*TestCase$/.test(c.childForFieldName('inherits_from')?.text ?? ''))
  const marked = (n: Node) => !!n.namedChildren.find((c) => c.type === 'modifiers')?.namedChildren.some((m) => m.type === 'attribute' && /^@Test\b/.test(m.text))
  return classRoles(defs, {
    isClass: (d) => d.node.type === 'class_declaration',
    isTestClass: testCase,
    isEntry: (d, owner) => d.node.type === 'function_declaration' && (marked(d.node) || (!!owner && testCase(owner) && /^test/.test(name(d.node)) && !d.node.namedChildren.some((c) => c.type === 'parameter'))),
  })
}

// Ruby: an RSpec example block is a test (see rubyBlocks); a test_* method of a class whose superclass is a Minitest or Test::Unit test case.
function rubyRoles(defs: Def[], examples: Set<string>): Map<string, string[]> {
  const testCase = (d: Def) => /(^|::)(Test|TestCase)$/.test(d.node.childForFieldName('superclass')?.namedChildren[0]?.text ?? '')
  const roles = classRoles(defs.filter((d) => !examples.has(d.id)), {
    isClass: (d) => d.node.type === 'class',
    isTestClass: testCase,
    isEntry: (d, owner) => d.node.type === 'method' && !!owner && testCase(owner) && /^test_?/.test(name(d.node)),
  })
  for (const id of examples) roles.set(id, [TEST])
  return roles
}

// C and C++ (googletest): TEST, TEST_F, TEST_P and the typed variants, which the grammar reads as a function named after the macro.
const GTEST = new Set(['TEST', 'TEST_F', 'TEST_P', 'TYPED_TEST', 'TYPED_TEST_P'])
/** The macro as it is written, `TEST(Calc, Adds)`, when the definition is a googletest test. */
export function gtestName(node: Node): string | null {
  // The tags query names the declarator; a macro that is only declared, with no body, is no test.
  const declarator = node.type === 'function_declarator' ? node : node.type === 'function_definition' ? node.childForFieldName('declarator') : null
  if (declarator?.type !== 'function_declarator' || (node === declarator && declarator.parent?.type !== 'function_definition')) return null
  const macro = declarator.childForFieldName('declarator')?.text ?? ''
  if (!GTEST.has(macro)) return null
  const params = declarator.childForFieldName('parameters')?.namedChildren.map((p) => p.childForFieldName('type')?.text ?? p.text) ?? []
  return `${macro}(${params.join(', ')})`
}

/** RSpec: a `describe`, `context` or `feature` block groups examples, and an `it`, `specify` or `example` block with a description is one. */
const GROUPS = new Set(['describe', 'context', 'feature', 'xdescribe', 'shared_examples', 'shared_context', 'shared_examples_for'])
const EXAMPLES = new Set(['it', 'specify', 'example', 'scenario', 'xit', 'fit'])
export function rubyBlocks(root: Node): { examples: Array<{ node: Node; name: string }>; groups: Array<{ node: Node; qualified: string }> } {
  const examples: Array<{ node: Node; name: string }> = [], groups: Array<{ node: Node; qualified: string }> = []
  for (const c of root.descendantsOfType('call')) {
    const block = c.childForFieldName('block'), method = c.childForFieldName('method')?.text ?? ''
    // `RSpec.describe` names a group too; any other receiver is a method that only shares the name.
    const receiver = c.childForFieldName('receiver')?.text
    if (!block || (receiver && receiver !== 'RSpec')) continue
    const arg = c.childForFieldName('arguments')?.namedChildren[0]
    const text = arg?.type === 'string' ? (arg.namedChildren.find((s) => s.type === 'string_content')?.text ?? '') : null
    if (EXAMPLES.has(method) && !receiver) examples.push({ node: c, name: text === null ? method : `${method} "${text}"` })
    else if (GROUPS.has(method)) groups.push({ node: c, qualified: arg ? (text ?? arg.text) : method })
  }
  return { examples, groups }
}

/** The roles of the symbols a file declares, by local id. `text` is the file's source, for the languages whose imports are read from it. */
export function testRoles(lang: string, file: string, text: string, defs: Def[], imports: Import[], examples: Set<string>): Map<string, string[]> {
  switch (lang) {
    case 'go': return goRoles(file, defs, imports)
    case 'rust': return rustRoles(defs)
    case 'java': return jvmRoles('java', text, defs)
    case 'kotlin': return jvmRoles('kotlin', text, defs)
    case 'php': return phpRoles(defs)
    case 'swift': return swiftRoles(defs)
    case 'ruby': return rubyRoles(defs, examples)
    // A googletest macro is its own definition, named by gtestName: every one is an entry point.
    case 'c': case 'cpp': return new Map(defs.filter((d) => gtestName(d.node)).map((d) => [d.id, [TEST]]))
    default: return new Map()
  }
}
