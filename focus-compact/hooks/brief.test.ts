import { describe, expect, test } from 'claude-code/testing'

import {
  defaultBriefDir, NEW_LOOP, briefPath, findSummary, formatBrief, formatStatus, handoffNote, mainLimits,
  STALE_MS, loopsOf, readLimits, resolveBriefDir, safeSegment, shrinkRatio, step, takeNote, withFocus,
  briefsBeyond, capLoops, DEFAULT_BRIEF_MAX_AGE_DAYS, DEFAULT_KEEP_BRIEFS, entryOf, isLegacySpent, isStaleBrief, loopOf,
  loopsFrom, MAX_SESSIONS, readRetention, sessionKeysToDrop, BRIEF_HEADER, isBriefText, isSessionFolder,
} from './brief'
import type { Message } from './brief'

const LIMITS = { handoffAfter: 3, minShrinkRatio: 0.6, minTokensForRatio: 50_000 }
const message = (role: Message['role'], text: string, handle?: string): Message =>
  handle === undefined ? { role, text } : { role, text, handle }

describe('withFocus', () => {
  test('the focus alone when nothing was typed', () => {
    expect(withFocus('FOCUS', undefined)).toBe('FOCUS')
    expect(withFocus('FOCUS', '  ')).toBe('FOCUS')
  })

  test('the user text verbatim, after the focus', () => {
    const made = withFocus('FOCUS', ' keep the  seed210 plan\n') ?? ''

    expect(made.startsWith('FOCUS\n')).toBe(true)
    expect(made.endsWith(' keep the  seed210 plan\n')).toBe(true)
  })

  test('no focus configured leaves the instructions as they were', () => {
    expect(withFocus('  ', 'mine')).toBe('mine')
    expect(withFocus('', undefined)).toBeUndefined()
  })

  test('a focus already in the instructions is not repeated', () => {
    expect(withFocus('FOCUS', 'FOCUS and more')).toBe('FOCUS and more')
  })
})

describe('findSummary', () => {
  const before = [message('user', 'build it', 'h1'), message('assistant', 'ok', 'h2'), message('user', 'next', 'h3')]

  test('the first message the transcript did not hold', () => {
    expect(findSummary(before, [message('user', 'SUMMARY'), message('user', 'next', 'h3')])).toBe('SUMMARY')
    expect(findSummary(before, [message('user', 'SUMMARY', 'new'), message('user', 'next', 'h3')])).toBe('SUMMARY')
  })

  test('a user-role message is preferred, an empty one passed over', () => {
    expect(findSummary(before, [message('assistant', 'ack'), message('user', ''), message('user', 'SUMMARY')])).toBe('SUMMARY')
    expect(findSummary(before, [message('assistant', 'ONLY')])).toBe('ONLY')
  })

  test('none when every message was kept', () => {
    expect(findSummary(before, before.slice(1))).toBeUndefined()
    expect(findSummary(before, [])).toBeUndefined()
  })
})

describe('shrinkRatio and readLimits', () => {
  test('null unless both counts are usable', () => {
    expect(shrinkRatio(100_000, 30_000)).toBe(0.3)
    expect(shrinkRatio(undefined, 30_000)).toBe(null)
    expect(shrinkRatio(100_000, undefined)).toBe(null)
    expect(shrinkRatio(0, 0)).toBe(null)
  })

  test('bad option values fall back to the defaults', () => {
    expect(readLimits(5, 0.5, 1_000)).toEqual({ handoffAfter: 5, minShrinkRatio: 0.5, minTokensForRatio: 1_000 })
    expect(readLimits('2', '0.9', '0')).toEqual({ handoffAfter: 2, minShrinkRatio: 0.9, minTokensForRatio: 0 })
    expect(readLimits(0, 0, -1)).toEqual(LIMITS)
    expect(readLimits(undefined, 7, undefined)).toEqual(LIMITS)
    expect(readLimits('x', Number.NaN, 'y')).toEqual(LIMITS)
    // Number() reads these as 0 or 1; none of them is a value the person set.
    expect(readLimits(true, null, null)).toEqual(LIMITS)
    expect(readLimits('', '', '')).toEqual(LIMITS)
    expect(readLimits({}, [], false)).toEqual(LIMITS)
  })

  test('the limits at their exact edges', () => {
    expect(readLimits(1, 1, 0)).toEqual({ handoffAfter: 1, minShrinkRatio: 1, minTokensForRatio: 0 })
    expect(readLimits(0.99, 1.01, -0.01)).toEqual(LIMITS)
    expect(readLimits(2.7, 0.5, 1)).toEqual({ handoffAfter: 2, minShrinkRatio: 0.5, minTokensForRatio: 1 })
  })

  test('retention falls back on bad values, and 0 is kept as off', () => {
    const DEFAULT = { keepBriefs: DEFAULT_KEEP_BRIEFS, briefMaxAgeDays: DEFAULT_BRIEF_MAX_AGE_DAYS }
    expect(readRetention(undefined, undefined)).toEqual(DEFAULT)
    expect(readRetention(-1, -1)).toEqual(DEFAULT)
    expect(readRetention('x', null)).toEqual(DEFAULT)
    expect(readRetention(0, 0)).toEqual({ keepBriefs: 0, briefMaxAgeDays: 0 })
    expect(readRetention('5.9', '1.5')).toEqual({ keepBriefs: 5, briefMaxAgeDays: 1.5 })
  })
})

