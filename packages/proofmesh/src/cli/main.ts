import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { asProofmeshError, ProofmeshError } from '../core/errors.js'
import { resolveDataDir } from '../core/paths.js'
import { Catalog, initDataDir, LEASE_OWNER, type IndexJob } from '../meshstore/catalog.js'
import { runVerificationCommand } from './verification.js'
import { decodeScip, repositoryPath } from '../scip/decode.js'
import { sameRepository } from '../indexer/discovery.js'
import { runWorkspaceLink } from './workspace-link.js'
import { sha256File } from '../core/hash.js'
import { normalizedDump, openSnapshot } from '../meshstore/snapshot.js'
import { indexRepository } from '../indexer/coordinator.js'
import { watch } from '../indexer/watch.js'
import { BUILT_IN, Registry, registryFor } from '../indexer/languages.js'
import { runKit } from '../conformance/kit.js'
import { runTool, treeFreshness } from '../query/tools.js'
import { serveHttp, serveStdio } from '../mcp/server.js'
import { startViewServer } from '../http/server.js'
import { galaxyFor } from '../query/galaxy.js'
import { fingerprint, readNotes } from '../query/notes.js'
import { observe } from './observe.js'
import { runDiscover } from './discover.js'
import { runTests } from './tests.js'
import { runCompleteness } from './completeness.js'
import { runClone } from './clone.js'
import { runBundle } from './bundle.js'
import { backup, restore } from './backup.js'
import { runGc } from './gc.js'
import { runMcpConfig } from './mcp-config.js'
import { runConventions } from './conventions.js'
import { duration, phaseLabel, progressReporter } from './progress.js'

export const VERSION = '0.1.0'
const USAGE = `proofmesh ${VERSION}: a code graph that shows its work

Usage: proofmesh [--data-dir DIR] <command>
  init                              create the data directory
  repo add <path> [--name N]        register a repository
  repo list                         registered repositories: id, name, root, trust
  repo move <repo> <new-path>       re-root a registered repository at another working tree of the same git repository
  repo trust <repo> --build-evaluation   allow build logic to run while indexing (C#)
  repo untrust <repo>               revoke that trust
  repo conventions <repo> [<file> | --clear]   job bases, flag keys and team enums only the repository can name (data, runs nothing)
  extension add <file> [--adapter csharp]   install a rules extension for every repository (runs its code)
  extension list | extension remove <file> [--adapter csharp]
  adapter add <entry> --id ID --extension .EXT=LANGUAGE [--extension ...] [--config NAME ...]   install an adapter for another language (runs its code)
  adapter list | adapter remove <id>
  adapter check <id or entry> --fixture <dir> [--expected <file>] [--json]   run the public conformance kit
  scip add <repository> <index.scip> [--name N]   name a SCIP index you produced; Proofmesh reads it and never runs an indexer
  scip list <repository> | scip remove <repository> <name>
  workspace add <name> <repository>... [--registry <repository>:<path>]   group repositories into an ecosystem; links and the overview are per workspace; --registry names the file a member lists its service callers in
  workspace list | workspace remove <name> [<repository>...]
  workspace link <name>   seal the cross-repository link file of the workspace's current snapshots (A7, A28)
  observe import <repository> <file.json> | observe list <repository> | observe validate <file.json>   import runtime observations (schemas/observations/0.3) to show beside static reach
  discover --anchor <repository> [--org ORG] [--limit N] [--json]   rank related GitHub repositories by this one's evidence, through read-only gh queries
  clone <owner/repo> --into <dir> [--add [--workspace NAME]]   gh repo clone one repository, and optionally register it
  verification enable|disable      allow agents to prepare verification recipes here (off by default; D07)
  verification approve <vr_id>     approve one prepared recipe, once, after reading its binding
  verification run <vr_id> [--container IMAGE]   the host-side launcher: run an approved recipe in a disposable copy of the snapshot
  notes add <dir> | notes sync | notes list | notes accept <id>   curated memory notes
  bundle export <repository> --out <dir.pmb> [--query <json>]... [--include-source]   portable evidence bundle; source only with consent
  bundle check <dir.pmb>            verify a bundle offline, with no data directory
  backup <dir> | restore <dir> --into <data-dir>   consistent copy of the data directory, verified on restore
  gc [--keep N] [--dry-run]         retire old snapshots and unreferenced evidence; never current, pinned or linked ones
  snapshot pin <id> | snapshot unpin <id>
  mcp-config [--client claude-code|codex] [--scope project|user] [--write .mcp.json]   print the client registration
  index <repository-id or path> [--rev <commit-ish>]   capture, analyse, seal, and publish a snapshot; --rev indexes a commit without touching the working tree; progress on stderr
  watch <repository> [--interval S] [--quiet-ms MS] [--poll]   keep the snapshot current; --poll ignores file notifications
  completeness <repository> <base>[..<head>] [--depth N] [--json]   every symbol the change made and what calls, implements, references or imports it, each changed, tested or neither; indexes a side with no snapshot and waits; exits 0 when no dependent is neither, 1 when one is, 2 on a usage error or unknown commit
  tests <repository> <path | path#name> [--json]   the tests that reach a file or symbol, how each is known and its chain; exits 0 when one executes it, 1 when none does, 2 on a usage error or unknown subject
  status [repository] [--json] [--fresh]   inventory and coverage of the current snapshot, and index jobs queued or running; --fresh compares the working tree with it and starts nothing
  mcp [--http [--port P]]           MCP server on stdio, or Streamable HTTP on loopback with a bearer token
  view [--port P] [--no-open]       Observatory on loopback
  debug dump --normalized <snapshot-id>`

