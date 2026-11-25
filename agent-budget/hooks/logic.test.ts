import { expect, test } from 'claude-code/testing'

import {
  advance, capTracks, cycleOf, DEFAULT_LIMITS, estimatedCompactAt, FALLBACK_WINDOW, limitsFor, mainCompactAt, subagentCompactAt, IDLE_CYCLE, isStaleHandoff, MAX_TRACKS, nonNegativeOption, positiveOption,
  readThresholds, tracksOf, compacted, compactInstructions, contextTokens, defaultHandoffDir, expandHome, formatK, handoffNote, handoffPath, handoffState, MAIN, MARKER,
  HANDOFF_MARKER, isOwnHandoff, isSessionFolder, newTrack, resolveHandoffDir, resumeNote, rotationNote, SPAWN_RULE, STALE_MS, statusLine, table, withInstructions, withSpawnRule,
} from './logic'
import type { Thresholds } from './logic'
import type { Track } from '../types'

const LIMITS: Thresholds = { warnTokens: 300_000, rotateTokens: 400_000, repeatTokens: 50_000 }
/** The engine's auto-compact point on a 1M window: far past every default threshold, so none is capped. */
const BIG = 967_000
const fresh = (): Track => newTrack('speed', true, 0, BIG)
const at = (tokens: number, more: Partial<Track> = {}): Track => ({ ...fresh(), tokens, ...more })

test('context size is uncached input plus both cache counts', () => {
  const usage = { input_tokens: 1200, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 8_800 }
  expect(contextTokens(usage)).toBe(260_000)
})

test('below the warning nothing happens', () => {
  const { track, event } = advance(fresh(), 299_999, LIMITS)
  expect(event).toBeNull()
  expect(track).toEqual(at(299_999))
})

test('crossing the warning fires once', () => {
  const first = advance(at(250_000), 300_000, LIMITS)
  expect(first.event).toBe('warn')
  expect(first.track.hasWarned).toBe(true)
  expect(first.track.isNotePending).toBe(false)
  expect(advance(first.track, 340_000, LIMITS).event).toBeNull()
  expect(advance(first.track, 399_999, LIMITS).event).toBeNull()
})

test('crossing rotation raises the note, from the warning or straight past it', () => {
  const warned = advance(fresh(), 310_000, LIMITS).track
  const rotated = advance(warned, 400_000, LIMITS)
  expect(rotated.event).toBe('rotate')
  expect(rotated.track).toEqual(at(400_000, { hasWarned: true, notedAt: 400_000, isNotePending: true }))

  const jumped = advance(fresh(), 450_000, LIMITS)
  expect(jumped.event).toBe('rotate')
  expect(jumped.track.hasWarned).toBe(true)
})

test('the note repeats once per further 50k, not on every step', () => {
  let track = advance(fresh(), 405_000, LIMITS).track
  track = { ...track, isNotePending: false }
  for (const tokens of [410_000, 430_000, 454_999]) {
    const step = advance(track, tokens, LIMITS)
    expect(step.event).toBeNull()
    expect(step.track.isNotePending).toBe(false)
    track = step.track
  }
  const repeat = advance(track, 455_000, LIMITS)
  expect(repeat.event).toBe('rotate')
  expect(repeat.track.notedAt).toBe(455_000)
  expect(repeat.track.isNotePending).toBe(true)
  expect(advance(repeat.track, 480_000, LIMITS).event).toBeNull()
  expect(advance(repeat.track, 505_000, LIMITS).event).toBe('rotate')
})

test('a dip under rotation and back does not repeat the note early', () => {
  const noted = at(420_000, { hasWarned: true, notedAt: 420_000 })
  const dipped = advance(noted, 380_000, LIMITS)
  expect(dipped.event).toBeNull()
  expect(advance(dipped.track, 430_000, LIMITS).event).toBeNull()
})

test('a context that falls by more than half starts over', () => {
  const noted = at(460_000, { hasWarned: true, notedAt: 455_000, isNotePending: true })
  const compacted = advance(noted, 120_000, LIMITS)
  expect(compacted.event).toBeNull()
  expect(compacted.track).toEqual(at(120_000))
  expect(advance(compacted.track, 300_000, LIMITS).event).toBe('warn')
  expect(advance(compacted.track, 400_000, LIMITS).event).toBe('rotate')

  // Exactly half is not "more than half": the flags stand.
  expect(advance(noted, 230_000, LIMITS).track.hasWarned).toBe(true)
})

