import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { asProofmeshError, ProofmeshError } from '../core/errors.js'
import { randomToken } from '../core/hash.js'
import { observatoryDir } from '../core/paths.js'
import { runTool } from '../query/tools.js'
import { GALAXY_FORMAT, galaxyFor } from '../query/galaxy.js'
import { Catalog } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
const STATUS: Record<string, number> = { INVALID_ARGUMENT: 400, UNAUTHORIZED: 401, SCOPE_DENIED: 403, NOT_FOUND: 404, SNAPSHOT_UNAVAILABLE: 409 }
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' }
const TOKEN_TTL_MS = 10 * 60 * 1000
/** What a content hash or a sealed snapshot names never changes, so a browser may keep it for a year without asking again (FR1450, FR1453). */
const IMMUTABLE = 'max-age=31536000, immutable'
/** Precompressed copies the build writes beside each asset, best first (FR1450). */
const ENCODINGS: Array<[string, string]> = [['br', '.br'], ['gzip', '.gz']]
/** Whether Accept-Encoding names the coding with a q above 0. */
const accepts = (header: string | undefined, coding: string) => (header ?? '').split(',').some((part) => {
  const [name, ...params] = part.split(';').map((x) => x.trim())
  const q = params.map((x) => /^q=([\d.]+)$/.exec(x)?.[1]).find((x) => x !== undefined)
  return name === coding && (q === undefined || Number(q) > 0)
})

export type ViewServer = { url: string; port: number; launchUrl: string; issueToken: () => string; close: () => Promise<void> }

