import { expect, mock, test } from 'claude-code/testing'
import type { On, PromptOrigin, SessionInfo } from 'claude-code'

import { REMINDER_HEAD } from './logic'
import { COMMAND, TOOL_NAME } from './register'

const SID = '11111111-2222-3333-4444-555555555555'
const KEY = `goal:${SID}`
const NOW = Date.parse('2026-11-21T12:00:00.000Z')
const MIN = 60_000
const NOTICE: PromptOrigin = { kind: 'task-notification' } as PromptOrigin
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const BASH = { tool: 'Bash', command: 'ls' } as const
/** The tool's wire name as the engine names it under the default plugin name. */
const TOOL = `mcp__goal-refresh__${TOOL_NAME}`
const compaction = (trigger: 'auto' | 'precompute', agentId?: string) =>
  ({ trigger, messages: [{ role: 'user', text: 'hi', toolUses: [] }], ...(agentId === undefined ? {} : { agentId }) }) as never

const goalRow = (attachment: Record<string, unknown>, at: number) =>
  JSON.stringify({ type: 'attachment', timestamp: new Date(at).toISOString(), attachment: { type: 'goal_status', ...attachment } })

/** The engine beneath the plugin, recording what the plugin showed and ran. */
function world(on: On, store: Record<string, unknown> = {}, opts: { dropsPrompts?: boolean; fails?: boolean; plugin?: string } = {}) {
  const clock = mock.clock(on, { now: NOW })
  if (opts.fails) {
    on('store.get', () => {
      throw new Error('store down')
    })
  } else {
    mock.store(on, store)
  }
  const seen = { statuses: [] as (string | undefined)[], toasts: [] as string[], notifies: [] as string[], greps: 0, tools: [] as string[], commands: [] as string[] }
  const transcript = { lines: [] as string[] }

  on('session.id', () => ({ value: SID }))
  on('session.info', () => ({ value: { transcriptPath: '/t/session.jsonl' } as SessionInfo }))
  on('process.run', (_$, e) => {
    if (opts.fails) throw new Error('no grep')
    seen.greps += 1
    expect(e.argv.slice(0, 3)).toEqual(['grep', '-F', '"type":"goal_status"'])
    const hits = transcript.lines.filter(l => l.includes('"type":"goal_status"'))

    return { value: { exitCode: hits.length > 0 ? 0 : 1, stdout: hits.join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_$, e) => (seen.statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_$, e) => (seen.toasts.push(e.text), { value: undefined }))
  on('ui.notify', (_$, e) => (seen.notifies.push(e.text), { value: { isWritten: true } as never }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', (_$, e) => (seen.tools.push(e.name), { value: { tool: `mcp__${opts.plugin ?? 'goal-refresh'}__${e.name}` } }))
  on('command.register', (_$, e) => (seen.commands.push(e.name), { value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ran' }))
  on('prompt.submit', (_$, e) => opts.dropsPrompts ? { drop: 'duplicate' } : { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) })
  on('command.run', () => ({ text: 'core output' }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }], tokensBefore: 100, tokensAfter: 10 }))

  return { clock, seen, transcript }
}

let turnNo = 0
type Commands = { command: { run: (input: never) => Promise<{ text?: string; context?: readonly string[] }> } }
/** A slash command as the person runs it; the engine stamps origin and presentation. */
const cmd = ($: Commands, command: string, args: string) => $.command.run({ command, args } as never)
type Turns = { turn: { start: (input: { text: string; turnId: string; agentId?: string }) => Promise<unknown> } }
const turn = ($: Turns, agentId?: string) =>
  $.turn.start({ text: '', turnId: `t${++turnNo}`, ...(agentId === undefined ? {} : { agentId }) })
const notice = (text = 'task done') => ({ text, wait: false, origin: NOTICE })
const stored = (goal: string, subgoals: string[] = []) => ({ [KEY]: { goal, subgoals, updatedAt: NOW - 60 * MIN, reason: 'set earlier', history: [] } })

test('a session with no goal gets nothing, never reads its transcript after start, and shows no status', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const startGreps = w.seen.greps
  for (let i = 0; i < 30; i++) await turn($)
  await w.clock.advance(120 * MIN)
  const p = await $.prompt.submit(notice())
  const t = await $.tool.call(BASH)

  expect(p.context).toBeUndefined()
  expect(t.context).toBeUndefined()
  expect(startGreps).toBe(1)
  expect(w.seen.greps).toBe(1)
  expect(w.seen.statuses.filter(s => s !== undefined)).toEqual([])
  expect(w.seen.tools).toEqual(['goal_update'])
  expect(w.seen.commands).toEqual([COMMAND])
})

test('a stored goal is reminded once after start, then every 10 turns, never twice in a row', async ($, on) => {
  const w = world(on, stored('Ship v1', ['tests']))
  await $.session.start(START)
  expect(w.seen.statuses.at(-1)).toBe('goal: Ship v1')

  const first = await $.prompt.submit(notice())
  expect(first.context?.[0]?.startsWith(REMINDER_HEAD)).toBe(true)
  expect(first.context?.[0]).toContain('Standing goal: Ship v1')
  expect(first.context?.[0]).toContain('(1) tests')

  // Same turn, nothing in between: no second reminder.
  expect((await $.tool.call(BASH)).context).toBeUndefined()
  expect((await $.prompt.submit(notice())).context).toBeUndefined()

  for (let i = 0; i < 9; i++) await turn($)
  expect((await $.tool.call(BASH)).context).toBeUndefined()
  await turn($)
  const tenth = await $.tool.call(BASH)
  expect(tenth.context?.[0]).toContain('Standing goal: Ship v1')
  expect((await $.tool.call(BASH)).context).toBeUndefined()
})

test('subagent turns and subagent tool calls neither count nor carry the reminder', async ($, on) => {
  const w = world(on, stored('G'))
  await $.session.start(START)
  await $.prompt.submit(notice())
  for (let i = 0; i < 20; i++) await turn($, 'agent-1')
  expect((await $.tool.call({ ...BASH, agentId: 'agent-1' })).context).toBeUndefined()
  expect((await $.tool.call(BASH)).context).toBeUndefined()
  expect(w.seen.greps).toBe(1)
})

test('the time trigger fires after 20 minutes with a turn in between', async ($, on) => {
  const w = world(on, stored('G'))
  await $.session.start(START)
  await $.prompt.submit(notice())
  await w.clock.advance(25 * MIN)
  expect((await $.tool.call(BASH)).context).toBeUndefined()
  await turn($)
  expect((await $.tool.call(BASH)).context?.[0]).toContain('Standing goal: G')
})

test('a compaction owes a refresh at the next chance; a precompute or subagent one does not', async ($, on) => {
  world(on, stored('G'))
  await $.session.start(START)
  await $.prompt.submit(notice())
  await $.session.compact(compaction('precompute'))
  await $.session.compact(compaction('auto', 'agent-1'))
  expect((await $.tool.call(BASH)).context).toBeUndefined()
  await $.session.compact(compaction('auto'))
  expect((await $.tool.call(BASH)).context?.[0]).toContain('Standing goal: G')
})

test('afterCompact false ignores compactions', { options: { afterCompact: false } }, async ($, on) => {
  world(on, stored('G'))
  await $.session.start(START)
  await $.prompt.submit(notice())
  await $.session.compact(compaction('auto'))
  expect((await $.tool.call(BASH)).context).toBeUndefined()
})

test('a dropped prompt gives the reminder back to the next chance', async ($, on) => {
  world(on, stored('G'), { dropsPrompts: true })
  await $.session.start(START)
  const p = await $.prompt.submit(notice())
  expect(p.drop).toBe('duplicate')
  expect((await $.tool.call(BASH)).context?.[0]).toContain('Standing goal: G')
})

test('/goal-refresh set, show, subgoals, history and clear', async ($, on) => {
  const w = world(on)
  await $.session.start(START)

  const set = await cmd($, COMMAND, 'set Keep the VM full')
  expect(set.text).toBe('Goal updated: (none) → "Keep the VM full"')
  expect(set.context?.[0]).toContain('Standing goal: Keep the VM full')
  expect(w.seen.statuses.at(-1)).toBe('goal: Keep the VM full')
  // The command told the model; the next chance in the same turn owes nothing.
  expect((await $.tool.call(BASH)).context).toBeUndefined()

  await cmd($, COMMAND, 'subgoals land PR 12 | rerun evals')
  const show = await cmd($, COMMAND, '')
  expect(show.text).toContain('Standing goal: Keep the VM full')
  expect(show.text).toContain('2. rerun evals')

  const again = await cmd($, COMMAND, 'set Keep the VM full')
  expect(again.text).toBe('No change.')

  const cleared = await cmd($, COMMAND, 'clear')
  expect(cleared.context?.[0]).toContain('cleared')
  expect(w.seen.statuses.at(-1)).toBeUndefined()

  const history = await cmd($, COMMAND, 'history')
  expect(history.text?.split('\n').filter(l => l.includes('command')).length).toBe(3)
  expect(w.seen.toasts).toEqual([])

  await turn($)
  await w.clock.advance(60 * MIN)
  expect((await $.tool.call(BASH)).context).toBeUndefined()

  const usage = await cmd($, COMMAND, 'frob')
  expect(usage.text).toContain('Usage:')
})

test('goal_update: validates, stores, toasts old and new, and logs history', async ($, on) => {
  const w = world(on, stored('Old goal'))
  await $.session.start(START)

  const bad = await $.tool.call({ tool: TOOL, goal: 'New goal' } as never)
  expect(bad.isError === true || bad.deny !== undefined).toBe(true)

  const ok = await $.tool.call({ tool: TOOL, goal: 'New goal', subgoals: ['a', 'b'], reason: 'user said yes' } as never)
  expect(String(ok.result)).toContain('Standing goal: New goal')
  expect(w.seen.toasts).toEqual(['Goal updated: "Old goal" → "New goal" +2 sub-goals'])
  expect(w.seen.notifies).toEqual([])
  expect(w.seen.statuses.at(-1)).toBe('goal: New goal')
  // Its own result told the model: no reminder piggybacks on it or right after.
  expect(ok.context).toBeUndefined()
  expect((await $.tool.call(BASH)).context).toBeUndefined()

  const history = await cmd($, COMMAND, 'history')
  expect(history.text).toContain('tool · user said yes')

  const sub = await $.tool.call({ tool: TOOL, goal: 'x', reason: 'r', agentId: 'agent-1' } as never)
  expect(sub.isError === true || sub.deny !== undefined).toBe(true)
})

test('toasts and notifications follow their options', { options: { showToasts: false, systemNotifications: true, showStatus: false } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, goal: 'G', reason: 'agreed' } as never)
  expect(w.seen.toasts).toEqual([])
  expect(w.seen.notifies).toEqual(['Goal updated: (none) → "G"'])
  expect(w.seen.statuses).toEqual([])
})

