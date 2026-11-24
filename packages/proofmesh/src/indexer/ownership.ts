/**
 * CODEOWNERS, read by the core because ownership is language-neutral. GitHub uses the first of .github/CODEOWNERS,
 * CODEOWNERS, and docs/CODEOWNERS that exists; patterns follow gitignore rules and the last matching line wins.
 */
export const OWNERSHIP_VERSION = '1'
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const

export type OwnerRule = { pattern: string; owners: string[]; line: number; startByte: number; endByte: number; regex: RegExp }

/** The effective CODEOWNERS file among the captured paths, in GitHub's order of precedence. */
export const effectiveCodeowners = (paths: Iterable<string>): string | undefined => {
  const set = new Set(paths)
  return CODEOWNERS_PATHS.find((p) => set.has(p))
}

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = []
  let offset = 0
  text.split('\n').forEach((raw, i) => {
    const lineBytes = Buffer.byteLength(raw, 'utf8')
    const content = raw.replace(/\r$/, '')
    const body = content.replace(/(^|\s)#.*$/, '').trim()
    if (body) {
      const [pattern, ...owners] = body.split(/\s+/)
      const lead = Buffer.byteLength(content.slice(0, content.length - content.trimStart().length), 'utf8')
      const trail = Buffer.byteLength(content.trimEnd(), 'utf8')
      rules.push({ pattern: pattern!, owners, line: i + 1, startByte: offset + lead, endByte: offset + trail, regex: toRegex(pattern!) })
    }
    offset += lineBytes + 1
  })
  return rules
}

/** gitignore semantics: a slash at the start or middle anchors the pattern to the root; a match on a directory covers what is in it. */
export function toRegex(pattern: string): RegExp {
  let p = pattern
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)
  const anchored = p.startsWith('/') || p.includes('/')
  if (p.startsWith('/')) p = p.slice(1)
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}${dirOnly ? '/.*' : '(?:/.*)?'}$`)
}

/** The rule that decides a path's owners: the last one that matches. */
export function ownerRule(rules: OwnerRule[], path: string): OwnerRule | undefined {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i]!.regex.test(path)) return rules[i]
  return undefined
}
