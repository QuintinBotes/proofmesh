// A12: compares agent sessions with and without Proofmesh's MCP tools on a golden question set, and reports only what the sessions
// record. Two modes:
//   node bench/eval/run.mjs <set.json> <with.json> <without.json> [--json]
//     scores two recorded sessions: { "session": "with"|"without", "method"?, "answers": [{ "question_id", "answer", "turns"?, "tool_calls"?, "tokens"?, "cost_usd"? }] }
//   node bench/eval/run.mjs sessions <set.json> --repo <dir> --data-dir <dir> --out <dir> [--model M] [--budget-usd N] [--with-skill] [--agent claude] [--json]
//     runs one headless Claude Code session per question and condition in <repo>, writes with.json, without.json and method.json to <out>,
//     then scores them. Both conditions read no user-level settings (so no personal plugins or hooks run), allow Read, Grep and Glob,
//     and load MCP servers only from the command line; "with" adds the Proofmesh server over <data-dir> and its tools, and with
//     --with-skill also the plugin's skill appended to its system prompt, as installing the plugin would give it.
// A question set: { "questions": [{ "id", "question", "expected_facts": [string | string[]] }] }. A question is correct when every
// expected fact appears in the answer (for a list, any one of its alternatives), compared case-insensitively on whitespace-collapsed
// text: a proxy a reader can check by hand, not a judgment.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }

export function score(set, session) {
  if (!Array.isArray(set.questions)) throw new Error('question set has no questions array')
  if (!Array.isArray(session.answers)) throw new Error(`session ${session.session ?? '?'} has no answers array`)
  const byId = new Map(session.answers.map((a) => [a.question_id, a]))
  const num = (v) => (typeof v === 'number' ? v : null)
  const rows = set.questions.map((q) => {
    const a = byId.get(q.id)
    const answer = a ? norm(a.answer ?? '') : ''
    const missing = (q.expected_facts ?? []).filter((f) => ![f].flat().some((alt) => answer.includes(norm(alt))))
    return { id: q.id, answered: answer.length > 0, correct: answer.length > 0 && missing.length === 0, missing, turns: num(a?.turns), tool_calls: num(a?.tool_calls), tools: a?.tools ?? null, tokens: num(a?.tokens), cost_usd: num(a?.cost_usd) }
  })
  const sum = (k) => (rows.every((r) => r[k] === null) ? null : Math.round(rows.reduce((n, r) => n + (r[k] ?? 0), 0) * 1e6) / 1e6)
  const tools = rows.every((r) => r.tools === null) ? null : rows.reduce((m, r) => { for (const [k, v] of Object.entries(r.tools ?? {})) m[k] = (m[k] ?? 0) + v; return m }, {})
  return { session: session.session, questions: rows.length, answered: rows.filter((r) => r.answered).length, correct: rows.filter((r) => r.correct).length, turns: sum('turns'), tool_calls: sum('tool_calls'), tools, tokens: sum('tokens'), cost_usd: sum('cost_usd'), rows }
}

const PROMPT = (q) => `Answer this question about the repository in the current directory. Name files and symbols exactly, and answer in at most three sentences.\n\n${q}`

