// Reads the SCIP indexes a person named, one document at a time (FR164). A document is decoded, distilled and dropped: what stays in
// memory is each routed document's definitions, so memory grows with the number of definitions, not with the size of the index.
import { sha256File } from '../core/hash.js'
import { DEFINITION, repositoryPath, scanScip, stampOf, type DocumentAt, type ScanProbe, type ScipOccurrence, type ScipSymbol, type Stamp } from './decode.js'

/** A routed document as the adapter keeps it: where to read it again, and its definitions with what the index says of them. */
export type RoutedDocument = { path: string; /** The path the index itself gives the document. */ scipPath: string; stamp: Stamp; language: string; positionEncoding: number; index: string; at: DocumentAt; definitions: ScipOccurrence[]; info: Map<string, ScipSymbol> }
export type Loaded = {
  tools: Record<string, string>
  routed: Map<string, RoutedDocument>
  /** Symbols an index defines in a file that is not routed to this adapter: a stale one, or one a first-party adapter analyses. */
  elsewhere: Set<string>
  /** The kind the index gives a symbol it does not define in a routed document: what the importer can tell of an external supertype (FR162). */
  kinds: Map<string, number>
}
export type LoadProbe = ScanProbe & { retainedOccurrences: number }
export type NamedIndex = { name: string; path: string; sha256: string }

export function loadIndexes(indexes: NamedIndex[], routedPaths: Set<string>, root: string, probe?: LoadProbe, chunkBytes?: number): Loaded {
  const out: Loaded = { tools: {}, routed: new Map(), elsewhere: new Set(), kinds: new Map() }
  for (const ix of indexes) {
    let meta = { projectRoot: '', tool: { name: '', version: '' } }
    let digest: string
    const stamp = stampOf(ix.path)
    try {
      digest = scanScip(ix.path, {
        metadata: (m) => { meta = m },
        document: (doc, at) => {
          const p = repositoryPath(meta, doc, root)
          if (p && routedPaths.has(p) && !out.routed.has(p)) {
            const definitions = doc.occurrences.filter((o) => o.roles & DEFINITION)
            const defined = new Set(definitions.map((o) => o.symbol))
            const info = new Map(doc.symbols.filter((s) => defined.has(s.symbol)).map((s) => [s.symbol, s]))
            for (const sym of doc.symbols) if (sym.kind && !defined.has(sym.symbol)) out.kinds.set(sym.symbol, sym.kind)
            out.routed.set(p, { path: p, scipPath: doc.path, stamp, language: doc.language, positionEncoding: doc.positionEncoding, index: ix.path, at, definitions, info })
            if (probe) probe.retainedOccurrences += definitions.length
          } else for (const o of doc.occurrences) if (o.roles & DEFINITION) out.elsewhere.add(o.symbol)
        },
        external: (sym) => { if (sym.kind) out.kinds.set(sym.symbol, sym.kind) },
      }, { ...(probe ? { probe } : {}), ...(chunkBytes ? { chunkBytes } : {}) })
    } catch (e) {
      if (sha256File(ix.path) !== ix.sha256) throw changed(ix.name)
      throw e
    }
    if (digest !== ix.sha256) throw changed(ix.name)
    out.tools[`scip:${ix.name}`] = `${meta.tool.name} ${meta.tool.version}`.trim()
  }
  return out
}
const changed = (name: string) => new Error(`the SCIP index ${name} changed after it was added; add it again: proofmesh scip add`)
