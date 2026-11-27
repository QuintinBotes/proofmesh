import type Database from 'better-sqlite3'
import type { EvidenceStore } from '../evidence/store.js'

// A read-only rename plan (#38, FR980 to FR988): every site a rename of a symbol must change, code sites as the snapshot observed
// them and seams as inferred, for an agent or an editor to apply. Nothing here writes a file.

type Sym = { id: string; key: string; name: string; kind: string; qualified_name: string; path: string; file_id: string; start_byte: number; end_byte: number; start_line: number; hash: string | null }
export type Site = { path: string; line: number; kind: string; basis: 'observed' | 'inferred'; key: string; seam?: string; rule?: string; text?: string; resolution?: string; repository?: { id: string; name: string; commit: string | null } }
export type Possible = { path: string; line: number; callee: string; resolution: string }
export type Plan = { subject: Sym; group: Array<Sym & { relationship: string }>; declared: Map<string, number>; sites: Site[]; possibly: Possible[]; carriers: string[]; exported: boolean; stopped: boolean }

const SYM_SQL = 'select s.id, s.stable_key as key, s.name, s.kind, s.qualified_name, f.path, s.file_id, s.start_byte, s.end_byte, s.start_line, f.content_hash as hash from symbol s join file f on f.id = s.file_id'
/** Origins that observe code: a name the compiler or the syntax bound. Every other origin binds by a rule, so its sites are seams. */
const OBSERVED = new Set(['semantic_resolver', 'syntax'])
/** Rules that bind by the symbol's name, so a rename breaks them: the seam kind each is reported as. */
const NAME_RULES: Record<string, string> = {
  openapi_operation_id: 'route', conventional_route: 'route', grpc_server: 'rpc', graphql_resolver_map: 'graphql',
  jni: 'ffi', pinvoke: 'ffi', cgo: 'ffi', cgo_export: 'ffi', rust_extern_c: 'ffi', rust_no_mangle: 'ffi', python_c_extension: 'ffi',
}
/** A call whose callee is one of these, with the name as a string argument, reads or registers a dependency-injection key. */
const DI_CALLEES = /^(register\w*|bind|provide|inject|Inject|resolve|make|singleton|transient|scoped)$/

/**
 * Strings and comments blanked to spaces, keeping offsets and newlines, so a name inside them is not taken for code. A template's
 * `${...}` stays: it is code.
 */
const blank = (s: string) => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => m.replace(m[0] === '`' ? /\$\{[^}]*\}|[^\n]/g : /[^\n]/g, (x) => (x.length > 1 ? x : ' ')))

/**
 * The public entry, among `paths`, of a package.json the snapshot indexed: its `main`, `module`, `types`, `typings`, `source` or any
 * `exports` target, as written or as the TypeScript source a build emits it from (`dist/x.js` from `src/x.ts`), else its `index`.
 */
