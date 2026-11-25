import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { indexedDataDir, indexedRepo, ROOT, tool } from './helpers.js'

const ROSETTA = path.join(ROOT, 'fixtures', 'rosetta')
type Sym = { id: string; qualified_name: string }
const find = (dataDir: string, text: string, qn: RegExp): string => (tool(dataDir, 'find_symbols', { text }).data.symbols as Sym[]).find((s) => qn.test(s.qualified_name))!.id
const dependents = (dataDir: string, subject: string, depth = 2) => (tool(dataDir, 'analyze_impact', { subject_ids: [subject], limits: { max_depth: depth } }).data as { dependents: Array<{ qualified_name: string; depth: number }> }).dependents

describe('FR225 impact of an interface member reaches every implementation, and no implementation reaches its siblings', () => {
  it.each([['typescript', /(^|[.:])Shape\.area$/, /Circle\.area$/, /Square\.area$/], ['csharp', /Shape\.Area$/, /Circle\.Area$/, /Square\.Area$/]])('FR225 %s: impact of Shape.area lists both implementations and their callers', async (lang, shape, circle, square) => {
    const { dataDir } = await indexedDataDir(path.join(ROSETTA, lang, 'repo'))
    const names = dependents(dataDir, find(dataDir, 'area', shape)).map((d) => d.qualified_name)
    expect(names.some((n) => circle.test(n))).toBe(true)
    expect(names.some((n) => square.test(n))).toBe(true)
    expect(names.some((n) => /(circleArea|CircleArea)$/.test(n))).toBe(true)
  })

  it('FR225: with three implementations, impact of the interface member lists all three and impact of one lists none of the others', async () => {
    const impl = (n: string) => `export class ${n} implements Shape { area(): number { return 1 } }\nexport function use${n}(): number { return new ${n}().area() }\n`
    const { dataDir } = await indexedRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true }, include: ['*.ts'] }),
      'shapes.ts': `export interface Shape { area(): number }\n${['A', 'B', 'C'].map(impl).join('')}`,
    })
    const all = dependents(dataDir, find(dataDir, 'area', /Shape\.area$/), 1).map((d) => d.qualified_name)
    for (const n of ['A', 'B', 'C']) expect(all.some((q) => q.endsWith(`${n}.area`)), n).toBe(true)
    const own = dependents(dataDir, find(dataDir, 'area', /B\.area$/), 1).map((d) => d.qualified_name)
    expect(own.some((q) => /[AC]\.area$/.test(q))).toBe(false)
    expect(own.some((q) => q.endsWith('useB'))).toBe(true)
  })
})

describe('FR224 the totals of get_relationships count only the rows include_tests false leaves', () => {
  it('FR224: an outbound import of a test file is in neither the rows nor the totals', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true }, include: ['*.ts'] }),
      'a.ts': "import './b.test'\nimport './c'\nexport const a = 1\n",
      'b.test.ts': 'export const b = 1\n',
      'c.ts': 'export const c = 1\n',
    })
    const ids = (tool(dataDir, 'find_symbols', { text: 'a', kinds: ['module'] }).data.symbols as Array<{ id: string; path: string }>)
    const subject = ids.find((s) => s.path === 'a.ts')!.id
    const data = tool(dataDir, 'get_relationships', { subject_id: subject, direction: 'out', types: ['imports'], include_tests: false }).data as { relationships: unknown[]; totals: { out: number } }
    expect(data.relationships).toHaveLength(1)
    expect(data.totals.out).toBe(data.relationships.length)
  })
})
