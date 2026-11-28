// Vue and Svelte single-file components (FR2280, FR2283): their script blocks and template, read by offset with no framework compiler.

export type Framework = 'vue' | 'svelte'
export type Script = { start: number; end: number; lang: string | undefined }
/** A component's script blocks, the ranges its template markup spans, and why it cannot be read, if it cannot. */
export type Sfc = { scripts: Script[]; markup: Array<[number, number]>; error?: string }
/** What a template uses: a tag, or the text of an expression at its offset in the file. */
export type Use = { tag: string; start: number; end: number } | { expr: string; start: number }

const blank = (s: string) => s.replace(/[^\n\r]/g, ' ')
const attr = (attrs: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?`, 'i').exec(attrs)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined
}

/** The blocks of a component: each `<script>` (Vue's `<script>` and `<script setup>` both), and the markup: Vue's top-level `<template>`, or all of a Svelte file outside its scripts and styles. */
export function readSfc(text: string, framework: Framework): Sfc {
  const code = text.replace(/<!--[\s\S]*?(?:-->|$)/g, blank), lower = code.toLowerCase()
  const scripts: Script[] = [], blocks: Array<[number, number]> = []
  for (const m of code.matchAll(/<(script|style)\b([^>]*)>/gi)) {
    if (blocks.some(([s, e]) => m.index >= s && m.index < e)) continue
    const name = m[1]!.toLowerCase(), close = lower.indexOf(`</${name}`, m.index + m[0].length)
    if (close < 0) return { scripts, markup: [], error: `unclosed_${name}` }
    blocks.push([m.index, lower.indexOf('>', close) + 1 || code.length])
    if (name === 'script') scripts.push({ start: m.index + m[0].length, end: close, lang: attr(m[2]!, 'lang')?.toLowerCase() })
  }
  if (framework === 'svelte') {
    const markup: Array<[number, number]> = []
    let from = 0
    for (const [s, e] of blocks.sort((a, b) => a[0] - b[0])) { markup.push([from, s]); from = e }
    return { scripts, markup: [...markup, [from, code.length] as [number, number]].filter(([s, e]) => e > s) }
  }
  // Vue: the first top-level <template> to its matching close; a template in another language (pug) is not read.
  const open = [...code.matchAll(/<template\b([^>]*)>/gi)].find((m) => !blocks.some(([s, e]) => m.index >= s && m.index < e))
  if (!open || (attr(open[1]!, 'lang') ?? 'html') !== 'html') return { scripts, markup: [] }
  const tags = /<(\/?)template\b[^>]*>/gi
  tags.lastIndex = open.index + open[0].length
  for (let depth = 1, m = tags.exec(code); m; m = tags.exec(code)) {
    depth += m[1] ? -1 : m[0].endsWith('/>') ? 0 : 1
    if (!depth) return { scripts, markup: [[open.index + open[0].length, m.index]] }
  }
  return { scripts, markup: [], error: 'unclosed_template' }
}

/** The text a checker reads: the script blocks where they are, everything else blanked, so every offset and line is the component file's own. */
export function virtualText(text: string, scripts: Script[]): string {
  let out = '', from = 0
  for (const s of scripts) { out += blank(text.slice(from, s.start)) + text.slice(s.start, s.end); from = s.end }
  return out + blank(text.slice(from))
}

/** Where a `{` ends, past nested braces and strings; the text's end when it does not. */
function braceEnd(code: string, at: number): number {
  let depth = 0
  for (let i = at; i < code.length; i++) {
    const c = code[i]!
    if (c === '"' || c === "'" || c === '`') { const q = c; for (i++; i < code.length && code[i] !== q; i++) if (code[i] === '\\') i++ }
    else if (c === '{') depth++
    else if (c === '}' && !--depth) return i
  }
  return code.length
}

/** A Svelte tag's expression without its block keyword: `{#each items as item}` uses `items`, `{:else if x}` uses `x`, `{/if}` and `{:then v}` use nothing. */
function svelteExpr(text: string, start: number, end: number): Use | undefined {
  const inner = text.slice(start, end), m = /^\s*([#:@/])(\w+)(\s+if\b)?/.exec(inner)
  if (!m) return { expr: inner, start }
  if (m[1] === '/' || m[2] === 'snippet' || ((m[2] === 'else' || m[2] === 'then' || m[2] === 'catch') && !m[3])) return undefined
  const rest = inner.slice(m[0].length), cut = rest.search(m[2] === 'each' ? /\sas\s/ : m[2] === 'await' ? /\s(then|catch)\b/ : /$/)
  return { expr: rest.slice(0, cut < 0 ? rest.length : cut), start: start + m[0].length }
}

/**
 * The tags and expressions a template uses, in order: Vue's `{{ }}` and the values of `v-`, `:` and `@` attributes (a `v-for`'s source,
 * no slot props); Svelte's `{ }` in text and attributes, block expressions included.
 */
// shortcut: a name a v-for, slot or {#each} binds in the template still reads as the script binding of that name; scope template names if a fixture needs it.
export function templateUses(text: string, sfc: Sfc, framework: Framework): Use[] {
  const code = text.replace(/<!--[\s\S]*?(?:-->|$)/g, blank), out: Use[] = []
  const brace = (at: number) => { const end = braceEnd(code, at), u = svelteExpr(text, at + 1, end); if (u) out.push(u); return end + 1 }
  for (const [from, to] of sfc.markup) {
    for (let i = from; i < to;) {
      if (code[i] === '<' && /[A-Za-z]/.test(code[i + 1] ?? '')) {
        const tag = /^[A-Za-z][\w.:-]*/.exec(code.slice(i + 1))![0]
        let j = i + 1 + tag.length
        while (j < to && code[j] !== '>') {
          if (/\s|\//.test(code[j]!)) { j++; continue }
          if (framework === 'svelte' && code[j] === '{') { j = brace(j); continue }
          const name = /^[^\s=>/{]+/.exec(code.slice(j))?.[0] ?? code[j]!
          j += name.length
          const eq = /^\s*=\s*/.exec(code.slice(j))
          if (!eq) continue
          j += eq[0].length
          const q = code[j]
          if (framework === 'svelte' && q === '{') { j = brace(j); continue }
          const vstart = q === '"' || q === "'" ? j + 1 : j
          const vend = q === '"' || q === "'" ? (code.indexOf(q, vstart) + 1 || to + 1) - 1 : vstart + /^[^\s>]*/.exec(code.slice(vstart))![0].length
          j = q === '"' || q === "'" ? vend + 1 : vend
          if (framework === 'svelte') { for (let k = code.indexOf('{', vstart); k >= 0 && k < vend; k = code.indexOf('{', k)) k = brace(k) }
          else if (/^(v-|:|@)/.test(name) && !/^v-slot\b/.test(name)) {
            const value = text.slice(vstart, vend), of = name === 'v-for' ? /\s(in|of)\s/.exec(value) : null
            out.push(of ? { expr: value.slice(of.index + of[0].length), start: vstart + of.index + of[0].length } : { expr: value, start: vstart })
          }
        }
        out.push({ tag, start: i, end: Math.min(j + 1, to) })
        i = j + 1
      } else if (framework === 'vue' && code.startsWith('{{', i)) {
        const close = code.indexOf('}}', i + 2)
        if (close < 0 || close > to) break
        out.push({ expr: text.slice(i + 2, close), start: i + 2 })
        i = close + 2
      } else if (framework === 'svelte' && code[i] === '{') i = brace(i)
      else i++
    }
  }
  return out
}
