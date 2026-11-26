import type { Progress } from '../indexer/coordinator.js'

/** A phase as a person reads it, and as a job row records it: the adapter is named during its own phases. */
export const phaseLabel = (p: Progress): string => (p.adapter ? `${p.phase} ${p.adapter}` : p.phase)

export const duration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** What a person and `get_job` read of one running adapter: where it is, how fast, and how long it has left. Never a file's text. */
export type AdapterLine = { adapter: string; language: string; done: number; total: number; files_per_second: number; eta_seconds: number | null }

const rounded = (n: number): number => Math.round(n * 10) / 10

/** The line for an analyze progress, from the time its phase has run; the estimate is unknown until a file is done. */
export function adapterLine(p: Progress, runMs: number): AdapterLine | undefined {
  if (p.phase !== 'analyze' || !p.adapter) return undefined
  const rate = p.done > 0 && runMs > 0 ? (p.done / runMs) * 1000 : 0
  return { adapter: p.adapter, language: p.language ?? '', done: p.done, total: p.total, files_per_second: rounded(rate), eta_seconds: rate > 0 ? Math.round((p.total - p.done) / rate) : null }
}

/**
 * Writes a line when the phase changes and repeats the latest progress every interval, so a long phase is never silent.
 * stop() returns how long each phase took, in the order they ran.
 */
export function progressReporter(write: (line: string) => void, intervalMs = 5000, onTick?: () => void): { update: (p: Progress) => void; current: () => AdapterLine | undefined; stop: () => Array<{ phase: string; ms: number }> } {
  const started = Date.now(), phases: Array<{ phase: string; ms: number }> = []
  let latest: Progress | undefined, since = started, printed = started
  const current = () => (latest ? adapterLine(latest, Date.now() - since) : undefined)
  // An adapter's repeated line says how fast it goes and how long it has left; its first line, at 0 files, has nothing to say yet.
  const line = (p: Progress, repeat = false) => {
    const a = repeat && p === latest ? current() : undefined
    const rate = a ? ` (${a.language}: ${a.files_per_second} files/s, ${a.eta_seconds === null ? 'no estimate yet' : `about ${duration(a.eta_seconds * 1000)} left`})` : ''
    return `[${duration(Date.now() - started)}] ${phaseLabel(p)}${p.total ? ` ${p.done}/${p.total}` : ''}${rate}`
  }
  const say = (text: string) => { printed = Date.now(); write(text) }
  // The timer covers phases that wait on an adapter; a phase that blocks the event loop, such as the write transaction, cannot fire
  // it, so an update a whole interval after the last line prints too.
  const timer = setInterval(() => { if (latest) say(`${line(latest, true)} (still running)`); onTick?.() }, intervalMs).unref()
  const close = () => { if (latest) phases.push({ phase: phaseLabel(latest), ms: Date.now() - since }) }
  return {
    update(p) {
      if (!latest || phaseLabel(latest) !== phaseLabel(p)) { close(); since = Date.now(); say(line(p)) }
      else if (Date.now() - printed >= intervalMs) { latest = p; say(line(p, true)) }
      latest = p
    },
    current,
    stop() { clearInterval(timer); close(); latest = undefined; return phases },
  }
}
