// Pure parts of the Observatory benchmark (#41): summaries over runs, the main thread read from long tasks, budgets and the
// Markdown table. frames.mjs measures; this file only computes, so packages/proofmesh/test/observatory-bench.test.ts can check it.

/** Nearest-rank percentile: the value at floor(p * n) of the sorted values. */
export const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null }
const round = (x) => (x == null ? null : Math.round(x * 10) / 10)

/** One measure over the measured runs: the median (lower middle of an even count), the range and the spread as a share of the median. */
export function summarize(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x))
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b), median = s[(s.length - 1) >> 1]
  return { median: round(median), min: round(s[0]), max: round(s.at(-1)), spread_pct: median ? round(((s.at(-1) - s[0]) / median) * 100) : 0, values: v.map(round) }
}
/** Each key of a list of flat runs, summarised. */
export const summarizeRuns = (runs) => Object.fromEntries([...new Set(runs.flatMap(Object.keys))].map((k) => [k, summarize(runs.map((r) => r[k]))]))

/**
 * The main thread over a load, from its long tasks (start and duration, ms since navigation). Time to interactive is the end of
 * the last long task before a quiet second, counted from the first drawn map; total blocking time sums each long task's time
 * over 50 ms between first contentful paint and that point, as Lighthouse does.
 */
export function mainThread({ longTasks, fcp, firstDraw }) {
  const tasks = [...longTasks].sort((a, b) => a.start - b.start)
  let tti = firstDraw
  for (const t of tasks) {
    if (t.start + t.duration <= tti) continue
    if (t.start - tti >= 1000) break
    tti = Math.max(tti, t.start + t.duration)
  }
  let tbt = 0
  for (const t of tasks) {
    const d = Math.min(t.start + t.duration, tti) - Math.max(t.start, fcp)
    if (d > 50) tbt += d - 50
  }
  return { tti_ms: round(tti), tbt_ms: round(tbt), longest_task_ms: round(Math.max(0, ...tasks.map((t) => t.duration))) }
}

/** SwiftShader and Mesa's llvmpipe or softpipe draw on the CPU: their frame times say nothing of a GPU. */
export const isSoftwareRenderer = (renderer) => /swiftshader|llvmpipe|softpipe|software/i.test(renderer ?? '')

const valueAt = (result, key) => key.split('.').reduce((o, k) => o?.[k], result)
/** Each budget against the median of its measure, from the GPU column or, on a software renderer, the software column. */
export function checkBudgets(result, budgets) {
  const column = result.software_renderer ? 'software' : 'gpu'
  return Object.entries(budgets).map(([key, b]) => {
    const median = valueAt(result, key)?.median ?? null, budget = b[column] ?? null
    return { key, label: b.label, median, budget, column, target: b.target ?? null, over: budget != null && median != null && median > budget }
  })
}

const UNITS = [[/_requests$/, ''], [/_mb$/, ' MB'], [/_kb$/, ' KB'], [/_ms$/, ' ms']]
const unit = (key) => UNITS.find(([re]) => re.test(key))?.[1] ?? ''
const fmt = (v, key) => (v == null ? '-' : `${v.toLocaleString('en')}${unit(key)}`)
const LABELS = {
  fcp_ms: 'First contentful paint', first_draw_ms: 'First drawn map', settled_ms: 'Final positions (layout settled)', tti_ms: 'Time to interactive',
  tbt_ms: 'Total blocking time', longest_task_ms: 'Longest main-thread task', js_heap_mb: 'JS heap', browser_rss_mb: 'Browser memory, all processes',
  frame_idle_p50_ms: 'Frame at rest, p50', frame_idle_p95_ms: 'Frame at rest, p95', frame_idle_max_ms: 'Frame at rest, max',
  frame_pan_zoom_p50_ms: 'Pan and zoom frame, p50', frame_pan_zoom_p95_ms: 'Pan and zoom frame, p95', frame_pan_zoom_max_ms: 'Pan and zoom frame, max',
  search_ms: 'Search', symbol_to_evidence_ms: 'Symbol to evidence', symbol_to_evidence_requests: 'Symbol to evidence, requests',
  edge_to_evidence_ms: 'Edge to evidence', edge_to_evidence_requests: 'Edge to evidence, requests', map_switch_ms: 'Map switch', map_switch_cold_ms: 'Map switch, first',
  palette_p50_ms: 'Command palette, query to matches, p50', palette_p95_ms: 'Command palette, query to matches, p95', palette_max_ms: 'Command palette, query to matches, max',
  palette_typing_longest_task_ms: 'Command palette, longest task while typing',
}
export const labelOf = (key) => { const [phase, k] = key.split('.'); return `${LABELS[k] ?? k}${phase === 'warm' ? ', warm' : phase === 'cold' && /^(fcp|first_draw|settled|tti|tbt|longest_task)_/.test(k) ? ', cold' : ''}` }
const kb = (n) => `${Math.round(n / 1024).toLocaleString('en')} KB`