/** Loopback-only server for Observatory and the tool API. Every request is checked for Host; API calls need a session and a same-origin request. */
export async function startViewServer(dataDir: string, port = 7317, assets = observatoryDir()): Promise<ViewServer> {
  const tokens = new Map<string, number>()
  const sessions = new Set<string>()
  let actualPort = port
  const hosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`])
  const origins = () => new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`])

  const server = http.createServer(async (req, res) => {
    const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }
    const send = (status: number, body: string | Buffer, type = 'application/json', extra: Record<string, string> = {}) => {
      res.writeHead(status, { ...headers, 'Content-Type': type, ...extra })
      res.end(body)
    }
    const fail = (e: ProofmeshError) => send(STATUS[e.code] ?? 500, JSON.stringify(e.toJSON()))
    const signedIn = () => { const cookie = /(?:^|;\s*)pm_session=([0-9a-f]+)/.exec(String(req.headers.cookie ?? '')); return !!cookie && sessions.has(cookie[1]!) }
    if (!hosts().has(req.headers.host ?? '')) return fail(new ProofmeshError('SCOPE_DENIED', 'unexpected Host header'))
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`)
    try {
      if (req.method === 'POST') {
        if (!origins().has(String(req.headers.origin ?? ''))) return fail(new ProofmeshError('SCOPE_DENIED', 'cross-origin request refused'))
        const body = await readBody(req)
        if (url.pathname === '/session') {
          const token = typeof body.token === 'string' ? body.token : ''
          const expires = tokens.get(token)
          tokens.delete(token)
          if (!expires || expires < Date.now()) return fail(new ProofmeshError('UNAUTHORIZED', 'launch token is unknown, used, or expired'))
          const session = randomToken()
          sessions.add(session)
          return send(204, '', 'text/plain', { 'Set-Cookie': `pm_session=${session}; HttpOnly; SameSite=Strict; Path=/` })
        }
        const m = /^\/api\/v1\/tools\/([a-z_]+)$/.exec(url.pathname)
        const api = m || url.pathname === '/api/v1/galaxy' || url.pathname === '/api/v1/galaxy/symbol' || url.pathname === '/api/v1/snapshots'
        if (api && !signedIn()) return fail(new ProofmeshError('UNAUTHORIZED', 'no valid session'))
        if (m) {
          // A lean answer is its text alone, as over MCP (FR095).
          const env = runTool(dataDir, m[1]!, body)
          return env.text !== undefined ? send(200, env.text, 'text/plain; charset=utf-8') : send(200, JSON.stringify(env))
        }
        const pinned = typeof body.snapshot_id === 'string' ? body.snapshot_id : undefined
        const scope = { snapshotId: pinned, repositoryId: typeof body.repository_id === 'string' ? body.repository_id : undefined }
        // The Observatory reads what every client can: these routes are the MCP tools' data (FR055).
        if (url.pathname === '/api/v1/snapshots') return send(200, JSON.stringify({ snapshots: (runTool(dataDir, 'list_snapshots', scope.repositoryId ? { repository_id: scope.repositoryId } : {}).data as { snapshots: unknown[] }).snapshots }))
        if (url.pathname === '/api/v1/galaxy') return send(200, galaxyFor(dataDir, scope).gz, 'application/octet-stream', { 'Content-Encoding': 'gzip' })
        if (url.pathname === '/api/v1/galaxy/symbol') {
          const id = galaxyFor(dataDir, scope).ids[Number(body.index)]
          if (!Number.isInteger(body.index) || !id) return fail(new ProofmeshError('INVALID_ARGUMENT', 'index is not a point of the current galaxy'))
          // With card, the point's get_symbol_card answer comes too, so a point opens with one request (FR1180); the tool checks its input.
          if (body.card !== undefined) {
            if (body.card === null || typeof body.card !== 'object' || Array.isArray(body.card)) return fail(new ProofmeshError('INVALID_ARGUMENT', 'card is the get_symbol_card input, without symbol_id'))
            const card = runTool(dataDir, 'get_symbol_card', { ...(body.card as Record<string, unknown>), symbol_id: id, ...(pinned ? { snapshot_id: pinned } : {}), ...(scope.repositoryId ? { repository_id: scope.repositoryId } : {}) })
            return send(200, JSON.stringify({ id, card }))
          }
          return send(200, JSON.stringify({ id }))
        }
        return fail(new ProofmeshError('NOT_FOUND', `no route ${url.pathname}`))
      }
      if (req.method !== 'GET') return fail(new ProofmeshError('INVALID_ARGUMENT', 'method not allowed'))
      if (url.pathname === '/api/workspaces') {
        if (!signedIn()) return fail(new ProofmeshError('UNAUTHORIZED', 'no valid session'))
        return send(200, JSON.stringify(runTool(dataDir, 'list_workspaces', {}).data))
      }
      // A sealed snapshot's Galaxy, at an address that changes only with the snapshot and the payload format, so the browser's
      // HTTP cache serves it again; private, as it is behind the session. A snapshot gc removed, or another format, is 404 (FR1453).
      const artefact = /^\/api\/v1\/galaxy\/v(\d+)\/([\w-]+)$/.exec(url.pathname)
      if (artefact) {
        if (!signedIn()) return fail(new ProofmeshError('UNAUTHORIZED', 'no valid session'))
        const catalog = Catalog.open(dataDir)
        const snapshot = Number(artefact[1]) === GALAXY_FORMAT ? catalog.snapshot(artefact[2]!) : undefined
        catalog.close()
        if (snapshot?.state !== 'published') return fail(new ProofmeshError('NOT_FOUND', `no Galaxy v${artefact[1]} for snapshot ${artefact[2]}`))
        return send(200, galaxyFor(dataDir, { snapshotId: snapshot!.id, repositoryId: snapshot!.repository_id }).gz, 'application/octet-stream', { 'Content-Encoding': 'gzip', 'Cache-Control': `private, ${IMMUTABLE}` })
      }
      if (!assets) return send(404, 'Observatory assets are not built; run pnpm build', 'text/plain; charset=utf-8')
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const file = path.resolve(assets, rel)
      if (!file.startsWith(path.resolve(assets) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'not found', 'text/plain; charset=utf-8')
      // Vite names every file under assets/ by its content hash; the page itself is asked for again each time (FR1450).
      const extra: Record<string, string> = { 'Cache-Control': rel.startsWith('assets/') ? `public, ${IMMUTABLE}` : 'no-cache' }
      if (ENCODINGS.some(([, ext]) => fs.existsSync(file + ext))) extra.Vary = 'Accept-Encoding'
      const type = TYPES[path.extname(file)] ?? 'application/octet-stream'
      const coded = ENCODINGS.find(([coding, ext]) => accepts(req.headers['accept-encoding'], coding) && fs.existsSync(file + ext))
      if (coded) return send(200, fs.readFileSync(file + coded[1]), type, { ...extra, 'Content-Encoding': coded[0] })
      return send(200, fs.readFileSync(file), type, extra)
    } catch (e) {
      return fail(asProofmeshError(e))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  actualPort = (server.address() as { port: number }).port
  const issueToken = () => {
    const t = randomToken()
    tokens.set(t, Date.now() + TOKEN_TTL_MS)
    return t
  }
  const url = `http://127.0.0.1:${actualPort}`
  return { url, port: actualPort, launchUrl: `${url}/#t=${issueToken()}`, issueToken, close: () => new Promise((r) => server.close(() => r())) }
}

/** The repository's published snapshots for Replay's picker, with the git state each was built from. */

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 1 << 20) { reject(new ProofmeshError('INVALID_ARGUMENT', 'request body too large')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {})
      } catch {
        reject(new ProofmeshError('INVALID_ARGUMENT', 'request body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}
