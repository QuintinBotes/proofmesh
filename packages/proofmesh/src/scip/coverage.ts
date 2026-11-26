// What a SCIP index covers (A27): each document that names a file in a tree, with that file's hash as the tree stands, read a document at a time (FR164).
import fs from 'node:fs'
import path from 'node:path'
import { sha256File } from '../core/hash.js'
import { repositoryPath, scanScip } from './decode.js'

/** `root` is the tree the index was produced against and the repository root its paths are made relative to. Throws if the file is not a SCIP index. */
export function indexCoverage(file: string, root: string, repositoryRoot = root): { files: Record<string, { hash: string; language: string }>; missing: number; tool: string } {
  const files: Record<string, { hash: string; language: string }> = {}
  let missing = 0, tool = '', meta = { projectRoot: '' }
  scanScip(file, {
    metadata: (m) => { tool = `${m.tool.name} ${m.tool.version}`.trim(); meta = m },
    document: (doc) => {
      const rel = repositoryPath(meta, doc, repositoryRoot), abs = rel ? path.join(root, rel) : undefined
      if (rel && abs && fs.existsSync(abs) && fs.lstatSync(abs).isFile()) files[rel] = { hash: sha256File(abs), language: doc.language || 'unknown' }
      else missing++
    },
  })
  return { files, missing, tool }
}
