import { describe, expect, test } from 'claude-code/testing'

import {
  GOAL_MAX,
  HISTORY_MAX,
  REMINDER_HEAD,
  SUBGOALS_MAX,
  applyUpdate,
  buildReminder,
  changeContext,
  clip,
  freshRefresh,
  historyText,
  isDue,
  isNativeReadDue,
  markGiven,
  nativeFromCommand,
  nativeFromTranscript,
  parseCommand,
  parseConfig,
  parseRecord,
  parseToolInput,
  pickNative,
  statusText,
  toastText,
} from './logic'
import type { Config, GoalRecord } from './logic'

const NOW = 1_700_000_000_000
const MIN = 60_000
const CFG: Config = parseConfig({})

const rec = (goal: string, subgoals: string[] = [], updatedAt = NOW): GoalRecord => ({
  goal,
  subgoals,
  updatedAt,
  reason: '',
  history: [],
})

describe('parseConfig', () => {
  test('defaults', () => {
    expect(CFG).toEqual({
      everyTurns: 10,
      afterCompact: true,
      minIntervalMs: 20 * MIN,
      mirrorNative: true,
      nativeReadMs: 10 * MIN,
      showStatus: true,
      showToasts: true,
      systemNotifications: false,
    })
  })

  test('bad values fall back one by one; zero is kept', () => {
    const c = parseConfig({ everyTurns: 'x', minIntervalMinutes: 0, showToasts: 'no', afterCompact: false, everyTurnz: 3 })
    expect(c.everyTurns).toBe(10)
    expect(c.minIntervalMs).toBe(0)
    expect(c.showToasts).toBe(true)
    expect(c.afterCompact).toBe(false)
    expect(parseConfig({ everyTurns: -4, minIntervalMinutes: NaN }).everyTurns).toBe(10)
    expect(parseConfig({ everyTurns: 3.7 }).everyTurns).toBe(3)
    expect(parseConfig(undefined).everyTurns).toBe(10)
    expect(parseConfig({ nativeReadMinutes: 0 }).nativeReadMs).toBe(0)
    expect(parseConfig({ nativeReadMinutes: -1 }).nativeReadMs).toBe(10 * MIN)
  })
})

describe('isNativeReadDue', () => {
  test('first read, a stale mark, or the interval passing makes a read due', () => {
    expect(isNativeReadDue(null, false, NOW, 10 * MIN)).toBe(true)
    expect(isNativeReadDue(NOW, false, NOW + 9 * MIN, 10 * MIN)).toBe(false)
    expect(isNativeReadDue(NOW, true, NOW + MIN, 10 * MIN)).toBe(true)
    expect(isNativeReadDue(NOW, false, NOW + 10 * MIN, 10 * MIN)).toBe(true)
  })

  test('an interval of 0 reads on every turn', () => {
    expect(isNativeReadDue(NOW, false, NOW, 0)).toBe(true)
  })
})

describe('changeContext', () => {
  test('a clear names who cleared it: the person by command, the model by goal_update', () => {
    const none = { goal: '', subgoals: [] }
    expect(changeContext(none, 'command')).toBe('[goal-refresh] The standing goal was cleared by the user (/goal-refresh clear).')
    expect(changeContext(none, 'tool')).toBe('[goal-refresh] The standing goal was cleared through goal_update.')
    expect(changeContext(none, 'tool')).not.toContain('by the user')
  })

  test('an update lists the goal and sub-goals whoever made it', () => {
    const text = changeContext({ goal: 'G', subgoals: ['a'] }, 'tool')
    expect(text).toContain('The standing goal was updated.')
    expect(text).toContain('Standing goal: G')
    expect(text).toContain('(1) a')
  })
})

describe('clip', () => {
  test('flattens whitespace and caps with an ellipsis', () => {
    expect(clip('  a\n\n b  ', 10)).toBe('a b')
    expect(clip('abcdefghij', 5)).toBe('abcd…')
    expect(clip(42, 5)).toBe('')
  })
})

describe('parseRecord', () => {
  test('junk is null, and fields are capped', () => {
    expect(parseRecord(undefined)).toBeNull()
    expect(parseRecord('x')).toBeNull()
    const r = parseRecord({ goal: 'g'.repeat(GOAL_MAX + 50), subgoals: Array(20).fill('s'), history: 'nope' })
    expect(r?.goal.length).toBe(GOAL_MAX)
    expect(r?.subgoals.length).toBe(SUBGOALS_MAX)
    expect(r?.history).toEqual([])
    expect(r?.updatedAt).toBe(0)
  })

  test('drops non-object history entries and keeps the last 20', () => {
    const history = [null, 3, ...Array.from({ length: 30 }, (_, i) => ({ at: i, by: 'tool', reason: `r${i}`, from: {}, to: { goal: `g${i}` } }))]
    const r = parseRecord({ goal: 'g', history })
    expect(r?.history.length).toBe(HISTORY_MAX)
    expect(r?.history.at(-1)?.to.goal).toBe('g29')
  })
})