describe('step', () => {
  test('escalates at the count, once', () => {
    const one = step(NEW_LOOP, 0.2, '/b/1', LIMITS, 100_000)
    const two = step(one.loop, 0.2, '/b/2', LIMITS, 100_000)
    const three = step(two.loop, 0.2, '/b/3', LIMITS, 100_000)

    expect([one.escalation, two.escalation, three.escalation]).toEqual([undefined, undefined, 'count'])
    expect(three.loop).toEqual({ count: 3, lastRatio: 0.2, lastBrief: '/b/3', hasEscalated: true, pendingNote: null })
  })

  test('escalates on a poor ratio at the first compaction, and not again while it stays poor', () => {
    const one = step(NEW_LOOP, 0.61, null, LIMITS, 100_000)
    const two = step(one.loop, 0.9, null, LIMITS, 100_000)

    expect(one.escalation).toBe('ratio')
    expect(two.escalation).toBeUndefined()
    expect(two.loop.hasEscalated).toBe(true)
  })

  test('a ratio at the limit is not poor', () => {
    expect(step(NEW_LOOP, 0.6, null, LIMITS, 100_000).escalation).toBeUndefined()
  })

  test('a proper shrink re-arms without escalating, and the next poor one escalates again', () => {
    const poor = step(NEW_LOOP, 0.8, null, LIMITS, 100_000)
    const good = step(poor.loop, 0.3, null, LIMITS, 100_000)
    const again = step(good.loop, 0.8, null, LIMITS, 100_000)

    expect(good.escalation).toBeUndefined()
    expect(good.loop.hasEscalated).toBe(false)
    expect(again.escalation).toBe('ratio')
  })

  test('absent tokens never escalate on ratio and never re-arm', () => {
    const one = step(NEW_LOOP, null, null, LIMITS, 100_000)
    const escalated = step({ ...NEW_LOOP, count: 5, hasEscalated: true }, null, null, LIMITS, 100_000)

    expect(one.escalation).toBeUndefined()
    expect(escalated.loop.hasEscalated).toBe(true)
  })

  test('a small conversation is not judged on its ratio, at the limit it is', () => {
    expect(step(NEW_LOOP, 1.18, null, LIMITS, 3_487).escalation).toBeUndefined()
    expect(step(NEW_LOOP, 0.9, null, LIMITS, 49_999).escalation).toBeUndefined()
    expect(step(NEW_LOOP, 0.9, null, LIMITS, undefined).escalation).toBeUndefined()
    expect(step(NEW_LOOP, 0.9, null, LIMITS, 50_000).escalation).toBe('ratio')
    expect(step(NEW_LOOP, 1.18, null, LIMITS, 3_487).loop.lastRatio).toBe(1.18)
  })

  test('a small conversation still counts, and its good ratio does not re-arm', () => {
    const two = { ...NEW_LOOP, count: 2 }
    const escalated = { ...NEW_LOOP, count: 4, hasEscalated: true }

    expect(step(two, 0.9, null, LIMITS, 1_000).escalation).toBe('count')
    expect(step(escalated, 0.1, null, LIMITS, 1_000).loop.hasEscalated).toBe(true)
  })

  test('keeps the last brief when this compaction wrote none', () => {
    expect(step({ ...NEW_LOOP, lastBrief: '/b/1' }, 0.1, null, LIMITS, 100_000).loop.lastBrief).toBe('/b/1')
  })
})

