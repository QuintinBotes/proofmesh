const LEVELS = { debug: 10, info: 20, warning: 30, error: 40 } as const
type Level = keyof typeof LEVELS
const threshold = LEVELS[(process.env.PROOFMESH_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info

/** Structured logs go to stderr only, so stdout stays clean for protocols. Never log source content. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold) return
  process.stderr.write(JSON.stringify({ level, msg, ...fields }) + '\n')
}
