import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { sha256File } from '../core/hash.js'
import { Catalog, type InstalledAdapter, type ScipIndexRecord } from '../meshstore/catalog.js'
import type { Discovered } from './discovery.js'

export type AdapterSpec = {
  id: string
  languages: Set<string>
  /** Source files this adapter analyses: lower-case extension, with its dot, to the language it is. */
  extensions: Record<string, string>
  /** Configuration files this adapter needs captured, by file name. */
  isConfig: (name: string) => boolean
  /** Build manifests this adapter analyses as sources whatever their extension: the language of a file name, or undefined. Other adapters still read them as configuration. */
  manifest?: (name: string) => string | undefined
  /** Resolves the adapter entry point, or undefined when it is not installed or no longer the file a person installed. */
  entry: () => string | undefined
  /** Why entry() is undefined, as a file disposition detail. */
  unavailable: () => string
  /** For an adapter a person installed: the hash its entry file had then, which joins snapshot identity. */
  sha256?: string
  /** Settings the core passes at initialize, beside the repository's own configuration for the adapter. */
  config?: () => Record<string, unknown>
}

const here = path.dirname(fileURLToPath(import.meta.url))

function csharpAdapterPath(): string | undefined {
  // An override naming a file that is not there leaves the adapter unavailable, so the census says so (FR138).
  if (process.env.PROOFMESH_CS_ADAPTER) return fs.existsSync(process.env.PROOFMESH_CS_ADAPTER) ? process.env.PROOFMESH_CS_ADAPTER : undefined
  const candidates = [
    path.join(here, 'adapters', 'csharp', 'Proofmesh.Adapter.CSharp.dll'),
    path.resolve(here, '..', '..', '..', '..', 'adapters', 'csharp', 'bin', 'Release', 'net10.0', 'Proofmesh.Adapter.CSharp.dll'),
    path.resolve(here, '..', '..', '..', 'adapters', 'csharp', 'bin', 'Release', 'net10.0', 'Proofmesh.Adapter.CSharp.dll'),
  ]
  return candidates.find((c) => fs.existsSync(c))
}

/** The names an API description goes by (FR253), read by the build adapter for the endpoints it declares: `openapi.yaml`, `swagger.json`, `orders.openapi.yaml`. */
const OPENAPI_NAME = /^((openapi|swagger)([.\-_].+)?|.+[.\-_](openapi|swagger))\.(ya?ml|json)$/i

const SYNTAX: Record<string, string> = {
  '.java': 'java', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.sh': 'bash', '.bash': 'bash', '.scala': 'scala', '.sc': 'scala', '.kt': 'kotlin', '.kts': 'kotlin',
  '.swift': 'swift', '.sql': 'sql', '.prisma': 'prisma',
}
const TS = { '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript' }

export const BUILT_IN: AdapterSpec[] = [
  {
    id: 'typescript', languages: new Set(['typescript', 'javascript']), extensions: TS,
    // Prisma schemas name the tables Prisma Client code queries (A36); the syntax tier still analyses them as sources.
    isConfig: (name) => /^(tsconfig|jsconfig)(\..+)?\.json$/.test(name) || name === 'package.json' || /\.prisma$/i.test(name),
    entry: () => process.env.PROOFMESH_TS_ADAPTER ?? createRequire(import.meta.url).resolve('@proofmesh/adapter-typescript'),
    unavailable: () => 'adapter_unavailable:typescript',
  },
  {
    id: 'csharp', languages: new Set(['csharp']), extensions: { '.cs': 'csharp' },
    isConfig: (name) => /\.(csproj|props|targets|sln|slnx)$/i.test(name) || ['global.json', 'nuget.config'].includes(name.toLowerCase()),
    entry: csharpAdapterPath,
    unavailable: () => 'adapter_unavailable:csharp',
  },
  // Python: declarations from Tree-sitter, call targets from Pyright, which never runs Python.
  {
    id: 'python', languages: new Set(['python']), extensions: { '.py': 'python', '.pyi': 'python' },
    isConfig: () => false,
    entry: () => createRequire(import.meta.url).resolve('@proofmesh/adapter-syntax/python'),
    unavailable: () => 'adapter_unavailable:python',
  },
  // Terraform (A8, A25): static HCL, never terraform init.
  {
    id: 'terraform', languages: new Set(['terraform']), extensions: { '.tf': 'terraform' },
    isConfig: () => false,
    entry: () => createRequire(import.meta.url).resolve('@proofmesh/adapter-syntax/terraform'),
    unavailable: () => 'adapter_unavailable:terraform',
  },
  // The build graph (FR124 to FR129, FR151 to FR160): each manifest is a source for this adapter and, where another adapter reads it as configuration, for that one too.
  {
    id: 'build', languages: new Set(['build']), extensions: {},
    manifest: (name) => (/^(go\.(mod|work)|package\.json|pnpm-workspace\.yaml|tsconfig(\..+)?\.json|pom\.xml|(settings|build)\.gradle(\.kts)?|libs\.versions\.toml)$/.test(name) || OPENAPI_NAME.test(name) ? 'build' : undefined),
    isConfig: () => false,
    entry: () => createRequire(import.meta.url).resolve('@proofmesh/adapter-syntax/build'),
    unavailable: () => 'adapter_unavailable:build',
  },
  // The Tree-sitter syntax tier (A6, A23) comes after the semantic adapters, so it takes only the languages they do not cover.
  {
    id: 'syntax', languages: new Set(Object.values(SYNTAX)), extensions: SYNTAX,
    isConfig: () => false,
    entry: () => createRequire(import.meta.url).resolve('@proofmesh/adapter-syntax'),
    unavailable: () => 'adapter_unavailable:syntax',
  },
]

