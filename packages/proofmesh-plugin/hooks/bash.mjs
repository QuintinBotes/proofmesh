// Bash commands the trail reads (#149, FR800 to FR803): a file read as opened, a search as searched, by path only, never the pattern or output.
const READS = new Set(['cat', 'head', 'tail', 'sed'])
// Per command, the short options that take a value (the rest of the word, or the next word when it ends the word), and those that take
// none, a count such as `head -20` included; any other letter makes the command record nothing, since its value would read as a path.
const VALUED = { cat: '', head: 'nc', tail: 'ncbs', sed: 'e', grep: 'efmABCdD', rg: 'efmABCdgtTjMEr' }
const FLAGS = { cat: 'beflnstuv', head: 'qv0123456789', tail: 'Ffqrv0123456789', sed: 'nEr', grep: 'abcEFGHhIiLlnoqRrsTUvwxyZz', rg: 'abcFHhIiLlNnoPpqSsUuvwxz0.' }
// shortcut: a long option is known by these lists, and any other makes the command record nothing; add one when a real session needs it.
const LONG_VALUED = new Set(['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-dir', '--glob', '--iglob', '--type', '--type-not', '--max-depth', '--lines', '--bytes'])
const LONG_FLAGS = new Set(['--line-number', '--recursive', '--ignore-case', '--files-with-matches', '--files-without-match', '--count', '--word-regexp', '--fixed-strings', '--extended-regexp', '--with-filename', '--no-filename', '--only-matching', '--invert-match', '--no-heading', '--heading', '--hidden', '--no-ignore', '--smart-case', '--case-sensitive', '--follow', '--files', '--number'])
// find's actions that run or change something: a find with one is not a search.
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/

/** The command's stages, each its words with the quotes taken off; null for anything but plain words and pipes. */
function stages(command) {
  const out = [[]]
  let w = null, q = null
  for (const c of command) {
    if (q) {
      if (c === q) q = null
      else if (q === '"' && /[$`\\!]/.test(c)) return null
      else w += c
    } else if (c === "'" || c === '"') {
      q = c
      w ??= ''
    } else if (c === ' ' || c === '\t' || c === '|') {
      if (w !== null) out.at(-1).push(w)
      w = null
      if (c === '|') out.push([])
    } else if (/[\n;&<>()$`\\*?[\]{}~#!]/.test(c)) {
      // A variable, glob, redirect, list, subshell, comment or second line: what runs, or on which file, is not in the words.
      return null
    } else w = (w ?? '') + c
  }
  if (q) return null
  if (w !== null) out.at(-1).push(w)
  return out.some((s) => !s.length) ? null : out
}

/** The operands of `cmd`'s arguments, options and their values left out, and whether an option gave the pattern; null for an option it does not know. */
function operands(cmd, args) {
  const pos = []
  let pattern = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') { pos.push(...args.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const name = a.split('=')[0]
      if (!LONG_VALUED.has(name) && !LONG_FLAGS.has(name)) return null
      if (LONG_VALUED.has(name) && !a.includes('=')) i++
      if (name === '--regexp' || name === '--file' || name === '--files') pattern = true
      continue
    }
    if (a.length > 1 && a.startsWith('-')) {
      for (let j = 1; j < a.length; j++) {
        if (FLAGS[cmd].includes(a[j])) continue
        if (!VALUED[cmd].includes(a[j])) return null
        if (j === a.length - 1) i++
        if (a[j] === 'e' || a[j] === 'f') pattern = true
        break
      }
      continue
    }
    pos.push(a)
  }
  return { pos, pattern }
}

/** What a Bash command read: `{ kind, paths }` as the session wrote them, or null when it cannot be read with confidence. */
export function bashReads(command) {
  const s = typeof command === 'string' ? stages(command) : null
  if (!s) return null
  // A later stage reads what the first one printed; only a head or tail of it is known to read no file.
  if (s.slice(1).some(([cmd, ...args]) => (cmd !== 'head' && cmd !== 'tail') || operands(cmd, args)?.pos.length !== 0)) return null
  const [cmd, ...args] = s[0]
  if (cmd === 'find') {
    let i = 0
    while (/^-[HLP]$/.test(args[i] ?? '')) i++
    const paths = []
    while (i < args.length && !args[i].startsWith('-')) paths.push(args[i++])
    if (args.slice(i).some((a) => FIND_ACTIONS.test(a))) return null
    return paths.length ? { kind: 'searched', paths } : null
  }
  if (!(cmd in VALUED)) return null
  const o = operands(cmd, args)
  if (!o) return null
  // sed reads only with -n, its script first unless -e gave it; grep and rg take the pattern first unless an option gave it.
  if (cmd === 'sed' && !args.some((a) => /^-[a-zA-Z]*n/.test(a) && !a.startsWith('--'))) return null
  const paths = (cmd === 'sed' || cmd === 'grep' || cmd === 'rg') && !o.pattern ? o.pos.slice(1) : o.pos
  // A search that names no path searched what the shell gave it (stdin, or the directory), which the words do not say.
  const named = paths.filter((p) => p !== '-' && p !== '')
  if (!named.length) return null
  return { kind: READS.has(cmd) ? 'opened' : 'searched', paths: named }
}
