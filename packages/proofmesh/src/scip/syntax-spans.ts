// The syntax tier's declaration spans for SCIP-covered files (FR121), asked of its own adapter process. Every failure of that process
// (it cannot be found, crashes, exits early, goes silent) ends in a `problem` and no spans, never a hang or a throw.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import readline from 'node:readline'

type Range = { start_byte: number; end_byte: number; start_line: number; end_line: number }
/** A declaration the syntax tier parsed: its name, qualified name, kind and whole span. */
export type SyntaxSymbol = { path: string; kind: string; name: string; qualified_name: string; range: Range }
export type SyntaxFile = { path: string; content_hash: string; language: string }
export type Spans = { symbols: Map<string, SyntaxSymbol[]>; unsupported: string[]; problem?: 'unavailable' | 'failed' | 'timeout' }

/** Well under the host's 60 s of adapter silence. */
export const SPANS_TIMEOUT_MS = 15000

export function syntaxEntry(): string | undefined {
  try { return createRequire(import.meta.url).resolve('@proofmesh/adapter-syntax') } catch { return undefined }
}

// shortcut: one process and a serial parse of every file with a bare definition on each initialize, with no cache across runs; cache spans by content hash if SCIP-covered repositories get large.
export async function syntaxSymbols(files: SyntaxFile[], workspace: string, entry: string | null | undefined = syntaxEntry() ?? null, timeoutMs = SPANS_TIMEOUT_MS): Promise<Spans> {
  const out: Spans = { symbols: new Map(), unsupported: [] }
  if (!files.length) return out
  if (!entry) return { ...out, problem: 'unavailable' }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } })
  } catch { return { ...out, problem: 'failed' } }
  type Reply = { symbols?: SyntaxSymbol[]; adapter?: { languages?: string[] } } | undefined
  const waiting = new Map<number, (r: Reply) => void>()
  let dead = false
  const die = () => { dead = true; for (const w of waiting.values()) w(undefined); waiting.clear() }
  readline.createInterface({ input: child.stdout! }).on('line', (l) => { try { const m = JSON.parse(l); waiting.get(m.id)?.(m.error ? undefined : m.result); waiting.delete(m.id) } catch { /* not a reply */ } })
  child.on('exit', die)
  child.on('error', die)
  child.stdin!.on('error', die)
  let id = 0
  const ask = (method: string, params: unknown) => new Promise<Reply>((resolve) => {
    if (dead) return resolve(undefined)
    waiting.set(++id, resolve)
    try { child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) } catch { die() }
  })
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
  const work = (async (): Promise<Spans['problem']> => {
    const init = await ask('initialize', { protocol_version: '1.0', workspace, analysis_mode: 'no_execution', files })
    if (!init) return 'failed'
    const languages = new Set(init.adapter?.languages ?? [])
    out.unsupported = files.filter((f) => !languages.has(f.language)).map((f) => f.path)
    const paths = files.filter((f) => languages.has(f.language)).map((f) => f.path)
    if (!paths.length) return undefined
    const r = await ask('analyze', { paths })
    if (!r) return 'failed'
    for (const sym of r.symbols ?? []) out.symbols.set(sym.path, [...(out.symbols.get(sym.path) ?? []), sym])
    return undefined
  })()
  try {
    const problem = await Promise.race([work, late])
    return problem ? { symbols: new Map(), unsupported: out.unsupported, problem } : out
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}