export function publicEntry(db: Database.Database, store: EvidenceStore, paths: string[]): string | undefined {
  const want = new Set(paths)
  for (const m of db.prepare("select path, content_hash as hash from file where (path = 'package.json' or path like '%/package.json') and content_hash is not null order by path").all() as Array<{ path: string; hash: string }>) {
    let pkg: Record<string, unknown>
    try { pkg = JSON.parse(store.read(m.hash)?.toString('utf8') ?? '') as Record<string, unknown> } catch { continue }
    const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/') + 1) : ''
    const targets: string[] = []
    const collect = (v: unknown): void => { if (typeof v === 'string') targets.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect) }
    for (const k of ['main', 'module', 'types', 'typings', 'source', 'exports']) collect(pkg[k])
    if (!targets.length) targets.push('index.js', 'src/index.ts')
    for (const t of targets) {
      const base = `${dir}${t.replace(/^\.\//, '')}`.replace(/(\.d)?\.[cm]?[jt]sx?$/, '')
      for (const p of [base, dir + base.slice(dir.length).replace(/^(dist|lib|build|out)\//, 'src/')].flatMap((b) => ['.ts', '.tsx', '.js', '.mjs', '.d.ts', '/index.ts', '/index.js'].map((x) => b + x))) if (want.has(p)) return p
    }
  }
  return undefined
}

const lines = (s: string) => s.match(/\n/g)?.length ?? 0
const order = (a: { path: string; line: number }, b: { path: string; line: number }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)

export function planRename(db: Database.Database, store: EvidenceStore, subjectId: string, deadline: number): Plan {
  const one = db.prepare(`${SYM_SQL} where s.id = ?`)
  const subject = one.get(subjectId) as Sym
  const texts = new Map<string, Buffer | null>()
  const text = (hash: string | null) => (hash ? (texts.has(hash) ? texts.get(hash)! : texts.set(hash, store.read(hash) ?? null).get(hash)!) : null)
  const names = (list: string[]) => new RegExp(`(?<![\\w$])(?:${list.map((n) => n.replace(/[$]/g, '\\$')).join('|')})(?![\\w$])`, 'g')
  /**
   * The line of the first code occurrence of one of `list` in a byte span; the span's first line when its text is unavailable;
   * undefined when the span does not write the name (`super(...)`, a call through an import alias), which a rename leaves as it is.
   */
  const lineIn = (hash: string | null, start: number, end: number, line: number, list: string[], member = false): number | undefined => {
    const t = text(hash)
    if (!t) return line
    const span = blank(t.subarray(start, end).toString('utf8'))
    // A member's name after a dot first: a receiver written with the same name may come before it, on a line of its own.
    const at = (member ? new RegExp(`(?<=\\.\\s*)${names(list).source}`).exec(span) : null) ?? names(list).exec(span)
    return at ? line + lines(span.slice(0, at.index)) : undefined
  }
  /** The line of the first occurrence of the name anywhere in a byte span, strings included, else the span's first line. */
  const nameLine = (hash: string | null, start: number, end: number, line: number, name: string): number => {
    const span = text(hash)?.subarray(start, end).toString('utf8') ?? ''
    const at = names([name]).exec(span)
    return at ? line + lines(span.slice(0, at.index)) : line
  }
  const sites: Site[] = []
  const add = (s: Site) => sites.push(s)
  type Ev = { start_byte: number; end_byte: number; start_line: number; path: string; hash: string | null }
  const evidenceOf = db.prepare('select e.start_byte, e.end_byte, e.start_line, f.path, f.content_hash as hash from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by f.path, e.start_byte')

  // Import and export specifiers that name a top-level symbol, from the declaring file outwards through every file that re-exports
  // it (`export { x } from`, `export * from`, a local `export { x }`). An export under another name (`export { x as y }`) makes y a
  // name of the symbol from there on, as the language service renames it. For a member, only the files that re-export its top-level
  // container are followed: they tell whether it is part of a package's public entry.
  const carriers: string[] = []
  const local = subject.qualified_name.slice(subject.qualified_name.indexOf(':') + 1)
  const topLevel = !local.includes('.') && subject.kind !== 'module'
  const known = [local.split('.')[0]!]
  /** The names of the symbol a specifier list writes, each at its offset, and the aliases it exports them under. */
  const specifiers = (list: string) => [...list.matchAll(/([\w$]+)(?:\s+as\s+([\w$]+))?/g)].filter((x) => known.includes(x[1]!)).map((x) => ({ at: x.index, alias: x[2] }))
  const fileOf = db.prepare('select id, path, content_hash as hash from file where id = ?')
  const importers = db.prepare("select a.id, a.source_id from assertion a where a.type = 'imports' and a.resolution = 'resolved' and a.target_kind = 'file' and a.target_id = ?")
  const queue = [subject.file_id], seen = new Set(queue), scanned = new Set<string>()
  const carry = (fileId: string, p: string) => { if (!seen.has(fileId)) { seen.add(fileId); queue.push(fileId); carriers.push(p) } }
  /**
   * A file's own export lists (`export { x }`, `export { x as y }`) and default export of the symbol; `locals` are the names the file
   * imported it under (`import { x as y }`), whose export makes the file carry it but renames nothing.
   * shortcut: such an alias is followed into the file that exports it, not on through files that re-export the alias; follow it when a barrel chain needs it.
   */
  const ownExports = (fileId: string, locals: string[] = []) => {
    if (scanned.has(fileId)) return
    scanned.add(fileId)
    const f = fileOf.get(fileId) as { id: string; path: string; hash: string | null }
    const code = blank(text(f.hash)?.toString('utf8') ?? '')
    for (const x of code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)|\bexport\s+default\s+([\w$]+)\s*;?/g)) {
      const hits = x[1] !== undefined ? specifiers(x[1]) : known.includes(x[2]!) ? [{ at: 0, alias: undefined }] : []
      for (const h of hits) {
        if (topLevel) add({ path: f.path, line: lines(code.slice(0, x.index + x[0].indexOf(x[1] ?? x[2]!) + h.at)) + 1, kind: 'export', basis: 'observed', key: subject.key })
        if (h.alias && !known.includes(h.alias)) known.push(h.alias)
      }
      const viaLocal = (x[1] ?? x[2]!).split(',').some((n) => locals.includes(n.trim().split(/\s+as\s+/)[0]!))
      if ((hits.length || viaLocal) && fileId !== subject.file_id) carry(fileId, f.path)
      if (hits.length && fileId === subject.file_id) exported = true
    }
  }
  // Whether the declaring file exports the top-level name, by a modifier on its declaration or by an export list.
  let exported = new RegExp(`\\bexport\\s+(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|const|let|var|namespace)\\s+${known[0]!.replace(/[$]/g, '\\$')}(?![\\w$])`).test(blank(text(subject.hash)?.toString('utf8') ?? ''))
  while (subject.kind !== 'module' && queue.length) {
    const target = queue.shift()!
    ownExports(target)
    for (const imp of importers.all(target) as Array<{ id: string; source_id: string }>) {
      for (const e of evidenceOf.all(imp.id) as Ev[]) {
        const stmt = text(e.hash)?.subarray(e.start_byte, e.end_byte).toString('utf8')
        if (!stmt) continue
        // `import { x } from`, `export { x } from`, or Python's `from m import x`.
        const braces = /\{([^}]*)\}/.exec(stmt) ?? /^\s*from\s+\S+\s+import\s+\(?([^)#]*)/.exec(stmt), reExport = /^\s*export\b/.test(stmt)
        const hits = braces ? specifiers(blank(braces[1]!)) : []
        for (const h of hits) {
          if (topLevel) add({ path: e.path, line: e.start_line + lines(stmt.slice(0, braces!.index + braces![0].lastIndexOf(braces![1]!) + h.at)), kind: reExport ? 'export' : 'import', basis: 'observed', key: subject.key })
          if (reExport && h.alias && !known.includes(h.alias)) known.push(h.alias)
        }
        if (reExport && (hits.length || /^\s*export\s*\*\s*from/.test(stmt))) carry(imp.source_id, e.path)
        else if (hits.length) ownExports(imp.source_id, hits.flatMap((h) => (h.alias ? [h.alias] : [])))
      }
    }
  }

  // Members that must be renamed with the subject: what it implements or overrides, and what implements or overrides it, at any distance.
  const group = new Map<string, Sym & { relationship: string }>()
  if (/^(method|property|field)$/.test(subject.kind)) {
    const linked = db.prepare("select dst as id, type from edge where src = ? and type in ('implements', 'overrides') and resolution = 'resolved' union select src as id, type from edge where dst = ? and type in ('implements', 'overrides') and resolution = 'resolved'")
    const todo = [subject.id], met = new Set(todo)
    while (todo.length) {
      const at = todo.shift()!
      for (const r of linked.all(at, at) as Array<{ id: string; type: string }>) {
        if (met.has(r.id)) continue
        met.add(r.id)
        todo.push(r.id)
        const s = one.get(r.id) as Sym | undefined
        if (s && s.name === subject.name) group.set(s.id, { ...s, relationship: r.type })
      }
    }
  }

  const inbound = db.prepare("select a.id, a.type, a.origin, a.resolution, a.detail from assertion a where a.target_id = ? and a.type not in ('contains', 'imports') union select a.id, a.type, a.origin, a.resolution, a.detail from assertion_candidate c join assertion a on a.id = c.assertion_id where c.symbol_id = ? and a.type not in ('contains', 'imports')")
  const outbound = db.prepare("select a.id, a.type, a.resolution, a.target_id, a.detail from assertion a where a.source_id = ? and a.origin not in ('semantic_resolver', 'syntax')")
  const candidatesOf = db.prepare('select symbol_id from assertion_candidate where assertion_id = ? order by rank')
  const possibly: Possible[] = [], declared = new Map<string, number>()
  for (const m of [subject, ...group.values()]) {
    const own = m === subject && topLevel ? known : [m.name]
    const decl = lineIn(m.hash, m.start_byte, m.end_byte, m.start_line, [m.name]) ?? m.start_line
    declared.set(m.id, decl)
    add({ path: m.path, line: decl, kind: m === subject ? 'declaration' : group.get(m.id)!.relationship === 'implements' ? 'implementation' : 'override', basis: 'observed', key: m.key })
    // Its own name inside its own body (a recursive call, this.name, Container.name): the adapters record no edge from a symbol to itself.
    const body = blank(text(m.hash)?.subarray(m.start_byte, m.end_byte).toString('utf8') ?? '')
    const container = m.qualified_name.includes('.') ? m.qualified_name.slice(0, m.qualified_name.lastIndexOf('.')).split(/[.:]/).at(-1)! : ''
    // A member's own name after `this.` or its container's name; a top-level symbol's only as a call not after a dot, so a key, a
    // destructured option or a parameter of the same name is not taken for it.
    const self = container ? new RegExp(`(?:\\bthis|(?<![\\w$])${container.replace(/[$]/g, '\\$')})\\s*\\.\\s*$`) : /(?<!(?:\.|\bfunction)\s*)$/
    for (const x of [...body.matchAll(names([m.name]))].slice(1)) {
      const call = /^\s*\(/.test(body.slice(x.index + x[0].length))
      if (self.test(body.slice(0, x.index)) && (call || container)) add({ path: m.path, line: m.start_line + lines(body.slice(0, x.index)), kind: call ? 'call' : 'reference', basis: 'observed', key: m.key })
    }
    for (const a of inbound.all(m.id, m.id) as Array<{ id: string; type: string; origin: string; resolution: string; detail: string | null }>) {
      const detail = a.detail ? (JSON.parse(a.detail) as Record<string, string>) : {}
      const evs = evidenceOf.all(a.id) as Ev[]
      if (a.type === 'mentions') {
        for (const e of evs) add({ path: e.path, line: e.start_line, kind: 'mention', basis: 'inferred', key: m.key, seam: 'doc_mention', rule: 'doc_mention', text: detail.text ?? m.name, ...(a.resolution === 'resolved' ? {} : { resolution: a.resolution }) })
      } else if (OBSERVED.has(a.origin) && a.resolution === 'resolved') {
        // An implements or overrides site is the other member's declaration, listed with the group.
        if (a.type === 'implements' || a.type === 'overrides') continue
        for (const e of evs) {
          const line = lineIn(e.hash, e.start_byte, e.end_byte, e.start_line, own, a.type === 'calls' && container !== '')
          if (line !== undefined) add({ path: e.path, line, kind: a.type === 'calls' ? 'call' : 'reference', basis: 'observed', key: m.key })
        }
      } else if (OBSERVED.has(a.origin) && a.type === 'calls') {
        for (const e of evs) possibly.push({ path: e.path, line: lineIn(e.hash, e.start_byte, e.end_byte, e.start_line, own) ?? e.start_line, callee: m.name, resolution: a.resolution })
      } else if (NAME_RULES[detail.rule ?? '']) {
        // The line that writes the name (an operationId under its verb), else the link's own line.
        for (const e of evs) add({ path: e.path, line: nameLine(e.hash, e.start_byte, e.end_byte, e.start_line, m.name), kind: a.type, basis: 'inferred', key: m.key, seam: NAME_RULES[detail.rule!]!, rule: detail.rule!, ...(a.resolution === 'resolved' ? {} : { resolution: a.resolution }) })
      }
    }
    // A rule that binds this symbol by its name to code on the other side (an FFI call from a native declaration, say): that side must change too.
    for (const a of outbound.all(m.id) as Array<{ id: string; type: string; resolution: string; target_id: string | null; detail: string | null }>) {
      const rule = a.detail ? (JSON.parse(a.detail) as Record<string, string>).rule ?? '' : ''
      if (!NAME_RULES[rule]) continue
      // A candidate or ambiguous link names its targets as candidates.
      const targets = a.target_id ? [a.target_id] : (candidatesOf.all(a.id) as Array<{ symbol_id: string }>).map((c) => c.symbol_id)
      for (const t of targets.map((x) => one.get(x) as Sym | undefined)) if (t) add({ path: t.path, line: lineIn(t.hash, t.start_byte, t.end_byte, t.start_line, [t.name]) ?? t.start_line, kind: a.type, basis: 'inferred', key: m.key, seam: NAME_RULES[rule]!, rule, text: t.name, ...(a.resolution === 'resolved' ? {} : { resolution: a.resolution }) })
    }
  }

  // Unresolved calls by the same name, which might reach the symbol.
  for (const a of db.prepare("select a.id from assertion a where a.type = 'calls' and a.resolution = 'unresolved' and json_extract(a.detail, '$.callee') = ?").all(subject.name) as Array<{ id: string }>) {
    for (const e of evidenceOf.all(a.id) as Ev[]) possibly.push({ path: e.path, line: lineIn(e.hash, e.start_byte, e.end_byte, e.start_line, [subject.name]) ?? e.start_line, callee: subject.name, resolution: 'unresolved' })
  }

  // String seams: a string literal that is exactly the name, read as a serialised key or a dependency-injection key by its context.
  let stopped = false
  const literal = new RegExp(`(['"\`])${subject.name.replace(/[$]/g, '\\$')}\\1`, 'g')
  for (const f of db.prepare("select path, content_hash as hash from file where disposition = 'indexed' and content_hash is not null order by path").all() as Array<{ path: string; hash: string }>) {
    if (Date.now() > deadline) { stopped = true; break }
    const buf = store.read(f.hash)
    if (!buf || !buf.includes(subject.name)) continue
    buf.toString('utf8').split('\n').forEach((line, i) => {
      for (const x of line.matchAll(literal)) {
        const before = line.slice(0, x.index).trimEnd(), after = line.slice(x.index + x[0].length).trimStart()
        // A string in a comment (`// container.resolve("Mailer")`, a doc comment's line) is no key.
        if (/\/\/|\/\*|^\s*\*/.test(before.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, ''))) continue
        let seam: string | undefined, rule: string | undefined
        if (before.endsWith('[')) { seam = 'serialised_key'; rule = 'string_key_access' }
        else if (after.startsWith(':') && (/[{,]$/.test(before) || before === '' || /\.(json|ya?ml)$/.test(f.path))) { seam = 'serialised_key'; rule = 'quoted_object_key' }
        else if (/[(,]$/.test(before)) {
          // The call the string is an argument of: its callee, and whether its arguments also name the symbol (a registration).
          let depth = 0, open = -1
          for (let k = before.length - 1; k >= 0 && open < 0; k--) { const c = before[k]; if (c === ')') depth++; else if (c === '(') { if (depth === 0) open = k; else depth-- } }
          const callee = open > 0 ? /([\w$]+)\s*(?:<[^()]*>)?\s*$/.exec(before.slice(0, open))?.[1] ?? '' : ''
          if (DI_CALLEES.test(callee)) { seam = 'di_key'; rule = 'di_call_key' }
          else if (open >= 0 && names([subject.name]).test(blank(line.slice(open)))) { seam = 'di_key'; rule = 'registration_key' }
        }
        if (seam) add({ path: f.path, line: i + 1, kind: 'string', basis: 'inferred', key: subject.key, seam, rule, text: line.trim().slice(0, 160) })
      }
    })
  }

  // One row per line, basis and seam: a line holding two uses of the symbol is one site.
  const uniq = new Map<string, Site>()
  for (const s of sites) { const k = `${s.path}:${s.line}:${s.basis}:${s.seam ?? ''}`; if (!uniq.has(k)) uniq.set(k, s) }
  const listed = new Set([...uniq.values()].filter((s) => s.basis === 'observed').map((s) => `${s.path}:${s.line}`))
  const maybe = new Map<string, Possible>()
  for (const p of possibly) { const k = `${p.path}:${p.line}`; if (!listed.has(k) && !maybe.has(k)) maybe.set(k, p) }
  return { subject, declared, group: [...group.values()].sort((a, b) => order({ path: a.path, line: a.start_line }, { path: b.path, line: b.start_line })), sites: [...uniq.values()].sort(order), possibly: [...maybe.values()].sort(order), carriers, exported, stopped }
}
