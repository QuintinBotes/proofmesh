// Test roles (FR192, FR193): which symbols are test entry points by the marker their framework uses, and which are test code without being one.
// Markers are syntax, so this reads the tree alone. A symbol is `test` for an entry point, `test_support` for test code that is none: the members
// of a Rust #[cfg(test)] module, the helpers of a test class. A symbol that is neither has no role.
import path from 'node:path'
import type { Node } from 'web-tree-sitter'

export type Def = { id: string; node: Node; qualified: string }
type Import = { node: Node; detail?: Record<string, string> }
const TEST = 'test', SUPPORT = 'test_support'

// What other files declare, for the markers that follow a base class and for Rust modules a parent marks #[cfg(test)]. Read from text at initialize, since
// each file is analysed alone; the unit of a file depends on the files whose classes its bases name (see unitDependencies), so a change there reanalyses it.
type Decl = { base: string; path: string }
const repoClasses = new Map<string, Decl[]>(), cfgTestModules = new Map<string, string>()
const simple = (n: string) => n.replace(/<.*$/, '').split(/::|\.|\\/).filter(Boolean).at(-1) ?? ''
const CLASS_DECLARATION: Record<string, RegExp> = {
  php: /\bclass\s+(\w+)(?:\s+extends\s+([\\\w]+))?/g,
  java: /\bclass\s+(\w+)(?:<[^>{]*>)?(?:\s+extends\s+([\w.]+))?/g,
  kotlin: /\bclass\s+(\w+)(?:<[^>{]*>)?\s*(?:\([^)]*\))?(?:\s*:\s*([\w.]+)\s*(?:<[^()]*>)?\s*\()?/g,
  ruby: /^[ \t]*class\s+(\w+)(?:\s*<\s*([\w:]+))?/gm,
}
const CFG_TEST_MODULE = /#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g
/** The file a Rust `mod name;` declared in `parent` names: name.rs or name/mod.rs, beside a lib, main or mod file and under the directory of any other. */
const moduleFiles = (parent: string, name: string) => {
  const dir = path.posix.dirname(parent), stem = path.posix.basename(parent, '.rs')
  const base = ['lib', 'main', 'mod'].includes(stem) ? dir : path.posix.join(dir, stem)
  return [path.posix.join(base, `${name}.rs`), path.posix.join(base, name, 'mod.rs')]
}
/** Reads the repository once: the classes each file declares with their base, and the Rust modules marked #[cfg(test)], transitively. */
export function scanRepository(files: Array<{ path: string; language: string }>, read: (p: string) => string): void {
  repoClasses.clear(); cfgTestModules.clear()
  const known = new Set(files.map((f) => f.path))
  const rust: string[] = []
  for (const f of files) {
    const re = CLASS_DECLARATION[f.language]
    if (f.language === 'rust') rust.push(f.path)
    if (!re) continue
    const text = read(f.path)
    for (const m of text.matchAll(re)) repoClasses.set(`${f.language}:${m[1]}`, [...(repoClasses.get(`${f.language}:${m[1]}`) ?? []), { base: m[2] ?? '', path: f.path }])
  }
  const marked = (p: string) => [...read(p).matchAll(CFG_TEST_MODULE)].flatMap((m) => moduleFiles(p, m[1]!)).filter((c) => known.has(c)).map((c) => [c, p] as const)
  // A module declared under a test module is test code too, so the files are followed from every file already known to be one.
  const queue = rust.flatMap(marked)
  for (const [child, parent] of queue) {
    if (cfgTestModules.has(child)) continue
    cfgTestModules.set(child, parent)
    queue.push(...marked(child))
  }
}
export const isCfgTestModule = (file: string) => cfgTestModules.has(file)
/** The files whose declarations the facts of a file depend on: the Rust file that marks it a test module, and the files of the base classes its own classes name. */
export function unitDependencies(file: string, language: string): string[] {
  const out = new Set<string>()
  if (language === 'rust' && cfgTestModules.has(file)) out.add(cfgTestModules.get(file)!)
  const own = [...repoClasses.entries()].filter(([k, ds]) => k.startsWith(`${language}:`) && ds.some((d) => d.path === file))
  const walk = (base: string, hops: number) => {
    if (hops === 0 || !base) return
    for (const d of repoClasses.get(`${language}:${simple(base)}`) ?? []) { out.add(d.path); if (d.base) walk(d.base, hops - 1) }
  }
  for (const [, ds] of own) for (const d of ds.filter((x) => x.path === file)) walk(d.base, HOPS)
  out.delete(file)
  return [...out].sort()
}

/** How far a base chain is followed through the repository: a class, its base, and that base's base. */
const HOPS = 2
/** What a base chain says: yes when it reaches a test case, unknown when it leaves the repository, no when it ends in the repository or runs out of hops. */
function classify(language: string, base: string, direct: (b: string) => boolean, hops = HOPS): 'yes' | 'no' | 'unknown' {
  if (!base) return 'no'
  if (direct(base)) return 'yes'
  const declared = repoClasses.get(`${language}:${simple(base)}`)
  if (!declared?.length) return 'unknown'
  if (hops === 0) return 'no'
  const out = declared.map((d) => classify(language, d.base, direct, hops - 1))
  return out.includes('yes') ? 'yes' : out.includes('unknown') ? 'unknown' : 'no'
}
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|Tests?\.(php|java|kts?|cs)$|_(spec|test)\.rb$/
/** An RSpec or Minitest spec file by convention: `describe`, `it` and friends outside one are ordinary calls of a DSL. */
export const isRubySpec = (file: string) => /(^|\/)(spec|test)\/|_(spec|test)\.rb$/.test(file)
const TEST_CLASS_NAME = /Tests?$|^Test/
/**
 * Whether a class with a base that is not itself a test case is one: its base chain reaches one through the repository (up to HOPS bases), or leaves the
 * repository, and the class is named like a test in a test file.
 */
function derivesTest(language: string, file: string, className: string, base: string | undefined, direct: (b: string) => boolean): boolean {
  if (!base) return false
  const c = classify(language, base, direct)
  return c === 'yes' || (c === 'unknown' && TEST_CLASS_NAME.test(className) && TEST_FILE.test(file))
}

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
function rustRoles(file: string, defs: Def[]): Map<string, string[]> {
  const roles = new Map<string, string[]>()
  // A file a parent declares as `#[cfg(test)] mod name;` is a test module: everything in it is test support.
  const outOfLine = isCfgTestModule(file)
  const support = defs.filter((d) => rustAttributes(d.node).some((a) => a.path === 'cfg' && /^\(\s*test\s*\)$/.test(a.args)))
  for (const d of defs) {
    const attrs = rustAttributes(d.node)
    if (d.node.type === 'function_item' && attrs.some((a) => a.path === 'test' || a.path === 'rstest' || a.path.endsWith('::test'))) roles.set(d.id, [TEST])
    else if (outOfLine || support.some((s) => s === d || within(d.node, s.node))) roles.set(d.id, [SUPPORT])
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
function jvmRoles(lang: 'java' | 'kotlin', file: string, text: string, defs: Def[]): Map<string, string[]> {
  const bound = importedNames(text)
  const direct = (b: string) => /\bTestCase$/.test(b)
  const specs = (d: Def) => d.node.namedChildren.find((c) => c.type === 'delegation_specifiers')
  // Kotlin lists supertypes after a colon; the class is the one called with a constructor invocation.
  const base = (d: Def) => (lang === 'java' ? d.node.childForFieldName('superclass')?.text.replace(/^extends\s+/, '').replace(/<.*$/, '').trim() : specs(d)?.descendantsOfType('constructor_invocation')[0]?.namedChildren[0]?.text.replace(/<.*$/, ''))
  const testCase = (d: Def) => (lang === 'java' ? direct(d.node.childForFieldName('superclass')?.text.replace(/^extends\s+/, '').trim() ?? '') : /\bTestCase\b/.test(specs(d)?.text ?? '')) || derivesTest(lang, file, name(d.node), base(d), direct)
  return classRoles(defs, {
    isClass: (d) => d.node.type === 'class_declaration',
    isTestClass: testCase,
    isEntry: (d, owner) => annotationNames(d.node).some((a) => isTestAnnotation(a, bound)) || (!!owner && testCase(owner) && /^test/.test(name(d.node)) && (d.node.type === 'method_declaration' || d.node.type === 'function_declaration')),
  })
}

// PHP (PHPUnit): a method of a class that extends a TestCase, named test*, tagged @test in its docblock, or carrying #[Test].
function phpRoles(file: string, defs: Def[]): Map<string, string[]> {
  const direct = (b: string) => b.split('\\').at(-1)!.endsWith('TestCase')
  const base = (d: Def) => (d.node.namedChildren.find((c) => c.type === 'base_clause')?.text ?? '').replace(/^extends\s*/, '').trim()
  const testCase = (d: Def) => direct(base(d)) || derivesTest('php', file, name(d.node), base(d) || undefined, direct)
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
function rubyRoles(file: string, defs: Def[], examples: Set<string>): Map<string, string[]> {
  // Minitest::Test, Test::Unit::TestCase, ActionDispatch::IntegrationTest, ApplicationSystemTestCase, ActiveSupport::TestCase and any app base named so.
  const direct = (b: string) => /(Test|TestCase)$/.test(b)
  const base = (d: Def) => d.node.childForFieldName('superclass')?.namedChildren[0]?.text
  const testCase = (d: Def) => direct(base(d) ?? '') || derivesTest('ruby', file, simple(d.node.childForFieldName('name')?.text ?? ''), base(d), direct)
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
    case 'rust': return rustRoles(file, defs)
    case 'java': return jvmRoles('java', file, text, defs)
    case 'kotlin': return jvmRoles('kotlin', file, text, defs)
    case 'php': return phpRoles(file, defs)
    case 'swift': return swiftRoles(defs)
    case 'ruby': return rubyRoles(file, defs, examples)
    // A googletest macro is its own definition, named by gtestName: every one is an entry point.
    case 'c': case 'cpp': return new Map(defs.filter((d) => gtestName(d.node)).map((d) => [d.id, [TEST]]))
    default: return new Map()
  }
}

/** Drops the dependencies that close a cycle, which name matching can invent (two classes of one name in different namespaces). */
export function withoutCycles(deps: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>(), state = new Map<string, 1 | 2>()
  const visit = (v: string) => {
    state.set(v, 1)
    const kept: string[] = []
    for (const w of deps.get(v) ?? []) {
      if (state.get(w) === 1) continue
      kept.push(w)
      if (!state.has(w)) visit(w)
    }
    out.set(v, kept)
    state.set(v, 2)
  }
  for (const v of deps.keys()) if (!state.has(v)) visit(v)
  return out
}