describe('applyUpdate', () => {
  test('a goal replaces the goal and keeps sub-goals; history records old and new', () => {
    const a = applyUpdate(rec('old', ['s1']), { goal: 'new', reason: 'user agreed' }, NOW, 'tool')
    expect(a.isChanged).toBe(true)
    expect(a.record.goal).toBe('new')
    expect(a.record.subgoals).toEqual(['s1'])
    expect(a.record.history).toEqual([{ at: NOW, by: 'tool', reason: 'user agreed', from: { goal: 'old', subgoals: ['s1'] }, to: { goal: 'new', subgoals: ['s1'] } }])
  })

  test('subgoals replace the list; clear empties both', () => {
    expect(applyUpdate(rec('g', ['a']), { subgoals: ['b', ' ', 'c'] }, NOW, 'command').record.subgoals).toEqual(['b', 'c'])
    const cleared = applyUpdate(rec('g', ['a']), { clear: true, goal: 'ignored' }, NOW, 'command')
    expect(cleared.record.goal).toBe('')
    expect(cleared.record.subgoals).toEqual([])
    expect(cleared.record.history.length).toBe(1)
  })

  test('no change writes no history', () => {
    const prev = rec('same', ['x'], 5)
    const a = applyUpdate(prev, { goal: 'same' }, NOW, 'tool')
    expect(a.isChanged).toBe(false)
    expect(a.record).toBe(prev)
  })

  test('history is capped at 20', () => {
    let r: GoalRecord | null = null
    for (let i = 0; i < 25; i++) r = applyUpdate(r, { goal: `g${i}` }, NOW + i, 'tool').record
    expect(r?.history.length).toBe(HISTORY_MAX)
    expect(r?.history[0]?.to.goal).toBe('g5')
  })
})

describe('isDue', () => {
  test('first chance and pending are due', () => {
    expect(isDue(freshRefresh(), NOW, CFG)).toBe(true)
    expect(isDue({ turns: 3, lastTurn: 3, lastAt: NOW, isPending: true }, NOW, CFG)).toBe(true)
  })

  test('never twice with no turn in between, even long after', () => {
    const s = markGiven({ ...freshRefresh(), turns: 4 }, NOW)
    expect(isDue(s, NOW + 999 * MIN, CFG)).toBe(false)
  })

  test('every N turns', () => {
    const s = markGiven({ ...freshRefresh(), turns: 0 }, NOW)
    expect(isDue({ ...s, turns: 9 }, NOW + MIN, CFG)).toBe(false)
    expect(isDue({ ...s, turns: 10 }, NOW + MIN, CFG)).toBe(true)
    expect(isDue({ ...s, turns: 50 }, NOW + MIN, { ...CFG, everyTurns: 0 })).toBe(false)
  })

  test('time interval needs one turn in between', () => {
    const s = markGiven(freshRefresh(), NOW)
    expect(isDue({ ...s, turns: 1 }, NOW + 19 * MIN, CFG)).toBe(false)
    expect(isDue({ ...s, turns: 1 }, NOW + 20 * MIN, CFG)).toBe(true)
    expect(isDue({ ...s, turns: 1 }, NOW + 99 * MIN, { ...CFG, minIntervalMs: 0 })).toBe(false)
  })
})

describe('buildReminder', () => {
  test('null with nothing to remind of', () => {
    expect(buildReminder(null, null, NOW)).toBeNull()
    expect(buildReminder(rec(''), null, NOW)).toBeNull()
  })

  test('goal, sub-goals, age and reason, short', () => {
    const r = { ...rec('Ship v1', ['tests', 'docs'], NOW - 3 * 60 * MIN), reason: 'user agreed' }
    const text = buildReminder(r, null, NOW) ?? ''
    expect(text.startsWith(REMINDER_HEAD)).toBe(true)
    expect(text).toContain('Standing goal: Ship v1')
    expect(text).toContain('Current sub-goals: (1) tests; (2) docs')
    expect(text).toContain('Last updated 3h ago (user agreed).')
    expect(text).toContain('goal_update')
    expect(text.length).toBeLessThan(600)
  })

  test('the native condition alone, or beside a different goal; not repeated when equal', () => {
    expect(buildReminder(null, 'all tests pass', NOW)).toContain('Active /goal stop condition: all tests pass')
    expect(buildReminder(rec('A'), 'B', NOW)).toContain('/goal stop condition: B')
    expect(buildReminder(rec('A'), 'A', NOW)).not.toContain('/goal stop condition')
  })
})