/** One headless session per question and condition; the agent's own JSON result supplies the answer, turns, tokens and cost. */
function runSessions(set, { repo, dataDir, model, budget, agent, skill }) {
  const bin = path.join(import.meta.dirname, '..', '..', 'packages', 'proofmesh', 'bin', 'proofmesh.mjs')
  const conditions = {
    with: { mcp: { mcpServers: { proofmesh: { command: process.execPath, args: [bin, '--data-dir', dataDir, 'mcp'] } } }, tools: 'Read,Grep,Glob,mcp__proofmesh', extra: skill ? ['--append-system-prompt', skill] : [] },
    without: { mcp: { mcpServers: {} }, tools: 'Read,Grep,Glob', extra: [] },
  }
  const sessions = {}
  for (const [name, c] of Object.entries(conditions)) {
    const answers = []
    for (const q of set.questions) {
      const args = ['-p', PROMPT(q.question), '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', JSON.stringify(c.mcp),
        '--allowedTools', c.tools, ...c.extra, '--no-session-persistence', ...(model ? ['--model', model] : []), ...(budget ? ['--max-budget-usd', String(budget)] : [])]
      const r = spawnSync(agent, args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      // The stream's last line is the result; each assistant tool_use before it is one tool call, counted by tool name.
      const lines = r.stdout.split('\n').flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
      const out = lines.findLast((o) => o.type === 'result') ?? { is_error: true, result: '', subtype: `exit ${r.status}` }
      const tools = {}
      for (const o of lines) if (o.type === 'assistant') for (const c of o.message?.content ?? []) if (c.type === 'tool_use') tools[c.name] = (tools[c.name] ?? 0) + 1
      const u = out.usage ?? {}
      const tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((n, k) => n + (u[k] ?? 0), 0)
      answers.push({
        question_id: q.id, answer: out.is_error ? '' : (out.result ?? ''), turns: out.num_turns ?? null, tool_calls: Object.values(tools).reduce((n, k) => n + k, 0), tools,
        denied: out.permission_denials?.length ?? 0, tokens: out.usage ? tokens : null,
        cost_usd: out.total_cost_usd ?? null, duration_ms: out.duration_ms ?? null, error: out.is_error ? (out.subtype ?? `exit ${r.status}`) : null,
      })
      process.stderr.write(`${name} ${q.id}: ${out.num_turns ?? '?'} turns, ${JSON.stringify(tools)}, ${out.is_error ? 'error' : 'answered'}\n`)
    }
    sessions[name] = { session: name, answers }
  }
  return sessions
}

const args = process.argv.slice(2)
let set, results, method = null
if (args[0] === 'sessions') {
  const setFile = args[1], repo = flag(args, '--repo'), dataDir = flag(args, '--data-dir'), out = flag(args, '--out')
  if (!setFile || !repo || !dataDir || !out) { console.error('usage: node bench/eval/run.mjs sessions <set.json> --repo <dir> --data-dir <dir> --out <dir> [--model M] [--budget-usd N] [--agent claude] [--json]'); process.exit(2) }
  set = read(setFile)
  const model = flag(args, '--model'), budget = flag(args, '--budget-usd'), agent = flag(args, '--agent') ?? 'claude'
  const skillFile = path.join(import.meta.dirname, '..', '..', 'packages', 'proofmesh-plugin', 'skills', 'proofmesh', 'SKILL.md')
  const skill = args.includes('--with-skill') ? fs.readFileSync(skillFile, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim() : null
  method = {
    set: path.basename(setFile), questions: set.questions.length, agent, agent_version: spawnSync(agent, ['--version'], { encoding: 'utf8' }).stdout.trim(), model: model ?? 'the agent default',
    budget_usd_per_session: budget ? Number(budget) : null, started_at: new Date().toISOString(),
    conditions: { with: `Read, Grep, Glob and the Proofmesh MCP tools${skill ? ", with the plugin's skill appended to the system prompt" : ''}`, without: 'Read, Grep, Glob' },
    isolation: 'no user-level settings read (no personal plugins or hooks); MCP servers only from the command line; no session persistence',
    correctness: 'every expected fact, or one of its alternatives, appears in the answer, case-insensitive',
  }
  const sessions = runSessions(set, { repo: path.resolve(repo), dataDir: path.resolve(dataDir), model, budget, agent, skill })
  method.finished_at = new Date().toISOString()
  fs.mkdirSync(out, { recursive: true })
  for (const s of Object.values(sessions)) fs.writeFileSync(path.join(out, `${s.session}.json`), JSON.stringify({ ...s, method }, null, 2))
  fs.writeFileSync(path.join(out, 'method.json'), JSON.stringify(method, null, 2))
  results = [score(set, sessions.with), score(set, sessions.without)]
} else {
  const [setFile, withFile, withoutFile] = args.filter((a) => !a.startsWith('--'))
  if (!setFile || !withFile || !withoutFile) {
    console.error('usage: node bench/eval/run.mjs <set.json> <with.json> <without.json> [--json]\n       node bench/eval/run.mjs sessions <set.json> --repo <dir> --data-dir <dir> --out <dir> [--model M] [--budget-usd N] [--json]')
    process.exit(2)
  }
  set = read(setFile)
  const w = read(withFile)
  method = w.method ?? null
  results = [score(set, w), score(set, read(withoutFile))]
}
if (args.includes('--json')) console.log(JSON.stringify({ set: set.name ?? null, method, results }, null, 2))
else {
  console.log(`${set.name ?? 'question set'}: ${set.questions.length} questions`)
  if (method?.agent_version) console.log(`method: ${method.agent} ${method.agent_version}, model ${method.model}, ${method.started_at}; ${method.isolation}`)
  const n = (v) => (v === null ? 'not recorded' : v.toLocaleString('en'))
  for (const r of results) {
    console.log(`${r.session}: ${r.correct}/${r.questions} correct, ${r.answered} answered, turns ${n(r.turns)}, tool calls ${n(r.tool_calls)}, tokens ${n(r.tokens)}, cost ${r.cost_usd === null ? 'not recorded' : `$${r.cost_usd.toFixed(4)}`}`)
    if (r.tools) console.log(`  tools: ${Object.entries(r.tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    for (const row of r.rows.filter((x) => !x.correct)) console.log(`  ${row.id}: ${row.answered ? `missing ${row.missing.map((m) => JSON.stringify(m)).join(', ')}` : 'unanswered'}`)
  }
  console.log('Measured on the sessions given; nothing is inferred about sessions that were not recorded.')
}
