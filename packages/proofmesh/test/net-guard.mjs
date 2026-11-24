// Preloaded with --import into every Node process of a run under test (FR053). Each attempt to reach a host other than loopback,
// by socket, DNS lookup or fetch, is written to PROOFMESH_NET_LOG and refused, so nothing leaves the machine; loading writes one line too.
import child from 'node:child_process'
import dns from 'node:dns'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'

const log = process.env.PROOFMESH_NET_LOG
const write = (entry) => fs.appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|::ffff:127(\.\d{1,3}){3})$/i
const local = (host) => host === undefined || host === null || LOOPBACK.test(String(host).replace(/^\[|\]$/g, ''))
const refused = (target) => Object.assign(new Error(`net-guard refused ${target}`), { code: 'ECONNREFUSED' })

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  // net.connect hands over its normalized arguments as an array; a string that is not a port is a local IPC path.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  const opts = first && typeof first === 'object' ? first : typeof first === 'string' && !/^\d+$/.test(first) ? { path: first } : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined }
  if (opts.path === undefined && !local(opts.host)) {
    write({ kind: 'connect', target: `${opts.host}:${opts.port}` })
    process.nextTick(() => this.destroy(refused(opts.host)))
    return this
  }
  return connect.apply(this, args)
}

const lookup = dns.lookup
dns.lookup = function (host, ...rest) {
  if (local(host)) return lookup.call(this, host, ...rest)
  write({ kind: 'dns', target: host })
  const cb = rest.find((a) => typeof a === 'function')
  process.nextTick(() => cb?.(Object.assign(new Error(`net-guard refused ${host}`), { code: 'ENOTFOUND' })))
}
const lookupAsync = dns.promises.lookup
dns.promises.lookup = async function (host, ...rest) {
  if (local(host)) return lookupAsync.call(this, host, ...rest)
  write({ kind: 'dns', target: host })
  throw Object.assign(new Error(`net-guard refused ${host}`), { code: 'ENOTFOUND' })
}

const realFetch = globalThis.fetch
globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (local(url.hostname)) return realFetch(input, init)
  write({ kind: 'fetch', target: url.href })
  throw refused(url.hostname)
}

// Adapters are Node children started with a cleared environment, so the guard passes itself on to them explicitly.
const spawn = child.spawn
child.spawn = function (command, args, options) {
  if (command === process.execPath && Array.isArray(args)) return spawn.call(this, command, [`--import=${import.meta.url}`, ...args], { ...options, env: { ...(options?.env ?? process.env), PROOFMESH_NET_LOG: log } })
  return spawn.apply(this, arguments)
}

// Named imports of node:dns and node:child_process made after this point see the patched functions.
syncBuiltinESMExports()
write({ kind: 'loaded', argv: process.argv.slice(1) })