test('status line names the largest live subagent and marks it past rotation', () => {
  const agents = {
    [MAIN]: newTrack(MAIN, true, 0, BIG),
    a1: at(312_000, { label: 'speed' }),
    a2: at(90_000, { label: 'grader' }),
    fork: at(500_000, { label: 'fork', isListed: false }),
    old: at(450_000, { label: 'old', at: -STALE_MS - 1 }),
  }
  agents[MAIN].tokens = 600_000
  expect(statusLine(agents, LIMITS, 0)).toBe('agents: 2 · max 312k (speed) !')
  expect(statusLine({ a1: at(412_000) }, LIMITS, 0)).toBe('agents: 1 · max 412k (speed) !! ROTATE')
  expect(statusLine({ a2: at(90_000, { label: 'grader' }) }, LIMITS, 0)).toBe('agents: 1 · max 90k (grader)')
  expect(statusLine({ [MAIN]: at(600_000) }, LIMITS, 0)).toBeUndefined()
})

test('the table lists every agent, largest first', () => {
  const text = table({ a2: at(90_000, { label: 'grader' }), a1: at(412_000), f: at(5_000, { isListed: false }) }, LIMITS, 120_000)
  const lines = text.split('\n')
  expect(lines[0]).toBe('warn 300k, rotate 400k, each capped at 60% and 75% of the agent\'s auto-compact point')
  expect(lines[2]).toContain('412k  ROTATE')
  expect(lines[2]).toContain('2m ago  speed  [a1]')
  expect(lines[3]).toContain('90k  ok')
  expect(lines[4]).toContain('untracked')
  expect(table({}, LIMITS, 0)).toContain('no agent has made a request yet')
})

test('the note states the size, the threshold and the three asks', () => {
  const note = rotationNote(412_345, LIMITS)
  expect(note).toContain('about 412k tokens')
  expect(note).toContain('400k rotation threshold')
  expect(note).toContain('at most 60 lines')
  expect(note).toContain('unmerged branches')
  expect(note).toContain('and stop')
  expect(formatK(299_600)).toBe('300k')
})

test('the standing rule is appended once and is one sentence naming the marker', () => {
  const once = withSpawnRule('Read a.txt.')
  expect(once).toBe(`Read a.txt.\n\n${SPAWN_RULE}`)
  expect(withSpawnRule(once)).toBe(once)
  expect(withSpawnRule(`Obey any ${MARKER} note. Read a.txt.`)).toBe(`Obey any ${MARKER} note. Read a.txt.`)
  expect(SPAWN_RULE).toContain('at most 60 lines')
  expect(SPAWN_RULE.split('\n')).toHaveLength(1)
  expect(rotationNote(412_000, LIMITS).startsWith(MARKER)).toBe(true)
})

test('main\'s handoff path is one file per session, under a folder that cannot be escaped', () => {
  const env = { configDir: '/home/me/.claude-alt', home: '/home/me' }
  const fallback = { dir: '/home/me/.claude-alt/handoffs', isDefault: true }
  expect(resolveHandoffDir(undefined, env)).toEqual(fallback)
  expect(resolveHandoffDir('', env)).toEqual(fallback)
  expect(resolveHandoffDir('relative/dir', env)).toEqual(fallback)
  expect(resolveHandoffDir('/a/../b', env)).toEqual(fallback)
  expect(resolveHandoffDir('~/../b', env)).toEqual(fallback)
  expect(resolveHandoffDir(' /data/h// ', env)).toEqual({ dir: '/data/h', isDefault: false })
  expect(resolveHandoffDir('~/notes/h/', env)).toEqual({ dir: '/home/me/notes/h', isDefault: false })
  // Naming the default folder outright is still the default folder, for legacy pruning.
  expect(resolveHandoffDir('~/.claude-alt/handoffs', env)).toEqual(fallback)
})

