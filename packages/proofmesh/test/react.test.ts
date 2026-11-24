import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, tmpDir, withSnapshot } from './helpers.js'

const REACT_TYPES = `export type ReactNode = unknown
export interface Context<T> { Provider: (props: { value: T; children?: ReactNode }) => ReactNode; Consumer: (props: { children: (value: T) => ReactNode }) => ReactNode }
export declare function createContext<T>(value: T): Context<T>
export declare function useContext<T>(context: Context<T>): T
export declare function useState<T>(value: T): [T, (next: T) => void]
export declare function lazy<T>(load: () => Promise<{ default: T }>): T
`
const JSX_RUNTIME = 'export namespace JSX { interface IntrinsicElements { [name: string]: any } interface Element {} }\nexport declare function jsx(type: unknown, props: unknown): unknown\nexport declare function jsxs(type: unknown, props: unknown): unknown\n'

describe('FR078 A20 React rules: renders, hooks, and context, as framework facts', () => {
  it('relates components to what they render, the hooks they call, and the contexts they provide and read', async () => {
    const repo = tmpDir('pm-react-')
    fs.cpSync(fixtureRepo('ts-react'), repo, { recursive: true })
    fs.mkdirSync(path.join(repo, 'node_modules/react'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules/react/package.json'), JSON.stringify({ name: 'react', version: '19.0.0', types: 'index.d.ts' }))
    fs.writeFileSync(path.join(repo, 'node_modules/react/index.d.ts'), REACT_TYPES)
    fs.writeFileSync(path.join(repo, 'node_modules/react/jsx-runtime.d.ts'), JSX_RUNTIME)
    const { dataDir } = await indexedDataDir(repo)
    const facts = withSnapshot(dataDir, (db) => db.prepare(`
      select a.type, a.resolution, a.reason, a.detail, s.qualified_name as src, t.qualified_name as dst, x.module, x.name as ext, f.path, ev.start_line as line
      from assertion a join symbol s on s.id = a.source_id left join symbol t on t.id = a.target_id left join external_symbol x on x.id = a.target_id
      join assertion_evidence ae on ae.assertion_id = a.id join evidence ev on ev.id = ae.evidence_id join file f on f.id = ev.file_id
      where a.type in ('renders', 'uses_hook', 'provides_context', 'uses_context') order by f.path, ev.start_byte`).all() as Array<Record<string, string | number | null>>)
    expect(facts.map((r) => [r.path, r.line, r.type, r.src, r.dst ?? (r.ext ? `${r.module}:${r.ext}` : null), r.resolution, r.reason, r.detail ? JSON.parse(String(r.detail)) : null])).toEqual([
      ['src/App.tsx', 9, 'provides_context', 'src/App:App', 'src/theme:Theme', 'resolved', null, { rule: 'Provider' }],
      ['src/App.tsx', 10, 'renders', 'src/App:App', 'src/Button:Button', 'resolved', null, { rule: 'jsx', props: 'label,onClick' }],
      ['src/App.tsx', 11, 'renders', 'src/App:App', 'src/Counter:Counter', 'resolved', null, { rule: 'lazy' }],
      ['src/App.tsx', 12, 'renders', 'src/App:App', null, 'unresolved', 'unknown_name', { rule: 'jsx' }],
      ['src/Button.tsx', 5, 'uses_context', 'src/Button:Button', 'src/theme:Theme', 'resolved', null, { rule: 'useContext' }],
      ['src/Counter.tsx', 5, 'uses_hook', 'src/Counter:Counter', 'src/useCounter:useCounter', 'resolved', null, { rule: 'hook' }],
      ['src/Counter.tsx', 6, 'renders', 'src/Counter:Counter', 'src/Button:Button', 'resolved', null, { rule: 'jsx', props: 'label,onClick' }],
      ['src/useCounter.ts', 4, 'uses_hook', 'src/useCounter:useCounter', 'react:useState', 'resolved_external', null, { rule: 'hook' }],
    ])
  }, 120000)
})
