// Rebuilds each grammar built.json lists from its package's source and checks the result against the recorded hash; --write
// records the new hashes and copies the WebAssembly here after a deliberate upgrade. Needs the `tree-sitter` CLI at the version
// built.json names on PATH: its wasm build fetches the clang (wasi-sdk) and wasm-opt that version pins, so the output does not
// depend on the machine (the same bytes on macOS arm64 and Linux arm64).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const here = path.dirname(new URL(import.meta.url).pathname)
const require = createRequire(path.join(here, '..', 'package.json'))
const record = path.join(here, 'built.json')
const built = JSON.parse(fs.readFileSync(record, 'utf8'))
const write = process.argv.includes('--write')
const cli = execFileSync('tree-sitter', ['--version'], { encoding: 'utf8' }).trim()
if (cli !== `tree-sitter ${built['tree-sitter']}`) throw new Error(`built.json pins tree-sitter ${built['tree-sitter']}; PATH has ${cli}`)
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-grammars-'))
let differ = 0
for (const [language, g] of Object.entries(built.grammars)) {
  const dir = path.dirname(require.resolve(`${g.package}/package.json`))
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
  const wasm = path.join(out, `${language}.wasm`)
  execFileSync('tree-sitter', ['build', '--wasm', '-o', wasm, dir], { stdio: ['ignore', 'ignore', 'inherit'] })
  const sha256 = createHash('sha256').update(fs.readFileSync(wasm)).digest('hex')
  if (write) {
    fs.writeFileSync(path.join(here, `${language}.wasm`), fs.readFileSync(wasm))
    fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(here, `${language}.LICENSE`))
    Object.assign(g, { version, sha256 })
  } else if (sha256 !== g.sha256 || version !== g.version) {
    differ++
    console.error(`${language}: built ${g.package}@${version} ${sha256}, recorded ${g.version} ${g.sha256}`)
  }
  console.log(`${language}: ${g.package}@${version} ${sha256}`)
}
fs.rmSync(out, { recursive: true, force: true })
if (write) fs.writeFileSync(record, JSON.stringify(built, null, 2) + '\n')
process.exitCode = differ ? 1 : 0
