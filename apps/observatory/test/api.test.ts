import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGalaxy, galaxySymbolId, listSnapshots, setRepository } from '../src/api'

afterEach(() => { vi.unstubAllGlobals(); setRepository(undefined) })

describe('A11 FR055 once drilled into one repository of a workspace, every Observatory route names it', () => {
  it('the Galaxy, its points and the snapshot list are all asked about the chosen repository', async () => {
    const asked: Array<[string, unknown]> = []
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      asked.push([url, JSON.parse(init.body)])
      return new Response(url.endsWith('/symbol') ? JSON.stringify({ id: 'sym_1' }) : url.endsWith('/snapshots') ? JSON.stringify({ snapshots: [] }) : new ArrayBuffer(4))
    })
    setRepository('repo_abc')
    await fetchGalaxy()
    expect(await galaxySymbolId(3)).toBe('sym_1')
    await listSnapshots()
    expect(asked).toEqual([
      ['/api/v1/galaxy', { repository_id: 'repo_abc' }],
      ['/api/v1/galaxy/symbol', { repository_id: 'repo_abc', index: 3 }],
      ['/api/v1/snapshots', { repository_id: 'repo_abc' }],
    ])
  })
})
