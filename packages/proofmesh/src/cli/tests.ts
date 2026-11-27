import fs from 'node:fs'
import path from 'node:path'
import { asProofmeshError, ProofmeshError } from '../core/errors.js'
import { Catalog } from '../meshstore/catalog.js'
import type { TestRow } from '../query/test-reach.js'
import { runTool } from '../query/tools.js'

type Row = TestRow & { chain: Array<{ name: string; path: string; line: number }> }

/**
 * proofmesh tests <repository> <path | path#name> [--json] (FR106): the find_tests rows. Exits 0 when a test executes the subject,
 * 1 when none does, and 2 when the question cannot be answered: a usage error, an unknown repository or subject, no snapshot.
 */
export function runTests(dataDir: string, rest: string[], has: (args: string[], flag: string) => boolean): number {
  const opts = [...rest], json = has(opts, '--json')
  try {
    if (opts.length !== 2) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh tests <repository> <path | path#name> [--json]')
    const catalog = Catalog.open(dataDir)
    const repo = (() => { try { return catalog.repository(opts[0]!) } finally { catalog.close() } })()
    // path#name is the symbol name declared in the file (FR100's { name, path }), unless a file has that whole path.
    const subject = opts[1]!, cut = subject.lastIndexOf('#')
    const input = { repository_id: repo.id, ...(cut > 0 && !fs.existsSync(path.join(repo.root, subject)) ? { subject_ids: [{ name: subject.slice(cut + 1), path: subject.slice(0, cut) }] } : { paths: [subject] }) }
    const env = runTool(dataDir, 'find_tests', input)
    const data = env.data as { tests: Row[]; totals: { executing: number; not_executing: number } }
    // --json is the tool's answer, cursor and all; the text lists every row, page by page.
    if (json) console.log(JSON.stringify(env, null, 2))
    else {
      for (let page = env; page.completion.next_cursor;) {
        page = runTool(dataDir, 'find_tests', { ...input, cursor: page.completion.next_cursor })
        data.tests.push(...(page.data as typeof data).tests)
      }
      for (const t of data.tests) {
        console.log(t.evidence === 'import_only' ? `${t.path}:${t.line} import_only` : `${t.name} ${t.path}:${t.line} ${t.evidence} depth=${t.depth}${t.via ? ` via ${t.via}` : ''}`)
        if (t.chain.length) console.log(`  ${t.chain.map((h) => `${h.name} ${h.path}:${h.line}`).join(' -> ')}`)
      }
      console.log(`executing ${data.totals.executing}, not executing ${data.totals.not_executing}`)
      for (const l of env.limitations) console.log(`limitation: ${l}`)
    }
    return data.totals.executing > 0 ? 0 : 1
  } catch (e) {
    const err = asProofmeshError(e)
    process.stderr.write(`proofmesh: ${err.code}: ${err.message}\n`)
    if (json) console.log(JSON.stringify(err.toJSON(), null, 2))
    return 2
  }
}
