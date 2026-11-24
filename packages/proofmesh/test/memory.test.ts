import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cli, copyFixture, symbolId, tmpDir, tool } from './helpers.js'

const note = (id: string, refs: string[], body: string) => `---\nid: ${id}\ntitle: "${id} title"\nkind: invariant\nnodes:\n${refs.map((r) => `  - ${r}`).join('\n')}\n---\n\n${body}\n`

describe('FR019 get_memory: curated notes with their dependency staleness', () => {
  it('reports a note current until the code it describes changes, lists unresolved references, and resets acceptance when the note changes', () => {
    const d = tmpDir(), repo = copyFixture(), notes = tmpDir('pm-notes-')
    fs.writeFileSync(path.join(notes, 'shared.md'), note('formatting-is-shared', ['function:packages/format/src/currency:formatAmount'], 'Every currency string goes through formatAmount.'))
    fs.writeFileSync(path.join(notes, 'gone.md'), note('gone-thing', ['function:packages/nowhere:gone'], 'Describes code that no longer exists.'))
    fs.writeFileSync(path.join(notes, 'broken.md'), 'no frontmatter here\n')
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo], ['notes', 'add', notes]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    const synced = cli(['--data-dir', d, 'notes', 'sync'])
    expect(synced.stdout).toContain('2 notes synced')
    expect(synced.stderr).toContain('broken.md: no frontmatter')
    expect(cli(['--data-dir', d, 'notes', 'accept', 'formatting-is-shared']).status).toBe(0)

    const byFormat = () => tool(d, 'get_memory', { symbol_id: symbolId(d, 'packages/format/src/currency:formatAmount') }).data as any
    expect(byFormat().notes.map((n: any) => [n.id, n.staleness, n.missing_refs])).toEqual([['formatting-is-shared', 'current', []]])
    expect((tool(d, 'get_memory', { query: 'no longer exists' }).data as any).notes.map((n: any) => [n.id, n.staleness, n.missing_refs])).toEqual([['gone-thing', 'unaccepted', ['function:packages/nowhere:gone']]])

    const invoice = path.join(repo, 'packages/billing/src/invoice.ts')
    fs.writeFileSync(invoice, fs.readFileSync(invoice, 'utf8').replace('return formatAmount(cents, currency);', 'return String(cents) + currency;'))
    expect(cli(['--data-dir', d, 'index', repo]).status).toBe(0)
    expect(byFormat().notes[0].staleness).toBe('changed')

    fs.writeFileSync(path.join(notes, 'shared.md'), note('formatting-is-shared', ['function:packages/format/src/currency:formatAmount'], 'Reworded after review.'))
    cli(['--data-dir', d, 'notes', 'sync'])
    expect(byFormat().notes[0].staleness).toBe('unaccepted')
  }, 240000)
})

describe('FR019 save_memory: an agent proposes a note, a person accepts it', () => {
  it('stores the proposal as unaccepted, never overwrites a curated note, and replaces its own proposal', async () => {
    const { indexedDataDir } = await import('./helpers.js')
    const { dataDir } = await indexedDataDir()
    const saved = tool(dataDir, 'save_memory', { id: 'invoices-format-once', title: 'Invoices format once', kind: 'invariant', nodes: ['function:packages/billing/src/invoice:invoiceTotal', 'function:packages/nowhere:gone'], body: 'invoiceTotal formats the amount exactly once.' }) as any
    expect(saved.data).toEqual({ id: 'invoices-format-once', staleness: 'unaccepted', missing_refs: ['function:packages/nowhere:gone'] })
    expect(saved.limitations).toContain('A saved note is a proposal: get_memory reports it as unaccepted until a person accepts it with proofmesh notes accept.')
    tool(dataDir, 'save_memory', { id: 'invoices-format-once', title: 'Invoices format once', kind: 'invariant', body: 'Reworded.' })
    const found = (tool(dataDir, 'get_memory', { query: 'format once' }).data as any).notes
    expect(found.map((n: any) => [n.id, n.staleness, n.body])).toEqual([['invoices-format-once', 'unaccepted', 'Reworded.']])
    const notes = tmpDir('pm-notes-')
    fs.writeFileSync(path.join(notes, 'curated.md'), note('curated-one', [], 'A person wrote this.'))
    cli(['--data-dir', dataDir, 'notes', 'add', notes]); cli(['--data-dir', dataDir, 'notes', 'sync'])
    expect(() => tool(dataDir, 'save_memory', { id: 'curated-one', title: 'x', kind: 'gotcha', body: 'y' })).toThrow('is curated by a person')
    expect((tool(dataDir, 'get_memory', { query: 'format once' }).data as any).total).toBe(1)
  })
})