test('the history keeps 20 entries and texts are capped', async ($, on) => {
  world(on)
  await $.session.start(START)
  for (let i = 0; i < 25; i++) await $.tool.call({ tool: TOOL, goal: `goal ${i} ${'x'.repeat(2000)}`, reason: `r${i}` } as never)
  const history = await cmd($, COMMAND, 'history')
  expect(history.text?.split('\n').filter(l => l.includes(' · tool')).length).toBe(20)
  const show = await cmd($, COMMAND, 'show')
  expect((show.text ?? '').split('\n')[0]?.length).toBeLessThan(1100)
})

test('a resumed native /goal is mirrored from the transcript, and its met row ends it', async ($, on) => {
  const w = world(on)
  w.transcript.lines = [goalRow({ met: false, sentinel: true, condition: 'all tests pass' }, NOW - MIN)]
  await $.session.start(START)
  await w.clock.settle()
  const p = await $.prompt.submit(notice())
  expect(p.context?.[0]).toContain('Active /goal stop condition: all tests pass')
  expect(w.seen.statuses.at(-1)).toBe('/goal: all tests pass')

  w.transcript.lines.push(goalRow({ met: true, condition: 'all tests pass' }, NOW))
  // Turns re-read the transcript at most every nativeReadMinutes (10).
  await w.clock.advance(10 * MIN)
  await turn($)
  await w.clock.settle()
  for (let i = 0; i < 10; i++) await turn($)
  expect((await $.tool.call(BASH)).context).toBeUndefined()
  expect(w.seen.statuses.at(-1)).toBeUndefined()
})