test('the default handoff folder is in Claude\'s config folder: CLAUDE_CONFIG_DIR, else ~/.claude', () => {
  // A custom CLAUDE_CONFIG_DIR keeps the folder in it: ~/.claude-custom/handoffs.
  expect(defaultHandoffDir({ configDir: '/Users/me/.claude-custom', home: '/Users/me' })).toBe('/Users/me/.claude-custom/handoffs')
  expect(defaultHandoffDir({ configDir: '~/.claude-custom/', home: '/Users/me/' })).toBe('/Users/me/.claude-custom/handoffs')
  expect(defaultHandoffDir({ configDir: undefined, home: '/Users/me' })).toBe('/Users/me/.claude/handoffs')
  expect(defaultHandoffDir({ configDir: '', home: '/Users/me' })).toBe('/Users/me/.claude/handoffs')
  expect(defaultHandoffDir({ configDir: 'relative', home: '/Users/me' })).toBe('/Users/me/.claude/handoffs')
  expect(defaultHandoffDir({})).toBe('/tmp/.claude/handoffs')
  expect(expandHome('~', '/h')).toBe('/h')
  expect(expandHome('~x/y', '/h')).toBe('~x/y')
  expect(expandHome('~/y', undefined)).toBe('~/y')
  expect(handoffPath('/h', 'abc-123')).toBe('/h/abc-123/main.md')
  expect(handoffPath('/h', '../x/y')).toBe('/h/_x_y/main.md')
})

test('the handoff is fresh only when written since the note', () => {
  expect(handoffState(null, 100)).toBe('missing')
  expect(handoffState(100, 100)).toBe('fresh')
  expect(handoffState(99, 100)).toBe('earlier')
  expect(handoffState(500, null)).toBe('earlier')
})

test('the handoff note asks for the file and an in-place compaction, never a rotation', () => {
  const note = handoffNote(412_000, LIMITS, '/h/s/main.md')
  expect(note.startsWith(MARKER)).toBe(true)
  expect(note).toContain('about 412k tokens, past the 400k handoff threshold')
  expect(note).toContain('write your handoff to /h/s/main.md')
  expect(note).toContain('compacted in place')
  expect(note).not.toMatch(/rotat|spawn|replacement|lead/i)
})

test('compaction instructions point at the file unless it is missing, and are appended once', () => {
  expect(compactInstructions('/h/main.md', 'missing')).toBeUndefined()
  expect(compactInstructions('/h/main.md', 'fresh')).toContain('"Read /h/main.md first: it is your handoff from before this compaction."')
  expect(compactInstructions('/h/main.md', 'earlier')).toContain('may be out of date')
  expect(withInstructions(undefined, 'B')).toBe('B')
  expect(withInstructions('A', undefined)).toBe('A')
  expect(withInstructions('A', 'B')).toBe('A\n\nB')
  expect(withInstructions('A\n\nB', 'B')).toBe('A\n\nB')
})

test('the resume note says what to read first, by what the compaction found', () => {
  expect(resumeNote('/h/main.md', 'fresh')).toContain('Read /h/main.md first')
  expect(resumeNote('/h/main.md', 'earlier')).toContain('may be out of date')
  expect(resumeNote('/h/main.md', 'missing')).toContain('no handoff file was written to /h/main.md')
})

test('a compacted track is warned and noted afresh', () => {
  expect(compacted(at(450_000, { hasWarned: true, notedAt: 420_000, isNotePending: true }))).toEqual(at(450_000))
})

test('a fall to exactly half is not a compaction; just under half is', () => {
  const noted = at(420_000, { hasWarned: true, notedAt: 420_000 })
  expect(advance(noted, 210_000, LIMITS).track.notedAt).toBe(420_000)
  expect(advance(noted, 209_999, LIMITS).track.notedAt).toBeNull()
})

test('bad threshold options fall back to the defaults; numeric strings are read', () => {
  expect(readThresholds({})).toEqual(DEFAULT_LIMITS)
  expect(readThresholds({ warnTokens: 0, rotateTokens: -5, repeatTokens: Number.NaN })).toEqual(DEFAULT_LIMITS)
  expect(readThresholds({ warnTokens: 'abc', rotateTokens: null, repeatTokens: true })).toEqual(DEFAULT_LIMITS)
  expect(readThresholds({ warnTokens: Number.POSITIVE_INFINITY, rotateTokens: '', repeatTokens: {} })).toEqual(DEFAULT_LIMITS)
  expect(readThresholds({ warnTokens: '1000', rotateTokens: 2000, repeatTokens: 1 })).toEqual({ warnTokens: 1000, rotateTokens: 2000, repeatTokens: 1 })
  expect(positiveOption(0.5, 9)).toBe(0.5)
  expect(nonNegativeOption(0, 30)).toBe(0)
  expect(nonNegativeOption(-1, 30)).toBe(30)
  expect(nonNegativeOption('x', 30)).toBe(30)
})

