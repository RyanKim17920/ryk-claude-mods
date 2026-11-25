import { expect, test } from 'claude-code/testing'

import { FINISHED_PAIRS } from './finished-fixtures'
import type { FinishedPair } from './finished-fixtures'
import { EMPTY_LEDGER, hasSignal, judgeTeammates, paraphrases, parseTeammateDelivery, remember, restates } from './logic'
import type { Settings, Verdict } from './logic'
import { idleNotice, PREAMBLE, teammateMessage, TRAILER } from './samples'

// A teammate's closing ("Teammate ... finished") notice that rewords the report it just sent, replayed
// from made-up deliveries shaped like real ones, against notices that say something new.

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
const SECOND = 1000

const framed = (inner: string) => `${PREAMBLE}${inner}${TRAILER}`

/** The report's delivery then the notice's, as the lead's prompt receives them; the notice's verdict, or undefined when not read. */
function replay(report: string, reportAt: number, notice: string, noticeAt: number, settings: Settings): Verdict | undefined {
  let ledger = EMPTY_LEDGER
  for (const [at, text] of [[reportAt, report], [noticeAt, notice]] as const) {
    const blocks = parseTeammateDelivery(text, settings.aggressiveIdle)
    if (blocks === null) {
      return undefined
    }
    const [verdict] = judgeTeammates(blocks.map(block => ({ ...block, loop: 'main' })), ledger, at, settings)
    if (text === notice) {
      return verdict
    }
    if (verdict?.key != null) {
      ledger = remember(ledger, verdict.key, verdict.digest, at, settings.windowMs, verdict.text)
    }
  }

  return undefined
}

const replayPair = (pair: FinishedPair, settings: Settings) =>
  replay(framed(pair.report[1]), pair.report[0], framed(pair.notice[1]), pair.notice[0], settings)

const bodyOf = (inner: string): string => parseTeammateDelivery(inner, false)?.[0]?.body ?? ''
const resultOf = (inner: string): string => (JSON.parse(bodyOf(inner)) as { result: string }).result
const EVENT = FINISHED_PAIRS.find(pair => pair.id === 'pricing-model-handoff')

test('the fixtures hold the case the class was written for and its siblings', () => {
  expect(EVENT?.teammate).toBe('pricing-model')
  expect(EVENT?.notice[1]).toContain('"type":"idle_notification"')
  expect(EVENT?.notice[1]).not.toContain('idleReason')
  expect(FINISHED_PAIRS.filter(pair => pair.expect === 'drop')).toHaveLength(3)
  expect(FINISHED_PAIRS.filter(pair => pair.expect === 'pass')).toHaveLength(4)
})

test('why that case got through before: a rewording, with a signal its report already held', () => {
  const report = bodyOf(EVENT?.report[1] ?? '')
  const notice = resultOf(EVENT?.notice[1] ?? '')
  // Under a third of its three-word runs are the report's, so it is no restatement...
  expect(restates(notice, report)).toBe(false)
  // ...and "Decision for you" and the projected scores are signals, so every other class let it pass.
  expect(hasSignal(notice)).toBe(true)
  expect(paraphrases(notice, report)).toBe(true)
})

test('switch on: each rewording a lead would answer with a no-op turn is dropped', () => {
  for (const pair of FINISHED_PAIRS.filter(candidate => candidate.expect === 'drop')) {
    expect(replayPair(pair, ON)).toMatchObject({ drop: 'idle-paraphrase', key: null })
  }
})

test('switch on: each closing notice that holds something new enters', () => {
  for (const pair of FINISHED_PAIRS.filter(candidate => candidate.expect === 'pass')) {
    expect(replayPair(pair, ON)?.drop).toBeNull()
  }
})

test('switch off (the default): none of them is dropped, as the frame is not read', () => {
  for (const pair of FINISHED_PAIRS) {
    expect(replayPair(pair, OFF)?.drop ?? null).toBeNull()
  }
})

