import { describe, expect, it } from 'vitest'
import { indexedRepo, rows, withSnapshot } from './helpers.js'

describe('FR500 FR501 the syntax tier records a Rust call through a path', () => {
  it('FR500 FR501 ffi::cosine(0.0), Foo::new() and crate::util::f() each give one calls row with the path before the last :: as its qualifier (ffi::cosine bound to its extern by FR463, Foo::new() and crate::util::f() candidates by FR751, the qualified trait call unresolved); a bare or method call has none', async () => {
    const { dataDir } = await indexedRepo({
      'rust/main.rs': 'mod ffi;\nmod util;\n\nstruct Foo;\nimpl Foo {\n    fn new() -> Foo { Foo }\n}\n\nfn main() {\n    let _ = unsafe { ffi::cosine(0.0) };\n    let x = Foo::new();\n    crate::util::f();\n    let _ = <Foo as Clone> :: clone(&x);\n    helper();\n    x.go();\n}\n\nfn helper() {}\n',
      'rust/ffi.rs': 'extern "C" {\n    fn cosine(x: f64) -> f64;\n}\n',
      'rust/util.rs': 'pub fn f() {}\n',
    })
    const calls = withSnapshot(dataDir, (db) => rows(db, 'calls')).map((r) => [r.from, r.line, r.resolution, r.reason, r.detail?.callee, r.detail?.qualifier])
    expect(calls).toEqual([
      ['rust/main:main', 10, 'resolved_external', null, 'cosine', 'ffi'], // bound to the extern block in ffi.rs by the FFI seam pass (FR463)
      ['rust/main:main', 11, 'candidate', 'candidate', 'new', 'Foo'], // Foo's associated function, by rust_path (FR751)
      ['rust/main:main', 12, 'candidate', 'candidate', 'f', 'crate::util'], // util.rs's f, by rust_path (FR751)
      ['rust/main:main', 13, 'unresolved', 'outside_capability', 'clone', '<Foo as Clone>'],
      ['rust/main:main', 14, 'candidate', 'candidate', 'helper', undefined], // the module's own helper, by rust_same_module (FR750)
      ['rust/main:main', 15, 'unresolved', 'outside_capability', 'go', undefined],
    ])
  })
})
