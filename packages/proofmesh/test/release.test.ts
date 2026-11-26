import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtureRepo, ROOT, tmpDir } from './helpers.js'

const out = tmpDir('pm-release-out-')
const env = { ...process.env, PROOFMESH_RELEASE_OUT: out }
const run = (script: string, args: string[] = [], extra: Record<string, string> = {}) => spawnSync('node', [path.join(ROOT, 'release', script), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...env, ...extra } })
const ok = (r: ReturnType<typeof run>) => { expect(r.status, r.stderr).toBe(0); return r.stdout }
const sha = (f: string) => execFileSync('shasum', ['-a', '256', f], { encoding: 'utf8' }).split(' ')[0]
/** The versions the repository's lockfile gives a package's production dependencies, so a fresh offline install resolves what the store holds. */
const locked = (dir: string): Record<string, string> => {
  const deps = (JSON.parse(execFileSync('pnpm', ['list', '--json', '--prod', '--depth', '0'], { cwd: path.join(ROOT, dir), encoding: 'utf8' }))[0].dependencies ?? {}) as Record<string, { version: string }>
  return Object.fromEntries(Object.entries(deps).filter(([, d]) => !d.version.startsWith('link:')).map(([n, d]) => [n, d.version]))
}

describe('NFR013 FR070 FR073 NFR007 D12 AC33 release tooling builds, attests, signs and exports locally, publishes nothing, and exports no legacy path', () => {
  it('packs installable tarballs: an offline install runs the CLI and indexes TypeScript and C# with the bundled adapters', () => {
    ok(run('pack.mjs'))
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
    expect(manifest.tarballs.map((t: { file: string }) => t.file)).toEqual(['proofmesh-0.1.0.tgz', 'proofmesh-adapter-syntax-0.1.0.tgz', 'proofmesh-adapter-typescript-0.1.0.tgz'])
    for (const t of manifest.tarballs) expect(sha(path.join(out, t.file))).toBe(t.sha256)
    const home = tmpDir('pm-release-install-')
    fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ name: 't', private: true, pnpm: { overrides: { ...locked('packages/proofmesh'), ...locked('adapters/syntax'), ...locked('adapters/typescript'), '@proofmesh/adapter-syntax': `file:${out}/proofmesh-adapter-syntax-0.1.0.tgz`, '@proofmesh/adapter-typescript': `file:${out}/proofmesh-adapter-typescript-0.1.0.tgz` } } }))
    const add = spawnSync('pnpm', ['add', '--offline', path.join(out, 'proofmesh-0.1.0.tgz')], { cwd: home, encoding: 'utf8' })
    expect(add.status, add.stderr).toBe(0)
    const bin = path.join(home, 'node_modules', '.bin', 'proofmesh'), data = path.join(home, 'data')
    const cli = (...args: string[]) => { const r = spawnSync(bin, ['--data-dir', data, ...args], { cwd: home, encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0); return r.stdout }
    expect(cli('--help')).toMatch(/^proofmesh 0\.1\.0/)
    for (const [name, fixture] of [['ts', 'ts-invoicing'], ['cs', 'cs-orders']] as const) {
      const repo = path.join(home, name)
      fs.cpSync(fixtureRepo(fixture), repo, { recursive: true })
      cli('init'); cli('repo', 'add', repo)
      expect(cli('index', repo)).toMatch(/published\ndiscovered \d+, indexed [1-9]\d*, .* failed 0/)
    }
    // The installed copy carries no path from this machine's checkout (NFR007: it runs where it is installed).
    expect(fs.readFileSync(path.join(home, 'node_modules', 'proofmesh', 'dist', 'cli.mjs'), 'utf8')).not.toContain(ROOT)
  }, 300000)

  it('writes a CycloneDX SBOM and SLSA provenance whose subjects are the packed tarballs', () => {
    ok(run('sbom.mjs')); ok(run('provenance.mjs'))
    const sbom = JSON.parse(fs.readFileSync(path.join(out, 'sbom.cdx.json'), 'utf8'))
    expect(sbom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { component: { name: 'proofmesh', purl: 'pkg:npm/proofmesh@0.1.0' } } })
    expect(sbom.components.length).toBeGreaterThan(50)
    expect(sbom.components.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['better-sqlite3', 'typescript', 'pyright', 'web-tree-sitter']))
    for (const c of sbom.components) expect(c.licenses[0].license.id ?? c.licenses[0].license.expression).toBeTruthy()
    const prov = JSON.parse(fs.readFileSync(path.join(out, 'provenance.intoto.json'), 'utf8'))
    expect(prov).toMatchObject({ _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1' })
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
    expect(prov.subject).toEqual(manifest.tarballs.map((t: { file: string; sha256: string }) => ({ name: t.file, digest: { sha256: t.sha256 } })))
    expect(prov.predicate.buildDefinition.externalParameters.commit).toMatch(/^[0-9a-f]{40}$/)
  }, 120000)

  it('signs with a key it is given and verifies; a tampered artifact or a missing key fails', () => {
    const keyDir = tmpDir('pm-release-key-')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(keyDir, 'key')])
    expect(run('sign.mjs').status).toBe(1)
    ok(run('sign.mjs', [], { PROOFMESH_SIGNING_KEY: path.join(keyDir, 'key') }))
    expect(fs.readdirSync(out).filter((f) => f.endsWith('.sig')).length).toBe(5)
    expect(fs.readFileSync(path.join(out, 'allowed_signers'), 'utf8')).toMatch(/^proofmesh namespaces="proofmesh-release" ssh-ed25519 /)
    ok(run('verify.mjs'))
    fs.appendFileSync(path.join(out, 'sbom.cdx.json'), '\n')
    const bad = run('verify.mjs')
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('sbom.cdx.json: signature does not verify')
    expect(fs.readdirSync(ROOT).some((f) => /\.(pem|key)$/.test(f) || f === 'allowed_signers')).toBe(false)
  }, 60000)

  it('FR069 keeps the third-party notices current and the open-source files present, with the Apache-2.0 text as the licence', () => {
    ok(run('notices.mjs', ['--check']))
    const oss = ROOT
    for (const f of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'MAINTAINERS.md', 'SECURITY.md', 'THREAT_MODEL.md', 'COMPATIBILITY.md', 'ROADMAP.md', 'CHANGELOG.md']) expect(fs.existsSync(path.join(oss, f)), f).toBe(true)
    expect(fs.readFileSync(path.join(oss, 'LICENSE'), 'utf8')).toMatch(/^Apache License\s+Version 2\.0, January 2004/)
    expect(fs.readFileSync(path.join(oss, 'CONTRIBUTING.md'), 'utf8')).toContain('Developer Certificate of Origin')
    expect(fs.readFileSync(path.join(oss, 'CODE_OF_CONDUCT.md'), 'utf8')).toContain('Contributor Covenant')
  }, 60000)

  it('exports the Proofmesh paths as one fresh commit with no remote, and the leak scan catches planted leaks and deny-list words', () => {
    const dir = path.join(tmpDir('pm-release-export-'), 'tree')
    const clean = run('export.mjs', ['--out', dir])
    expect(clean.status, clean.stderr).toBe(0)
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim()
    expect(git('rev-list', '--count', 'HEAD')).toBe('1')
    expect(git('remote')).toBe('')
    for (const f of ['LICENSE', 'SECURITY.md', 'packages/proofmesh/package.json', 'release/leak-scan.mjs']) expect(fs.existsSync(path.join(dir, f)), f).toBe(true)
    for (const f of ['src', 'agents', 'eval', '.claude-plugin', 'docs/proofmesh/oss']) expect(fs.existsSync(path.join(dir, f)), f).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.verify).not.toContain('check:legacy')
    // The planted strings are assembled here so this test file itself passes the scan of the real tree.
    const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP', mail = 'someone@' + 'corp-mail.test', host = 'wiki.' + 'internal-host.example', word = 'Acme ' + 'Gizmoworks'
    fs.writeFileSync(path.join(dir, 'packages', 'planted.ts'), `const key = "${aws}"\nconst who = "${mail}"\nfetch("https://${host}/x")\n// ${word} internal\n`)
    const deny = path.join(os.tmpdir(), `deny-${process.pid}.txt`)
    fs.writeFileSync(deny, `# names that must not leave the building\n${word}\n`)
    const scan = spawnSync('node', [path.join(ROOT, 'release', 'leak-scan.mjs'), dir, '--deny-list', deny], { encoding: 'utf8' })
    expect(scan.status).toBe(1)
    expect(scan.stderr).toContain(`packages/planted.ts:1  AWS access key: ${aws}`)
    expect(scan.stderr).toContain(`packages/planted.ts:2  email address: ${mail}`)
    expect(scan.stderr).toContain(`packages/planted.ts:3  host not on the allow list: ${host}`)
    expect(scan.stderr).toContain(`packages/planted.ts:4  deny-list word: ${word}`)
    expect(scan.stderr.trim().split('\n').filter((l) => l.startsWith('packages/planted.ts')).length).toBe(4)
    expect(run('export.mjs', ['--out', dir]).status).not.toBe(0)
  }, 120000)
})

