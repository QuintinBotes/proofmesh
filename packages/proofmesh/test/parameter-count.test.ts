import { describe, expect, it } from 'vitest'
import { parameterCount } from '../src/query/tools.js'

describe('#29 a signature\'s parameter count, for ranking unresolved calls by arity', () => {
  it('counts top-level parameters only, past generics, tuples and default-free lists', () => {
    expect(parameterCount('Task<Order> LoadAsync(int id, Dictionary<string, int> options, CancellationToken ct)')).toBe(3)
    expect(parameterCount('(int Code, string Text) Parse(string raw)')).toBe(1)
    expect(parameterCount('void Run()')).toBe(0)
    expect(parameterCount('Func<int, (string, bool)> Make(Action<int, int> a, (int, int) pair)')).toBe(2)
    expect(parameterCount('int Total')).toBeNull()
    expect(parameterCount(null)).toBeNull()
  })
})
