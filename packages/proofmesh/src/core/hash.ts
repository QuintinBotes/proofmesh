import crypto from 'node:crypto'
import fs from 'node:fs'

export const sha256 = (data: string | Uint8Array): string => crypto.createHash('sha256').update(data).digest('hex')

export function sha256File(file: string): string {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** `${prefix}_` + the first `length` hex characters of sha256 over the parts joined by newlines. */
export const derivedId = (prefix: string, length: number, ...parts: Array<string | number>): string =>
  `${prefix}_${sha256(parts.join('\n')).slice(0, length)}`

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
export const queryId = (): string => `q_${Array.from(crypto.randomBytes(16), (b) => BASE32[b & 31]).join('')}`
export const randomToken = (): string => crypto.randomBytes(32).toString('hex')
