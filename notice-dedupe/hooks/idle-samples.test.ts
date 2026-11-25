import { expect, test } from 'claude-code/testing'

import { DELIVERIES, LOADED_AT } from './idle-fixtures'
import { EMPTY_LEDGER, hasSignal, judgeTeammates, parseTeammateDelivery, remember } from './logic'
import type { Settings } from './logic'
import { PREAMBLE, TRAILER } from './samples'
import type { DropClass } from '../types'

// The deliveries of one made-up team session, replayed through the judging the hooks do. Each notice
// in idle-fixtures.ts is written to one shape; the counts below are those shapes.

const OFF: Settings = {
  dropsWaiting: true,
  dropsDelivered: true,
  dropsRepeats: true,
  dropsIdleAfterReport: true,
  aggressiveIdle: false,
  refusesRepeatSends: true,
  dropsPeerRepeats: true,
  dropsRepeatFailures: true,
  foldMode: 'empty',
  showsStatus: true,
  showsToasts: false,
  alertsDrift: true,
  sendMinChars: 80,
  windowMs: 30 * 60_000,
}
const ON: Settings = { ...OFF, aggressiveIdle: true }

type Notice = {
  at: number
  teammate: string
  result: string
  isEcho: boolean
  /** Whether that teammate's last prose message to the lead was inside the window. */
  hasReported: boolean
  /** The class it was dropped under; null when it entered, alone or held by another block of its delivery. */
  drop: DropClass | null
  /** The class it was judged droppable under, dropped or held. */
  judged: DropClass | null
}

/** Every idle notice from LOADED_AT on, with what became of it; `isFramed` replays each delivery as the transcript holds it. */
function replay(settings: Settings, isFramed: boolean): Notice[] {
  let ledger = EMPTY_LEDGER
  const reportedAt = new Map<string, number>()
  const notices: Notice[] = []
  for (const [at, inner] of DELIVERIES) {
    const blocks = parseTeammateDelivery(isFramed ? `${PREAMBLE}${inner}${TRAILER}` : inner, settings.aggressiveIdle)
    const verdicts = blocks === null ? [] : judgeTeammates(blocks.map(block => ({ ...block, loop: 'main' })), ledger, at, settings)
    const isDropped = verdicts.length > 0 && verdicts.every(verdict => verdict.drop !== null)
    for (const verdict of verdicts) {
      if (verdict.key !== null && (isDropped || verdict.drop === null)) {
        ledger = remember(ledger, verdict.key, verdict.digest, at, settings.windowMs, verdict.text)
      }
    }
    // What the delivery held is read apart from the parser under test.
    const found = [...inner.matchAll(/<teammate-message\s+teammate_id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/teammate-message>/g)]
    found.forEach((match, i) => {
      const teammate = match[1] ?? ''
      const body = match[2] ?? ''
      if (!body.startsWith('{"type":"idle_notification"')) {
        reportedAt.set(teammate, at)

        return
      }
      const message = JSON.parse(body) as { result?: string; summary?: string }
      const judged = verdicts[i]?.drop ?? null
      if (at >= LOADED_AT) {
        notices.push({
          at,
          teammate,
          result: message.result ?? '',
          isEcho: (message.summary ?? '').startsWith('[to '),
          hasReported: at - (reportedAt.get(teammate) ?? -Infinity) < settings.windowMs,
          drop: isDropped ? judged : null,
          judged,
        })
      }
    })
  }

  return notices
}

const countBy = (notices: readonly Notice[], pick: (notice: Notice) => string | null): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const notice of notices) {
    const kind = pick(notice)
    if (kind !== null) {
      counts[kind] = (counts[kind] ?? 0) + 1
    }
  }

  return counts
}

test('the sample holds 29 idle notices, 13 of them echoes of a message to another teammate', () => {
  const notices = replay(OFF, true)
  expect(notices).toHaveLength(29)
  expect(notices.filter(notice => notice.isEcho)).toHaveLength(13)
})

test('switch off: framed or not, only the notice that is one sentence of its report and a closing notice that adds nothing are dropped', () => {
  // frontend-1's "Waiting on qa-1's smoke run." is aggressiveIdle's alone, and its "The light test run is
  // still going; ..." holds words its report lacked.
  for (const isFramed of [true, false]) {
    const notices = replay(OFF, isFramed)
    expect(countBy(notices, notice => notice.drop)).toEqual({ 'idle-after-report': 1, 'idle-closing': 1 })
    expect(notices.filter(notice => notice.drop !== null).map(notice => notice.result)).toEqual([
      'All migrations are applied.',
      "I'm done; nothing further to add.",
    ])
  }
})

