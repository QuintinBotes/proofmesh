import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, tmpDir } from './helpers.js'

// The Observatory benchmark (bench/observatory, issue #41) on a small project-authored fixture standing in for the TypeORM
// sample (PARITY_FIXTURE), one measured cold run beside the first. The full run is `pnpm bench:observatory --fixture typeorm`.
const BENCH = path.join(ROOT, 'bench/observatory/frames.mjs')
const lib = () => import(path.join(ROOT, 'bench/observatory/lib.mjs'))
const gen = () => import(path.join(ROOT, 'bench/observatory/gen-galaxy.mjs'))
const stability = () => import(path.join(ROOT, 'bench/observatory/stability.mjs'))

function fixture(): string {
  const dir = fs.realpathSync(tmpDir('pm-obs-fixture-'))
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
  write('tsconfig.json', '{ "compilerOptions": { "target": "es2020", "module": "commonjs", "strict": false, "noEmit": true }, "include": ["src"] }\n')
  write('LICENSE', 'Project-authored for the Observatory benchmark test. Apache-2.0.\n')
  write('PROVENANCE', 'Source: project-authored\nCommit: test-fixture\nLicence: Apache-2.0\n')
  write('src/order/Order.ts', 'import { price } from "../pricing/price"\nexport class Order {\n  total(): number { return price(this.lines()) }\n  lines(): number[] { return [1, 2] }\n}\n')
  write('src/pricing/price.ts', 'import { tax } from "./tax"\nexport function price(lines: number[]): number { return tax(lines.reduce((a, b) => a + b, 0)) }\n')
  write('src/pricing/tax.ts', 'export function tax(n: number): number { return n * 1.2 }\n')
  write('src/order/OrderService.ts', 'import { Order } from "./Order"\nexport class OrderService {\n  open(): number { return new Order().total() }\n  close(): number { return this.open() }\n}\n')
  write('src/index.ts', 'import { OrderService } from "./order/OrderService"\nexport function main(): number { return new OrderService().close() }\n')
  // What snapshot B's commit edits (bench/observatory/snapshot-b.mjs), in small, so the stability step can write it here too.
  write('src/query-builder/QueryBuilder.ts', 'export class QueryBuilder {\n    expressionMap = { parameters: {} as Record<string, unknown> }\n    protected createParameter(value: any): string {\n        return String(value)\n    }\n}\n')
  write('src/util/StringUtils.ts', `export function camelCase(str: string): string {\n    return str\n}\n\n/**\n * Converts string into Title Case.\n */\nexport function titleCase(str: string): string {\n    return str.replace(\n        /\\w\\S*/g,\n        (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase(),\n    )\n}\n\nexport function abbreviate(str: string): string {\n    return str.slice(0, 1)\n}\n`)
  write('src/data-source/DataSource.ts', 'import { ObjectLiteral } from "../common/ObjectLiteral"\nexport class DataSource {\n    driver = { connect: async () => {} }\n    async initialize(): Promise<this> {\n        await this.driver.connect()\n        return this\n    }\n}\n')
  execFileSync('git', ['-C', dir, 'init', '-q'])
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'fixture'])
  return dir
}
const bench = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [BENCH, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 900000 })

