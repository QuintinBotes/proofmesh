import path from 'node:path'
import { LINGUIST, type LinguistType } from './linguist-table.js'

export type Kind = 'code' | 'template' | 'data' | 'prose' | 'unknown' | 'binary'
export type Detected = {
  name: string
  kind: Kind
  /** Only for `unknown`: the extension with its dot, or the whole file name when it has none. */
  extension?: string
  /** True when the shebang or the file's content settled the language, so it overrides the extension an adapter would route by. */
  via_content?: boolean
}

/** Linguist's names for the languages the built-in adapters analyse, by the language id the adapters are registered under. */
export const ADAPTER_LANGUAGE_NAMES: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', csharp: 'C#', python: 'Python', terraform: 'HCL', java: 'Java', go: 'Go', rust: 'Rust',
  ruby: 'Ruby', php: 'PHP', c: 'C', cpp: 'C++', bash: 'Shell', scala: 'Scala', kotlin: 'Kotlin', swift: 'Swift', sql: 'SQL', prisma: 'Prisma',
}
const ADAPTER_IDS = new Map(Object.entries(ADAPTER_LANGUAGE_NAMES).map(([id, name]) => [name, id]))
/** The adapter language id of a language name, when a built-in adapter analyses it. */
export const adapterLanguageId = (name: string): string | undefined => ADAPTER_IDS.get(name)

// Linguist keeps TSX and JSX apart and files .html.erb under HTML+ERB; a census row is the language a person would name.
const RENAMED: Record<string, string> = { 'HTML+ERB': 'ERB', TSX: 'TypeScript', JSX: 'JavaScript' }
// Template languages read by a template engine, whatever type Linguist gives them.
const TEMPLATES = new Set(['ERB', 'Haml', 'Slim', 'Jinja', 'Handlebars', 'EJS', 'Liquid', 'Twig', 'Mustache', 'Pug', 'Blade', 'Smarty', 'Nunjucks', 'HTML+EEX', 'HTML+Razor', 'HTML+PHP', 'HTML+ECR', 'Razor', 'Latte'])
// Linguist types these as markup; they hold logic and structure a grammar could read, so they are code, not data.
const MARKUP_CODE = new Set(['CSS', 'SCSS', 'Sass', 'Less', 'Stylus', 'Vue', 'Svelte', 'Astro'])
// Ambiguous extensions and interpreters Linguist settles with heuristics this table does not carry: the common reading wins.
// Anything not listed here and shared by several languages stays unknown, never a guess.
const PREFERRED_EXTENSION: Record<string, string> = {
  '.cs': 'C#', '.ex': 'Elixir', '.html': 'HTML', '.json': 'JSON', '.md': 'Markdown', '.php': 'PHP', '.properties': 'Java Properties',
  '.rs': 'Rust', '.sql': 'SQL', '.ts': 'TypeScript', '.tsx': 'TSX', '.txt': 'Text', '.yaml': 'YAML', '.yml': 'YAML',
  '.sc': 'Scala', '.fs': 'F#', '.ml': 'OCaml', '.r': 'R', '.sol': 'Solidity', '.scm': 'Scheme', '.hh': 'C++', '.lisp': 'Common Lisp', '.lsp': 'Common Lisp',
}
const PREFERRED_INTERPRETER: Record<string, string> = { node: 'JavaScript', bun: 'JavaScript', deno: 'JavaScript', perl: 'Perl', lua: 'Lua', ocaml: 'OCaml' }

const kindOf = (name: string, type: LinguistType): Kind =>
  TEMPLATES.has(name) ? 'template' : type === 'programming' ? 'code' : type === 'prose' ? 'prose' : type === 'markup' && MARKUP_CODE.has(name) ? 'code' : 'data'
const TYPES = new Map(LINGUIST.map(([name, type]) => [name, type]))
const index = (pick: (l: (typeof LINGUIST)[number]) => readonly string[]): Map<string, string[]> => {
  const m = new Map<string, string[]>()
  for (const l of LINGUIST) for (const key of pick(l)) m.set(key, [...(m.get(key) ?? []), l[0]])
  return m
}
const BY_EXTENSION = index((l) => l[2])
const BY_FILENAME = index((l) => l[3])
const BY_INTERPRETER = index((l) => l[4])

