import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGalaxy, galaxySymbolId, listSnapshots, setRepository } from '../src/api'

afterEach(() => { vi.unstubAllGlobals(); setRepository(undefined) })

describe('A11 FR055 once drilled into one repository of a workspace, every Observatory route names it', () => {
  it('the Galaxy, its points and the snapshot list are all asked about the chosen repository', async () => {
    const asked: Array<[string, unknown]> = []
    vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
      asked.push([url, init.body === undefined ? undefined : JSON.parse(init.body)])
      return new Response(url.endsWith('/symbol') ? JSON.stringify({ id: 'sym_1' }) : url.endsWith('/snapshots') ? JSON.stringify({ snapshots: [] }) : new ArrayBuffer(4))
    })
    setRepository('repo_abc')
    // The Galaxy is addressed by the snapshot the repository's status named, which belongs to that repository alone (FR1453).
    await fetchGalaxy('snap_1')
    expect(await galaxySymbolId(3)).toBe('sym_1')
    await listSnapshots()
    expect(asked).toEqual([
      ['/api/v1/galaxy/v4/snap_1', undefined],
      ['/api/v1/galaxy/symbol', { repository_id: 'repo_abc', index: 3 }],
      ['/api/v1/snapshots', { repository_id: 'repo_abc' }],
    ])
  })

  it('FR1453 a snapshot gc retired since is asked again as the repository\'s current one', async () => {
    const asked: Array<[string, unknown]> = []
    vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
      asked.push([url, init.body === undefined ? undefined : JSON.parse(init.body)])
      if (url.endsWith('/snap_old')) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'gone' } }), { status: 404 })
      return new Response(url.includes('/tools/') ? JSON.stringify({ snapshot: { id: 'snap_new' } }) : new ArrayBuffer(4))
    })
    setRepository('repo_abc')
    expect((await fetchGalaxy('snap_old')).byteLength).toBe(4)
    expect(asked).toEqual([
      ['/api/v1/galaxy/v4/snap_old', undefined],
      ['/api/v1/tools/workspace_status', { repository_id: 'repo_abc', limits: { max_rows: 1 } }],
      ['/api/v1/galaxy/v4/snap_new', undefined],
    ])
  })
})