describe('takeNote', () => {
  test('takes the waiting note of one loop, once, and tolerates a loop stored before notes existed', () => {
    const loops = { main: { ...NEW_LOOP, pendingNote: 'NOTE' }, other: { ...NEW_LOOP, pendingNote: 'THEIRS' } }
    const taken = takeNote(loops, 'main')
    const older = { count: 1, lastRatio: null, lastBrief: null, hasEscalated: false } as typeof NEW_LOOP

    expect(taken?.note).toBe('NOTE')
    expect(taken?.loops.main?.pendingNote).toBe(null)
    expect(taken?.loops.other?.pendingNote).toBe('THEIRS')
    expect(takeNote(taken?.loops ?? {}, 'main')).toBeUndefined()
    expect(takeNote(loops, 'absent')).toBeUndefined()
    expect(takeNote({ main: older }, 'main')).toBeUndefined()
    expect(step(older, 0.1, null, LIMITS, 100_000).loop.pendingNote).toBe(null)
  })

  test('a note survives a later compaction until it is given', () => {
    expect(step({ ...NEW_LOOP, hasEscalated: true, pendingNote: 'NOTE' }, 0.1, null, LIMITS, 100_000).loop.pendingNote).toBe('NOTE')
  })
})

describe('the store', () => {
  const loops = { main: { ...NEW_LOOP, count: 2 } }
  const NOW = 100 * STALE_MS
  const entry = (updatedAt: number) => ({ updatedAt, loops })

  test('a session entry is read defensively, and garbage reads as nothing', () => {
    expect(entryOf(entry(NOW))).toEqual(entry(NOW))
    expect(entryOf(undefined)).toBeUndefined()
    expect(entryOf('garbage')).toBeUndefined()
    expect(entryOf({ updatedAt: 'x', loops })).toBeUndefined()
    expect(entryOf({ updatedAt: 1, loops: [] })).toBeUndefined()
    expect(loopsFrom({ main: 'x', a: null, b: { count: 'lots', lastRatio: Number.NaN, pendingNote: 3, hasEscalated: 'yes' } })).toEqual({
      b: NEW_LOOP,
    })
    expect(loopOf({ count: 2.5, lastRatio: 0.3, lastBrief: '/b', hasEscalated: true, pendingNote: '' })).toEqual({
      count: 2, lastRatio: 0.3, lastBrief: '/b', hasEscalated: true, pendingNote: null,
    })
  })

  test('the 0.1.0 layout is read for a session, and nothing from a value that holds nothing usable', () => {
    const stored = { s1: entry(NOW) }
    expect(loopsOf(stored, 's1')).toEqual(loops)
    expect(loopsOf(stored, 's2')).toEqual({})
    expect(loopsOf(stored, 'constructor')).toEqual({})
    expect(loopsOf(undefined, 's1')).toEqual({})
    expect(loopsOf('garbage', 's1')).toEqual({})
    expect(loopsOf({ s1: { updatedAt: 1 } }, 's1')).toEqual({})
  })

  test('the 0.1.0 layout is spent once no entry in it is fresh, at the exact edge', () => {
    expect(isLegacySpent({ a: entry(NOW - STALE_MS - 1), b: 'junk' }, NOW)).toBe(true)
    expect(isLegacySpent({ a: entry(NOW - STALE_MS) }, NOW)).toBe(false)
    expect(isLegacySpent('garbage', NOW)).toBe(true)
  })

  test('a tidy drops stale and unreadable sessions, then the least recently written past the cap, never its own', () => {
    const entries = [
      ['session:stale', entry(NOW - STALE_MS - 1)],
      ['session:edge', entry(NOW - STALE_MS)],
      ['session:broken', { loops }],
      ['session:mine', entry(0)],
    ] as const
    expect(sessionKeysToDrop(entries, NOW, 'session:mine', MAX_SESSIONS).sort()).toEqual(['session:broken', 'session:stale'])

    const many = Array.from({ length: 6 }, (_, n) => [`session:s${n}`, entry(NOW - n)] as const)
    // A cap of 4 keeps the own session and the 3 most recent others.
    expect(sessionKeysToDrop(many, NOW, 'session:s5', 4).sort()).toEqual(['session:s3', 'session:s4'])
  })

  test('loops are capped, dropping the earliest recorded, a waiting note last; main and the loop just changed stay', () => {
    const many: Record<string, typeof NEW_LOOP> = { main: NEW_LOOP }
    for (let n = 0; n < 6; n++) many[`a${n}`] = NEW_LOOP
    many.a0 = { ...NEW_LOOP, pendingNote: 'NOTE' }
    const capped = capLoops(many, 4, 'a1')
    expect(Object.keys(capped).sort()).toEqual(['a0', 'a1', 'a5', 'main'])
    expect(capLoops(loops, 4, 'main')).toBe(loops)
  })
})

