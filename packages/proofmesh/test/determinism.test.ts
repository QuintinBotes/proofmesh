import { describe, expect, it } from 'vitest'
import { cli, FIXTURE, tmpDir } from './helpers.js'

describe('AC12 determinism', () => {
  it('two clean indexes produce the same snapshot ID and byte-identical normalized dumps', () => {
    const dumps = [tmpDir(), tmpDir()].map((d) => {
      cli(['--data-dir', d, 'init'])
      cli(['--data-dir', d, 'repo', 'add', FIXTURE])
      const id = cli(['--data-dir', d, 'index', FIXTURE]).stdout.match(/snap_[0-9a-f]+/)![0]
      return { id, dump: cli(['--data-dir', d, 'debug', 'dump', '--normalized', id]).stdout }
    })
    expect(dumps[0]!.id).toBe(dumps[1]!.id)
    expect(dumps[0]!.dump.length).toBeGreaterThan(1000)
    expect(dumps[0]!.dump).toBe(dumps[1]!.dump)
  })
})