test('switch on: 10 of the 29 are dropped, framed or not, and 4 more are held by another block of their delivery', () => {
  for (const isFramed of [true, false]) {
    const notices = replay(ON, isFramed)
    expect(countBy(notices, notice => notice.drop)).toEqual({
      'idle-peer-echo': 6,
      'idle-after-report': 1,
      'idle-closing': 1,
      'idle-restatement': 1,
      'idle-paraphrase': 1,
    })
    expect(countBy(notices, notice => (notice.drop === null ? notice.judged : null))).toEqual({ 'idle-peer-echo': 2, 'idle-waiting': 1, 'idle-paraphrase': 1 })
  }
})

test('switch on drops everything the switch off drops but a notice with a signal', () => {
  const on = replay(ON, false)
  const off = replay(OFF, false)
  expect(off.filter(notice => notice.drop !== null)).toHaveLength(2)
  off.forEach((notice, i) => {
    if (notice.drop !== null) {
      expect(on[i]?.judged === null).toBe(hasSignal(notice.result))
    }
  })
})

test('switch on: every echo with no signal and a report inside the window is judged droppable, and no other echo', () => {
  const echoes = replay(ON, true).filter(notice => notice.isEcho)
  for (const echo of echoes) {
    const isSafe = echo.hasReported && !hasSignal(echo.result)
    expect(echo.judged === 'idle-peer-echo').toBe(isSafe)
  }
  expect(echoes.filter(echo => echo.judged === 'idle-peer-echo')).toHaveLength(8)
  // A first contact, and one whose teammate's report is past the window.
  expect(echoes.filter(echo => !echo.hasReported)).toHaveLength(2)
  expect(echoes.filter(echo => echo.hasReported && hasSignal(echo.result))).toHaveLength(3)
})

test('switch on: only the notice that repeats a sentence of its report word for word counts as a restatement', () => {
  const restated = replay(ON, true).filter(notice => notice.judged === 'idle-restatement')
  expect(restated.map(notice => [notice.teammate, notice.result])).toEqual([['search-index', 'Search index rebuild is running on the staging server.']])
})

test('switch on: a first contact is never dropped, and a notice with a signal only as a paraphrase of its report', () => {
  const notices = replay(ON, true)
  for (const notice of notices) {
    if (!notice.hasReported) {
      expect(notice.judged).toBeNull()
    }
    if (hasSignal(notice.result)) {
      expect([null, 'idle-paraphrase']).toContain(notice.judged)
    }
  }
  // The one: api-1's "Waiting on the lead's decision ...", the decision its report asked for, in the same delivery.
  const judged = notices.filter(notice => hasSignal(notice.result) && notice.judged !== null)
  expect(judged.map(notice => [notice.teammate, notice.drop])).toEqual([['api-1', null]])
  expect(notices.filter(notice => !notice.hasReported)).toHaveLength(4)
})

test('switch on: these blockers, results, waiting statuses with news and first contacts enter', () => {
  const notices = replay(ON, true)
  const mustPass = [
    ['api-1', 'Blocked on CI runner capacity for the payment-flow bisect'],
    ['api-1', 'Two contract tests failed after the rebase'],
    ['api-1', 'Staging verification is done and reported (318 passed at 9c2e71b0)'],
    ['cache-2', "Waiting on two things: the lead's decision on whether the warmer ships enabled"],
    ['cache-2', 'Warmer is green on staging ✅'],
    ['perf-2', 'Rerun failed on the orders endpoint: 37 errors'],
    ['perf-2', 'Index build and the second load test are running on the staging server'],
    ['perf-2', 'Waiting on the profile runs that write to `bench/out/orders_profile`'],
    ['frontend-1', 'The light test run is still going'],
    ['audit-1', 'The audit is written to'],
    ['qa-1', 'Oriented and standing by; nothing is actionable until a green staging build is reported'],
    ['qa-1', 'Told frontend-1 that the two coupon failures block the flag rollout'],
    ['release-1', 'I’ve asked search-index for its reindex command'],
    ['release-1', "Blocked: the release branch needs the lead's sign-off"],
    ['docs-1', 'Asked frontend-1 for cart page screenshots'],
  ] as const
  for (const [teammate, opening] of mustPass) {
    const found = notices.filter(notice => notice.teammate === teammate && notice.result.startsWith(opening))
    expect(found).toHaveLength(1)
    expect(found[0]?.judged).toBeNull()
  }
})