describe('brief retention', () => {
  test('a conversation keeps its newest briefs by number, other conversations untouched', () => {
    const names = ['main-1.md', 'main-2.md', 'main-10.md', 'main-3.md', 'agent-1-4.md', 'main-x.md', 'notes.md']
    expect(briefsBeyond(names, 'main', 2).sort()).toEqual(['main-1.md', 'main-2.md'])
    expect(briefsBeyond(names, 'main', 4)).toEqual([])
    expect(briefsBeyond(names, 'main', 0)).toEqual([])
    expect(briefsBeyond(names, 'agent-1', 0)).toEqual([])
    expect(briefsBeyond([...names, 'agent-1-9.md'], 'agent-1', 1)).toEqual(['agent-1-4.md'])
  })

  test('only a brief-named regular file past the age is stale, at the exact edge, and never with the age at 0', () => {
    const DAY = 24 * 60 * 60 * 1000
    const NOW = 100 * DAY
    const file = (name: string, mtimeMs: number, more = {}) => ({ name, kind: 'file', mtimeMs, isLink: false, ...more })
    expect(isStaleBrief(file('main-1.md', NOW - 30 * DAY - 1), NOW, 30)).toBe(true)
    expect(isStaleBrief(file('main-1.md', NOW - 30 * DAY), NOW, 30)).toBe(false)
    expect(isStaleBrief(file('main-1.md', NOW - 90 * DAY), NOW, 0)).toBe(false)
    expect(isStaleBrief(file('notes.md', NOW - 90 * DAY), NOW, 30)).toBe(false)
    expect(isStaleBrief(file('main-1.md', NOW - 90 * DAY, { isLink: true }), NOW, 30)).toBe(false)
    expect(isStaleBrief(file('main-1.md', NOW - 90 * DAY, { kind: 'dir' }), NOW, 30)).toBe(false)
  })
})