describe('FR049 the image and the release notes; publishing them is a person\'s step', () => {
  const image = (PATH: string) => spawnSync(process.execPath, [path.join(ROOT, 'release', 'image.mjs')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH } })

  it('FR049 without docker on the path, release/image.mjs reports the image unverified and builds nothing', () => {
    const r = image(tmpDir('pm-no-docker-'))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('unverified: docker not available, the image was not built\n')
  })

  it('FR049 with docker on the path, release/image.mjs builds the root Dockerfile tagged with the version and labelled with the OCI revision and version, and pushes nothing', () => {
    const bin = tmpDir('pm-fake-docker-'), calls = path.join(bin, 'calls.log')
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = version ] && echo 27.0.0\nexit 0\n`, { mode: 0o755 })
    const r = image(`${bin}${path.delimiter}${process.env.PATH}`)
    expect(r.status, r.stderr).toBe(0)
    const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      'version --format {{.Server.Version}}',
      `build --label org.opencontainers.image.revision=${head} --label org.opencontainers.image.version=0.1.0 -t proofmesh:0.1.0 ${ROOT}`,
    ])
  })

  it('FR049 CHANGELOG.md has a section, with entries, for the package version or for unreleased changes', () => {
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'proofmesh', 'package.json'), 'utf8')).version as string
    const sections = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split(/^## /m).slice(1)
    const notes = sections.find((s) => s.startsWith('Unreleased\n') || s.startsWith(`${version} `) || s.startsWith(`[${version}]`) || s.startsWith(`${version}\n`))
    expect(notes, `no "## Unreleased" or "## ${version}" section`).toBeDefined()
    expect(notes).toMatch(/^- \S/m)
  })
})

describe('SC016 release artifacts build from the exported fresh-history tree; tagging it publicly is a person\'s step', () => {
  it('SC016 the exported tree installs offline, builds, passes the licence policy, and packs, attests and signs its own artifacts, whose provenance names the export commit', () => {
    const tree = path.join(tmpDir('pm-sc016-'), 'tree'), artifacts = tmpDir('pm-sc016-out-'), keyDir = tmpDir('pm-sc016-key-')
    ok(run('export.mjs', ['--out', tree]))
    const inTree = (cmd: string, args: string[], extra: Record<string, string> = {}) => {
      const r = spawnSync(cmd, args, { cwd: tree, encoding: 'utf8', env: { ...process.env, PROOFMESH_RELEASE_OUT: artifacts, ...extra } })
      expect(r.status, `${cmd} ${args.join(' ')}: ${r.stderr}`).toBe(0)
      return r.stdout
    }
    inTree('pnpm', ['install', '--offline', '--frozen-lockfile'])
    inTree('pnpm', ['build'])
    expect(inTree(process.execPath, ['policy/check-licenses.mjs'])).toMatch(/^licenses ok: \d+ production packages checked/)
    for (const script of ['pack.mjs', 'sbom.mjs', 'provenance.mjs']) inTree(process.execPath, [path.join('release', script)])
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(keyDir, 'key')])
    inTree(process.execPath, [path.join('release', 'sign.mjs')], { PROOFMESH_SIGNING_KEY: path.join(keyDir, 'key') })
    inTree(process.execPath, [path.join('release', 'verify.mjs')])

    const git = (...a: string[]) => execFileSync('git', ['-C', tree, ...a], { encoding: 'utf8' }).trim()
    const head = git('rev-parse', 'HEAD')
    expect(git('rev-list', '--count', 'HEAD')).toBe('1')
    expect(git('remote')).toBe('')
    expect(head).not.toBe(execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
    const manifest = JSON.parse(fs.readFileSync(path.join(artifacts, 'manifest.json'), 'utf8'))
    expect(manifest.commit).toBe(head)
    expect(manifest.tarballs.map((t: { file: string }) => t.file)).toEqual(['proofmesh-0.1.0.tgz', 'proofmesh-adapter-syntax-0.1.0.tgz', 'proofmesh-adapter-typescript-0.1.0.tgz'])
    const prov = JSON.parse(fs.readFileSync(path.join(artifacts, 'provenance.intoto.json'), 'utf8'))
    expect(prov.predicate.buildDefinition.externalParameters).toEqual({ commit: head, branch: 'main' })
    expect(prov.predicate.buildDefinition.resolvedDependencies[0].digest).toEqual({ gitCommit: head })
    expect(prov.subject).toEqual(manifest.tarballs.map((t: { file: string; sha256: string }) => ({ name: t.file, digest: { sha256: t.sha256 } })))
    expect(JSON.parse(fs.readFileSync(path.join(artifacts, 'sbom.cdx.json'), 'utf8')).metadata.component.purl).toBe('pkg:npm/proofmesh@0.1.0')
    expect(fs.readdirSync(artifacts).filter((f) => f.endsWith('.sig')).sort()).toEqual(['proofmesh-0.1.0.tgz.sig', 'proofmesh-adapter-syntax-0.1.0.tgz.sig', 'proofmesh-adapter-typescript-0.1.0.tgz.sig', 'provenance.intoto.json.sig', 'sbom.cdx.json.sig'])
  }, 600000)
})

describe('FR049 the image is built from an allowlisted context', () => {
  it('FR049 .dockerignore excludes everything, then admits only the build inputs: never evaluation results, data directories or fixtures', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const lines = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', '.dockerignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    expect(lines[0]).toBe('*')
    const admitted = lines.filter((l) => l.startsWith('!')).map((l) => l.slice(1).replace(/\/$/, ''))
    expect(admitted.sort()).toEqual(['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'adapters', 'apps', 'global.json', 'package.json', 'packages', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'policy/licenses.json', 'schemas', 'tsconfig.base.json'])
    for (const kept of ['packages/proofmesh/bin', 'packages']) expect(lines.some((l) => !l.startsWith('!') && kept.startsWith(l.replace('/**', '')) && l !== '*')).toBe(false)
  })
})

describe('NFR013 compiled grammars carry their notices', () => {
  it('NFR013 every grammar the syntax adapter ships has its license text beside it and a row in the third-party notices', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const root = path.join(import.meta.dirname, '..', '..', '..')
    const dir = path.join(root, 'adapters', 'syntax', 'dist', 'grammars')
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'grammars.json'), 'utf8')) as Record<string, { package: string; version: string; license: string }>
    const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    expect(Object.keys(manifest).length).toBe(18)
    for (const [language, g] of Object.entries(manifest)) {
      expect(fs.readFileSync(path.join(dir, `${language}.LICENSE`), 'utf8'), language).toMatch(g.license === 'MIT' ? /Permission is hereby granted, free of charge/ : /Apache License/)
      expect(notices, g.package).toContain(`| ${g.package} | ${g.version} | ${g.license} |`)
    }
  })
})

