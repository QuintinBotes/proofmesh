import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import type { GalaxyHeader } from './galaxy.js'

const inflate = promisify(gunzip), deflate = promisify(gzip)
const projected = new WeakMap<Buffer, Promise<Buffer>>()

/** Terrain draws area bundles and degrees. The individual symbol adjacency list is available in the full representation. */
async function project(full: Buffer): Promise<Buffer> {
  const raw = await inflate(full)
  const length = raw.readUInt32LE(0)
  const header = JSON.parse(raw.toString('utf8', 4, 4 + length)) as GalaxyHeader
  const base = 4 + Math.ceil(length / 4) * 4
  // In v6, the links are the first section. Every later section keeps its bytes and alignment.
  const removed = header.offsets.degree
  for (const key of Object.keys(header.offsets) as (keyof GalaxyHeader['offsets'])[]) {
    if (key !== 'links') header.offsets[key] -= removed
  }
  header.links = 0
  const json = Buffer.from(JSON.stringify(header))
  const prefix = Buffer.alloc(4 + Math.ceil(json.length / 4) * 4)
  prefix.writeUInt32LE(json.length)
  json.copy(prefix, 4)
  return deflate(Buffer.concat([prefix, raw.subarray(base + removed)]))
}

export function terrainPayload(full: Buffer): Promise<Buffer> {
  let pending = projected.get(full)
  if (!pending) {
    pending = project(full).catch((error) => { projected.delete(full); throw error })
    projected.set(full, pending)
  }
  return pending
}
