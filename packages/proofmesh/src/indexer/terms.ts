// The term index of concept search (FR581): the words of each indexed file, by line, filled at seal time from the captured text.
import type Database from 'better-sqlite3'
import type { EvidenceStore } from '../evidence/store.js'

/** The version of the term extraction, part of snapshot identity: a change to it rebuilds the next index. */
export const TERMS_VERSION = 1

/** Function words of English prose, which say nothing about code; identifiers common in a repository are weighed down by their frequency instead. */
export const STOP_WORDS = new Set(('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its me my no not of on or our she so than that the their them then there these they this those to us was we were what when where which who why will with would you your').split(' '))

/** An identifier or a word of prose: letters, digits, `_` and `$`, not starting with a digit. */
const TOKEN = /[\p{L}_$][\p{L}\p{N}_$]*/gu

/** The words of an identifier: camelCase, PascalCase, snake_case and kebab-case split, lower-cased (`HTTPRequestLoader` is http, request, loader). */
export function identifierWords(token: string): string[] {
  return token.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2').split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.toLowerCase())
}

const isWord = (w: string) => w.length > 1 && !/^\p{N}+$/u.test(w) && !STOP_WORDS.has(w)

/**
 * The terms a token stands for: its words, and the whole identifier when it has several, its words joined (`RelationLoader` and
 * `relation_loader` are both `relationloader`), so a phrase finds it word by word and whole. Stop words, one letter and numbers are none.
 */
export function tokenTerms(token: string): string[] {
  const all = identifierWords(token)
  const words = all.filter(isWord)
  return all.length > 1 ? [...words, all.join('')] : words
}

export const textTerms = (text: string): string[] => (text.match(TOKEN) ?? []).flatMap(tokenTerms)

/** A query's terms: those of its text, and each run of two or three adjacent words joined, as the index holds a multi-word identifier (`lazy relation loader` also asks for `relationloader` and `lazyrelationloader`). */
export function queryTerms(text: string): string[] {
  const words = (text.match(TOKEN) ?? []).flatMap(identifierWords).filter(isWord)
  return [...textTerms(text), ...words.slice(1).map((w, i) => words[i] + w), ...words.slice(2).map((w, i) => words[i]! + words[i + 1] + w)]
}

/**
 * The terms of a file and the lines each occurs on, once per occurrence, ascending: identifiers, comments, docstrings and string
 * literals alike, as they are all words of the text. The path's own segments are terms on line 0.
 */
export function fileTerms(filePath: string, text: string): Map<string, number[]> {
  const out = new Map<string, number[]>()
  const add = (t: string, line: number) => { const l = out.get(t); if (l) l.push(line); else out.set(t, [line]) }
  for (const t of textTerms(filePath.replace(/\.[^./]*$/, ''))) add(t, 0)
  text.split('\n').forEach((line, i) => { for (const t of textTerms(line)) add(t, i + 1) })
  return out
}

/** Fills `term` and `term_file` from the captured content of each indexed file, at seal time, whatever adapter read it. */
export function fillTerms(db: Database.Database, store: EvidenceStore): void {
  const files = db.prepare("select id, path, content_hash from file where disposition = 'indexed' and content_hash is not null order by id").all() as Array<{ id: string; path: string; content_hash: string }>
  const term = db.prepare('insert into term (term, file_id, lines) values (?, ?, ?)')
  const length = db.prepare('insert into term_file (file_id, terms) values (?, ?)')
  db.transaction(() => {
    for (const f of files) {
      const content = store.read(f.content_hash)
      if (!content) continue
      let n = 0
      for (const [t, lines] of fileTerms(f.path, content.toString('utf8'))) { term.run(t, f.id, lines.join(' ')); n += lines.length }
      length.run(f.id, n)
    }
  })()
}
