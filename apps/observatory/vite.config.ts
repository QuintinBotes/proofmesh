import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** Writes a Brotli and a gzip copy beside every text asset, so the view server sends them compressed without compressing per request (FR1450). */
function precompress(): Plugin {
  let outDir = ''
  return {
    name: 'proofmesh-precompress',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir) },
    closeBundle() {
      const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
      for (const file of walk(outDir).filter((f) => /\.(js|css|html|svg|json)$/.test(f))) {
        const body = fs.readFileSync(file)
        fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }))
        fs.writeFileSync(`${file}.gz`, zlib.gzipSync(body, { level: 9 }))
      }
    },
  }
}

export default defineConfig({ plugins: [react(), precompress()], base: '/', build: { outDir: 'dist', emptyOutDir: true, sourcemap: false } })
