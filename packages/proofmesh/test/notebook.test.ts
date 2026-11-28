import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readNotebook } from '../../../adapters/syntax/src/notebook.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { fixtureRepo, indexedDataDir, tmpDir, tool, withSnapshot } from './helpers.js'
import type { FindSymbolsData, GetSymbolData, ReadEvidenceData } from '../src/core/generated.js'

describe('FR3002 notebook cell citations', () => {
  it('round-trips duplicate Python definitions to their own cell and keeps IDs stable across snapshots', async () => {
    const repo = tmpDir()
    fs.cpSync(fixtureRepo('notebook'), repo, { recursive: true })
    const file = path.join(repo, 'scores.ipynb')
    const raw = fs.readFileSync(file, 'utf8')
    const { dataDir, repoId, snapshotId } = await indexedDataDir(repo)
    const find = (text: string) => (tool(dataDir, 'find_symbols', { text }).data as unknown as FindSymbolsData).symbols
    const get = (id: string) => (tool(dataDir, 'get_symbol', { symbol_id: id }).data as unknown as GetSymbolData).symbol
    const read = (id: string, snapshot_id?: string) => (tool(dataDir, 'read_evidence', { evidence_ids: [id], snapshot_id }).data as unknown as ReadEvidenceData).evidence[0]!
    const definitions = () => find('score').filter(s => s.kind === 'function')
    const original = definitions().map(s => get(s.id))
    expect(original.map(s => s.notebook_cell?.id)).toEqual(['first', 'second'])
    const source = 'def score():\n    return tally("é")'
    for (const [i, symbol] of original.entries()) {
      const e = read(symbol.evidence_id)
      expect(e.path).toBe('scores.ipynb')
      expect(e.notebook_cell).toMatchObject({ id: i ? 'second' : 'first', ordinal: i ? 4 : 2, start_line: 2, start_column: 1, end_line: 3, end_column: 22 })
      expect(e.notebook_cell).toEqual(definitions()[i]!.notebook_cell)
      expect(e.cell_text).toBe(source)
      expect(e.text).toBe(Buffer.from(raw).subarray(e.start_byte, e.end_byte).toString())
      expect(e.integrity.status).toBe('verified')
    }
    const markdown = find('markdown cell')[0]!
    expect(read(get(markdown.id).evidence_id).cell_text).toBe('Review the scores.')
    expect(find('code cell shell')[0]?.notebook_cell?.reason).toBe('unsupported_cell_magic:bash')
    expect(find('shell_only')).toEqual([])
    expect(find('output_only')).toEqual([])
    const calls = () => withSnapshot(dataDir, db => db.prepare("select resolution from assertion where type = 'calls' order by resolution").all())
    expect(calls()).toEqual([{ resolution: 'unresolved' }, { resolution: 'unresolved' }])

    const notebook = JSON.parse(raw)
    notebook.cells[1].outputs[0].text = ['def new_output(): pass\n'.repeat(10)]
    notebook.cells[1].execution_count++
    fs.writeFileSync(file, JSON.stringify(notebook, null, 2))
    await indexRepository(dataDir, repoId)
    const facts = () => definitions().map(s => get(s.id)).map(s => [s.stable_key, s.body_hash])
    expect(facts()).toEqual(original.map(s => [s.stable_key, s.body_hash]))
    expect(find('new_output')).toEqual([])
    expect(calls()).toHaveLength(2)

    notebook.cells.reverse()
    fs.writeFileSync(file, JSON.stringify(notebook))
    await indexRepository(dataDir, repoId)
    const moved = definitions().map(s => get(s.id))
    expect(moved.map(s => s.stable_key)).toEqual(original.map(s => s.stable_key))
    expect(moved.map(s => s.notebook_cell?.ordinal)).toEqual([3, 1])
    expect(read(moved[0]!.evidence_id).cell_text).toBe(source)
    expect(read(original[0]!.evidence_id, snapshotId).notebook_cell?.ordinal).toBe(2)
  })

  it('maps escaped Unicode and arbitrary source fragments back to the exact JSON bytes', () => {
    const raw = String.raw`{"nbformat":4,"metadata":{"language_info":{"name":"python"}},"cells":[{"cell_type":"code","source":["# \ud83d\udc0d\n","de","f caf\u00e9(): pass"]}]}`
    const cell = readNotebook(raw)[0]!
    const begin = cell.text.indexOf('def')
    const range = cell.range(begin, cell.text.length)
    expect(Buffer.from(raw).subarray(range.start_byte, range.end_byte).toString()).toBe(String.raw`de","f caf\u00e9(): pass`)
    expect(cell.locate(range.start_byte, range.end_byte)).toMatchObject({ source: 'def café(): pass', address: { start_line: 2, start_column: 1, end_line: 2, end_column: 17 } })
  })

  it('records ordinal fallbacks, unsupported kernels and invalid notebook dispositions', async () => {
    const repo = tmpDir()
    const write = (name: string, raw: string) => fs.writeFileSync(path.join(repo, name + '.ipynb'), raw)
    write('bad', '{"cells":')
    write('old', '{"nbformat":3,"cells":[]}')
    write('julia', JSON.stringify({ nbformat: 4, metadata: { kernelspec: { language: 'julia' } }, cells: [
      { cell_type: 'code', source: 'def ignored(): pass' },
      { cell_type: 'code', source: '%%python\ndef explicit(): pass' },
    ] }))
    const { dataDir } = await indexedDataDir(repo)
    const files = withSnapshot(dataDir, db => db.prepare('select path, disposition, disposition_detail as detail from file order by path').all())
    expect(files).toMatchObject([
      { path: 'bad.ipynb', disposition: 'failed', detail: 'invalid notebook JSON' },
      { path: 'julia.ipynb', disposition: 'indexed' },
      { path: 'old.ipynb', disposition: 'failed', detail: 'unsupported notebook version (expected nbformat 4)' },
    ])
    const symbols = (tool(dataDir, 'find_symbols', { text: 'julia.ipynb' }).data as unknown as FindSymbolsData).symbols
    expect(symbols.map(s => s.name).sort()).toEqual(['code cell 1', 'code cell 2', 'explicit'])
    expect(symbols.find(s => s.name === 'code cell 1')?.notebook_cell?.reason).toBe('unsupported_kernel:julia')
    expect(symbols.find(s => s.name === 'explicit')).toMatchObject({ qualified_name: 'julia.ipynb:cell[ordinal:2]:explicit', notebook_cell: { ordinal: 2, id: null, start_line: 2 } })
  })
})
