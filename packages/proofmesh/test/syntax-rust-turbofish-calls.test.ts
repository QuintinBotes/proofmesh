import { describe, expect, it } from 'vitest'
import { indexedRepo, rows, withSnapshot } from './helpers.js'

describe('FR600 FR601 the syntax tier records a Rust turbofish call', () => {
  it('FR600 FR601 f::<u8>(), x.collect::<Vec<_>>() and std::iter::repeat::<u8>(0) each give one unresolved calls row; the path call keeps the path before the last :: as its qualifier, without the turbofish', async () => {
    const { dataDir } = await indexedRepo({
      'rust/main.rs': 'fn f<T>() {}\n\nfn main() {\n    f::<u8>();\n    let x = 0..3u8;\n    let v = x.collect::<Vec<_>>();\n    std::iter::repeat::<u8>(0);\n}\n',
    })
    const calls = withSnapshot(dataDir, (db) => rows(db, 'calls')).map((r) => [r.from, r.line, r.resolution, r.reason, r.detail?.callee, r.detail?.qualifier])
    expect(calls).toEqual([
      ['rust/main:main', 4, 'unresolved', 'outside_capability', 'f', undefined],
      ['rust/main:main', 6, 'unresolved', 'outside_capability', 'collect', undefined],
      ['rust/main:main', 7, 'unresolved', 'outside_capability', 'repeat', 'std::iter'],
    ])
  })
})
