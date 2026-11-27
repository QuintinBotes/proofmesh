import { execFile, type ExecFileOptions } from 'node:child_process'

/**
 * What `ps` prints, or undefined where it cannot say. Never rejects: Node throws a refused spawn (EPERM, as from a sandbox that will
 * not exec the setuid /bin/ps on macOS) synchronously instead of passing it to the callback, so the call is guarded as well (#105).
 */
export function psOutput(args: string[], opts: ExecFileOptions = {}): Promise<string | undefined> {
  return new Promise((resolve) => {
    try { execFile('ps', args, { ...opts, encoding: 'utf8' }, (e, out) => resolve(e ? undefined : String(out))) } catch { resolve(undefined) }
  })
}
