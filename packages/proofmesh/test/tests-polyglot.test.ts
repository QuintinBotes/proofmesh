import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { isTestCode, isTestPath } from '../src/query/tests.js'
import { expectedFor, fixtureRepo, indexedDataDir, indexedRepo, ROOT, symbolId, tool, withSnapshot } from './helpers.js'

// Issue 11: tests are recognised the way each language and its frameworks define them, by file convention and by the marker in code.
const EXPECTED = expectedFor('tests-polyglot')
type Sym = { id: string; kind: string; name: string; qualified_name: string; path: string; roles?: string[] }
type Key = { path: string; name: string }
const key = (s: Key) => `${s.path} ${s.name}`
const keys = (list: Key[]) => list.map(key).sort()

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir(fixtureRepo('tests-polyglot'))) }, 240000)
const symbols = (input: Record<string, unknown> = {}) => (tool(d, 'find_symbols', { text: 'a', kinds: ['function', 'method'], limits: { max_rows: 500 }, ...input }).data as unknown as { symbols: Sym[] }).symbols

describe('FR191 test files are recognised by each language\'s convention', () => {
  it.each([
    ['calc/calc_test.go'], ['calc/calc_test_test.go'], ['pkg/test_calc.py'], ['pkg/calc_test.py'], ['pkg/conftest.py'], ['conftest.py'],
    ['src/test/java/a/CalcTest.java'], ['mod/src/test/kotlin/CalcTest.kt'], ['src/CalcTest.php'], ['spec/calc_spec.rb'], ['lib/calc_test.rb'], ['lib/calc_spec.rb'],
    ['calc_test.cc'], ['src/calc_unittest.cpp'], ['include/calc_test.h'], ['test/calc_test.c'], ['Tests/CalcTests/CalcTests.swift'],
    ['src/a.test.ts'], ['src/a.spec.js'], ['Orders.Tests/Calc.cs'], ['src/CalcTests.cs'],
  ])('FR191 %s is test code', (p) => expect(isTestPath(p!)).toBe(true))

  it.each([
    ['calc/calc.go'], ['pkg/calc.py'], ['pkg/attest.py'], ['pkg/testing_utils.py'], ['src/Contest.php'], ['lib/latest.rb'], ['latest.cc'], ['src/main/java/a/Calc.java'], ['Sources/Calc.swift'], ['Sources/CalcCheck.swift'],
  ])('FR191 %s is not', (p) => expect(isTestPath(p!)).toBe(false))

  it('FR191 an external test package is test code like the package it tests, and a Go directory named test that holds production code is not test code', () => {
    // The package clause does not matter: only the file name does.
    expect(isTestPath('calc/calc_ext_test.go')).toBe(true)
    expect(isTestPath('internal/test/clock.go')).toBe(false)
    expect(isTestPath('tests/helpers.go')).toBe(false)
    expect(isTestPath('tests/helpers_test.go')).toBe(true)
  })

  it('FR191 on fixtures/tests-polyglot exactly the files the conventions name are test files', () => {
    withSnapshot(d, (db) => {
      const files = (db.prepare("select path from file where disposition = 'indexed' order by path").all() as Array<{ path: string }>).map((f) => f.path)
      expect(files.filter((p) => isTestPath(p))).toEqual(EXPECTED.test_files)
    })
  })
})

describe('FR193 symbols carry roles', () => {
  it('FR193 scenario 2: exactly the test entry points carry the role test, and no helper does', () => {
    const all = symbols({ include_tests: true })
    expect(keys(all.filter((s) => s.roles?.includes('test')))).toEqual(keys(EXPECTED.roles_test))
    for (const h of EXPECTED.helpers as Key[]) {
      const found = all.filter((s) => s.path === h.path && s.name === h.name)
      expect(found, key(h)).toHaveLength(1)
      expect(found[0]!.roles ?? []).not.toContain('test')
    }
  })

  it('FR193 a symbol with no role has no roles field, and the snapshot has a roles column the adapter protocol allows', () => {
    const add = symbols().find((s) => s.path === 'calc/calc.go' && s.name === 'Add')!
    expect(add).toBeDefined()
    expect('roles' in add).toBe(false)
    withSnapshot(d, (db) => expect((db.prepare("select count(*) as n from pragma_table_info('symbol') where name = 'roles'").get() as { n: number }).n).toBe(1))
  })

  it('FR193 a symbol an adapter sent no roles for is still valid: the snapshot holds null', async () => {
    const { dataDir } = await indexedRepo({ 'a.ts': 'export function f() { return 1 }\n', 'tsconfig.json': '{ "include": ["*.ts"] }\n' })
    withSnapshot(dataDir, (db) => {
      expect((db.prepare("select count(*) as n from symbol where name = 'f' and roles is null").get() as { n: number }).n).toBe(1)
    })
  }, 240000)
})