function take(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
function has(args: string[], flag: string): boolean {
  const i = args.indexOf(flag)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv]
  const dataDirFlag = take(args, '--data-dir')
  const dataDir = resolveDataDir(dataDirFlag)
  const [cmd, ...rest] = args
  try {
    switch (cmd) {
      case 'init': {
        const { created } = initDataDir(dataDir)
        console.log(`${created ? 'initialized' : 'already initialized'} ${dataDir}`)
        return 0
      }
      case 'notes': {
        const catalog = Catalog.open(dataDir)
        try {
          if (rest[0] === 'add' && rest[1]) { console.log(`notes directory added: ${catalog.addNoteSource(rest[1], os.userInfo().username)}; run proofmesh notes sync`); return 0 }
          if (rest[0] === 'sync') {
            const r = catalog.syncNotes(readNotes)
            console.log(`${r.notes} notes synced`)
            for (const p of r.problems) console.error(`skipped ${p}`)
            return r.problems.length ? 1 : 0
          }
          if (rest[0] === 'list') {
            for (const n of catalog.notes()) console.log(`${n.id}  ${n.kind}  ${n.fingerprint ? `accepted by ${n.accepted_by ?? 'file'}` : 'unaccepted'}  ${n.title}`)
            return 0
          }
          if (rest[0] === 'accept' && rest[1]) {
            const repo = catalog.resolveRepository(take([...rest.slice(2)], '--repository'))
            const snapshot = catalog.currentSnapshot(repo.id)
            if (!snapshot) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', 'index the repository before accepting a note')
            const note = catalog.notes().find((n) => n.id === rest[1])
            if (!note) throw new ProofmeshError('NOT_FOUND', `no note ${rest[1]}; run proofmesh notes sync first`)
            const db = openSnapshot(catalog, snapshot)
            try { catalog.acceptNote(note.id, fingerprint(db, note.refs), os.userInfo().username) } finally { db.close() }
            console.log(`note ${note.id} accepted against snapshot ${snapshot.id}`)
            return 0
          }
          throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh notes add <dir> | notes sync | notes list | notes accept <id>')
        } finally {
          catalog.close()
        }
      }
      case 'extension': {
        const opts = [...rest]
        const adapter = take(opts, '--adapter') ?? 'csharp'
        const catalog = Catalog.open(dataDir)
        try {
          if (opts[0] === 'add' && opts[1]) {
            const e = catalog.addExtension(adapter, opts[1], os.userInfo().username)
            console.log(`extension installed for the ${adapter} adapter: ${e.path} (sha256 ${e.sha256.slice(0, 16)}) by ${e.added_by} at ${e.added_at}`)
            console.log('It runs inside that adapter with your permissions whenever any repository is indexed. Remove it with: proofmesh extension remove ' + e.path)
            return 0
          }
          if (opts[0] === 'remove' && opts[1]) {
            const n = catalog.removeExtension(adapter, opts[1])
            console.log(n ? `extension removed from the ${adapter} adapter` : 'no such extension was installed')
            return 0
          }
          if (opts[0] === 'list') {
            const all = catalog.extensions()
            if (!all.length) console.log('no extensions installed')
            for (const e of all) console.log(`${e.adapter_id}  ${e.path}  sha256 ${e.sha256.slice(0, 16)}  by ${e.added_by} at ${e.added_at}`)
            return 0
          }
          throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh extension add <file> [--adapter csharp] | extension list | extension remove <file> [--adapter csharp]')
        } finally {
          catalog.close()
        }
      }
      case 'adapter': {
        const opts = [...rest]
        const catalog = Catalog.open(dataDir)
        try {
          if (opts[0] === 'add' && opts[1]) {
            const entry = opts[1]
            const id = take(opts, '--id')
            const extensions: Record<string, string> = {}, configNames: string[] = []
            for (let e = take(opts, '--extension'); e; e = take(opts, '--extension')) {
              const m = /^(\.[A-Za-z0-9_+-]+)=([a-z][a-z0-9-]*)$/.exec(e)
              if (!m) throw new ProofmeshError('INVALID_ARGUMENT', `--extension takes .EXT=LANGUAGE, such as .rb=ruby; got ${e}`)
              extensions[m[1]!.toLowerCase()] = m[2]!
            }
            for (let c = take(opts, '--config'); c; c = take(opts, '--config')) configNames.push(c)
            if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) throw new ProofmeshError('INVALID_ARGUMENT', '--id takes a lower-case name, such as ruby')
            if (BUILT_IN.some((b) => b.id === id)) throw new ProofmeshError('INVALID_ARGUMENT', `${id} is a built-in adapter`)
            if (!Object.keys(extensions).length) throw new ProofmeshError('INVALID_ARGUMENT', 'name at least one --extension the adapter analyses')
            const others = new Registry([...BUILT_IN, ...registryFor(dataDir).specs.filter((s) => !BUILT_IN.includes(s) && s.id !== id)])
            for (const ext of Object.keys(extensions)) {
              const owner = others.owner(ext)
              if (owner) throw new ProofmeshError('INVALID_ARGUMENT', `${ext} is analysed by the ${owner.id} adapter`)
            }
            const a = catalog.installAdapter({ id, entry, extensions, configNames }, os.userInfo().username)
            console.log(`adapter ${a.id} installed: ${a.entry} (sha256 ${a.sha256.slice(0, 16)}) by ${a.added_by} at ${a.added_at}`)
            console.log('Installing an adapter is trusting its code: it runs with your permissions whenever a repository with its files is indexed.')
            console.log(`It runs only while the file keeps that hash. Its capabilities are unverified until it passes: proofmesh adapter check ${a.id} --fixture <dir>`)
            return 0
          }
          if (opts[0] === 'remove' && opts[1]) {
            console.log(catalog.removeAdapter(opts[1]) ? `adapter ${opts[1]} removed` : `no adapter ${opts[1]} was installed`)
            return 0
          }
          if (opts[0] === 'list') {
            const all = catalog.installedAdapters()
            if (!all.length) console.log(`no adapters installed; the built-in ones are ${BUILT_IN.map((b) => b.id).join(', ')}`)
            for (const a of all) {
              const verdict = !a.kit ? 'unverified' : a.kit.sha256 !== a.sha256 ? 'unverified (changed since its check)' : a.kit.passed ? `passed the conformance kit at ${a.kit.checked_at}` : `failed the conformance kit at ${a.kit.checked_at}: ${a.kit.failed.join(', ')}`
              console.log(`${a.id}  ${Object.entries(a.extensions).map(([e, l]) => `${e}=${l}`).join(',')}  ${a.entry}  sha256 ${a.sha256.slice(0, 16)}  ${verdict}`)
            }
            return 0
          }
          if (opts[0] === 'check' && opts[1]) {
            const fixture = take(opts, '--fixture'), expectedFile = take(opts, '--expected'), json = has(opts, '--json')
            if (!fixture) throw new ProofmeshError('INVALID_ARGUMENT', 'name the fixture directory to check the adapter on: --fixture <dir>')
            const installed = catalog.installedAdapters().find((a) => a.id === opts[1])
            const builtIn = BUILT_IN.find((b) => b.id === opts[1])
            const extensions: Record<string, string> = {}, configNames: string[] = []
            for (let e = take(opts, '--extension'); e; e = take(opts, '--extension')) { const [ext, language] = e.split('='); if (ext && language) extensions[ext.toLowerCase()] = language }
            for (let c = take(opts, '--config'); c; c = take(opts, '--config')) configNames.push(c)
            const subject = installed ? { id: installed.id, entry: installed.entry, extensions: installed.extensions, configNames: installed.configNames }
              : builtIn ? { id: builtIn.id, entry: builtIn.entry() ?? '', extensions: builtIn.extensions, configNames: [] }
              : { id: take(opts, '--id') ?? 'candidate', entry: opts[1], extensions, configNames }
            if (!subject.entry) throw new ProofmeshError('INVALID_ARGUMENT', `the ${opts[1]} adapter is not available here`)
            const expected = expectedFile ? JSON.parse(fs.readFileSync(expectedFile, 'utf8')) : undefined
            const result = await runKit(subject, fixture, expected)
            if (installed) catalog.recordKit(installed.id, { passed: result.passed, checked_at: new Date().toISOString(), sha256: installed.sha256, checks: result.checks.length, failed: result.checks.filter((c) => !c.passed).map((c) => c.id) })
            if (json) console.log(JSON.stringify(result, null, 2))
            else {
              for (const c of result.checks) console.log(`${c.passed ? 'pass' : 'FAIL'}  ${c.id}  ${c.detail}`)
              console.log(result.passed ? `${subject.id} passes the conformance kit on ${fixture}` : `${subject.id} fails the conformance kit; its capabilities may not be called supported (FR072)`)
            }
            return result.passed ? 0 : 1
          }
          throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh adapter add <entry> --id ID --extension .EXT=LANGUAGE [--config NAME] | adapter list | adapter remove <id> | adapter check <id or entry> --fixture <dir> [--expected <file>]')
        } finally {
          catalog.close()
        }
      }
      case 'observe': {
        const catalog = Catalog.open(dataDir)
        try { return observe(catalog, [...rest]) } finally { catalog.close() }
      }
      case 'scip': {
        const opts = [...rest]
        const catalog = Catalog.open(dataDir)
        try {
          if (opts[0] === 'add' && opts[1] && opts[2]) {
            const repo = catalog.repository(opts[1]), file = path.resolve(opts[2])
            const name = take(opts, '--name') ?? path.basename(file).replace(/\.scip$/, '')
            if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new ProofmeshError('INVALID_ARGUMENT', `--name takes letters, digits, dots, dashes and underscores; got ${name}`)
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not a file`)
            let index
            try { index = decodeScip(fs.readFileSync(file)) } catch (e) { throw new ProofmeshError('INVALID_ARGUMENT', `${file} is not a SCIP index: ${(e as Error).message}`) }
            // A27: each covered file's hash as the tree stands now, on the assumption that the person just built the index from it.
            const files: Record<string, { hash: string; language: string }> = {}
            let missing = 0
            for (const doc of index.documents) {
              const rel = repositoryPath(index, doc, repo.root), abs = rel ? path.join(repo.root, rel) : undefined
              if (rel && abs && fs.existsSync(abs) && fs.lstatSync(abs).isFile()) files[rel] = { hash: sha256File(abs), language: doc.language || 'unknown' }
              else missing++
            }
            const s = catalog.addScip(repo.id, { name, path: file, sha256: sha256File(file), tool: `${index.tool.name} ${index.tool.version}`.trim(), files }, os.userInfo().username)
            console.log(`SCIP index ${s.name} named for ${repo.name}: ${Object.keys(s.files).length} files covered${missing ? `, ${missing} of its documents ${missing === 1 ? 'names' : 'name'} no file in the repository` : ''}; produced by ${s.tool || 'an unnamed indexer'}; by ${s.added_by} at ${s.added_at}`)
            console.log('Proofmesh reads it at every index and never runs an indexer. Files no semantic adapter covers get its symbols and references while they keep their content as of now; after an edit a file falls back to its usual adapter until you produce the index again and add it again.')
            return 0
          }
          if (opts[0] === 'remove' && opts[1] && opts[2]) {
            const repo = catalog.repository(opts[1])
            console.log(catalog.removeScip(repo.id, opts[2]) ? `SCIP index ${opts[2]} removed from ${repo.name}` : `${repo.name} has no SCIP index named ${opts[2]}`)
            return 0
          }
          if (opts[0] === 'list' && opts[1]) {
            const repo = catalog.repository(opts[1]), all = catalog.scipIndexes(repo.id)
            if (!all.length) console.log(`no SCIP indexes named for ${repo.name}`)
            for (const s of all) {
              const state = !fs.existsSync(s.path) ? 'missing' : sha256File(s.path) !== s.sha256 ? 'changed since it was added' : 'current'
              console.log(`${s.name}  ${s.path}  ${Object.keys(s.files).length} files  ${s.tool}  ${state}  by ${s.added_by} at ${s.added_at}`)
            }
            return 0
          }
          throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh scip add <repository> <index.scip> [--name N] | scip list <repository> | scip remove <repository> <name>')
        } finally {
          catalog.close()
        }
      }
      case 'discover': return runDiscover(dataDir, rest, take, has)
      case 'tests': return runTests(dataDir, rest, has)
      case 'completeness': return runCompleteness(dataDir, rest, take, has)
      case 'clone': return runClone(dataDir, rest, take, has, os.userInfo().username)
      case 'verification':
        return runVerificationCommand(dataDir, rest)
      case 'workspace': {
        const opts = [...rest]
        const catalog = Catalog.open(dataDir)
        try {
          const registry = opts[0] === 'add' ? take(opts, '--registry') : undefined
          if (opts[0] === 'add' && opts[1] && (opts[2] || registry)) {
            if (!/^[A-Za-z0-9._-]+$/.test(opts[1])) throw new ProofmeshError('INVALID_ARGUMENT', `a workspace name takes letters, digits, dots, dashes and underscores; got ${opts[1]}`)
            const members = opts.slice(2).map((r) => catalog.repository(r))
            // --registry <repository>:<path>: the file, relative to that member's root, that lists the callers it grants (A7).
            const granted = registry === undefined ? undefined : { repo: catalog.repository(registry.slice(0, Math.max(0, registry.indexOf(':')))), path: registry.slice(registry.indexOf(':') + 1) }
            if (granted && (!granted.path || path.posix.isAbsolute(granted.path) || granted.path.includes('\\') || granted.path.split('/').some((s) => s === '..' || s === '.' || s === ''))) throw new ProofmeshError('INVALID_ARGUMENT', `--registry takes <repository>:<path relative to its root>, such as orders:.contoso/api-clients.yaml; got ${registry}`)
            if (granted && !members.some((m) => m.id === granted.repo.id) && !catalog.workspaces().find((w) => w.name === opts[1])?.members.includes(granted.repo.id)) throw new ProofmeshError('INVALID_ARGUMENT', `${granted.repo.name} is not a member of workspace ${opts[1]}; add it before naming its registry`)
            catalog.addToWorkspace(opts[1], members.map((m) => m.id), os.userInfo().username)
            if (granted) catalog.setWorkspaceRegistry(opts[1], granted.repo.id, granted.path)
            console.log(`workspace ${opts[1]}: ${catalog.workspace(opts[1]).members.length} repositories${members.length ? ` (added ${members.map((m) => m.name).join(', ')})` : ''}${granted ? `; ${granted.repo.name} lists its callers in ${granted.path}, read from its snapshot once "proofmesh index ${granted.repo.name}" captures it` : ''}`)
            return 0
          }
          if (opts[0] === 'remove' && opts[1]) {
            const ids = opts.slice(2).map((r) => catalog.repository(r).id)
            const n = catalog.removeFromWorkspace(opts[1], ids)
            console.log(ids.length ? `${n} repositories removed from workspace ${opts[1]}` : n ? `workspace ${opts[1]} removed` : `no workspace named ${opts[1]}`)
            return 0
          }
          if (opts[0] === 'link' && opts[1]) return runWorkspaceLink(catalog, dataDir, opts[1])
          if (opts[0] === 'list') {
            const all = catalog.workspaces()
            if (!all.length) console.log('no workspaces; create one with: proofmesh workspace add <name> <repository>...')
            for (const w of all) {
              const registries = catalog.workspaceRegistries(w.name)
              console.log(`${w.name}  ${w.members.map((id) => `${catalog.repository(id).name}${registries.has(id) ? ` (registry ${registries.get(id)})` : ''}`).sort().join(', ')}  by ${w.created_by} at ${w.created_at}`)
            }
            return 0
          }
          throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh workspace add <name> <repository>... [--registry <repository>:<path>] | workspace link <name> | workspace list | workspace remove <name> [<repository>...]')
        } finally {
          catalog.close()
        }
      }
      case 'repo': {
        if (rest[0] === 'conventions') {
          const catalog = Catalog.open(dataDir)
          try { return runConventions(catalog, rest.slice(1)) } finally { catalog.close() }
        }
        if (rest[0] === 'list') {
          const catalog = Catalog.open(dataDir)
          try {
            for (const r of catalog.repositories()) {
              console.log(`${r.id}  ${r.name}  ${r.root}${catalog.activeTrust(r.id) ? '  trusted: build evaluation' : ''}`)
              for (const w of rootWarnings(r.root, r.name)) process.stderr.write(`warning: ${r.id} ${w}\n`)
            }
            return 0
          } finally {
            catalog.close()
          }
        }
        if ((rest[0] === 'trust' || rest[0] === 'untrust') && rest[1]) {
          const catalog = Catalog.open(dataDir)
          try {
            const repo = catalog.repository(rest[1])
            if (rest[0] === 'untrust') {
              const n = catalog.revokeTrust(repo.id)
              console.log(n ? `build evaluation trust revoked for ${repo.name}; the next index runs without executing build logic` : `${repo.name} had no trust grant`)
              return 0
            }
            if (!rest.includes('--build-evaluation')) throw new ProofmeshError('INVALID_ARGUMENT', 'name what you trust: proofmesh repo trust <repository> --build-evaluation')
            const grant = catalog.grantTrust(repo.id, os.userInfo().username)
            console.log(`build evaluation trusted for ${repo.name} by ${grant.granted_by} at ${grant.granted_at}`)
            console.log('Indexing may now run this repository\'s build logic (MSBuild evaluation, analyzers, source generators) with your permissions. Revoke with: proofmesh repo untrust ' + repo.id)
            return 0
          } finally {
            catalog.close()
          }
        }
        if (rest[0] === 'move' && rest[1] && rest[2]) {
          const catalog = Catalog.open(dataDir)
          try {
            const repo = catalog.repository(rest[1]), to = path.resolve(rest[2])
            if (!fs.existsSync(to) || !fs.statSync(to).isDirectory()) throw new ProofmeshError('INVALID_ARGUMENT', `${to} is not a directory`)
            const snap = catalog.currentSnapshot(repo.id)
            let commit: string | undefined
            if (snap) { const db = openSnapshot(catalog, snap); try { commit = JSON.parse((db.prepare("select value from meta where key = 'git'").get() as { value: string } | undefined)?.value ?? '{}').commit } finally { db.close() } }
            if (!sameRepository(repo.root, to, commit)) throw new ProofmeshError('INVALID_ARGUMENT', `${to} is not the top of a working tree of the same git repository as ${repo.root}${commit ? `, nor of one holding commit ${commit} of its current snapshot` : ''}; register it with proofmesh repo add instead`)
            // Trust is a person's grant to run one checkout's build logic, and anyone may move a registration, so trust never moves with it.
            const revoked = catalog.revokeTrust(repo.id)
            const moved = catalog.moveRepository(repo.id, to)
            console.log(`${moved.name} (${moved.id}) moved from ${repo.root} to ${moved.root}; its snapshots, notes and observations stay. Index it to capture this working tree.`)
            if (revoked) console.log(`Build evaluation trust was revoked by the move; a person grants it again for the new checkout with: proofmesh repo trust ${moved.id} --build-evaluation`)
            return 0
          } finally {
            catalog.close()
          }
        }
        if (rest[0] !== 'add' || !rest[1]) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh repo add <path> [--name N] | repo list | repo move <repository> <new-path> | repo trust <repository> --build-evaluation | repo untrust <repository>')
        const opts = rest.slice(2)
        const name = take(opts, '--name')
        const catalog = Catalog.open(dataDir)
        try {
          const repo = catalog.addRepository(rest[1], name)
          console.log(repo.id)
          for (const w of rootWarnings(repo.root, repo.name)) process.stderr.write(`warning: ${w}\n`)
        } finally {
          catalog.close()
        }
        return 0
      }
      case 'index': {
        const opts = [...rest]
        const jobFlag = take(opts, '--job'), rev = take(opts, '--rev'), keepCurrent = has(opts, '--keep-current')
        if (!opts[0]) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh index <repository-id or path> [--rev <commit-ish> [--keep-current]]')
        const jobs = Catalog.open(dataDir)
        let jobId: string
        // Every index is a job row, so status and get_job see it; one the MCP server spawned names its row with --job.
        try { jobId = jobFlag ?? jobs.createJob(jobs.repository(opts[0]).id, os.userInfo().username) } catch (e) { jobs.close(); throw e }
        // Progress goes to stderr, so stdout stays the parseable summary.
        const report = progressReporter((line) => process.stderr.write(`${line}\n`))
        let started = false, phase = ''
        const plan: Record<string, { mode: string; analyse: number; reuse: number }> = {}
        let r: Awaited<ReturnType<typeof indexRepository>>
        try {
          // --keep-current: a commit indexed for impact_completeness leaves the repository's current snapshot as it was (FR109).
          r = await indexRepository(dataDir, opts[0], (p) => {
            const now = new Date().toISOString(), label = phaseLabel(p)
            if (p.plan && p.adapter) plan[p.adapter] = p.plan
            // Running from the first progress, which comes after the lease is held, so status never sees it running without one.
            jobs.updateJob(jobId, {
              ...(started ? {} : { state: 'running', started_at: now, owner: LEASE_OWNER }), phase: label, done: p.done, total: p.total, progress_at: now,
              ...(label !== phase ? { phase_started_at: now } : {}), ...(p.plan ? { plan: JSON.stringify(plan) } : {}),
            })
            started = true
            phase = label
            report.update(p)
          }, undefined, rev, keepCurrent && !!rev)
        } catch (e) {
          report.stop()
          jobs.updateJob(jobId, { state: 'failed', finished_at: new Date().toISOString(), error: asProofmeshError(e).message })
          jobs.close()
          throw e
        }
        const phases = report.stop()
        // A finished job keeps counts that mean something: the files indexed, not the last phase's zero.
        jobs.updateJob(jobId, { state: 'succeeded', finished_at: new Date().toISOString(), phase: 'done', done: r.counts.indexed, total: r.counts.indexed, progress_at: new Date().toISOString(), result: JSON.stringify({ snapshot_id: r.snapshotId, status: r.status, counts: r.counts, reuse: r.reuse ?? null, commit: r.commit ?? null }) })
        jobs.close()
        if (r.resumed) console.log(`resumed from checkpoint: ${r.resumed.done} of ${r.resumed.total} batches were already done`)
        if (r.reuse?.reused) console.log(`reused the facts of ${r.reuse.reused} of ${r.reuse.reused + r.reuse.analysed} files whose inputs did not change`)
        console.log(`snapshot ${r.snapshotId} ${r.status}${r.commit ? ` from commit ${r.commit} (${rev}); the working tree was not read` : ''}${r.analysisMode === 'trusted_build' ? ' (analysed with build execution)' : ''}`)
        // Observatory's Galaxy reads this; building it now keeps opening the view instant. It is a cache, so failure only costs time later.
        try { galaxyFor(dataDir) } catch { /* rebuilt on first view */ }
        console.log(`discovered ${r.counts.discovered}, indexed ${r.counts.indexed}, excluded ${r.counts.excluded_by_rule}, unsupported ${r.counts.unsupported}, failed ${r.counts.failed}`)
        console.log(`phases ${phases.map((p) => `${p.phase} ${duration(p.ms)}`).join(', ')} (job ${jobId})`)
        const peaks = Object.entries(r.adapterPeakRssKb)
        if (peaks.length) console.log(`adapter peak memory ${peaks.map(([id, kb]) => `${id} ${kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GiB` : `${Math.round(kb / 1024)} MiB`}`).join(', ')}`)
        return 0
      }
      case 'watch': {
        const opts = [...rest]
        const interval = Number(take(opts, '--interval') ?? 300), quiet = Number(take(opts, '--quiet-ms') ?? 1500)
        const poll = has(opts, '--poll')
        if (!opts[0] || !(interval > 0) || !(quiet >= 0)) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh watch <repository> [--interval SECONDS] [--quiet-ms MS] [--poll]')
        const stop = new AbortController()
        for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort())
        await watch(dataDir, opts[0], { intervalMs: interval * 1000, quietMs: quiet, poll, signal: stop.signal, log: (line) => console.log(line) })
        return 0
      }
      case 'status': {
        const opts = [...rest]
        const json = has(opts, '--json')
        if (has(opts, '--fresh')) {
          // Compares the working tree with the current snapshot and starts nothing: what the plugin's hooks ask before indexing.
          const catalog = Catalog.open(dataDir)
          try {
            const repo = catalog.resolveRepository(opts[0])
            const snapshot = catalog.currentSnapshot(repo.id)
            if (!snapshot) throw new ProofmeshError('SNAPSHOT_UNAVAILABLE', 'no published snapshot for this repository; run "proofmesh index" first', { detail: 'none' })
            const db = openSnapshot(catalog, snapshot)
            const t = (() => { try { return treeFreshness(db, dataDir, repo.root) } finally { db.close() } })()
            const out = { repository_id: repo.id, name: repo.name, snapshot_id: snapshot.id, current: t.current, changed_count: t.changed.length, changed: t.changed.slice(0, 20) }
            if (json) console.log(JSON.stringify(out, null, 2))
            else console.log(t.current ? `${repo.name}: snapshot ${snapshot.id} matches the working tree` : `${repo.name}: the working tree differs from snapshot ${snapshot.id}: ${t.changed.length} files changed${t.changed.length ? `, such as ${t.changed.slice(0, 3).map((c) => `${c.path} (${c.change})`).join(', ')}` : ''}`)
            return 0
          } finally {
            catalog.close()
          }
        }
        const env = runTool(dataDir, 'workspace_status', opts[0] ? { repository_id: opts[0] } : {})
        if (json) console.log(JSON.stringify(env, null, 2))
        else {
          for (const j of (env.data.jobs as IndexJob[] | undefined) ?? []) console.log(`index job ${j.id} ${j.state}${j.started_at ? ` since ${j.started_at}` : `, requested ${j.requested_at}`} by ${j.requested_by}${j.phase ? `: ${j.phase}${j.total ? ` ${j.done}/${j.total}` : ''}` : ''}`)
          const d = env.coverage!.dispositions
          console.log(`snapshot ${env.snapshot!.id} (${env.snapshot!.analysis_mode})${env.snapshot!.commit ? ` of commit ${env.snapshot!.commit} (${env.snapshot!.ref})` : ''}, published ${env.snapshot!.published_at}`)
          console.log(`files ${env.coverage!.files_discovered}: indexed ${d.indexed}, excluded ${d.excluded_by_rule}, unsupported ${d.unsupported}, failed ${d.failed}, pending ${d.pending}`)
          console.log(`capabilities ${Object.entries(env.coverage!.capabilities).map(([k, v]) => `${k}=${v}`).join(' ')}`)
          console.log(`unresolved ${env.unresolved.count}${Object.keys(env.unresolved.by_reason).length ? ` (${Object.entries(env.unresolved.by_reason).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`)
          // The rules discovery applied, and what each adapter read from outside the repository (FR004).
          const catalog = Catalog.open(dataDir)
          try {
            const db = openSnapshot(catalog, catalog.snapshot(env.snapshot!.id)!)
            const meta = Object.fromEntries((db.prepare("select key, value from meta where key in ('analysis_config', 'adapters')").all() as Array<{ key: string; value: string }>).map((m) => [m.key, JSON.parse(m.value)]))
            db.close()
            console.log(meta.analysis_config ? `analysis ${Object.entries(meta.analysis_config as Record<string, unknown>).map(([k, v]) => `${k} ${[v].flat().join(' ')}`).join('; ')}` : 'analysis configuration not recorded in this snapshot; index again to record it')
            for (const a of meta.adapters as Array<{ id: string; version: string; analysis_mode: string; external_inputs: string[] }>) {
              const missing = a.external_inputs.filter((i) => i.endsWith(' missing')).length
              console.log(`adapter ${a.id} ${a.version} ${a.analysis_mode}: ${a.external_inputs.length - missing} external inputs read, ${missing} missing`)
            }
          } finally {
            catalog.close()
          }
        }
        return 0
      }
      case 'mcp': {
        Catalog.open(dataDir).close()
        if (rest.includes('--http')) {
          const opts = [...rest]
          const s = await serveHttp(dataDir, VERSION, Number(take(opts, '--port') ?? 7318))
          console.log(`MCP over Streamable HTTP: ${s.url}`)
          console.log(`Authorization: Bearer ${s.token}`)
          return await new Promise<number>(() => {})
        }
        await serveStdio(dataDir, VERSION)
        return await new Promise<number>(() => {})
      }
      case 'view': {
        const opts = [...rest]
        const port = Number(take(opts, '--port') ?? 7317)
        const noOpen = has(opts, '--no-open')
        Catalog.open(dataDir).close()
        const server = await startViewServer(dataDir, port)
        console.log(`Observatory: ${server.launchUrl}`)
        setTimeout(() => { try { galaxyFor(dataDir) } catch { /* built on first request instead */ } }, 0)
        if (!noOpen) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [server.launchUrl], { stdio: 'ignore', detached: true }).unref()
        return await new Promise<number>(() => {})
      }
      case 'debug': {
        if (rest[0] !== 'dump' || rest[1] !== '--normalized' || !rest[2]) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh debug dump --normalized <snapshot-id>')
        const catalog = Catalog.open(dataDir)
        try {
          const snap = catalog.snapshot(rest[2])
          if (!snap) throw new ProofmeshError('NOT_FOUND', `snapshot ${rest[2]} is not in the catalog`)
          const db = openSnapshot(catalog, snap)
          process.stdout.write(normalizedDump(db))
          db.close()
        } finally {
          catalog.close()
        }
        return 0
      }
      case 'bundle': return runBundle(dataDir, rest, take, has)
      case 'backup': {
        if (!rest[0]) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh backup <dir>')
        const r = await backup(dataDir, path.resolve(rest[0]))
        console.log(`backup of ${dataDir} written to ${path.resolve(rest[0])}: ${r.files} files, hashed in backup-manifest.json`)
        return 0
      }
      case 'restore': {
        const opts = [...rest], into = take(opts, '--into')
        if (!opts[0] || !into) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh restore <dir> --into <data-dir>')
        const r = restore(path.resolve(opts[0]), path.resolve(into))
        console.log(`restored ${r.files} files into ${path.resolve(into)}; every hash matched the backup manifest`)
        return 0
      }
      case 'gc': return runGc(dataDir, rest, take, has)
      case 'snapshot': {
        if ((rest[0] !== 'pin' && rest[0] !== 'unpin') || !rest[1]) throw new ProofmeshError('INVALID_ARGUMENT', 'usage: proofmesh snapshot pin <id> | snapshot unpin <id>')
        const catalog = Catalog.open(dataDir)
        try { catalog.pin(rest[1], rest[0] === 'pin') } finally { catalog.close() }
        console.log(`snapshot ${rest[1]} ${rest[0] === 'pin' ? 'pinned: retention keeps it until you unpin it' : 'unpinned'}`)
        return 0
      }
      case 'mcp-config': return runMcpConfig(dataDirFlag, rest, take)
      case 'version':
      case '--version':
      case '-v':
        console.log(VERSION)
        return 0
      case undefined:
      case 'help':
      case '--help':
        console.log(USAGE)
        return 0
      default:
        throw new ProofmeshError('INVALID_ARGUMENT', `unknown command ${cmd}\n${USAGE}`)
    }
  } catch (e) {
    const err = asProofmeshError(e)
    process.stderr.write(`proofmesh: ${err.code}: ${err.message}\n`)
    return 1
  }
}

// `node dist/cli.mjs …` runs the CLI; bin/proofmesh.mjs imports main instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2))

/** What may go wrong with a registered root: it lives where the system deletes files, it is gone, or its name hides which directory it is. */
export function rootWarnings(root: string, name: string): string[] {
  const temporary = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].flatMap((t) => { try { return [t, fs.realpathSync(t)] } catch { return [t] } })
  return [
    ...(temporary.some((t) => root === t || root.startsWith(`${t}${path.sep}`)) ? [`root ${root} is under a temporary directory and may disappear; register a stable checkout, or move the registration with proofmesh repo move`] : []),
    ...(!fs.existsSync(root) ? [`root ${root} no longer exists; proofmesh repo move points the registration at the checkout's new place`] : []),
    ...(path.basename(root) !== name ? [`name ${name} differs from its directory ${path.basename(root)}`] : []),
  ]
}