test('garbage held state reads as no tracks and an idle cycle', () => {
  expect(tracksOf(undefined)).toEqual({})
  expect(tracksOf('garbage')).toEqual({})
  expect(tracksOf([at(1)])).toEqual({})
  const good = at(5_000)
  expect(tracksOf({ a: good, b: { tokens: 'lots' }, c: null, d: { ...good, notedAt: 'x' } })).toEqual({ a: good })

  expect(cycleOf(undefined)).toEqual(IDLE_CYCLE)
  expect(cycleOf({ phase: 'weird' })).toEqual(IDLE_CYCLE)
  expect(cycleOf({ phase: 'asked', askedAt: 'x', attempts: Number.NaN, resumeNote: 3 })).toEqual({
    phase: 'asked', askedAt: null, attempts: 0, resumeNote: null,
  })
  const held = { phase: 'compacting' as const, askedAt: 7, attempts: 2, resumeNote: 'read it' }
  expect(cycleOf(held)).toEqual(held)
})

test('tracks are capped, dropping the longest idle first, never main, the stepped agent or a waiting note before others', () => {
  const agents: Record<string, Track> = { main: at(1, { at: 0 }) }
  for (let n = 0; n < MAX_TRACKS + 5; n++) {
    agents[`a${n}`] = at(1, { at: n + 1 })
  }
  agents.a0 = { ...(agents.a0 as Track), isNotePending: true }
  const capped = capTracks(agents, MAX_TRACKS, 'a1')
  const ids = Object.keys(capped)
  expect(ids).toHaveLength(MAX_TRACKS)
  expect(ids).toContain('main')
  expect(ids).toContain('a0')
  expect(ids).toContain('a1')
  // The six idle longest without a note went: a2..a7.
  expect(['a2', 'a3', 'a4', 'a5', 'a6', 'a7'].some(id => ids.includes(id))).toBe(false)
  expect(ids).toContain('a8')
  // At or under the cap nothing changes.
  const few = { main: at(1), a: at(2) }
  expect(capTracks(few, MAX_TRACKS, 'a')).toBe(few)
})

test('a handoff is stale only past the age, and never with the age at 0', () => {
  const DAY = 24 * 60 * 60_000
  const now = 100 * DAY
  expect(isStaleHandoff(now - 30 * DAY, now, 30)).toBe(false)
  expect(isStaleHandoff(now - 30 * DAY - 1, now, 30)).toBe(true)
  expect(isStaleHandoff(now - 400 * DAY, now, 0)).toBe(false)
  expect(isStaleHandoff(0, now, 30)).toBe(false)
})

test('pruning looks only in folders named like a session id', () => {
  expect(isSessionFolder('0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f405162')).toBe(true)
  for (const name of ['notes', 'session-1', '0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f40516', '0f3c2a1e7b6d4c5e9a8b1d2e3f405162']) {
    expect(isSessionFolder(name)).toBe(false)
  }
})

test('a handoff is this mod\'s by its marker anywhere, and without it only in the default folder', () => {
  expect(isOwnHandoff(`${HANDOFF_MARKER}\n# Goal`, false)).toBe(true)
  expect(isOwnHandoff(`\uFEFF\n  ${HANDOFF_MARKER}\n# Goal`, false)).toBe(true)
  expect(isOwnHandoff('# Chapter 3', false)).toBe(false)
  expect(isOwnHandoff('', false)).toBe(false)
  expect(isOwnHandoff('# Goal written before the marker', true)).toBe(true)
  expect(handoffNote(412_000, LIMITS, '/h/s/main.md')).toContain(`its first line exactly ${HANDOFF_MARKER}`)
})

// The auto-compact points below stand for the engine's: 167k on a 200k window, 967k on a 1M one.
test('on a 200k window the handoff comes at 75% and the warning at 60% of the auto-compact point', () => {
  expect(limitsFor(LIMITS, 167_000)).toEqual({ warnTokens: 100_200, rotateTokens: 125_250, repeatTokens: 50_000 })
  const { track, event } = advance(fresh(), 126_000, limitsFor(LIMITS, 167_000))
  expect(event).toBe('rotate')
  expect(track.tokens).toBeLessThan(167_000)
})

