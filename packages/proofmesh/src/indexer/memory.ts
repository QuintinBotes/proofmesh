import os from 'node:os'

/** Half of physical memory, held between these bounds: the one rule that sizes an adapter's budget and the index host's heap. */
export const MIN_MEMORY_MB = 8192
export const MAX_MEMORY_MB = 32768
export const HOST_MEMORY_ENV = 'PROOFMESH_HOST_MEMORY_MB'

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