describe('FR192 FR194 issue 11 scenario 1: include_tests leaves out test code by symbol', () => {
  it('FR194 scenario 1: with include_tests false no symbol of a test file and no member of the Rust tests module is listed; production code and the Swift class outside a Tests directory are judged by their own roles', () => {
    const kept = symbols({ include_tests: false })
    expect(keys(kept.filter((s) => (EXPECTED.test_files as string[]).includes(s.path)))).toEqual([])
    expect(kept.filter((s) => s.path === 'src/lib.rs').map((s) => s.name)).toEqual(['add'])
    expect(kept.filter((s) => s.path === 'Sources/CalcCheck.swift')).toEqual([])
    expect(keys(kept)).toEqual(expect.arrayContaining(keys(EXPECTED.production)))
    expect(keys(kept)).toEqual(keys(EXPECTED.production))
  })

  it('FR194 scenario 1: with include_tests true every one of them is listed', () => {
    const all = symbols({ include_tests: true })
    expect(keys(all)).toEqual(keys([...EXPECTED.production, ...EXPECTED.helpers, ...EXPECTED.roles_test]))
    expect(all.some((s) => s.path === 'src/lib.rs' && s.qualified_name.endsWith('tests.adds'))).toBe(true)
  })
})

describe('FR194 issue 11 scenario 4: a source file with code and tests is decided per symbol', () => {
  it('FR194 scenario 4: isTestCode on src/lib.rs says add is not test code and tests.adds is', () => {
    expect(isTestCode('src/lib.rs', null, null)).toBe(false)
    expect(isTestCode('src/lib.rs', null, ['test'])).toBe(true)
    expect(isTestCode('src/lib.rs', null, ['test_support'])).toBe(true)
    expect(isTestCode('src/lib.rs', null, [])).toBe(false)
    expect(isTestCode('calc/calc_test.go', null, null)).toBe(true)
  })

  it('FR194 scenario 4: the symbols of src/lib.rs, as indexed, are decided that way', () => {
    const rust = symbols({ include_tests: true, kinds: undefined }).filter((s) => s.path === 'src/lib.rs')
    withSnapshot(d, (db) => {
      const rows = db.prepare("select s.name, s.roles from symbol s join file f on f.id = s.file_id where f.path = 'src/lib.rs' and s.kind <> 'module' order by s.start_line").all() as Array<{ name: string; roles: string | null }>
      expect(rows.map((r) => [r.name, r.roles && isTestCode('src/lib.rs', null, JSON.parse(r.roles))])).toEqual([['add', null], ['tests', true], ['adds', true]])
    })
    expect(rust.length).toBeGreaterThan(0)
  })

  it('FR194 include_tests false on get_relationships leaves out a caller by its own roles: the helper in a test file is left out, and so is the test', () => {
    const add = symbolId(d, 'pkg/calc:add')
    const rows = (include_tests?: boolean) => (tool(d, 'get_relationships', { subject_id: add, direction: 'in', ...(include_tests === undefined ? {} : { include_tests }) }).data as unknown as { relationships: Array<{ other: { name: string } }> }).relationships.map((r) => r.other.name).sort()
    expect(rows()).toEqual(['make', 'test_add'])
    expect(rows(false)).toEqual([])
  })
})

