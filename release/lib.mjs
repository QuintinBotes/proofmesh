// Shared by the release scripts: paths, hashing, and the packages a release ships.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const out = process.env.PROOFMESH_RELEASE_OUT ?? path.join(root, 'release', 'out')
export const PACKAGES = ['packages/proofmesh', 'adapters/typescript', 'adapters/syntax']
export const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
export const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
export const version = () => readJson(path.join(root, 'packages/proofmesh/package.json')).version
export const tarballs = () => fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith('.tgz')).sort().map((f) => path.join(out, f)) : []
/** Production dependencies of every workspace package, by license, as pnpm reports them. */
export const licenseReport = () => JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--prod', '--json', '--recursive'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }))