function scipAdapterPath(): string | undefined {
  return [path.join(here, 'scip-adapter.mjs'), path.resolve(here, '..', '..', 'dist', 'scip-adapter.mjs')].find((c) => fs.existsSync(c))
}

/** A SCIP index as discovery sees it: whether the index file still has the hash it had when a person named it. */
/** `revoked` is the id of the revoked grant an index Proofmesh produced was run under: such an index is not read (A38). */
type ScipCoverage = ScipIndexRecord & { current: boolean; revoked?: string }

function scipSpec(indexes: ScipCoverage[]): AdapterSpec {
  return {
    id: 'scip', languages: new Set(), extensions: {}, isConfig: () => false, entry: scipAdapterPath, unavailable: () => 'adapter_unavailable:scip',
    config: () => ({ indexes: indexes.filter((i) => i.current).map((i) => ({ name: i.name, path: i.path, sha256: i.sha256, ...(i.run ? { run: i.run } : {}) })) }),
  }
}

/** An adapter a person installed runs only while its entry file is the one they installed (D13, US18). */
function installedSpec(a: InstalledAdapter): AdapterSpec {
  const state = () => (!fs.existsSync(a.entry) ? 'missing' : sha256File(a.entry) === a.sha256 ? 'ok' : 'changed')
  return {
    id: a.id, languages: new Set(Object.values(a.extensions)), extensions: a.extensions, sha256: a.sha256,
    isConfig: (name) => a.configNames.includes(name),
    entry: () => (state() === 'ok' ? a.entry : undefined),
    unavailable: () => (state() === 'changed' ? `adapter_changed:${a.id}` : `adapter_unavailable:${a.id}`),
  }
}

/** Which adapter analyses which file. Built-in adapters come first, so an installed one never takes their files. */
export class Registry {
  /** serviceRegistries: files a workspace names as a repository's service registry, captured so links read them from the snapshot (A7). */
  constructor(readonly specs: AdapterSpec[], readonly scip: ScipCoverage[] = [], readonly serviceRegistries: string[] = []) {}
  /**
   * A27: a file a SCIP index covers goes to the SCIP adapter when no semantic adapter analyses it and it still has the content the
   * index was named against; a covered file that changed since, or whose index changed, stays with its usual adapter and says so.
   */
  route(d: Discovered, root: string): Discovered {
    let unusable: Discovered | undefined
    for (const ix of this.scip) {
      const covered = ix.files[d.path]
      if (!covered) continue
      const owner = d.role === 'source' && d.language ? this.specs.find((s) => s.languages.has(d.language!)) : undefined
      if (owner && owner.id !== 'syntax') return d
      if (d.status !== 'capture' && !(d.status === 'unsupported' && d.detail?.startsWith('no_adapter:'))) return d
      if (ix.current && sha256File(path.join(root, d.path)) === covered.hash) return { ...d, status: 'capture', detail: null, role: 'source', language: d.language ?? covered.language, adapter: 'scip', scip: ix.name }
      // A stale or revoked index does not stop the search: a later index may be valid. The first that is not is what is reported if none is.
      unusable ??= { ...d, detail: ix.revoked ? `scip_revoked:${ix.name}:${ix.revoked}` : `scip_stale:${ix.name}` }
    }
    return unusable ?? d
  }
  sourceLanguage(fileName: string): string | undefined {
    const ext = path.posix.extname(fileName).toLowerCase()
    for (const s of this.specs) if (Object.hasOwn(s.extensions, ext)) return s.extensions[ext]
    return undefined
  }
  manifestLanguage(fileName: string): string | undefined {
    for (const s of this.specs) { const l = s.manifest?.(fileName); if (l) return l }
    return undefined
  }
  configOwner(fileName: string): AdapterSpec | undefined {
    return this.specs.find((a) => a.isConfig(fileName))
  }
  owner(extension: string): AdapterSpec | undefined {
    return this.specs.find((s) => Object.hasOwn(s.extensions, extension.toLowerCase()))
  }
}

export const BUILT_IN_REGISTRY = new Registry(BUILT_IN)

/**
 * The built-in adapters and those installed in a data directory, and for a repository the SCIP indexes named for it. Index, strict
 * freshness and the watcher all classify through it.
 */
export function registryFor(dataDir: string, repositoryId?: string): Registry {
  const catalog = Catalog.open(dataDir)
  try {
    const revokedGrant = (i: ScipIndexRecord) => (i.run && (!catalog.trustGrant(i.run.grant_id) || catalog.trustGrant(i.run.grant_id)!.revoked_at) ? i.run.grant_id : undefined)
    const scip = repositoryId ? catalog.scipIndexes(repositoryId).map((i) => { const revoked = revokedGrant(i); return { ...i, current: !revoked && fs.existsSync(i.path) && sha256File(i.path) === i.sha256, ...(revoked ? { revoked } : {}) } }) : []
    return new Registry([...BUILT_IN, ...catalog.installedAdapters().map(installedSpec), ...(scip.length ? [scipSpec(scip)] : [])], scip, repositoryId ? catalog.registryPaths(repositoryId) : [])
  } finally {
    catalog.close()
  }
}