describe('FR195 issue 11 scenario 3: find_tests lists test entry points, not helpers', () => {
  it('FR195 scenario 3: find_tests on pkg/calc.py add returns test_add as a call at depth 1, and not make', () => {
    const data = tool(d, 'find_tests', { subject_ids: [symbolId(d, EXPECTED.python_find_tests.subject)] }).data as unknown as { tests: Array<{ name: string; path: string; line: number; evidence: string; depth: number }> }
    expect(data.tests.map(({ name, path, line, evidence, depth }) => ({ name, path, line, evidence, depth }))).toEqual(EXPECTED.python_find_tests.tests)
  })

  it('FR195 a helper called by a test entry point leads to the entry point: the test is listed at depth 2', async () => {
    const { dataDir } = await indexedRepo({
      'pkg/__init__.py': '', 'pkg/calc.py': 'def add(a, b):\n    return a + b\n',
      'pkg/test_calc.py': 'from pkg.calc import add\n\n\ndef make():\n    return add(0, 0)\n\n\ndef test_make():\n    assert make() == 0\n',
    })
    const rows = (tool(dataDir, 'find_tests', { subject_ids: [symbolId(dataDir, 'pkg/calc:add')] }).data as unknown as { tests: Array<{ name: string; depth: number; evidence: string }> }).tests
    expect(rows.map((t) => [t.name, t.depth, t.evidence])).toEqual([['test_make', 2, 'transitive_call']])
  }, 240000)
})

