import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, tmpDir } from './helpers.js'

const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'bench', 'eval', 'run.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
let env: Record<string, string> = {}
const samples = (f: string) => path.join(ROOT, 'bench', 'eval', 'samples', f)

describe('A12 the evaluation harness reports only what recorded sessions hold', () => {
  it('scores the sample sessions against the question set, as a reader can check by hand', () => {
    const r = run(samples('invoicing-questions.json'), samples('with.json'), samples('without.json'), '--json')
    expect(r.status, r.stderr).toBe(0)
    const { results } = JSON.parse(r.stdout)
    expect(results.map((x: Record<string, unknown>) => ({ ...x, rows: undefined }))).toEqual([
      { session: 'with', questions: 3, answered: 3, correct: 3, turns: null, tool_calls: 5, tools: null, tokens: 3900, cost_usd: null, rows: undefined },
      { session: 'without', questions: 3, answered: 2, correct: 1, turns: null, tool_calls: 13, tools: null, tokens: null, cost_usd: null, rows: undefined },
    ])
    expect(results[1].rows[1]).toMatchObject({ id: 'q2', answered: true, correct: false, missing: ['Intl.NumberFormat'] })
    const text = run(samples('invoicing-questions.json'), samples('with.json'), samples('without.json')).stdout
    expect(text).toMatch(/without: 1\/3 correct, 2 answered, turns not recorded, tool calls 13, tokens not recorded, cost not recorded/)
    expect(text).toMatch(/q3: unanswered/)
    expect(run().status).toBe(2)
  })

  it('A12 sessions mode runs one headless session per question and condition, isolated alike, and measures turns, tokens, cost and correctness', () => {
    const dir = tmpDir('pm-eval-'), log = path.join(dir, 'argv'), out = path.join(dir, 'out'), set = path.join(dir, 'set.json')
    fs.writeFileSync(set, JSON.stringify({ name: 'two', questions: [
      { id: 'a', question: 'Which function does handleInvoice call, and where is it defined?', expected_facts: ['invoiceTotal', 'packages/billing/src/invoice.ts'] },
      { id: 'b', question: 'FAIL on purpose', expected_facts: [['x', 'invoiceTotal']] },
    ] }))
    env = { PATH: `${path.join(import.meta.dirname, 'fake-claude')}:${process.env.PATH}`, CLAUDE_LOG: log }
    const r = run('sessions', set, '--repo', dir, '--data-dir', path.join(dir, 'data'), '--out', out, '--model', 'sonnet', '--json')
    env = {}
    expect(r.status, r.stderr).toBe(0)
    const { method, results } = JSON.parse(r.stdout)
    expect(method).toMatchObject({ agent: 'claude', agent_version: '9.9.9 (Fake Code)', model: 'sonnet', questions: 2, conditions: { with: 'Read, Grep, Glob and the Proofmesh MCP tools', without: 'Read, Grep, Glob' } })
    expect(results.map((x: Record<string, unknown>) => ({ ...x, rows: undefined }))).toEqual([
      { session: 'with', questions: 2, answered: 1, correct: 1, turns: 2, tool_calls: 1, tools: { mcp__proofmesh__find_symbols: 1 }, tokens: 1160, cost_usd: 0.0125, rows: undefined },
      { session: 'without', questions: 2, answered: 1, correct: 0, turns: 6, tool_calls: 3, tools: { Grep: 2, Read: 1 }, tokens: 4390, cost_usd: 0.04, rows: undefined },
    ])
    expect(results[1].rows[0]).toMatchObject({ id: 'a', answered: true, correct: false, missing: ['packages/billing/src/invoice.ts'] })
    expect(JSON.parse(fs.readFileSync(path.join(out, 'with.json'), 'utf8')).answers[1]).toMatchObject({ question_id: 'b', answer: '', error: 'exit 1' })
    expect(fs.existsSync(path.join(out, 'method.json'))).toBe(true)
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    expect(calls).toHaveLength(4)
    for (const c of calls) {
      expect(c).toContain('--output-format stream-json --verbose --setting-sources project,local --strict-mcp-config --mcp-config')
      expect(c).toContain('--no-session-persistence --model sonnet')
    }
    expect(calls.slice(0, 2).every((c) => c.includes('--allowedTools Read,Grep,Glob,mcp__proofmesh') && c.includes('"proofmesh":{"command"'))).toBe(true)
    expect(calls.slice(2).every((c) => c.includes('--allowedTools Read,Grep,Glob --no-session') && c.includes('{"mcpServers":{}}'))).toBe(true)
    // --with-skill appends the plugin's skill to the "with" condition only, and says so in the method.
    fs.writeFileSync(log, '')
    env = { PATH: `${path.join(import.meta.dirname, 'fake-claude')}:${process.env.PATH}`, CLAUDE_LOG: log }
    const skilled = JSON.parse(run('sessions', set, '--repo', dir, '--data-dir', path.join(dir, 'data'), '--out', path.join(dir, 'skilled'), '--with-skill', '--json').stdout)
    env = {}
    expect(skilled.method.conditions.with).toBe("Read, Grep, Glob and the Proofmesh MCP tools, with the plugin's skill appended to the system prompt")
    const skilledCalls = fs.readFileSync(log, 'utf8').trim().split('\n')
    expect(skilledCalls.map((c) => c.includes('--append-system-prompt # Proofmesh'))).toEqual([true, true, false, false])
    // The recorded sessions score the same when read back.
    const again = JSON.parse(run(set, path.join(out, 'with.json'), path.join(out, 'without.json'), '--json').stdout)
    expect(again.results).toEqual(results)
    expect(again.method.agent_version).toBe('9.9.9 (Fake Code)')
  })
})
