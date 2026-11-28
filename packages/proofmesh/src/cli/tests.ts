import fs from 'node:fs'
import path from 'node:path'
import { asProofmeshError, ProofmeshError } from '../core/errors.js'
import { Catalog } from '../meshstore/catalog.js'
import type { TestRow } from '../query/test-reach.js'
import { runTool } from '../query/tools.js'
import { completenessAnswer, indexSides, parseDepth, parseRange } from './completeness.js'

type Row = TestRow & { chain: Array<{ name: string; path: string; line: number }> }

/**
 * proofmesh tests <repository> <path | path#name> [--json] (FR106): the find_tests rows. Exits 0 when a test executes the subject,
 * 1 when none does, and 2 when the question cannot be answered: a usage error, an unknown repository or subject, no snapshot.
 */
export function runTests(dataDir: string, rest: string[], take: (args: string[], flag: string) => string | undefined, has: (args: string[], flag: string) => boolean): number {
  const opts = [...rest], json = has(opts, '--json'), changed = take(opts, '--changed'), depth = take(opts, '--depth')
  if (changed !== undefined || depth !== undefined) return runChangedTests(dataDir, opts, changed, depth, json)
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

const CHANGED_USAGE = 'usage: proofmesh tests <repository> --changed <base>[..<head>] [--depth N] [--json]'
// shortcut: the reasons are read from the limitation texts of impact_completeness and find_tests; give the answers a structured field if a third reason turns up.
const INCOMPLETE = /^(The diff touches \d+ files? no snapshot analyses|Calls in .* are not resolved yet|The (test )?search stopped)/

/**
 * proofmesh tests <repository> --changed <base>[..<head>] (FR2143): every test file find_tests finds for a changed symbol or one of its
 * dependents to --depth, once, sorted. Exits 0 when answered, 3 when the answer may miss tests (a changed file no adapter analyses, a language
 * whose calls are not resolved, a search cut short; each reason on stderr as `# incomplete:`), and 2 on a usage or index failure.
 */
function runChangedTests(dataDir: string, opts: string[], range: string | undefined, depthFlag: string | undefined, json: boolean): number {
  try {
    if (opts.length !== 1 || range === undefined) throw new ProofmeshError('INVALID_ARGUMENT', CHANGED_USAGE)
    const { base, head } = parseRange(range, CHANGED_USAGE), depth = parseDepth(depthFlag, CHANGED_USAGE)
    const { repo } = indexSides(dataDir, opts[0]!, base, head)
    const { data, limitations } = completenessAnswer(dataDir, { repository_id: repo.id, base, ...(head ? { head } : {}), depth })
    if (data.pending.length) throw new ProofmeshError('INTERNAL_ERROR', 'a side of the diff has no snapshot yet')
    const incomplete = new Set(limitations.filter((l) => INCOMPLETE.test(l)))
    // Test file -> the changed symbols it reaches, each with the evidence of the first (strongest) row that reaches it.
    const files = new Map<string, Map<string, { name: string; path: string; line: number; change: string; evidence: string }>>()
    for (const c of data.changed) {
      const snapshot_id = c.change === 'deleted' ? data.base.snapshot_id : data.head.snapshot_id
      const ids = [c.id, ...c.dependents.filter((d) => d.relation !== 'imports').map((d) => d.id)], paths = c.dependents.filter((d) => d.relation === 'imports').map((d) => d.path)
      for (const ask of [...chunks(ids).map((subject_ids) => ({ subject_ids })), ...chunks(paths).map((p) => ({ paths: p }))]) {
        const input = { repository_id: repo.id, snapshot_id, ...ask }
        for (let page = runTool(dataDir, 'find_tests', input); ; page = runTool(dataDir, 'find_tests', { ...input, cursor: page.completion.next_cursor })) {
          for (const l of page.limitations) if (INCOMPLETE.test(l)) incomplete.add(l)
          for (const t of (page.data as { tests: Row[] }).tests) {
            const reached = files.get(t.path) ?? new Map()
            if (!reached.has(c.id)) reached.set(c.id, { name: c.name, path: c.path, line: c.line, change: c.change, evidence: t.evidence })
            files.set(t.path, reached)
          }
          if (!page.completion.next_cursor) break
        }
      }
    }
    const tests = [...files.keys()].sort().map((p) => ({ path: p, changed: [...files.get(p)!.values()] }))
    if (json) console.log(JSON.stringify({ base: data.base, head: data.head, depth, tests, incomplete: [...incomplete] }, null, 2))
    else for (const t of tests) console.log(t.path)
    for (const reason of incomplete) process.stderr.write(`# incomplete: ${reason}\n`)
    return incomplete.size ? 3 : 0
  } catch (e) {
    const err = asProofmeshError(e)
    process.stderr.write(`proofmesh: ${err.code}: ${err.message}\n`)
    if (json) console.log(JSON.stringify(err.toJSON(), null, 2))
    return 2
  }
}

/** find_tests takes at most 100 subjects or paths a call. */
const chunks = <T>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / 100) }, (_, i) => xs.slice(i * 100, i * 100 + 100))
