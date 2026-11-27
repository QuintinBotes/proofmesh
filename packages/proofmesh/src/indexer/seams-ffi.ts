// FFI seams inside one repository (FR460 to FR467): a call across a foreign-function interface is linked to the function on the other
// side by that mechanism's naming rule. Like the HTTP seams, the pass runs once over every adapter's facts, cached or not, and reads
// the files' text where the facts do not say enough (a `native` modifier, a `[DllImport]` attribute, a `PyMethodDef` table).
//
// Every row it writes is a `calls` row, origin `contract_match`, with the rule in `detail.rule`: `candidate` for one target, `ambiguous`
// for several, never `resolved`, because a naming convention is a name match (FR023) however strict. A declaration whose counterpart
// is not in the repository is `resolved_external`, named by the library where the code writes it. A call row it binds (cgo, Rust, C,
// Python) replaces the row the adapter wrote at that site; a declaration (JNI, P/Invoke) gets a row of its own at its own span.
//
//   jni                 a Java `native` or Kotlin `external` method -> the C function `Java_<class>_<method>[__<signature>]`
//   pinvoke             a C# `[DllImport]` or `[LibraryImport]` method -> the C function its EntryPoint or own name names
//   cgo                 `C.f(...)` in a Go file that imports "C" -> the C function f
//   cgo_export          a C call of f -> the Go function a `//export f` comment marks
//   rust_extern_c       a Rust call of a function an `extern "C"` block declares (a bare or `self::` call in the same file, a path call in
//                       the module file its path names) -> the C function (its `link_name` if it has one)
//   rust_no_mangle      a C call of f -> the Rust function `#[no_mangle]` f
//   python_c_extension  `m.f(...)` in Python, where m is imported -> the C function a `PyMethodDef` entry of module m registers as f
//
// A C function target is a definition (a body follows it) where the repository has one, else the prototypes that declare it.
import { canonicalJson } from '../core/hash.js'
import { CAP, type Item, type Rel, type Sym } from './constrained/common.js'
import { rustModules } from './constrained/rust.js'
import type { Qualified } from './seams-http.js'

/** Bump when a rule changes what is linked: it is part of a snapshot's identity, so an older snapshot is never reused. */
export const FFI_SEAMS_VERSION = '2'
export const FFI_PRODUCER = 'seams-ffi'

const C_FILE = /\.(c|h|cc|cpp|cxx|hpp|hh|hxx)$/
/** What cgo provides itself, and C's scalar types, whose `C.int(x)` is a conversion and no call. */
const CGO_BUILTIN = /^(CString|CBytes|GoString|GoStringN|GoBytes|(u|s)?char|(u)?short|(u)?int|(u)?long|(u)?longlong|float|double|s?size_t|u?int(8|16|32|64)_t|u?intptr_t|complexfloat|complexdouble|(struct|union|enum)_\w+)$/
const refOf = (producer: string, local: string) => `${producer}:${local}`
const RECENT_FILES = 64
/** How much text around a declaration is read for its modifiers and attributes: no FFI declaration's head is longer, and a hostile file cannot make the pass read more. */
const HEAD_BYTES = 4096
/** Comments, an unterminated one included, so no comment is searched to the end of the text again from each opener. */
const COMMENTS = /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/g