const known = (name: string, via_content?: boolean): Detected => {
  const final = RENAMED[name] ?? name
  // A language a built-in adapter reads is code whichever of its files is looked at, so a row's kind never depends on file order.
  return { name: final, kind: ADAPTER_IDS.has(final) ? 'code' : kindOf(final, TYPES.get(name)!), ...(via_content ? { via_content } : {}) }
}
export const NO_EXTENSION = '(no extension)'
const PLAUSIBLE_EXTENSION = /^\.[a-z0-9]{1,8}$/
const unknown = (extension: string): Detected => ({ name: 'unknown', kind: 'unknown', extension })
const one = (candidates: string[] | undefined, preferred?: string): string | undefined => (candidates?.length === 1 ? candidates[0] : candidates && preferred && candidates.includes(preferred) ? preferred : undefined)

// Comments and string literals say nothing about the language: they are blanked before a header is read.
const COMMENTS_AND_STRINGS = /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g
const HEADER_BYTES = 65536
const CPP = /\b(class\s+\w+\s*[:{]|namespace\s+\w+|template\s*<|typename\s|public:|private:|protected:|std::|using\s+namespace)|#include\s*<(iostream|string|vector|memory|map|cstdint|cstdlib|algorithm)>/
const OBJC = /@(interface|implementation|protocol|property|import|class)\b|#import\b/
/** A .h file is C++ or Objective-C when its content says so, and C otherwise, as Linguist reads it. */
const header = (raw: string): string => {
  const text = raw.replace(COMMENTS_AND_STRINGS, ' ')
  return CPP.test(text) ? 'C++' : OBJC.test(text) ? 'Objective-C' : 'C'
}

/** The program a shebang line names: through env and its options, without a version suffix when only the bare name is known. */
function interpreter(text: string): string | undefined {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  if (!first.startsWith('#!')) return undefined
  const words = first.slice(2).trim().split(/\s+/)
  let prog = path.posix.basename(words.shift() ?? '')
  if (prog === 'env') {
    const next = words.find((w) => !w.startsWith('-') && !w.includes('='))
    if (!next) return undefined
    prog = path.posix.basename(next)
  }
  return BY_INTERPRETER.has(prog) || PREFERRED_INTERPRETER[prog] ? prog : prog.replace(/[\d.]+$/, '')
}

/**
 * The language and kind of one file, from its file name, its longest known extension, its shebang when it has no extension, and a
 * content check where an extension is ambiguous. `probe` returns the start of the file and is called only when needed.
 */
export function detectLanguage(rel: string, probe: (bytes?: number) => string | undefined): Detected {
  const file = path.posix.basename(rel)
  const byName = one(BY_FILENAME.get(file))
  if (byName) return known(byName)
  const lower = file.toLowerCase()
  // index.html.erb is tried as .html.erb, then .erb.
  for (let dot = lower.indexOf('.', 1); dot > 0; dot = lower.indexOf('.', dot + 1)) {
    const ext = lower.slice(dot)
    if (ext === '.h') return known(header(probe(HEADER_BYTES) ?? ''), true)
    const hit = one(BY_EXTENSION.get(ext), PREFERRED_EXTENSION[ext])
    if (hit) return known(hit)
    if (BY_EXTENSION.has(ext)) return unknown(ext)
  }
  const last = lower.lastIndexOf('.')
  // Only a short suffix of letters and digits is an extension; anything else (a dated log, a version) shares one row.
  if (last > 0) return unknown(PLAUSIBLE_EXTENSION.test(lower.slice(last)) ? lower.slice(last) : '(other)')
  const prog = interpreter(probe() ?? '')
  const viaShebang = prog && one(BY_INTERPRETER.get(prog), PREFERRED_INTERPRETER[prog])
  return viaShebang ? known(viaShebang, true) : unknown(NO_EXTENSION)
}

/** Everything detection decides by, for the census version: change a rule or a table entry and the census is rebuilt. */
export const DETECTION_RULES = {
  // Bump when detectLanguage's logic changes without changing any of the data below.
  revision: '2',
  adapterNames: ADAPTER_LANGUAGE_NAMES, renamed: RENAMED, templates: [...TEMPLATES], markupCode: [...MARKUP_CODE],
  preferredExtension: PREFERRED_EXTENSION, preferredInterpreter: PREFERRED_INTERPRETER,
  patterns: [COMMENTS_AND_STRINGS.source, CPP.source, OBJC.source, PLAUSIBLE_EXTENSION.source], headerBytes: HEADER_BYTES,
}