test('the person typing /goal is seen at once, before the transcript has a row for it', async ($, on) => {
  const w = world(on)
  // An older goal, already met, is the transcript's last row.
  w.transcript.lines = [goalRow({ met: true, condition: 'old' }, NOW - 5 * MIN)]
  await $.session.start(START)
  const ran = await cmd($, 'goal', 'coverage over 90%')
  expect(ran.text).toBe('core output')
  await w.clock.settle()
  expect(w.seen.statuses.at(-1)).toBe('/goal: coverage over 90%')
  const p = await $.prompt.submit(notice())
  expect(p.context?.[0]).toContain('Active /goal stop condition: coverage over 90%')

  await cmd($, 'goal', 'clear')
  await w.clock.settle()
  expect(w.seen.statuses.at(-1)).toBeUndefined()
})

test('mirrorNativeGoal false never reads the transcript', { options: { mirrorNativeGoal: false } }, async ($, on) => {
  const w = world(on)
  w.transcript.lines = [goalRow({ met: false, condition: 'c' }, NOW)]
  await $.session.start(START)
  await cmd($, 'goal', 'c')
  expect((await $.prompt.submit(notice())).context).toBeUndefined()
  expect(w.seen.greps).toBe(0)
})

test('a failing store or transcript read lets everything through', async ($, on) => {
  world(on, {}, { fails: true })
  await $.session.start(START)
  expect((await $.prompt.submit(notice('hello'))).text).toBe('hello')
  expect((await $.tool.call(BASH)).result).toBe('ran')
  const set = await cmd($, COMMAND, 'set G')
  expect(set.text).toContain('failed')
})

