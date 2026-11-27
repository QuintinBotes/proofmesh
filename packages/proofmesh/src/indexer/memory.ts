import os from 'node:os'

/** Half of physical memory, held between these bounds: the one rule that sizes an adapter's budget and the index host's heap. */
export const MIN_MEMORY_MB = 8192
export const MAX_MEMORY_MB = 32768
export const HOST_MEMORY_ENV = 'PROOFMESH_HOST_MEMORY_MB'
/**
 * V8 flags for every Node process an index starts: the index host and each JavaScript adapter. V8's defaults trade memory for speed, with
 * a young generation of up to 64 MB and an old generation left to grow to several times its live data between full collections, so on
 * the parity fixture each process held about 490 MB for 60 to 160 MB of live data (#32). A 4 MB semi-space and a 25% growing factor keep
 * the resident set near the live data, for more, smaller collections. A heap flag the person gives still comes later, and wins.
 */
export const NODE_GC_FLAGS = ['--max-semi-space-size=4', '--heap-growing-percent=25']

const wholeMb = (v: unknown): number | undefined => (v !== undefined && v !== '' && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined)

/** Physical memory in bytes; PROOFMESH_TEST_TOTALMEM_MB stands in for it only with PROOFMESH_TEST_HARNESS set, so tests need not own a big machine. */
export function physicalMemoryBytes(): number {
  const fake = process.env.PROOFMESH_TEST_HARNESS ? wholeMb(process.env.PROOFMESH_TEST_TOTALMEM_MB) : undefined
  return fake ? fake * 1048576 : os.totalmem()
}

export const machineMemoryMb = (totalBytes: number = physicalMemoryBytes()): number => Math.min(MAX_MEMORY_MB, Math.max(MIN_MEMORY_MB, Math.floor(totalBytes / 2 / 1048576)))

/** The heap of the index host in MB: PROOFMESH_HOST_MEMORY_MB when set, else the machine rule. */
export const hostHeapMb = (totalBytes?: number): { mb: number; source: 'setting' | 'machine' } => {
  const set = wholeMb(process.env[HOST_MEMORY_ENV])
  return set ? { mb: set, source: 'setting' } : { mb: machineMemoryMb(totalBytes), source: 'machine' }
}
