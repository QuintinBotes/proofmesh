import fs from 'node:fs'
import path from 'node:path'

/** Only the listener port is advertised. Launch tokens and browser cookies stay with the view server. */
export function announceViewPort(dataDir: string, port: number) {
  const dir = path.join(dataDir, 'views')
  fs.mkdirSync(dir, { recursive: true })
  const record = path.join(dir, `${process.pid}-${port}`)
  fs.writeFileSync(record, '', { mode: 0o600 })
  return () => fs.rmSync(record, { force: true })
}

export function activeViewPort(dataDir: string): number | null {
  const dir = path.join(dataDir, 'views')
  try {
    const views = fs.readdirSync(dir).flatMap(name => {
      const match = /^(\d+)-(\d+)$/.exec(name)
      if (!match) return []
      const pid = Number(match[1]), port = Number(match[2])
      if (pid < 1 || port < 1 || port > 65535) return []
      try {
        process.kill(pid, 0)
        return [{ port, time: fs.statSync(path.join(dir, name)).mtimeMs }]
      } catch { return [] }
    })
    return views.sort((a, b) => b.time - a.time || a.port - b.port)[0]?.port ?? null
  } catch { return null }
}
