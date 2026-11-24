import type { Progress } from '../indexer/coordinator.js'

/** A phase as a person reads it, and as a job row records it: the adapter is named during its own phases. */
export const phaseLabel = (p: Progress): string => (p.adapter ? `${p.phase} ${p.adapter}` : p.phase)

export const duration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/**
 * Writes a line when the phase changes and repeats the latest progress every interval, so a long phase is never silent.
 * stop() returns how long each phase took, in the order they ran.
 */
export function progressReporter(write: (line: string) => void, intervalMs = 60000): { update: (p: Progress) => void; stop: () => Array<{ phase: string; ms: number }> } {
  const started = Date.now(), phases: Array<{ phase: string; ms: number }> = []
  let latest: Progress | undefined, since = started, printed = started
  const line = (p: Progress) => `[${duration(Date.now() - started)}] ${phaseLabel(p)}${p.total ? ` ${p.done}/${p.total}` : ''}`
  const say = (text: string) => { printed = Date.now(); write(text) }
  // The timer covers phases that wait on an adapter; a phase that blocks the event loop, such as the write transaction, cannot fire
  // it, so an update a whole interval after the last line prints too.
  const timer = setInterval(() => { if (latest) say(`${line(latest)} (still running)`) }, intervalMs).unref()
  const close = () => { if (latest) phases.push({ phase: phaseLabel(latest), ms: Date.now() - since }) }
  return {
    update(p) {
      if (!latest || phaseLabel(latest) !== phaseLabel(p)) { close(); since = Date.now(); say(line(p)) }
      else if (Date.now() - printed >= intervalMs) say(line(p))
      latest = p
    },
    stop() { clearInterval(timer); close(); latest = undefined; return phases },
  }
}