/** `Java_com_acme_Native_add__II` is `com.acme.Native.add`: `_1` is `_`, `_2` `;`, `_3` `[`, `_0xxxx` a UTF-16 unit, and `__` starts the signature. */
export function jniName(c: string): string | undefined {
  if (!c.startsWith('Java_')) return undefined
  let out = ''
  for (let i = 5; i < c.length; i++) {
    if (c[i] !== '_') { out += c[i]; continue }
    const n = c[i + 1]
    if (n === '_') break
    if (n === '0') { out += String.fromCharCode(parseInt(c.slice(i + 2, i + 6), 16)); i += 5 } else if (n === '1' || n === '2' || n === '3') { out += { 1: '_', 2: ';', 3: '[' }[n]; i++ } else out += '.'
  }
  // A nested class is `Outer$Inner` to the JVM and `Outer.Inner` to the syntax tier.
  return out.includes('.') ? out.replace(/\$/g, '.') : undefined
}
/** The short JNI name of a method: the inverse of jniName without the signature. */
const jniMangle = (qualified: string) => `Java_${qualified.split('.').map((p) => [...p].map((ch) => (ch === '_' ? '_1' : ch === ';' ? '_2' : ch === '[' ? '_3' : /[A-Za-z0-9]/.test(ch) ? ch : `_0${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)).join('')).join('_')}`

export function linkFfi<P extends { id: string }>(code: Sym[], items: Array<Item<P>>, read: (file: string) => Buffer | undefined, seams: P): Array<Item<P> | Qualified<P>> {
  // The files last read, so a pass over a large repository holds a few in memory and not all of them.
  const recent = new Map<string, { b: Buffer; t?: string }>()
  const entry = (f: string) => {
    const e = recent.get(f) ?? { b: read(f) ?? Buffer.alloc(0) }
    recent.delete(f)
    recent.set(f, e)
    if (recent.size > RECENT_FILES) recent.delete(recent.keys().next().value!)
    return e
  }
  const buf = (f: string) => entry(f).b
  const text = (f: string) => { const e = entry(f); return (e.t ??= e.b.toString('utf8')) }
  /** Whether a file mentions a word, asked once per file: most files mention no FFI at all and are not looked at again. */
  const said = new Map<string, boolean>()
  const mentions = (f: string, word: string) => { const k = `${f}\0${word}`; let v = said.get(k); if (v === undefined) said.set(k, (v = buf(f).includes(word))); return v }
  /** A declaration's own span up to its body, without comments: where Java, Kotlin and C# keep their modifiers and attributes. */
  const own = (s: Sym) => buf(s.path).subarray(s.start, Math.min(s.end, s.start + HEAD_BYTES)).toString('utf8').replace(COMMENTS, '').split('{')[0]!
  /** The text just above a declaration: where a Go `//export` comment and Rust attributes sit, outside the symbol's span. */
  const above = (s: Sym) => buf(s.path).subarray(Math.max(0, s.start - HEAD_BYTES), s.start).toString('utf8')
  // Each file's newline offsets, found once, so a file of many declarations is not counted from its start for each.
  const newlines = new Map<string, number[]>()
  const lineAt = (f: string, byte: number) => {
    let nl = newlines.get(f)
    if (!nl) { nl = []; const b = buf(f); for (let i = b.indexOf(0x0a); i >= 0; i = b.indexOf(0x0a, i + 1)) nl.push(i); newlines.set(f, nl) }
    let lo = 0, hi = nl.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid]! < byte) lo = mid + 1; else hi = mid }
    return lo + 1
  }
  const spanOf = (s: Sym): Rel['site'] => ({ path: s.path, range: { start_byte: s.start, end_byte: s.end, start_line: lineAt(s.path, s.start), end_line: lineAt(s.path, s.end) } })

  const functions = code.filter((s) => s.kind === 'function' || s.kind === 'method')
  const cByName = new Map<string, Sym[]>()
  for (const s of functions) if (C_FILE.test(s.path)) cByName.set(s.name, [...(cByName.get(s.name) ?? []), s])
  /** A C function's symbol spans its declarator: it is a definition when a body follows before any `;`. */
  const defines = (s: Sym) => { const b = buf(s.path), brace = b.indexOf('{', s.end), semi = b.indexOf(';', s.end); return brace >= 0 && (semi < 0 || brace < semi) }
  /** The C functions of a name: its definitions, else its prototypes. */
  const cTargets = (name: string) => { const all = cByName.get(name) ?? []; const defs = all.filter(defines); return defs.length ? defs : all }

  const added: Array<Qualified<P>> = []
  const replaced = new Map<Rel, Rel>()
  const row = (base: Omit<Rel, 'type' | 'origin' | 'resolution'>, targets: Sym[], rule: string, external?: { module: string; name: string }): Rel => {
    const { reason: _r, target: _t, candidates: _c, ...rest } = base as Rel
    const detail = { ...(rest.detail ?? {}), rule }
    if (!targets.length) return { ...rest, type: 'calls', origin: 'contract_match', resolution: 'resolved_external', target: { external: external! }, detail: { ...detail, ...(external!.module ? { library: external!.module } : {}) } }
    const refs = [...new Set(targets.map((t) => refOf(t.producer, t.local_id)))]
    return { ...rest, type: 'calls', origin: 'contract_match', resolution: refs.length === 1 ? 'candidate' : 'ambiguous', candidates: refs.slice(0, CAP), detail: { ...detail, ...(refs.length > CAP ? { more: String(refs.length - CAP) } : {}) } }
  }
  const declare = (s: Sym, targets: Sym[], rule: string, external: { module: string; name: string }) => added.push({ rel: row({ source: { symbol: refOf(s.producer, s.local_id) }, site: spanOf(s) }, targets, rule, external), producer: seams, qualified: true })
  const bind = (i: Item<P>, targets: Sym[], rule: string, external?: { module: string; name: string }) => replaced.set(i.rel, row({ ...i.rel, source: { symbol: refOf(i.producer.id, i.rel.source.symbol!) } }, targets, rule, external))

  // JNI: each native method, to the C functions whose JNI name decodes to it.
  const jni = new Map<string, Sym[]>()
  for (const s of cByName.values()) for (const f of s) { const q = jniName(f.name); if (q) jni.set(q, [...(jni.get(q) ?? []), f]) }
  for (const s of functions) {
    const word = s.path.endsWith('.java') ? 'native' : s.path.endsWith('.kt') ? 'external' : undefined
    if (!word || !mentions(s.path, word) || !new RegExp(`\\b${word}\\b`).test(own(s))) continue
    const library = /System\s*\.\s*loadLibrary\s*\(\s*"([^"\n]+)"/.exec(text(s.path))?.[1] ?? ''
    // The syntax tier names an overload with its parameter types; the JNI name of every overload is the method's.
    const method = s.qualified_name.replace(/\(.*\)$/, ''), targets = jni.get(method) ?? []
    // Kotlin/JS declares JavaScript functions `external` too: without a JNI function or a loaded library there is no sign of the JVM.
    if (word === 'external' && !targets.length && !library) continue
    declare(s, targets, 'jni', { module: library, name: jniMangle(method) })
  }
  // P/Invoke: each method a DllImport or LibraryImport attribute marks, to the C functions of its entry point.
  for (const s of functions) {
    if (!s.path.endsWith('.cs') || !(mentions(s.path, 'DllImport') || mentions(s.path, 'LibraryImport'))) continue
    const h = own(s), attr = /\[[^\]]*?\b(?:DllImport|LibraryImport)(?:Attribute)?\s*\(([^)]*)\)/.exec(h)
    if (!attr || !/\b(extern|partial)\b/.test(h)) continue
    const library = /^\s*"([^"]*)"/.exec(attr[1]!)?.[1] ?? '', entry = /\bEntryPoint\s*=\s*"([^"]+)"/.exec(attr[1]!)?.[1] ?? s.name
    declare(s, cTargets(entry), 'pinvoke', { module: library, name: entry })
  }

  // Exports to C: Go functions a `//export` comment marks and Rust functions `#[no_mangle]` marks, by the name C calls them.
  const exports = new Map<string, { rule: string; targets: Sym[] }>()
  for (const s of functions) {
    const go = s.path.endsWith('.go') && mentions(s.path, '//export') ? /\/\/export[ \t]+(\w+)[ \t]*\r?\n[ \t]*$/.exec(above(s))?.[1] : undefined
    // Only the attributes directly above the function: a comment that names no_mangle is none.
    const rust = s.path.endsWith('.rs') && mentions(s.path, 'no_mangle') && /#\[\s*(unsafe\s*\(\s*)?no_mangle\s*\)?\s*\]/.test(/(?:#\[[^[\]\n]*\][ \t]*\r?\n?[ \t]*)*$/.exec(above(s))![0]) ? s.name : undefined
    const name = go ?? rust, rule = go ? 'cgo_export' : 'rust_no_mangle'
    if (name) exports.set(name, { rule, targets: [...(exports.get(name)?.targets ?? []), s] })
  }
  // Rust: the functions each file's `extern "C"` blocks declare, by the name Rust calls them, with the C name and the library.
  const externs = new Map<string, Map<string, { c: string; library: string }>>()
  const rustFiles = new Set(code.filter((s) => s.path.endsWith('.rs')).map((s) => s.path))
  for (const f of rustFiles) {
    if (!mentions(f, 'extern')) continue
    const t = text(f)
    const mine = new Map<string, { c: string; library: string }>()
    for (const b of t.matchAll(/(#\[\s*link\s*\(([^\]]{0,1024})\)\s*\]\s*)?(?:unsafe\s+)?extern\s+"C"\s*\{([^}]*)(?:\}|$)/g)) {
      const library = /\bname\s*=\s*"([^"]+)"/.exec(b[2] ?? '')?.[1] ?? ''
      for (const fn of b[3]!.matchAll(/(#\[\s*link_name\s*=\s*"(\w+)"\s*\]\s*)?(?:pub(?:\([^)]*\))?\s+)?(?:(?:safe|unsafe)\s+)?fn\s+(\w+)/g)) mine.set(fn[3]!, { c: fn[2] ?? fn[3]!, library })
    }
    if (mine.size) externs.set(f, mine)
  }
  // Python: the functions each C extension module registers, by module and Python name.
  const extensions = new Map<string, Map<string, Sym[]>>()
  for (const f of new Set([...cByName.values()].flat().map((s) => s.path))) {
    if (!mentions(f, 'PyMethodDef')) continue
    const t = text(f)
    const module = /\bPyInit_(\w+)\s*\(/.exec(t)?.[1] ?? /\bPy_InitModule\d*\s*\(\s*"(\w+)"/.exec(t)?.[1]
    if (!module) continue
    const own = new Map((functions.filter((s) => s.path === f)).map((s) => [s.name, s]))
    const table = extensions.get(module) ?? new Map<string, Sym[]>()
    for (const m of t.matchAll(/PyMethodDef\s+\w+\s*\[\s*\w*\s*\]\s*=\s*\{([\s\S]*?)(?:\}\s*;|$)/g)) {
      for (const e of m[1]!.matchAll(/\{\s*"(\w+)"\s*,\s*(?:\(\s*PyCFunction\s*\)\s*)?(\w+)/g)) {
        const fn = own.get(e[2]!) ? [own.get(e[2]!)!] : cTargets(e[2]!)
        if (fn.length) table.set(e[1]!, [...(table.get(e[1]!) ?? []), ...fn])
      }
    }
    if (table.size) extensions.set(module, table)
  }
  /** A Python file's names for extension modules (`import calc`, `import pkg.calc as c`, `from pkg import calc`) and for their functions (`from calc import add`). */
  const pyNames = new Map<string, { modules: Map<string, string>; functions: Map<string, { module: string; name: string }> }>()
  const pyOf = (f: string) => {
    if (pyNames.has(f)) return pyNames.get(f)!
    const modules = new Map<string, string>(), fns = new Map<string, { module: string; name: string }>()
    for (const m of text(f).matchAll(/^[ \t]*import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+(\w+))?[ \t]*$/gm)) { const last = m[1]!.split('.').at(-1)!; if (extensions.has(last)) modules.set(m[2] ?? m[1]!, last) }
    for (const m of text(f).matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(\w[\w \t,]*)$/gm)) {
      const from = m[1]!.split('.').at(-1)!
      for (const part of m[2]!.split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/)
        if (!name) continue
        if (extensions.get(from)?.has(name)) fns.set(alias ?? name, { module: from, name })
        else if (extensions.has(name)) modules.set(alias ?? name, name)
      }
    }
    return pyNames.set(f, { modules, functions: fns }).get(f)!
  }

  // Rust modules by file, as constrained resolution reads them.
  const { moduleFile } = rustModules(rustFiles)
  /** A Go file's cgo: whether it imports "C", and the first library its `#cgo LDFLAGS` links. */
  const cgo = new Map<string, { library: string } | null>()
  const cgoOf = (f: string) => {
    if (!cgo.has(f)) cgo.set(f, mentions(f, '"C"') && /\bimport\s*(\(\s*)?"C"/.test(text(f)) ? { library: /#cgo\b[^\n]*\bLDFLAGS:[^\n]*?-l(\S+)/.exec(text(f))?.[1] ?? '' } : null)
    return cgo.get(f)
  }
  for (const i of items) {
    const r = i.rel, f = r.site.path, callee = r.detail?.callee
    if (r.type !== 'calls' || r.resolution !== 'unresolved' || !r.source.symbol || !callee) continue
    if (f.endsWith('.go')) {
      if (r.detail?.qualifier !== 'C' || CGO_BUILTIN.test(callee)) continue
      const c = cgoOf(f)
      if (c) bind(i, cTargets(callee), 'cgo', { module: c.library, name: callee })
    } else if (f.endsWith('.rs')) {
      // A bare call, or `self::f()`, may name an extern of its own file; any other path names the module whose file declares it, and a path through a type (`Foo::new()`) names none.
      const q = r.detail?.qualifier, file = !q || q === 'self' ? f : moduleFile(f, q)
      const ext = file ? externs.get(file)?.get(callee) : undefined
      if (ext) bind(i, cTargets(ext.c), 'rust_extern_c', { module: ext.library, name: ext.c })
    } else if (C_FILE.test(f)) {
      const e = !r.detail?.qualifier ? exports.get(callee) : undefined
      if (e) bind(i, e.targets, e.rule)
    } else if (f.endsWith('.py') && extensions.size) {
      const names = pyOf(f)
      const receiver = /^([A-Za-z_][\w.]*?)\s*\.\s*(\w+)\s*\(/.exec(buf(f).subarray(r.site.range.start_byte, r.site.range.end_byte).toString('utf8'))
      const hit = receiver ? (names.modules.has(receiver[1]!) && receiver[2] === callee ? { module: names.modules.get(receiver[1]!)!, name: callee } : undefined) : names.functions.get(callee)
      const targets = hit ? extensions.get(hit.module)?.get(hit.name) : undefined
      if (targets?.length) bind(i, targets, 'python_c_extension')
    }
  }
  return [...(replaced.size ? items.map((i) => (replaced.has(i.rel) ? { rel: replaced.get(i.rel)!, producer: seams, qualified: true as const } : i)) : items), ...added]
}

/** The FFI seams of a snapshot by mechanism (FR467): every row the pass wrote, linked or external, counted under its rule. */
export function ffiCensus(items: Array<{ rel: Rel; producer: { id: string } }>): string {
  const counts: Record<string, number> = {}
  for (const { rel, producer } of items) if (producer.id === FFI_PRODUCER && rel.detail?.rule) counts[rel.detail.rule] = (counts[rel.detail.rule] ?? 0) + 1
  return canonicalJson(counts)
}