test('on a 1M window the set thresholds stand', () => {
  expect(limitsFor(LIMITS, 967_000)).toEqual(LIMITS)
  expect(limitsFor({ warnTokens: 700_000, rotateTokens: 900_000, repeatTokens: 50_000 }, 967_000)).toEqual({
    warnTokens: 580_200, rotateTokens: 725_250, repeatTokens: 50_000,
  })
})

test('a set threshold past the cap is capped, one under it stands', () => {
  const set = { warnTokens: 450_000, rotateTokens: 500_000, repeatTokens: 10_000 }
  expect(limitsFor(set, 167_000)).toEqual({ warnTokens: 100_200, rotateTokens: 125_250, repeatTokens: 10_000 })
  expect(limitsFor({ warnTokens: 50_000, rotateTokens: 90_000, repeatTokens: 10_000 }, 167_000)).toEqual({
    warnTokens: 50_000, rotateTokens: 90_000, repeatTokens: 10_000,
  })
})

test('an unknown window caps as the fallback window would', () => {
  expect(FALLBACK_WINDOW).toBe(200_000)
  expect(estimatedCompactAt(undefined)).toBe(160_000)
  expect(limitsFor(LIMITS, null)).toEqual({ warnTokens: 96_000, rotateTokens: 120_000, repeatTokens: 50_000 })
})

test('main\'s auto-compact point: the engine\'s threshold, else the window it would run out of, else an estimate', () => {
  const on = { autoCompactThreshold: 167_000, isAutoCompactEnabled: true, rawMaxTokens: 200_000 }
  expect(mainCompactAt({ window: 200_000, breakdown: on })).toBe(167_000)
  // Auto-compaction off: the window itself is the wall.
  expect(mainCompactAt({ window: 200_000, breakdown: { isAutoCompactEnabled: false, rawMaxTokens: 200_000 } })).toBe(200_000)
  // No breakdown: estimated from the window.
  expect(mainCompactAt({ window: 1_000_000 })).toBe(800_000)
  expect(mainCompactAt({ window: 200_000 })).toBe(160_000)
  // Nothing usable: the fallback.
  expect(mainCompactAt(undefined)).toBe(160_000)
  expect(mainCompactAt({ window: 0, breakdown: { autoCompactThreshold: Number.NaN, rawMaxTokens: -1 } })).toBe(160_000)
})

test('a subagent\'s point is estimated from its own window, lowered by a compaction window set for the session', () => {
  expect(subagentCompactAt(200_000, undefined)).toBe(160_000)
  expect(subagentCompactAt(1_000_000, undefined)).toBe(800_000)
  expect(subagentCompactAt(1_000_000, 300_000)).toBe(240_000)
  expect(subagentCompactAt(200_000, 300_000)).toBe(160_000)
  expect(subagentCompactAt(undefined, undefined)).toBe(160_000)
})

test('a held track with no or a bad auto-compact point reads as unknown', () => {
  const { compactAt: _, ...old } = at(5_000)
  expect(tracksOf({ a: old }).a?.compactAt).toBeNull()
  expect(tracksOf({ a: { ...old, compactAt: 'x' } }).a?.compactAt).toBeNull()
  expect(tracksOf({ a: { ...old, compactAt: 167_000 } }).a?.compactAt).toBe(167_000)
})

test('status line and table judge each agent by its own capped thresholds', () => {
  const small = at(130_000, { label: 'small', compactAt: 167_000 })
  expect(statusLine({ s: small }, LIMITS, 0)).toBe('agents: 1 · max 130k (small) !! ROTATE')
  const lines = table({ s: small, b: at(130_000, { label: 'big', compactAt: 967_000 }) }, LIMITS, 0).split('\n')
  expect(lines[0]).toBe('warn 300k, rotate 400k, each capped at 60% and 75% of the agent\'s auto-compact point')
  expect(lines.find(line => line.includes('small'))).toContain('ROTATE')
  expect(lines.find(line => line.includes('small'))).toContain('hand off at 125k')
  expect(lines.find(line => line.includes('big'))).toContain('ok')
  expect(lines.find(line => line.includes('big'))).toContain('hand off at 400k')
})
