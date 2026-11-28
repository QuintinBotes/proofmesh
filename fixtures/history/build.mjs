// fixtures/history: a git repository built from a fixed, scripted commit sequence, so history counts are known (#239; shared with #238).
// Usage: node fixtures/history/build.mjs <empty directory>. Identity and dates are fixed, so the same script always gives the same commits.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const M = 'src/model.ts', S = 'db/schema.sql', T = 'src/types.ts', X = 'test/model.test.ts', U = 'src/util.ts', C = 'src/client.ts', L = 'src/legacy.ts', R = 'src/serializer.ts'

/** Each file's text at revision n: a one-line edit per revision. model.ts imports types.ts and the test imports model.ts; nothing links schema.sql, client.ts or serializer.ts. */
const TEXT = {
  [M]: (n) => `import type { Kind } from './types'\nexport const modelRevision = ${n}\nexport function model(kind: Kind): Kind {\n  return kind\n}\n`,
  [S]: (n) => `-- revision ${n}\ncreate table model (id integer primary key, kind text not null);\n`,
  [T]: (n) => `export type Kind = 'a' | 'b'\nexport const typesRevision = ${n}\n`,
  [X]: (n) => `import { model } from '../src/model'\nexport const testRevision = ${n}\nexport function modelKeepsKind(): boolean {\n  return model('a') === 'a'\n}\n`,
  [U]: (n) => `export const utilRevision = ${n}\n`,
  [C]: (n) => `export const clientRevision = ${n}\nexport function send(body: string): string {\n  return body\n}\n`,
  [L]: (n) => `export const serializerRevision = ${n}\nexport function serialize(value: unknown): string {\n  return JSON.stringify(value)\n}\n`,
}
TEXT[R] = TEXT[L]

/** The commits, oldest first: the files each changes, and a rename of legacy.ts to serializer.ts with no other change (commit 19). */
export const COMMITS = [
  { files: ['README.md', 'tsconfig.json', M, S, T] },
  { files: [M, S, T] },
  { files: [M, S, X] },
  { files: [M, S, U] },
  { files: [M, S, U] },
  { files: [M, S] },
  { files: [M, S] },
  { files: [M, S] },
  { files: [M, T, X] },
  { files: [M, T, X] },
  { files: [S] },
  { files: [S] },
  { files: [T] },
  { files: [T] },
  { files: [X] },
  { files: [X] },
  { files: [C, L] },
  { files: [C, L] },
  { rename: [L, R] },
  { files: [C, R] },
  { files: [C, R] },
]

/**
 * Every pair that changes together at the default thresholds (min_shared 3, min_degree 0.3), counted from COMMITS by hand: degree is
 * shared / min(a's commits, b's commits). src/util.ts shares two commits with model.ts, under min_shared; serializer.ts counts the two
 * commits made as legacy.ts. Linked pairs are joined by an import.
 */
export const PAIRS = [
  { a: M, b: S, shared: 8, a_commits: 10, b_commits: 10, degree: 0.8, linked: false },
  { a: M, b: T, shared: 4, a_commits: 10, b_commits: 6, degree: 0.67, linked: true },
  { a: M, b: X, shared: 3, a_commits: 10, b_commits: 5, degree: 0.6, linked: true },
  { a: C, b: R, shared: 4, a_commits: 4, b_commits: 5, degree: 1, linked: false },
]
/** Every file the repository holds at its last commit. */
export const FILES = ['README.md', 'tsconfig.json', M, S, T, X, U, C, R]

export function build(dir) {
  const date = (i) => `2026-01-${String(i + 1).padStart(2, '0')}T12:00:00Z`
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' }
  const git = (args, extra = {}) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' })
  fs.mkdirSync(dir, { recursive: true })
  git(['init', '-q'])
  const revision = new Map()
  for (const [i, c] of COMMITS.entries()) {
    if (c.rename) git(['mv', ...c.rename])
    for (const f of c.files ?? []) {
      const n = (revision.get(f) ?? 0) + 1
      revision.set(f, n)
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
      const text = f === 'README.md' ? '# history fixture\n' : f === 'tsconfig.json' ? '{ "compilerOptions": { "strict": true } }\n' : TEXT[f](n)
      fs.writeFileSync(path.join(dir, f), text)
    }
    git(['add', '-A'])
    git(['commit', '-q', '-m', `commit ${i + 1}`], { GIT_AUTHOR_DATE: date(i), GIT_COMMITTER_DATE: date(i) })
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  if (!process.argv[2]) { console.error('usage: node fixtures/history/build.mjs <empty directory>'); process.exit(2) }
  console.log(build(path.resolve(process.argv[2])))
}
