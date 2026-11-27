import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const app = path.resolve(import.meta.dirname, '..')

describe('FR1408 #42 exactly one WebGL stack ships in the Observatory: sigma, not cosmos.gl and luma.gl', () => {
  it('lists no cosmos.gl dependency, and its built bundle holds sigma and no cosmos.gl or luma.gl code', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'))
    expect(Object.keys(pkg.dependencies)).not.toContain('@cosmos.gl/graph')
    expect(Object.keys(pkg.dependencies)).toContain('sigma')
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-observatory-'))
    execFileSync(process.execPath, [path.join(app, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: app })
    const js = fs.readdirSync(path.join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(out, 'assets', f), 'utf8')).join('\n')
    expect(js).toMatch(/sigma/)
    expect(js).not.toMatch(/luma\.gl|@luma\.gl|cosmos\.gl|@cosmos\.gl/)
  }, 120000)
})
