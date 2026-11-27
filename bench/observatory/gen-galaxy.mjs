// A synthetic Galaxy of any size (#41 scenario 2), project-authored (Apache-2.0). Deterministic for a seed: the same seed, size,
// snapshot id and ids give byte-identical files. It is written in the server's own galaxy format (packages/proofmesh/src/query/galaxy.ts)
// into its cache, so the real `proofmesh view` serves it and the transfer path is measured. Each point's id is one of the indexed
// fixture's real symbol ids, in turn, so opening a point shows real evidence.
import zlib from 'node:zlib'

const WORDS = ['order', 'user', 'repository', 'query', 'entity', 'column', 'metadata', 'driver', 'schema', 'relation', 'connection', 'migration', 'builder', 'cache', 'index', 'table', 'event', 'subscriber', 'transaction', 'listener']
const KINDS = [['method', 40], ['property', 25], ['function', 10], ['class', 10], ['constructor', 5], ['interface', 5], ['variable', 5]]
const cap = (w) => w[0].toUpperCase() + w.slice(1)

/** mulberry32: a small seeded generator, the same on every platform. */
function random(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** { gz, ids, links }: the gzipped galaxy and the id of each point, for `nodes` symbols and about 2.94 links per symbol. */
export function generateGalaxy({ nodes: n, seed, snapshotId, ids: real }) {
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new Error(`--nodes must be an integer from 1 to 1,000,000, not ${n}`)
  if (!real.length) throw new Error('the indexed fixture has no symbols to map synthetic points to')
  const rnd = random(seed)
  const A = Math.max(8, Math.round(n / 400))
  // Areas of unequal size, as a real repository's are: a point lands in area floor(A * u^2).
  const area = new Uint16Array(n), kind = new Uint8Array(n), degree = new Uint32Array(n)
  const members = Array.from({ length: A }, () => [])
  const kindTotal = KINDS.reduce((s, [, w]) => s + w, 0)
  const names = []
  for (let i = 0; i < n; i++) {
    const a = Math.min(A - 1, Math.floor(A * rnd() ** 2))
    area[i] = a; members[a].push(i)
    let k = rnd() * kindTotal, ki = 0
    while (k >= KINDS[ki][1]) k -= KINDS[ki++][1]
    kind[i] = ki
    const w = () => WORDS[Math.floor(rnd() * WORDS.length)]
    names.push(`${cap(w())}${cap(w())}${a}.${w()}${cap(w())}${i}`)
  }
  // Links: four in five within the area, the rest anywhere; no self links and no repeats, as the server's are.
  const L = Math.round(n * 2.94), seen = new Set(), pairs = new Uint32Array(Math.min(L, n * (n - 1)) * 2)
  let made = 0
  for (let tries = 0; made < pairs.length / 2 && tries < L * 20; tries++) {
    const a = Math.floor(rnd() * n), m = members[area[a]]
    const b = rnd() < 0.8 ? m[Math.floor(rnd() * m.length)] : Math.floor(rnd() * n)
    const key = a * n + b
    if (a === b || seen.has(key)) continue
    seen.add(key); pairs[made * 2] = a; pairs[made * 2 + 1] = b; made++
    degree[a]++; degree[b]++
  }
  const kinds = KINDS.map(([k]) => k)
  const areas = members.map((m, a) => ({
    name: `src/pkg${a % 16}/mod${a}`, count: m.length,
    files: { indexed: Math.ceil(m.length / 8), unsupported: 0, excluded: 0, failed: 0, pending: 0 },
    calls: { sites: m.length * 2, unresolved: Math.floor(m.length / 5) }, gaps: [],
  }))
  // The analysed files the palette lists: each area's, named in order.
  const files = areas.flatMap((a) => Array.from({ length: a.files.indexed }, (_, k) => `${a.name}/file${k}.ts`)).sort()
  const nameBytes = Buffer.from(names.join('\n'), 'utf8')
  const sections = [Buffer.from(pairs.buffer, 0, made * 8), Buffer.from(degree.buffer), Buffer.from(area.buffer), Buffer.from(kind.buffer), nameBytes]
  const offsets = []
  let at = 0
  for (const s of sections) { offsets.push(at); at += s.length; at += (4 - (at % 4)) % 4 }
  const header = Buffer.from(JSON.stringify({
    snapshot_id: snapshotId, nodes: n, links: made, areas, kinds, files, names_bytes: nameBytes.length,
    offsets: { links: offsets[0], degree: offsets[1], area: offsets[2], kind: offsets[3], names: offsets[4] },
  }), 'utf8')
  const parts = [Buffer.from(new Uint32Array([header.length]).buffer), header, Buffer.alloc((4 - ((4 + header.length) % 4)) % 4)]
  sections.forEach((s, i) => { parts.push(s); const end = offsets[i] + s.length; parts.push(Buffer.alloc((i + 1 < sections.length ? offsets[i + 1] : end) - end)) })
  return { gz: zlib.gzipSync(Buffer.concat(parts), { level: 6 }), ids: Array.from({ length: n }, (_, i) => real[i % real.length]), links: made }
}