describe('paths', () => {
  test('a segment cannot leave its folder', () => {
    expect(safeSegment('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(safeSegment('..')).toBe('_')
    expect(safeSegment('a/b\\c d')).toBe('a_b_c_d')
    expect(briefPath('/briefs', '../x', '../../y', 2)).toBe('/briefs/_x/_.._y-2.md')
    expect(briefPath('/briefs', 'abc-123', 'main', 1)).toBe('/briefs/abc-123/main-1.md')
  })

  test('the folder is the option only when absolute (or under ~/) and without ..', () => {
    const env = { configDir: '/home/me/.claude-alt', home: '/home/me' }
    const fallback = '/home/me/.claude-alt/compact-briefs'
    expect(resolveBriefDir('/data/briefs/', env)).toBe('/data/briefs')
    expect(resolveBriefDir('relative/briefs', env)).toBe(fallback)
    expect(resolveBriefDir('~/briefs', env)).toBe('/home/me/briefs')
    expect(resolveBriefDir('~/../etc', env)).toBe(fallback)
    expect(resolveBriefDir('/data/../etc', env)).toBe(fallback)
    expect(resolveBriefDir('', env)).toBe(fallback)
    expect(resolveBriefDir('/', env)).toBe(fallback)
    expect(resolveBriefDir(undefined, env)).toBe(fallback)
  })

  test('the default folder is in Claude\'s config folder: CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    // A custom CLAUDE_CONFIG_DIR keeps briefs in it: ~/.claude-custom/compact-briefs.
    expect(defaultBriefDir({ configDir: '/Users/me/.claude-custom', home: '/Users/me' })).toBe('/Users/me/.claude-custom/compact-briefs')
    expect(defaultBriefDir({ configDir: '~/.claude-custom/', home: '/Users/me' })).toBe('/Users/me/.claude-custom/compact-briefs')
    expect(defaultBriefDir({ configDir: undefined, home: '/Users/me' })).toBe('/Users/me/.claude/compact-briefs')
    expect(defaultBriefDir({ configDir: '', home: '/Users/me/' })).toBe('/Users/me/.claude/compact-briefs')
    expect(defaultBriefDir({ configDir: 'relative', home: '/Users/me' })).toBe('/Users/me/.claude/compact-briefs')
    expect(defaultBriefDir({})).toBe('/tmp/.claude/compact-briefs')
  })
})

describe('texts', () => {
  test('the brief has a header and the summary', () => {
    const brief = formatBrief({
      loopKey: 'main', sessionId: 's1', trigger: 'auto', count: 2, nowMs: 0,
      tokensBefore: 200_000, tokensAfter: 50_000, ratio: 0.25, summary: 'SUMMARY TEXT\n\n',
    })

    expect(brief).toBe(
      [
        '# Compaction brief: main, compaction 2',
        '',
        '- time: 1970-01-01T00:00:00.000Z',
        '- session: s1',
        '- conversation: main',
        '- trigger: auto',
        '- tokens: 200000 -> 50000 (25% kept)',
        '- compaction number: 2',
        '',
        '---',
        '',
        'SUMMARY TEXT',
        '',
      ].join('\n'),
    )
  })

  test('the note sends a subagent to its own brief and never names /handoff', () => {
    const loop = { count: 3, lastRatio: 0.75, lastBrief: '/b/agent-1-3.md', hasEscalated: true, pendingNote: null }
    const sub = handoffNote('ratio', loop, LIMITS)

    expect(sub).toContain('kept 75% of the tokens')
    expect(sub).toContain('/b/agent-1-3.md')
    expect(sub).toContain('at most 60 lines')
    expect(sub).toContain('every unmerged branch you created')
    expect(sub).not.toContain('/handoff')
  })

  test('main never escalates on count, whatever the limit', () => {
    const main = mainLimits(LIMITS)
    expect(main.minShrinkRatio).toBe(LIMITS.minShrinkRatio)
    let loop = NEW_LOOP
    for (let n = 0; n < 8; n++) {
      const stepped = step(loop, 0.2, null, main, 100_000)
      expect(stepped.escalation).toBeUndefined()
      loop = { ...stepped.loop, pendingNote: null }
    }
    expect(loop.count).toBe(8)
    expect(step(loop, 0.75, null, main, 100_000).escalation).toBe('ratio')
  })

  test('the status lists main first, then each subagent', () => {
    expect(formatStatus({})).toBe('no compaction yet this session.')
    expect(
      formatStatus({
        zed: { count: 1, lastRatio: null, lastBrief: null, hasEscalated: false, pendingNote: null },
        main: { count: 3, lastRatio: 0.7, lastBrief: '/b/main-3.md', hasEscalated: true, pendingNote: null },
      }),
    ).toBe(
      [
        'main: 3 compactions, last 70% kept, poor shrink, brief /b/main-3.md',
        'zed: 1 compaction, last not recorded, brief none',
      ].join('\n'),
    )
  })
})

describe('what pruning may touch', () => {
  test('only folders named like a Claude session id', () => {
    expect(isSessionFolder('0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f405162')).toBe(true)
    expect(isSessionFolder('0F3C2A1E-7B6D-4C5E-9A8B-1D2E3F405162')).toBe(true)
    for (const name of ['book', 'session-1', '0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f40516', '0f3c2a1e7b6d4c5e9a8b1d2e3f405162', 'x0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f405162']) {
      expect(isSessionFolder(name)).toBe(false)
    }
  })

  test('only files that start as formatBrief starts every brief', () => {
    const brief = formatBrief({
      loopKey: 'main', sessionId: 's', trigger: 'auto', count: 1, nowMs: 0,
      tokensBefore: 10, tokensAfter: 5, ratio: 0.5, summary: 'S',
    })
    expect(brief.startsWith(BRIEF_HEADER)).toBe(true)
    expect(isBriefText(brief.slice(0, BRIEF_HEADER.length))).toBe(true)
    expect(isBriefText('# Chapter 3')).toBe(false)
    expect(isBriefText('')).toBe(false)
    expect(isBriefText(` ${BRIEF_HEADER}`)).toBe(false)
  })
})