test('switch on: that case with anything new added enters', () => {
  const pair = EVENT as FinishedPair
  const notice = resultOf(pair.notice[1])
  const additions = [
    'The head is now 7f177eef6.',
    'Which of the two scorings do you want?',
    'Blocked: the staging server is gone.',
    'One unit test failed on the rebuilt branch.',
    'The rule test rerun stands at 5/7.',
  ]
  for (const added of additions) {
    const said = `${notice}\n\n${added}`
    expect(paraphrases(said, bodyOf(pair.report[1]))).toBe(false)
    const changed = framed(idleNotice(pair.teammate, said, { idleReason: undefined }))
    expect(replay(framed(pair.report[1]), pair.report[0], changed, pair.notice[0], ON)?.drop).toBeNull()
  }
})

test('switch on: a different final result, a first contact, a failure and a late notice all enter', () => {
  const pair = EVENT as FinishedPair
  const report = framed(pair.report[1])
  const [at, inner] = pair.notice
  // Another of this teammate's closing notices (its v1 report), after this report.
  const other = FINISHED_PAIRS.find(candidate => candidate.id === 'pricing-model-v1')?.notice[1] ?? ''
  expect(replay(report, pair.report[0], framed(other), at, ON)?.drop).toBeNull()
  // First contact: no report from this teammate, or the report from another teammate.
  expect(replay(framed(teammateMessage('someone-else', bodyOf(pair.report[1]))), pair.report[0], framed(inner), at, ON)?.drop).toBeNull()
  // A failure, however it reads.
  const notice = resultOf(inner)
  for (const more of [{ idleReason: 'failed' }, { failureReason: 'API error' }, { completedStatus: 'failed' }, { idleReason: 'interrupted' }]) {
    expect(replay(report, pair.report[0], framed(idleNotice(pair.teammate, notice, more)), at, ON)?.drop).toBeNull()
  }
  // Past the window.
  expect(replay(report, pair.report[0], framed(inner), pair.report[0] + 30 * 60 * SECOND, ON)?.drop).toBeNull()
  // A question in its summary.
  const asked = framed(idleNotice(pair.teammate, notice, { idleReason: undefined, summary: 'Which scoring do you want?' }))
  expect(replay(report, pair.report[0], asked, at, ON)?.drop).toBeNull()
})

test('paraphrase: short notices and unseen numbers are never read as one', () => {
  const report = 'The suite is green at e48dabb0 and the branch is pushed for review; seeds 223 to 226 are screened.'
  expect(paraphrases('The suite is green.', report)).toBe(false)
  expect(paraphrases('The branch is pushed for review and the suite is green at e48dabb0.', report)).toBe(true)
  expect(paraphrases('The branch is pushed for review and the suite is green at e48dabb1.', report)).toBe(false)
  expect(paraphrases('Seeds 223 to 227 are screened and the branch is pushed for review.', report)).toBe(false)
  expect(paraphrases('The branch is pushed for review and the suite is green at e48dabb0; any objection?', report)).toBe(false)
  expect(paraphrases('', report)).toBe(false)
  // A number is read whole: 0.5 is not 0.57, 5/7 is not 4-7, and a path's tail is the path's.
  const scores = 'Expected scores are 0.57 and 0.43 when 4-7 units are lost; files are in /tmp/x/run-9/scratchpad/handoff.md for the next owner.'
  expect(paraphrases('Expected scores are 0.57 and 0.43 when 4-7 units are lost; files are in run-9/scratchpad.', scores)).toBe(true)
  expect(paraphrases('Expected scores are 0.5 and 0.43 when 4-7 units are lost; files are in run-9/scratchpad.', scores)).toBe(false)
  expect(paraphrases('Expected scores are 0.57 and 0.43 when 5/7 units are lost; files are in run-9/scratchpad.', scores)).toBe(false)
})
