// What the syntax tier's adapters share: the pinned grammars, and UTF-8 offsets for Tree-sitter's UTF-16 indices.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Language, Parser } from 'web-tree-sitter'

export type Range = { start_byte: number; end_byte: number; start_line: number; end_line: number }
export const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n')
const here = path.dirname(fileURLToPath(import.meta.url))
export const grammarsDir = path.join(here, 'grammars')
export const manifest = JSON.parse(fs.readFileSync(path.join(grammarsDir, 'grammars.json'), 'utf8')) as Record<string, { package: string; version: string; sha256: string }>

const languages = new Map<string, Promise<Language>>()
export function language(name: string): Promise<Language> {
  let l = languages.get(name)
  if (!l) { l = Language.load(fs.readFileSync(path.join(grammarsDir, `${name}.wasm`))); languages.set(name, l) }
  return l
}

export async function parser(name: string): Promise<Parser> {
  const p = new Parser()
  p.setLanguage(await language(name))
  return p
}

/** The toolchain entries that pin each grammar an adapter uses: its package version and the hash of its WebAssembly. */
export function toolchain(names: string[]): Record<string, string> {
  const out: Record<string, string> = { 'web-tree-sitter': JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve('web-tree-sitter'))), 'package.json'), 'utf8')).version }
  for (const n of names) out[`grammar:${n}`] = `${manifest[n]!.package}@${manifest[n]!.version} ${manifest[n]!.sha256.slice(0, 16)}`
  return out
}

/** UTF-8 byte offset of every UTF-16 code unit index, because Tree-sitter counts code units and the protocol counts bytes. */
export function byteOffsets(text: string): Uint32Array {
  const out = new Uint32Array(text.length + 1)
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    out[i] = bytes
    const c = text.charCodeAt(i)
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : c >= 0xdc00 && c <= 0xdfff ? 0 : 3
  }
  out[text.length] = bytes
  return out
}

/** The last line holding content, counting a final line break as the end of that line. */
export const lastLine = (text: string) => Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0))
