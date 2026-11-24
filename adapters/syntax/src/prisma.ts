// Prisma schemas (A9), with the Entity Framework rule's fact shapes: each model and view is a class that maps_to a table, declared
// at its first mapping. A table is the one @@map names (rule prisma_map), else the model's own name, as Prisma does without one
// (rule prisma_convention, marked inferred); @@schema names its schema. A field whose type is a model in the file references it;
// a relation to a model the file does not declare is unresolved, because each file is analysed alone.
import type { Node } from 'web-tree-sitter'
import type { Range } from './common.js'

const INFERRED = 'the table is named after the model, as Prisma does when no @@map names it'
const literal = (n: Node | undefined) => n?.descendantsOfType('string')[0]?.text.slice(1, -1)

export function prismaFacts(root: Node, file: string, module: string, range: (n: Node) => Range) {
  const symbols: Array<Record<string, unknown>> = []
  const relationships: Array<Record<string, unknown>> = []
  const nameOf = (d: Node) => d.namedChildren.find((c) => c.type === 'identifier')
  const declarations = root.namedChildren.filter((n) => (n.type === 'model_declaration' || n.type === 'view_declaration') && nameOf(n))
  // A relation names the first model declared with that name.
  const models = new Map(declarations.map((d) => [nameOf(d)!.text, `${file}#${d.startIndex}`] as const).reverse())
  const tables = new Set<string>()
  let unresolved = false
  for (const d of declarations) {
    const nameNode = nameOf(d)!, name = nameNode.text, id = `${file}#${d.startIndex}`
    const body = d.namedChildren.find((c) => c.type === 'statement_block')?.namedChildren ?? []
    const attribute = (a: string) => body.find((c) => c.type === 'block_attribute_declaration' && c.namedChildren[0]?.namedChildren[0]?.text === a)
    symbols.push({ local_id: id, path: file, kind: 'class', name, qualified_name: `${module}:${name}`, range: range(d), signature: `${d.type === 'view_declaration' ? 'view' : 'model'} ${name}` })
    const map = attribute('map'), schema = literal(attribute('schema'))
    const table = literal(map) ?? name, qualified = schema ? `${schema}.${table}` : table, site = map ?? nameNode
    const tableId = `${file}#table#${qualified}`
    if (!tables.has(tableId)) {
      tables.add(tableId)
      symbols.push({ local_id: tableId, path: file, kind: 'table', name: table, qualified_name: qualified, range: range(site), signature: null })
    }
    relationships.push({ type: 'maps_to', origin: 'framework_adapter', source: { symbol: id }, site: { path: file, range: range(site) }, resolution: 'resolved', target: { symbol: tableId }, detail: map ? { rule: 'prisma_map' } : { rule: 'prisma_convention', inferred: INFERRED } })
    for (const field of body.filter((c) => c.type === 'column_declaration')) {
      const type = field.namedChildren.find((c) => c.type === 'column_type')?.namedChildren[0]?.text ?? ''
      const relation = field.namedChildren.some((c) => c.type === 'attribute' && c.namedChildren[0]?.namedChildren[0]?.text === 'relation')
      const target = models.get(type)
      if (!target && !relation) continue
      relationships.push({
        type: 'references', origin: 'framework_adapter', source: { symbol: id }, site: { path: file, range: range(field) },
        ...(target ? { resolution: 'resolved', target: { symbol: target } } : { resolution: 'unresolved', reason: 'outside_capability' }),
        detail: { rule: 'prisma_relation', field: field.namedChildren[0]!.text, ...(target ? {} : { name: type }) },
      })
      unresolved ||= !target
    }
  }
  return { symbols, relationships, unresolved }
}