describe('texts', () => {
  test('status truncates; falls back to sub-goal, then native', () => {
    expect(statusText(rec('x'.repeat(100)), null)?.length).toBeLessThanOrEqual(46)
    expect(statusText(rec('', ['first']), null)).toBe('goal: first')
    expect(statusText(null, 'cond')).toBe('/goal: cond')
    expect(statusText(null, null)).toBeUndefined()
  })

  test('toast shows old and new', () => {
    expect(toastText({ goal: 'a', subgoals: [] }, { goal: 'b', subgoals: ['s'] })).toBe('Goal updated: "a" → "b" +1 sub-goal')
    expect(toastText({ goal: '', subgoals: [] }, { goal: 'b', subgoals: [] })).toBe('Goal updated: (none) → "b"')
  })

  test('history lists newest first', () => {
    const r = applyUpdate(applyUpdate(null, { goal: 'one', reason: 'r1' }, NOW, 'command').record, { goal: 'two', reason: 'r2' }, NOW + MIN, 'tool').record
    const text = historyText(r, NOW + 2 * MIN)
    expect(text.indexOf('r2')).toBeLessThan(text.indexOf('r1'))
    expect(historyText(null, NOW)).toContain('No goal changes')
  })
})

describe('parseCommand', () => {
  test('subcommands', () => {
    expect(parseCommand('')).toEqual({ kind: 'show' })
    expect(parseCommand('  set   Ship   v1 ')).toEqual({ kind: 'set', goal: 'Ship   v1' })
    expect(parseCommand('set')).toEqual({ kind: 'usage', error: 'set needs the goal text.' })
    expect(parseCommand('subgoals a | b |  | c')).toEqual({ kind: 'subgoals', subgoals: ['a', 'b', 'c'] })
    expect(parseCommand('subgoals')).toEqual({ kind: 'subgoals', subgoals: [] })
    expect(parseCommand('CLEAR')).toEqual({ kind: 'clear' })
    expect(parseCommand('history')).toEqual({ kind: 'history' })
    expect(parseCommand('frob')).toEqual({ kind: 'usage', error: 'Unknown subcommand "frob".' })
  })
})

describe('native /goal', () => {
  const row = (attachment: Record<string, unknown>, timestamp = '2026-11-08T16:46:34.617Z') =>
    JSON.stringify({ type: 'attachment', timestamp, attachment: { type: 'goal_status', ...attachment } })

  test('the last goal_status row wins; met or failed means none', () => {
    expect(nativeFromTranscript([])).toBeNull()
    expect(nativeFromTranscript([row({ met: false, sentinel: true, condition: 'c1' })])?.condition).toBe('c1')
    expect(nativeFromTranscript([row({ met: false, condition: 'c1' }), row({ met: true, condition: 'c1' })])?.condition).toBeNull()
    expect(nativeFromTranscript([row({ met: false, failed: true, condition: 'c1' })])?.condition).toBeNull()
    expect(nativeFromTranscript([row({ met: false, condition: 'c1' })])?.at).toBe(Date.parse('2026-11-08T16:46:34.617Z'))
  })

  test('skips junk lines and rows that only quote the marker', () => {
    const quoted = JSON.stringify({ type: 'user', message: { content: '"type":"goal_status"' } })
    expect(nativeFromTranscript([row({ met: false, condition: 'c1' }), 'not json', quoted, ''])?.condition).toBe('c1')
  })

  test('/goal args', () => {
    expect(nativeFromCommand('')).toBeUndefined()
    expect(nativeFromCommand(' Clear ')).toBeNull()
    expect(nativeFromCommand('cancel')).toBeNull()
    expect(nativeFromCommand('all tests pass')).toBe('all tests pass')
  })

  test('a transcript row overrides a local set only when as new', () => {
    expect(pickNative(null, null)).toBeNull()
    expect(pickNative(null, { condition: 'r', at: 1 })).toBe('r')
    expect(pickNative({ condition: 'l', at: 10 }, { condition: null, at: 5 })).toBe('l')
    expect(pickNative({ condition: 'l', at: 10 }, { condition: null, at: 10 })).toBeNull()
    expect(pickNative({ condition: null, at: 10 }, null)).toBeNull()
  })
})

describe('parseToolInput', () => {
  test('needs a reason and something to change', () => {
    expect(typeof parseToolInput({ goal: 'g' })).toBe('string')
    expect(typeof parseToolInput({ reason: 'r' })).toBe('string')
    expect(typeof parseToolInput({ reason: 'r', goal: '   ' })).toBe('string')
    expect(typeof parseToolInput({ reason: 'r', subgoals: 'a' })).toBe('string')
  })

  test('valid inputs', () => {
    expect(parseToolInput({ reason: 'r', goal: 'g' })).toEqual({ reason: 'r', goal: 'g' })
    expect(parseToolInput({ reason: 'r', subgoals: ['a', ''] })).toEqual({ reason: 'r', subgoals: ['a'] })
    expect(parseToolInput({ reason: 'r', clear: true, goal: 'x' })).toEqual({ reason: 'r', clear: true })
  })
})
