import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The schemas directory: next to the bundle when packaged, at the repository root during development. */
export function schemasDir(): string {
  const candidates = [path.join(here, 'schemas'), path.join(here, '..', 'schemas'), path.resolve(here, '..', '..', '..', '..', 'schemas')]
  const found = candidates.find((c) => fs.existsSync(path.join(c, 'envelope.schema.json')))
  if (!found) throw new Error(`schemas directory not found near ${here}`)
  return found
}

export function observatoryDir(): string | undefined {
  const candidates = [path.join(here, 'observatory'), path.resolve(here, '..', '..', '..', '..', 'apps', 'observatory', 'dist')]
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html')))
}

export const resolveDataDir = (flag?: string): string =>
  path.resolve(flag ?? process.env.PROOFMESH_DATA_DIR ?? path.join(os.homedir(), '.proofmesh'))