describe('FR1160 to FR1169 the Observatory benchmark measures what a reader waits for, reproducibly, against published budgets', () => {
  it('FR1160 FR1161 FR1163 FR1164 FR1166 FR1168 one command builds the pinned fixture, measures every field cold and warm over fresh profiles, reports stability, and --check exits 1 on a slowed build', () => {
    const fix = fixture()
    const out = path.join(tmpDir('pm-obs-out-'), 'obs.json')
    // A 250 ms main-thread task after the first draw stands in for a slowed build (SC-003).
    const r = bench(['--fixture', 'typeorm', '--runs', '1', '--out', out, '--inject-task-ms', '250', '--check'], { PARITY_FIXTURE: fix })
    expect(r.status, r.stderr).toBe(1)
    const res = JSON.parse(fs.readFileSync(out, 'utf8'))
    const md = fs.readFileSync(out.replace(/\.json$/, '.md'), 'utf8')
    // FR1160 and FR1168: the fixture, read from its PROVENANCE, indexed into a fresh data directory; the run names the machine, its load, the browser build and the WebGL renderer.
    expect(res.fixture).toMatchObject({ name: 'typeorm', commit: 'test-fixture', licence: 'Apache-2.0' })
    expect(res.fixture.symbols).toBeGreaterThan(5)
    expect(res.proofmesh_commit).toMatch(/^[0-9a-f]{40}$/)
    expect(res.machine.hardware).toBeTruthy()
    expect(res.machine.load_avg_start).toHaveLength(3)
    expect(res.browser.version).toMatch(/^\d+\./)
    expect(res.browser.build).toBeTruthy()
    expect(res.viewport).toEqual({ width: 1400, height: 900, device_scale_factor: 1 })
    expect(typeof res.webgl_renderer).toBe('string')
    expect(typeof res.software_renderer).toBe('boolean')
    for (const words of [res.machine.hardware, res.browser.version, res.webgl_renderer, 'load average']) expect(md).toContain(words)
    // FR1161: every field of FR-002, cold and warm, each the median of the measured runs with its spread.
    const LOAD = ['fcp_ms', 'first_draw_ms', 'settled_ms', 'tti_ms', 'tbt_ms', 'longest_task_ms', 'js_heap_mb', 'browser_rss_mb']
    const AFTER = ['frame_idle_p50_ms', 'frame_idle_p95_ms', 'frame_idle_max_ms', 'frame_pan_zoom_p50_ms', 'frame_pan_zoom_p95_ms', 'frame_pan_zoom_max_ms',
      'search_ms', 'palette_p50_ms', 'palette_p95_ms', 'palette_max_ms', 'palette_typing_longest_task_ms', 'symbol_to_evidence_ms', 'symbol_to_evidence_requests', 'edge_to_evidence_ms', 'edge_to_evidence_requests', 'terrain_switch_ms', 'terrain_switch_cold_ms']
    for (const k of [...LOAD, ...AFTER]) {
      expect(res.cold[k], `cold.${k}`).toMatchObject({ median: expect.any(Number), min: expect.any(Number), max: expect.any(Number), values: [expect.any(Number)] })
      expect(res.first_run[k], `first_run.${k}`).toEqual(expect.any(Number))
    }
    for (const k of LOAD) expect(res.warm[k], `warm.${k}`).toMatchObject({ median: expect.any(Number) })
    expect(res.cold.symbol_to_evidence_requests.median).toBeGreaterThanOrEqual(1)
    for (const type of ['script', 'stylesheet', 'api']) expect(res.bytes_total[type]).toMatchObject({ raw: expect.any(Number), gzip: expect.any(Number), transferred: expect.any(Number) })
    expect(res.bytes_total.script.raw).toBeGreaterThan(res.bytes_total.script.gzip)
    expect(res.bytes.some((b: { url: string }) => b.url === '/api/v1/galaxy/v6/:snapshot')).toBe(true)
    expect(JSON.stringify(res)).not.toMatch(/#t=|pm_session/)
    expect(res.calls.map((c: { call: string }) => c.call)).toEqual(expect.arrayContaining(['/api/v1/galaxy/v6/:snapshot', '/api/v1/galaxy/symbol']))
    // FR1163: same snapshot in two fresh profiles, and A followed by B, snapshot-b.mjs's commit touching four files (one of them new).
    for (const s of [res.stability.same_snapshot, res.stability.a_to_b]) expect(s).toMatchObject({ shared: expect.any(Number), median: expect.any(Number), p90: expect.any(Number), max: expect.any(Number), moved_2pct: expect.any(Number), moved_5pct: expect.any(Number) })
    expect(res.stability.a_to_b.files).toHaveLength(4)
    // FR1763: from A, ] to B once both are loaded, timed in the page.
    expect(res.warm.time_step_ms).toMatchObject({ median: expect.any(Number) })
    // FR1166: one first run apart, the medians over the measured cold runs, each in a fresh profile, and the spread across them.
    expect(res.runs).toBe(1)
    expect(md).toMatch(/^\| Measure \| Median \| Spread \| First run \| Budget \| Target \| Status \|$/m)
    // FR1164: the injected task misses the longest-task budget; the table says so and --check exits 1.
    expect(res.cold.longest_task_ms.median).toBeGreaterThanOrEqual(250)
    expect(res.over_budget).toContain('cold.longest_task_ms')
    expect(md).toMatch(/^\| Longest main-thread task, cold \|.*\| over budget \|$/m)
  }, 900000)

  it('FR1162 a synthetic galaxy of any size is generated deterministically, served by the real proofmesh view and measured', async () => {
    const { generateGalaxy } = await gen()
    const ids = Array.from({ length: 7 }, (_, i) => `sym_${i}`)
    const a = generateGalaxy({ nodes: 5000, seed: 1, snapshotId: 'snap_x', ids })
    const b = generateGalaxy({ nodes: 5000, seed: 1, snapshotId: 'snap_x', ids })
    expect(Buffer.compare(a.gz, b.gz)).toBe(0)
    expect(a.ids).toEqual(b.ids)
    expect(a.ids[8]).toBe('sym_1')
    expect(Buffer.compare(a.gz, generateGalaxy({ nodes: 5000, seed: 2, snapshotId: 'snap_x', ids }).gz)).not.toBe(0)
    // About 2.94 links per symbol, as 147,000 links over 50,000 symbols.
    expect(a.links / 5000).toBeGreaterThan(2.8)
    expect(a.links / 5000).toBeLessThan(3.1)
    const out = path.join(tmpDir('pm-obs-syn-'), 'obs.json')
    const r = bench(['--fixture', 'synthetic', '--nodes', '900', '--seed', '7', '--runs', '1', '--out', out], { PARITY_FIXTURE: fixture() })
    expect(r.status, r.stderr).toBe(0)
    const res = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(res.fixture).toMatchObject({ name: 'synthetic', nodes: 900, seed: 7, symbols: 900 })
    expect(res.fixture.galaxy_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(res.galaxy).toMatch(/^900 symbols in /)
    expect(res.cold.first_draw_ms.median).toEqual(expect.any(Number))
    expect(res.cold.symbol_to_evidence_ms.median).toEqual(expect.any(Number))
  }, 900000)

  it('FR1163 displacement is measured as a share of the fitted map width, for symbols present in both layouts', async () => {
    const { displacement } = await stability()
    // A is a 100-wide square of four points; B moves one shared point by 10 (10% of the width) and adds a point A lacks.
    const a = { positions: [0, 0, 100, 0, 0, 100, 100, 100], names: [1, 2, 3, 4] }
    const b = { positions: [0, 0, 100, 0, 0, 100, 90, 100, 50, 50], names: [1, 2, 3, 4, 5] }
    expect(displacement(a, b)).toEqual({ shared: 4, median: 0, p90: 0.1, max: 0.1, moved_2pct: 0.25, moved_5pct: 0.25 })
    expect(displacement(a, a)).toMatchObject({ max: 0, moved_2pct: 0 })
  })

  it('FR1164 FR1165 a value over its budget is marked and counted; a software renderer is checked against the software column', async () => {
    const { checkBudgets, isSoftwareRenderer } = await lib()
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe(true)
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true)
    expect(isSoftwareRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)')).toBe(false)
    const budgets = { 'cold.frame_pan_zoom_p95_ms': { label: 'Pan and zoom frame, p95', gpu: 33, software: 100, target: '≤ 16.7 ms (#46)' } }
    const result = (sw: boolean) => ({ software_renderer: sw, cold: { frame_pan_zoom_p95_ms: { median: 50 } } })
    expect(checkBudgets(result(false), budgets)).toEqual([{ key: 'cold.frame_pan_zoom_p95_ms', label: 'Pan and zoom frame, p95', median: 50, budget: 33, column: 'gpu', target: '≤ 16.7 ms (#46)', over: true }])
    expect(checkBudgets(result(true), budgets)[0]).toMatchObject({ budget: 100, column: 'software', over: false })
    const { markdown } = await lib()
    const md = markdown({ ...result(false), measured_at: '2026-11-27T00:00:00Z', fixture: { name: 'f' }, machine: { hardware: 'h', load_avg_start: [1, 2, 3], load_avg_end: [1, 2, 3] }, browser: { version: '1', build: 'b' }, webgl_renderer: 'w', runs: 3, first_run: {} }, checkBudgets(result(false), budgets))
    expect(md).toMatch(/^\| Pan and zoom frame, p95 \|.*\| 33 ms \(gpu\) \| ≤ 16\.7 ms \(#46\) \| over budget \|$/m)
  })

  it('FR1763 the A-to-B stability share and the Time step are budgeted: a share over 1% fails the check, and the row says so', async () => {
    const { checkBudgets, markdown } = await lib()
    const budgets = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'observatory', 'budgets.json'), 'utf8')).budgets
    expect([budgets['stability.a_to_b.moved_2pct'].gpu, budgets['warm.time_step_ms'].gpu]).toEqual([0.01, 300])
    const result = (share: number) => ({ software_renderer: false, warm: { time_step_ms: { median: 87 } }, stability: { a_to_b: { moved_2pct: share } } })
    const pick = (share: number) => checkBudgets(result(share), budgets).filter((b: { key: string }) => b.key === 'stability.a_to_b.moved_2pct' || b.key === 'warm.time_step_ms').map((b: { key: string; median: number; over: boolean }) => [b.key, b.median, b.over])
    expect(pick(0.0059)).toEqual([['warm.time_step_ms', 87, false], ['stability.a_to_b.moved_2pct', 0.0059, false]])
    expect(pick(0.02)).toEqual([['warm.time_step_ms', 87, false], ['stability.a_to_b.moved_2pct', 0.02, true]])
    const md = markdown({ ...result(0.02), measured_at: '2026-11-27T00:00:00Z', fixture: { name: 'f' }, machine: { hardware: 'h', load_avg_start: [1, 2, 3], load_avg_end: [1, 2, 3] }, browser: { version: '1', build: 'b' }, webgl_renderer: 'w', runs: 3, first_run: {} }, checkBudgets(result(0.02), budgets))
    expect(md).toMatch(/^\| Shared symbols moved more than 2% of the map's width, A then B \(share\) \| 0\.02 \|.*\| 0\.01 \(gpu\) \| ≤ 1% \(#48 SC-001\) \| over budget \|$/m)
    expect(md).toMatch(/^\| Time, a step between two loaded snapshots \| 87 ms \|.*\| 300 ms \(gpu\) \| ≤ 300 ms \(#48 SC-002\) \| within \|$/m)
  })

  it('FR2620 the farthest a shared symbol moves from A to B is budgeted at 2% of the width: #275\'s 16% fails the check', async () => {
    const { checkBudgets } = await lib()
    const budgets = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'observatory', 'budgets.json'), 'utf8')).budgets
    const row = (max: number) => checkBudgets({ software_renderer: false, stability: { a_to_b: { max } } }, budgets).find((b: { key: string }) => b.key === 'stability.a_to_b.max')
    expect(row(0.0177)).toMatchObject({ median: 0.0177, budget: 0.02, over: false })
    expect(row(0.1624)).toMatchObject({ median: 0.1624, budget: 0.02, over: true })
  })

  it('FR1166 the main thread is read from long tasks: blocking time and the quiet window that ends it', async () => {
    const { mainThread } = await lib()
    // Long tasks at 100 (80 ms), 300 (120 ms) and 3000 (60 ms); first paint at 50, first draw at 200; quiet for a second after 420.
    const tasks = [{ start: 100, duration: 80 }, { start: 300, duration: 120 }, { start: 3000, duration: 60 }]
    expect(mainThread({ longTasks: tasks, fcp: 50, firstDraw: 200 })).toEqual({ tti_ms: 420, tbt_ms: 30 + 70, longest_task_ms: 120 })
  })

  it('FR1167 a missing pinned browser build stops the run with the install command', () => {
    const r = bench(['--fixture', 'typeorm', '--runs', '1'], { PLAYWRIGHT_BROWSERS_PATH: tmpDir('pm-obs-nobrowser-'), PARITY_FIXTURE: fixture() })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('pnpm exec playwright install chromium')
    const viaEnv = bench(['--fixture', 'typeorm', '--runs', '1'], { PW_EXECUTABLE_PATH: path.join(tmpDir('pm-obs-nobrowser-'), 'chrome'), PARITY_FIXTURE: fixture() })
    expect(viaEnv.status).toBe(1)
    expect(viaEnv.stderr).toMatch(/PW_EXECUTABLE_PATH .* does not exist/)
  })

  it('FR1169 the README publishes every budget of budgets.json and the latest result with its date, machine, load, browser build and commit', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'bench/observatory/README.md'), 'utf8')
    const budgets = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/observatory/budgets.json'), 'utf8')).budgets as Record<string, { label: string }>
    for (const b of Object.values(budgets)) expect(readme).toContain(`| ${b.label} |`)
    for (const words of ['Measured on', 'Machine:', 'load average', 'Browser:', 'ProofMesh commit']) expect(readme).toContain(words)
  })
})