describe('FR199 issue 11 scenario 5: calls in a language with no resolved calls are said not to be resolved', () => {
  it('FR199 scenario 5: find_tests on Go Add says calls in Go are not resolved yet, and lists no test as executing it', () => {
    const env = tool(d, 'find_tests', { subject_ids: [symbolId(d, 'calc/calc:Add')] })
    const data = env.data as unknown as { tests: Array<{ name: string; evidence: string }>; totals: { executing: number } }
    expect(data.totals.executing).toBe(0)
    expect(data.tests.filter((t) => ['call', 'transitive_call', 'dispatch'].includes(t.evidence))).toEqual([])
    expect(env.limitations.some((l) => /^Calls in Go are not resolved yet/.test(l))).toBe(true)
  })

  it('FR199 the note is not made for a language whose calls are resolved', () => {
    const env = tool(d, 'find_tests', { subject_ids: [symbolId(d, 'pkg/calc:add')] })
    expect(env.limitations.some((l) => /are not resolved yet/.test(l))).toBe(false)
    const lean = tool(d, 'find_tests', { subject_ids: [symbolId(d, 'calc/calc:Add')], envelope: 'lean' }) as unknown as { text?: string }
    expect(String(lean.text ?? '')).toMatch(/# Calls in Go are not resolved yet/)
  })
})

describe('FR192 test entry points are recognised by their markers', () => {
  type Row = { name: string; roles: string | null }
  const roles = async (files: Record<string, string>) => {
    const { dataDir } = await indexedRepo(files)
    return withSnapshot(dataDir, (db) => (db.prepare("select s.name, s.roles from symbol s join file f on f.id = s.file_id where s.kind <> 'module' order by f.path, s.start_line, s.id").all() as Row[]).map((r) => [r.name, r.roles ? (JSON.parse(r.roles) as string[]).join('+') : '-']))
  }

  it('FR192 Go: Test, Benchmark, Fuzz and Example functions with their testing parameter, in a _test.go file only; TestMain, a lowercase continuation and a method are no tests', async () => {
    expect(await roles({
      'x/x_test.go': 'package x\n\nimport "testing"\n\nfunc TestA(t *testing.T) {}\nfunc BenchmarkA(b *testing.B) {}\nfunc FuzzA(f *testing.F) {}\nfunc ExampleA() {}\nfunc Example_b() {}\nfunc TestMain(m *testing.M) {}\nfunc Testing(t *testing.T) {}\nfunc TestNoParam() {}\nfunc (s S) TestM(t *testing.T) {}\n',
      'x/y.go': 'package x\n\nimport "testing"\n\nfunc TestNotInATestFile(t *testing.T) {}\n',
    })).toEqual([['TestA', 'test'], ['BenchmarkA', 'test'], ['FuzzA', 'test'], ['ExampleA', 'test'], ['Example_b', 'test'], ['TestMain', '-'], ['Testing', '-'], ['TestNoParam', '-'], ['TestM', '-'], ['TestNotInATestFile', '-']])
  }, 240000)

  it('FR192 FR196 Rust: #[test] and #[tokio::test] functions, and the members of a #[cfg(test)] module as support; #[cfg(not(test))] is not one', async () => {
    expect(await roles({
      'src/lib.rs': 'pub fn f() {}\n\n#[test]\nfn top() {}\n\n#[tokio::test]\nasync fn runs() {}\n\n#[cfg(not(test))]\nmod real {\n    pub fn g() {}\n}\n\n#[cfg(test)]\nmod tests {\n    fn helper() {}\n\n    #[test]\n    fn inner() {}\n}\n',
    })).toEqual([['f', '-'], ['top', 'test'], ['runs', 'test'], ['real', '-'], ['g', '-'], ['tests', 'test_support'], ['helper', 'test_support'], ['inner', 'test']])
  }, 240000)

  it('FR192 FR196 FR198 JUnit and Kotlin: @Test and its siblings, an annotation under another name matched through the import, a TestCase subclass', async () => {
    expect(await roles({
      'src/main/java/A.java': 'import org.junit.jupiter.api.Test;\nimport org.junit.jupiter.params.ParameterizedTest;\n\nclass A {\n    @Test void one() {}\n    @ParameterizedTest void two() {}\n    void three() {}\n    @Deprecated void four() {}\n}\n',
      'src/main/java/B.java': 'import junit.framework.TestCase;\n\nclass B extends TestCase {\n    public void testX() {}\n    void helper() {}\n}\n',
      'src/main/kotlin/C.kt': 'import org.junit.jupiter.api.Test as T\nimport org.junit.Test\n\nclass C {\n    @T fun aliased() {}\n    @Test fun direct() {}\n    fun other() {}\n}\n',
      'src/main/kotlin/D.kt': 'import com.example.Test as T\n\nclass D {\n    @T fun notJunit() {}\n}\n',
    })).toEqual([['A', 'test_support'], ['one', 'test'], ['two', 'test'], ['three', 'test_support'], ['four', 'test_support'], ['B', 'test_support'], ['testX', 'test'], ['helper', 'test_support'], ['C', 'test_support'], ['aliased', 'test'], ['direct', 'test'], ['other', 'test_support'], ['D', '-'], ['notJunit', '-']])
  }, 240000)

  it('FR192 FR196 pytest and unittest: test functions of a test file, Test classes, TestCase methods anywhere; no test_ function in a production file', async () => {
    expect(await roles({
      'pkg/__init__.py': '',
      'pkg/test_a.py': 'import unittest\n\n\ndef test_one():\n    pass\n\n\ndef helper():\n    pass\n\n\nclass TestGroup:\n    def test_two(self):\n        pass\n\n    def setup_method(self):\n        pass\n\n\nclass Case(unittest.TestCase):\n    def test_three(self):\n        pass\n',
      'pkg/prod.py': 'import unittest\n\n\ndef test_not_collected():\n    pass\n\n\nclass Odd(unittest.TestCase):\n    def test_four(self):\n        pass\n\n    def util(self):\n        pass\n',
    })).toEqual([['test_not_collected', '-'], ['Odd', 'test_support'], ['test_four', 'test'], ['util', 'test_support'], ['test_one', 'test'], ['helper', '-'], ['TestGroup', 'test_support'], ['test_two', 'test'], ['setup_method', 'test_support'], ['Case', 'test_support'], ['test_three', 'test']])
  }, 240000)

  it('FR192 FR196 C#: xUnit, NUnit and MSTest attributes, by name under any namespace and with or without the Attribute suffix; the type and the other members of a test type are support', async () => {
    expect(await roles({
      'src/A.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n',
      'src/CalcChecks.cs': 'using Xunit;\n\nnamespace A;\n\npublic class CalcChecks\n{\n    private int field;\n\n    [Fact] public void One() { }\n    [Theory, InlineData(1)] public void Two(int x) { }\n    [Xunit.Fact] public void Three() { }\n    [NUnit.Framework.TestAttribute] public void Four() { }\n    [TestMethod] public void Five() { }\n    [Obsolete] public void Helper() { }\n}\n\npublic class Plain\n{\n    public void Run() { }\n}\n',
    })).toEqual([['A', '-'], ['CalcChecks', 'test_support'], ['field', 'test_support'], ['One', 'test'], ['Two', 'test'], ['Three', 'test'], ['Four', 'test'], ['Five', 'test'], ['Helper', 'test_support'], ['Plain', '-'], ['Run', '-']])
  }, 240000)

  it('FR192 FR196 FR197 PHPUnit, RSpec, Minitest, gtest and XCTest: the markers each uses, and the names of the blocks and macros that declare none', async () => {
    expect(await roles({
      'src/Foo.php': '<?php\n\nclass FooTest extends \\PHPUnit\\Framework\\TestCase\n{\n    public function testA() {}\n    /** @test */\n    public function checksB() {}\n    #[Test]\n    public function checksC() {}\n    public function helper() {}\n    public function testWithArg(int $x) {}\n}\n\nclass Plain\n{\n    public function testNotATest() {}\n}\n',
      'spec/foo_spec.rb': 'describe Foo do\n  it "a" do\n  end\n\n  context "when b" do\n    specify "c" do\n    end\n  end\nend\n',
      'test/foo_test.rb': 'class FooTest < Minitest::Test\n  def test_a\n  end\n\n  def helper\n  end\nend\n',
      'foo_test.cc': 'TEST(S, A) {}\nTEST_F(Fix, B) {}\nTEST_P(Par, C) {}\nint helper() { return 0; }\n',
      'Sources/Bar.swift': 'import XCTest\n\nclass BarCheck: XCTestCase {\n    func testA() {}\n    func testWithArg(_ x: Int) {}\n    func helper() {}\n}\n\nclass Plain {\n    func testNotATest() {}\n}\n',
    })).toEqual([
      ['BarCheck', 'test_support'], ['testA', 'test'], ['testWithArg', 'test_support'], ['helper', 'test_support'], ['Plain', '-'], ['testNotATest', '-'],
      ['TEST(S, A)', 'test'], ['TEST_F(Fix, B)', 'test'], ['TEST_P(Par, C)', 'test'], ['helper', '-'],
      ['it "a"', 'test'], ['specify "c"', 'test'],
      ['FooTest', 'test_support'], ['testA', 'test'], ['checksB', 'test'], ['checksC', 'test'], ['helper', 'test_support'], ['testWithArg', 'test'], ['Plain', '-'], ['testNotATest', '-'],
      ['FooTest', 'test_support'], ['test_a', 'test'], ['helper', 'test_support'],
    ])
  }, 240000)
})

describe('FR200 docs/proofmesh/languages.md lists the conventions and the markers', () => {
  it('FR200 each convention of FR191, each marker of FR192 and the roles of FR193 are named', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'languages.md'), 'utf8')
    for (const word of ['_test.go', 'test_*.py', '*_test.py', 'conftest.py', 'src/test/', '*Test.php', '_spec.rb', '_test.rb', '*_test.*', '*_unittest.*', 'Tests/', '#[test]', '#[tokio::test]', '#[cfg(test)]', '@Test', 'TestCase', 'XCTestCase', 'TEST_F', 'TEST_P', '[Fact]', '[TestMethod]', 'it "adds"', '`roles`', '`test_support`']) expect(doc, word).toContain(word)
  })

  it('FR200 the adapter protocol schema declares roles as optional, and the compatibility table names protocol 1.1 and snapshot format 0.9', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'adapter-protocol', 'analyze.response.schema.json'), 'utf8'))
    const symbol = schema.properties.symbols.items
    expect(symbol.properties.roles.items.enum).toEqual(['test', 'test_support'])
    expect(symbol.required).not.toContain('roles')
    const table = fs.readFileSync(path.join(ROOT, 'COMPATIBILITY.md'), 'utf8')
    expect(table).toMatch(/\| Adapter protocol \| 1\.1 \|/)
    expect(table).toMatch(/\| Snapshot file format \| 0\.9 \|/)
  })
})