test('a native goal re-reads the transcript every 10 minutes, not every turn, and at once after a compaction', async ($, on) => {
  const w = world(on)
  w.transcript.lines = [goalRow({ met: false, condition: 'ship it' }, NOW - MIN)]
  await $.session.start(START)
  await w.clock.settle()
  const afterStart = w.seen.greps
  expect(afterStart).toBe(1)

  for (let i = 0; i < 5; i++) await turn($)
  await w.clock.settle()
  expect(w.seen.greps).toBe(afterStart)

  await w.clock.advance(10 * MIN)
  await turn($)
  await w.clock.settle()
  expect(w.seen.greps).toBe(afterStart + 1)

  // A compaction marks the transcript stale: the very next main turn reads it.
  await $.session.compact(compaction('auto'))
  await turn($)
  await w.clock.settle()
  expect(w.seen.greps).toBe(afterStart + 2)
  await turn($)
  await w.clock.settle()
  expect(w.seen.greps).toBe(afterStart + 2)

  // A subagent's compaction does not.
  await $.session.compact(compaction('auto', 'agent-1'))
  await turn($)
  await w.clock.settle()
  expect(w.seen.greps).toBe(afterStart + 2)
})

test('nativeReadMinutes 0 reads the transcript on every main turn', { options: { nativeReadMinutes: 0 } }, async ($, on) => {
  const w = world(on)
  w.transcript.lines = [goalRow({ met: false, condition: 'ship it' }, NOW - MIN)]
  await $.session.start(START)
  await w.clock.settle()
  const afterStart = w.seen.greps
  for (let i = 0; i < 3; i++) {
    await turn($)
    await w.clock.settle()
  }
  expect(w.seen.greps).toBe(afterStart + 3)
})

test('goal_update clearing the goal tells the model it went through goal_update, not the user', async ($, on) => {
  world(on, stored('Old goal'))
  await $.session.start(START)
  const ok = await $.tool.call({ tool: TOOL, clear: true, reason: 'user agreed to drop it' } as never)
  expect(String(ok.result)).toContain('cleared through goal_update')
  expect(String(ok.result)).not.toContain('by the user')
  const byCommand = await cmd($, COMMAND, 'set G')
  expect(byCommand.context?.[0]).toContain('updated')
  const cleared = await cmd($, COMMAND, 'clear')
  expect(cleared.context?.[0]).toContain('cleared by the user')
})

test('goal_update is answered under the name the engine registered it by, whatever the plugin is called', async ($, on) => {
  const w = world(on, stored('Old goal'), { plugin: 'goal-refresh-demo' })
  await $.session.start(START)

  const ok = await $.tool.call({ tool: `mcp__goal-refresh-demo__${TOOL_NAME}`, goal: 'Demo goal', reason: 'user said yes' } as never)
  expect(ok.result).not.toBe('ran')
  expect(String(ok.result)).toContain('Standing goal: Demo goal')
  expect(w.seen.toasts).toEqual(['Goal updated: "Old goal" → "Demo goal"'])
  expect(ok.context).toBeUndefined()

  // The default plugin's name is not this plugin's tool: it passes through untouched.
  const other = await $.tool.call({ tool: TOOL, goal: 'Other', reason: 'r' } as never)
  expect(other.result).toBe('ran')
  expect(w.seen.statuses.at(-1)).toBe('goal: Demo goal')
})

test('before session.start registers the tool, a goal_update-shaped call passes through', async ($, on) => {
  world(on)
  const early = await $.tool.call({ tool: TOOL, goal: 'G', reason: 'r' } as never)
  expect(early.result).toBe('ran')
})
