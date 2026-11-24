import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, tmpDir } from './helpers.js'

const check = (root?: string) => spawnSync(process.execPath, [path.join(ROOT, 'policy', 'check-fixtures.mjs'), ...(root ? [root] : [])], { encoding: 'utf8' })

describe('FR075 fixtures, benchmarks and examples record their origin and licence, and the leak scan finds nothing in them', () => {
  it('FR075 pnpm check:fixtures passes on this repository', () => {
    const r = check()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^FR075 fixtures ok: \d+ directories name their origin and Apache-2\.0; leak scan clean over \d+ tracked files in fixtures\/ and bench\/\n$/)
  })

  it('FR075 pnpm check:fixtures fails a fixture without an origin, one without Apache-2.0, eval samples without PROVENANCE.md, and a tracked leak', () => {
    const root = tmpDir('pm-fixtures-policy-')
    const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
    write('fixtures/good/PROVENANCE.md', '# Provenance\n\nProject-authored for Proofmesh. Apache-2.0.\n')
    write('fixtures/no-origin/PROVENANCE.md', '# Provenance\n\nApache-2.0.\n')
    write('fixtures/no-licence/PROVENANCE.md', '# Provenance\n\nOrigin: copied from a public sample. MIT.\n')
    write('bench/eval/samples/set.json', '{}\n')
    // Assembled here so this file passes the scan of the real tree.
    const mail = 'someone@' + 'corp-mail.test'
    write('fixtures/good/repo/a.ts', `export const who = "${mail}"\n`)
    write('fixtures/good/repo/untracked.ts', `export const also = "${mail}"\n`)
    execFileSync('git', ['-C', root, 'init', '-q'])
    execFileSync('git', ['-C', root, 'add', 'fixtures/good/PROVENANCE.md', 'fixtures/no-origin', 'fixtures/no-licence', 'bench', 'fixtures/good/repo/a.ts'])
    const r = check(root)
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr.trim().split('\n').sort()).toEqual([
      'FR075 fixtures: 4 problems',
      'bench/eval/samples: PROVENANCE.md is missing',
      `fixtures/good/repo/a.ts:1  leak scan, email address: ${mail}`,
      'fixtures/no-licence: PROVENANCE.md does not state Apache-2.0',
      'fixtures/no-origin: PROVENANCE.md names no origin (a line starting "Project-authored for Proofmesh" or "Origin: ")',
    ].sort())
  })
})