/** The run as a Markdown page: what ran where, then one row per measure, then bytes, calls and stability. */
export function markdown(r, rows) {
  const byKey = new Map(rows.map((x) => [x.key, x]))
  const m = r.machine
  const lines = [
    `# Observatory benchmark: ${r.fixture.name}${r.fixture.nodes ? ` (${r.fixture.nodes.toLocaleString('en')} symbols, seed ${r.fixture.seed})` : ''}`, '',
    `Measured on ${r.measured_at}. Fixture: ${r.fixture.nodes ? `synthetic galaxy (sha256 ${r.fixture.galaxy_sha256.slice(0, 12)}), its points mapped to the TypeORM sample` : r.fixture.name}${r.fixture.commit ? ` @ ${r.fixture.commit}` : ''}${r.fixture.licence ? ` (${r.fixture.licence})` : ''}${r.fixture.symbols ? `, ${r.fixture.symbols.toLocaleString('en')} symbols` : ''}. ProofMesh commit ${r.proofmesh_commit ?? 'unknown'}${r.proofmesh_dirty ? ' with uncommitted changes' : ''}.`,
    `Machine: ${m.hardware}; load average ${m.load_avg_start.map((x) => x.toFixed(2)).join(' ')} at start, ${m.load_avg_end.map((x) => x.toFixed(2)).join(' ')} at end${m.free_memory_gb != null ? `; ${m.free_memory_gb} GB free` : ''}.`,
    `Browser: Chromium ${r.browser.version} (${r.browser.build})${r.browser.headless === false ? '' : ', headless'}, viewport ${r.viewport ? `${r.viewport.width}×${r.viewport.height} @${r.viewport.device_scale_factor}x` : '-'}. WebGL renderer: ${r.webgl_renderer}${r.software_renderer ? ' (software renderer: frame budgets use the software column)' : ''}.`,
    `Medians of ${r.runs} cold run${r.runs === 1 ? '' : 's'}, each in a fresh browser profile and a fresh \`proofmesh view\`; warm is the Galaxy opened again in the same tab, its layout and HTTP cache kept. The first run on the machine is reported apart.${r.injected_task_ms ? ` A ${r.injected_task_ms} ms main-thread task was injected after the first draw (--inject-task-ms).` : ''}`,
    '',
    '| Measure | Median | Spread | First run | Budget | Target | Status |', '|---|---|---|---|---|---|---|',
  ]
  for (const phase of ['cold', 'warm']) for (const [k, s] of Object.entries(r[phase] ?? {})) {
    if (!s) continue
    const key = `${phase}.${k}`, b = byKey.get(key)
    lines.push(`| ${b?.label ?? labelOf(key)} | ${fmt(s.median, k)} | ${s.min === s.max ? '-' : `${fmt(s.min, k)}–${fmt(s.max, k)} (${s.spread_pct}%)`} | ${phase === 'cold' ? fmt(r.first_run?.[k], k) : '-'} | ${b?.budget != null ? `${fmt(b.budget, k)} (${b.column})` : '-'} | ${b?.target ?? '-'} | ${!b || b.budget == null ? '-' : b.over ? 'over budget' : 'within'} |`)
  }
  for (const b of rows) if (b.median == null) lines.push(`| ${b.label} | not measured | - | - | ${b.budget ?? '-'} (${b.column}) | ${b.target ?? '-'} | not measured |`)
  if (r.agreement) lines.push('', r.agreement.ok ? `Cold runs agree within 10% on every time over 100 ms.` : `Cold runs differ by more than 10% on: ${r.agreement.outliers.join(', ')}.`)
  if (r.bytes_total) {
    lines.push('', '| Bytes, cold load | Raw | Gzip | Transferred |', '|---|---|---|---|')
    for (const [t, v] of Object.entries(r.bytes_total)) lines.push(`| ${t} (${v.count}) | ${kb(v.raw)} | ${kb(v.gzip)} | ${kb(v.transferred)} |`)
  }
  if (r.calls?.length) {
    lines.push('', '| API call | Calls | Median | Max |', '|---|---|---|---|')
    for (const c of r.calls) lines.push(`| \`${c.call}\` | ${c.count} | ${c.ms.median} ms | ${c.ms.max} ms |`)
  }
  if (r.stability) {
    lines.push('', '| Stability (share of map width) | Shared symbols | Median | p90 | Max | Moved > 2% | Moved > 5% |', '|---|---|---|---|---|---|---|')
    const p = (x) => (x == null ? '-' : `${(x * 100).toFixed(2)}%`)
    for (const [name, s] of [['Same snapshot, two fresh profiles', r.stability.same_snapshot], ['Snapshot A, then B (a commit touching four files)', r.stability.a_to_b]]) {
      lines.push(s?.shared != null ? `| ${name} | ${s.shared.toLocaleString('en')} | ${p(s.median)} | ${p(s.p90)} | ${p(s.max)} | ${p(s.moved_2pct)} | ${p(s.moved_5pct)} |` : `| ${name} | ${s?.reason ?? 'not measured'} | | | | | |`)
    }
  }
  const over = rows.filter((b) => b.over)
  lines.push('', over.length ? `Over budget: ${over.map((b) => b.label).join(', ')}.` : 'Every budget is met.')
  return lines.join('\n') + '\n'
}
