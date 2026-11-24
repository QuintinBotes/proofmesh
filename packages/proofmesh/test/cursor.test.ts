import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { cli, copyFixture, tmpDir, tool, withSnapshot } from './helpers.js'

const pages = (d: string, name: string, input: Record<string, unknown>, list: string, rows: number) => {
  const seen: unknown[] = [], snapshots = new Set<string>()
  let cursor: string | null = null, calls = 0
  do {
    const env = tool(d, name, { ...input, limits: { max_rows: rows }, ...(cursor ? { cursor } : {}) }) as any
    seen.push(...env.data[list]); snapshots.add(env.snapshot.id)
    cursor = env.completion.next_cursor
    expect(env.completion.truncated).toBe(cursor !== null)
    calls++
  } while (cursor && calls < 50)
  return { seen, calls, snapshots }
}

describe('FR021 integrity-protected cursors: stable pages, no omissions or duplicates', () => {
  let d: string, repo: string
  beforeAll(() => {
    d = tmpDir(); repo = copyFixture()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  }, 240000)

  it('find_symbols paged two at a time returns exactly the unpaged answer, in order', () => {
    const all = (tool(d, 'find_symbols', { text: 'e', limits: { max_rows: 500 } }).data as any).symbols
    expect(all.length).toBeGreaterThan(6)
    const { seen, calls } = pages(d, 'find_symbols', { text: 'e' }, 'symbols', 2)
    expect(seen).toEqual(all)
    expect(calls).toBe(Math.ceil(all.length / 2))
  })

  it('get_relationships paged one at a time returns exactly the unpaged answer, both directions', () => {
    const subject = withSnapshot(d, (db) => (db.prepare(`select id from symbol s where (select count(*) from assertion where source_id = s.id and type = 'calls') > 0
      and (select count(*) from assertion where target_id = s.id and type = 'calls') > 0 order by (select count(*) from assertion where source_id = s.id or target_id = s.id) desc, id limit 1`).get() as { id: string }).id)
    const all = (tool(d, 'get_relationships', { subject_id: subject, limits: { max_rows: 500 } }).data as any).relationships
    expect(new Set(all.map((r: any) => r.direction))).toEqual(new Set(['in', 'out']))
    expect(pages(d, 'get_relationships', { subject_id: subject }, 'relationships', 1).seen).toEqual(all)
  })

  it('a cursor never continues a tampered, different, or expired query', () => {
    const first = tool(d, 'find_symbols', { text: 'e', limits: { max_rows: 2 } }).completion.next_cursor as string
    const flipped = first.slice(0, -2) + (first.at(-2) === 'A' ? 'B' : 'A') + first.at(-1)
    expect(() => tool(d, 'find_symbols', { text: 'e', cursor: flipped })).toThrow('the cursor failed its integrity check')
    expect(() => tool(d, 'find_symbols', { text: 'x', cursor: first })).toThrow('the cursor continues a different query')
    expect(() => tool(d, 'search_sources', { text: 'e', cursor: first })).toThrow('invalid input')
    const [, body] = first.split('.')
    const expired = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), exp: Date.now() - 1 })).toString('base64url')
    const key = Buffer.from(fs.readFileSync(path.join(d, 'tokens', 'cursor'), 'utf8').trim(), 'hex')
    const forged = `pmc1.${expired}.${crypto.createHmac('sha256', key).update(expired).digest('base64url')}`
    expect(() => tool(d, 'find_symbols', { text: 'e', cursor: forged })).toThrow('the cursor expired; repeat the query without it')
  })

  it('a cursor keeps reading the snapshot it was issued for after a newer one is published', () => {
    const first = tool(d, 'find_symbols', { text: 'e', limits: { max_rows: 2 } }) as any
    fs.appendFileSync(path.join(repo, 'packages/format/src/currency.ts'), '\nexport const EXTRA = 1\n')
    expect(cli(['--data-dir', d, 'index', repo]).status).toBe(0)
    const current = (tool(d, 'workspace_status', { limits: { max_rows: 1 } }) as any).snapshot.id
    expect(current).not.toBe(first.snapshot.id)
    const second = tool(d, 'find_symbols', { text: 'e', limits: { max_rows: 2 }, cursor: first.completion.next_cursor }) as any
    expect(second.snapshot.id).toBe(first.snapshot.id)
    expect(() => tool(d, 'find_symbols', { text: 'e', snapshot_id: current, cursor: first.completion.next_cursor })).toThrow('the cursor continues a different query')
  }, 240000)
})
