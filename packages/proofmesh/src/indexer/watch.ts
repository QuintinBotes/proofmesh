import fs from 'node:fs'
import { asProofmeshError } from '../core/errors.js'
import { Catalog } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'
import { indexRepository } from './coordinator.js'
import { workingTree } from './freshness.js'
import { registryFor } from './languages.js'

export type WatchOptions = { intervalMs: number; quietMs: number; poll: boolean; log: (line: string) => void; signal: AbortSignal }

/** The manifest the repository's current snapshot was built from, or null when none is published. */
function publishedManifest(dataDir: string, repositoryId: string): { id: string; manifest: string } | null {
  const catalog = Catalog.open(dataDir)
  try {
    const snapshot = catalog.currentSnapshot(repositoryId)
    if (!snapshot) return null
    const db = openSnapshot(catalog, snapshot)
    try {
      return { id: snapshot.id, manifest: (JSON.parse((db.prepare("select value from meta where key = 'identity'").get() as { value: string }).value) as { manifest_hash: string }).manifest_hash }
    } finally {
      db.close()
    }
  } finally {
    catalog.close()
  }
}

/**
 * Keeps a repository's snapshot current (FR009). A filesystem notification only makes the next check sooner: whether to index is
 * always decided by comparing the working tree with the published snapshot's manifest, and a full check also runs on a fixed
 * interval, so a lost notification delays an update but never skips it.
 */
export async function watch(dataDir: string, repoIdOrPath: string, o: WatchOptions): Promise<void> {
  const catalog = Catalog.open(dataDir)
  const repo = catalog.repository(repoIdOrPath)
  catalog.close()
  let timer: NodeJS.Timeout | undefined
  let running = false, again = false, reported = ''
  const schedule = (ms: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => void check(), ms)
  }
  const check = async () => {
    if (running) { again = true; return }
    running = true
    try {
      do {
        again = false
        const published = publishedManifest(dataDir, repo.id)
        if (published && workingTree(repo.root, registryFor(dataDir, repo.id)).manifest === published.manifest) {
          if (reported !== published.id) o.log(`current ${published.id}`)
          reported = published.id
          continue
        }
        o.log('working tree changed; indexing')
        const r = await indexRepository(dataDir, repo.id)
        o.log(`snapshot ${r.snapshotId} ${r.status}`)
        reported = r.snapshotId
      } while (again && !o.signal.aborted)
    } catch (e) {
      const err = asProofmeshError(e)
      o.log(`${err.code}: ${err.message}`)
      // An unstable tree is retried once it is quiet; other failures wait for the next change or interval.
      if (err.code === 'UNSTABLE_WORKTREE') schedule(o.quietMs)
    } finally {
      running = false
    }
  }
  const watcher = o.poll ? null : fs.watch(repo.root, { recursive: true }, (_event, file) => {
    if (!/^\.git(\/|\\|$)/.test(String(file ?? ''))) schedule(o.quietMs)
  })
  const interval = setInterval(() => schedule(0), o.intervalMs)
  schedule(0)
  await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }))
  clearInterval(interval)
  clearTimeout(timer)
  watcher?.close()
  while (running) await new Promise((r) => setTimeout(r, 100))
}
