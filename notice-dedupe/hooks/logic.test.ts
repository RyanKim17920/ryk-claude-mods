import { expect, test } from 'claude-code/testing'

import {
  addToTotals,
  boilerplateClass,
  countProbe,
  DEFAULT_SETTINGS,
  emptyTotals,
  fingerprint,
  isAgentDelivery,
  addsNothing,
  isClosingStatus,
  plainOf,
  reportKept,
  parseAgentMessage,
  isDrifting,
  judgePeer,
  MAX_SEEN,
  parseCrossSession,
  parseTotals,
  probeOf,
  settingsOf,
  totalsReport,
  countDrop,
  digestOf,
  EMPTY_LEDGER,
  excerptOf,
  foldedStub,
  hasSignal,
  isJudged,
  isTeammateDelivery,
  isWaitingStatus,
  judgePrompt,
  judgeSend,
  judgeTeammate,
  judgeTeammates,
  parseTeammateBundle,
  parseTeammateDelivery,
  parseTeammateMessage,
  normalize,
  parseNotification,
  remember,
  report,
  restates,
  localDayOf,
  statusLine,
} from './logic'
import type { Settings } from './logic'
import { agentMessage, crossSession, DELIVERED, idleNotice, NOTE_DONE, NOTE_PARKED, notification, peerDelivery, teammateMessage, WAITING } from './samples'

const MINUTE = 60_000
const SETTINGS: Settings = {
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
  windowMs: 30 * MINUTE,
}
const TASK = { kind: 'task-notification' }

test('a notification parses to its task, status and result', () => {
  const note = parseNotification(notification('a82785c8', 'completed', WAITING))
  expect(note.taskId).toBe('a82785c8')
  expect(note.status).toBe('completed')
  expect(note.summary).toBe('Agent "R2: checkout latency survey" finished')
  expect(note.note).toBe(NOTE_PARKED)
  expect(note.result).toBe(WAITING)
})

test('text with no block, or several, parses to nothing', () => {
  const none = { taskId: null, status: null, summary: null, note: null, result: null }
  expect(parseNotification('just words')).toEqual(none)
  expect(parseNotification(notification('a', 'completed', WAITING) + notification('b', 'completed', WAITING))).toEqual(none)
})

test('each boilerplate class is recognised only as a completed notification\'s whole result', () => {
  expect(boilerplateClass(parseNotification(notification('a', 'completed', WAITING)))).toBe('waiting')
  expect(boilerplateClass(parseNotification(notification('a', 'completed', DELIVERED)))).toBe('delivered')
  for (const status of ['failed', 'killed', 'stopped', 'stalled', 'terminated', 'error']) {
    expect(boilerplateClass(parseNotification(notification('a', status, WAITING)))).toBeNull()
  }
  // A real report that quotes the boilerplate, and one that merely mentions it later.
  expect(boilerplateClass(parseNotification(notification('a', 'completed', `Findings: ${WAITING}`)))).toBeNull()
  expect(boilerplateClass(parseNotification(notification('a', 'completed', WAITING + ' x'.repeat(300))))).toBeNull()
  expect(boilerplateClass(parseNotification(notification('a', 'completed', 'All 14 tests pass.')))).toBeNull()
})

test('normalising ignores whitespace and the usage counters, nothing else', () => {
  const a = normalize(notification('a', 'completed', 'Done.', 1000))
  expect(normalize(notification('a', 'completed', 'Done.', 299_004).replace(/\n/g, '\n  '))).toBe(a)
  expect(normalize(notification('a', 'completed', 'Done!', 1000))).not.toBe(a)
  expect(digestOf(a)).toBe(digestOf(a))
  expect(digestOf(a)).not.toBe(digestOf(`${a} `))
})

test('only notifications, schedules and framed plugin prompts are judged', () => {
  expect(isJudged({ kind: 'task-notification' })).toBe(true)
  expect(isJudged({ kind: 'scheduled-trigger' })).toBe(true)
  expect(isJudged({ kind: 'plugin' })).toBe(true)
  expect(isJudged({ kind: 'plugin', asUser: true })).toBe(false)
  for (const kind of ['composer', 'bridge', 'sdk', 'peer', 'peer-send-message', 'coordinator', 'channel', 'unclassified', 'slack-ping']) {
    expect(isJudged({ kind })).toBe(false)
  }
})

test('"report was delivered" drops every time, behind its switch', () => {
  expect(judgePrompt(TASK, notification('a', 'completed', DELIVERED), EMPTY_LEDGER, 0, SETTINGS).drop).toBe('delivered')
  expect(judgePrompt(TASK, notification('a', 'completed', DELIVERED), EMPTY_LEDGER, 0, { ...SETTINGS, dropsWaiting: false }).drop).toBe('delivered')
  expect(judgePrompt(TASK, notification('a', 'completed', DELIVERED), EMPTY_LEDGER, 0, { ...SETTINGS, dropsDelivered: false }).drop).toBeNull()
})

test('"has not reported yet" passes once per task, then drops inside the window', () => {
  const first = judgePrompt(TASK, notification('a', 'completed', WAITING, 1000), EMPTY_LEDGER, 0, SETTINGS)
  expect(first).toMatchObject({ drop: null, key: 'waiting:a' })
  const told = remember(EMPTY_LEDGER, first.key ?? '', first.digest, 0, SETTINGS.windowMs)

  expect(judgePrompt(TASK, notification('a', 'completed', WAITING, 2000), told, MINUTE, SETTINGS).drop).toBe('waiting')
  expect(judgePrompt(TASK, notification('a', 'completed', WAITING, 3000), told, 29 * MINUTE, SETTINGS).drop).toBe('waiting')
  // Another task has not been told of yet; and past the window main is told again.
  expect(judgePrompt(TASK, notification('b', 'completed', WAITING), told, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgePrompt(TASK, notification('a', 'completed', WAITING), told, 30 * MINUTE, SETTINGS).drop).toBeNull()
  // Switched off, the class is not special: nothing is dropped as waiting.
  const off = { ...SETTINGS, dropsWaiting: false, dropsRepeats: false }
  expect(judgePrompt(TASK, notification('a', 'completed', WAITING), told, MINUTE, off).drop).toBeNull()
})

test('a repeat is the same text for the same task inside the window', () => {
  const text = notification('a', 'completed', 'Interim: 3 of 9 images built.')
  const first = judgePrompt(TASK, text, EMPTY_LEDGER, 0, SETTINGS)
  expect(first).toMatchObject({ drop: null, key: 'task:a' })
  const seen = remember(EMPTY_LEDGER, 'task:a', first.digest, 0, SETTINGS.windowMs)

  expect(judgePrompt(TASK, text, seen, 29 * MINUTE, SETTINGS).drop).toBe('repeat-notification')
  expect(judgePrompt(TASK, notification('a', 'completed', 'Interim: 3 of 9 images built.', 77), seen, MINUTE, SETTINGS).drop).toBe('repeat-notification')
  expect(judgePrompt(TASK, text, seen, 30 * MINUTE, SETTINGS).drop).toBeNull()
  expect(judgePrompt(TASK, notification('b', 'completed', 'Interim: 3 of 9 images built.'), seen, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgePrompt(TASK, notification('a', 'completed', 'Interim: 4 of 9 images built.'), seen, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgePrompt(TASK, text, seen, MINUTE, { ...SETTINGS, dropsRepeats: false }).drop).toBeNull()
})

test('a resumed agent\'s notification is a repeat without its tool-use-id, and not one when the harness note changes', () => {
  const first = judgePrompt(TASK, notification('a', 'completed', 'PARKED', 25_359), EMPTY_LEDGER, 0, SETTINGS)
  const seen = remember(EMPTY_LEDGER, 'task:a', first.digest, 0, SETTINGS.windowMs)
  const resumed = notification('a', 'completed', 'PARKED', 25_984, NOTE_PARKED, false)
  expect(resumed).not.toContain('<tool-use-id>')
  expect(judgePrompt(TASK, resumed, seen, MINUTE, SETTINGS).drop).toBe('repeat-notification')
  // Same words, but now it stopped with nothing left running: that is news.
  expect(judgePrompt(TASK, notification('a', 'completed', 'PARKED', 26_404, NOTE_DONE, false), seen, MINUTE, SETTINGS).drop).toBeNull()
})

test('only the previous notification of a task counts', () => {
  const a = judgePrompt(TASK, notification('a', 'completed', 'one'), EMPTY_LEDGER, 0, SETTINGS)
  const b = judgePrompt(TASK, notification('a', 'completed', 'two'), EMPTY_LEDGER, 0, SETTINGS)
  const seen = remember(remember(EMPTY_LEDGER, 'task:a', a.digest, 0, SETTINGS.windowMs), 'task:a', b.digest, MINUTE, SETTINGS.windowMs)
  expect(judgePrompt(TASK, notification('a', 'completed', 'one'), seen, 2 * MINUTE, SETTINGS).drop).toBeNull()
  expect(judgePrompt(TASK, notification('a', 'completed', 'two'), seen, 2 * MINUTE, SETTINGS).drop).toBe('repeat-notification')
})

test('a stopped, stalled, terminated or errored notification is never a repeat', () => {
  for (const status of ['stopped', 'stalled', 'terminated', 'error']) {
    const text = notification('a', status, 'Process exited with code 137.')
    const first = judgePrompt(TASK, text, EMPTY_LEDGER, 0, SETTINGS)
    const seen = remember(EMPTY_LEDGER, 'task:a', first.digest, 0, SETTINGS.windowMs)
    expect(judgePrompt(TASK, text, seen, MINUTE, SETTINGS).drop).toBeNull()
  }
})

test('a failed or killed notification: the first always passes; only an exact repeat for the same task inside the window drops', () => {
  for (const status of ['failed', 'killed']) {
    const text = (when: string, id = 'a') => notification(id, status, `[${when}] Process exited with code 137.`)
    const first = judgePrompt(TASK, text('2026-11-21T10:00:00Z'), EMPTY_LEDGER, 0, SETTINGS)
    expect(first).toMatchObject({ drop: null, key: 'task:a' })
    const seen = remember(EMPTY_LEDGER, 'task:a', first.digest, 0, SETTINGS.windowMs)
    // Only the timestamp differs: the same failure.
    expect(judgePrompt(TASK, text('2026-11-21T10:04:12Z'), seen, MINUTE, SETTINGS).drop).toBe('repeat-failure')
    // Another task, a different failure, past the window, or the switch off: it passes.
    expect(judgePrompt(TASK, text('2026-11-21T10:00:00Z', 'b'), seen, MINUTE, SETTINGS).drop).toBeNull()
    expect(judgePrompt(TASK, notification('a', status, 'Process exited with code 1.'), seen, MINUTE, SETTINGS).drop).toBeNull()
    expect(judgePrompt(TASK, text('2026-11-21T10:00:00Z'), seen, 30 * MINUTE, SETTINGS).drop).toBeNull()
    expect(judgePrompt(TASK, text('2026-11-21T10:00:00Z'), seen, MINUTE, { ...SETTINGS, dropsRepeatFailures: false }).drop).toBeNull()
    // dropRepeats does not govern failures.
    expect(judgePrompt(TASK, text('2026-11-21T10:00:00Z'), seen, MINUTE, { ...SETTINGS, dropsRepeats: false }).drop).toBe('repeat-failure')
  }
  // A completed notification and a failure with the same result are not each other's repeat.
  const done = judgePrompt(TASK, notification('a', 'completed', 'Exited.'), EMPTY_LEDGER, 0, SETTINGS)
  const seen = remember(EMPTY_LEDGER, 'task:a', done.digest, 0, SETTINGS.windowMs)
  expect(judgePrompt(TASK, notification('a', 'failed', 'Exited.'), seen, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgePrompt(TASK, notification('a', 'completed', 'Exited.'), seen, MINUTE, { ...SETTINGS, dropsRepeatFailures: false }).drop).toBe('repeat-notification')
})

test('a scheduled prompt repeats by text; another origin keeps its own memory', () => {
  const cron = { kind: 'scheduled-trigger' }
  const first = judgePrompt(cron, 'Check the suite and report.', EMPTY_LEDGER, 0, SETTINGS)
  expect(first.drop).toBeNull()
  const seen = remember(EMPTY_LEDGER, first.key ?? '', first.digest, 0, SETTINGS.windowMs)
  expect(judgePrompt(cron, 'Check  the suite\nand report.', seen, 10 * MINUTE, SETTINGS).drop).toBe('repeat-prompt')
  expect(judgePrompt(cron, 'Check the suite and report.', seen, 31 * MINUTE, SETTINGS).drop).toBeNull()
  expect(judgePrompt({ kind: 'plugin' }, 'Check the suite and report.', seen, MINUTE, SETTINGS).drop).toBeNull()
})

test('a repeated send is refused per sender and recipient, and short ones never', () => {
  const text = 'Rebase fix/cache-infra onto e48dabb0, rerun the full integration suite and report the pass rate.'
  const send = { agentId: 'lead', to: 'speed', text }
  const first = judgeSend(send, EMPTY_LEDGER, 0, SETTINGS)
  expect(first.drop).toBeNull()
  const seen = remember(EMPTY_LEDGER, first.key ?? '', first.digest, 0, SETTINGS.windowMs)
  expect(judgeSend(send, seen, MINUTE, SETTINGS).drop).toBe('repeat-send')
  expect(judgeSend({ ...send, to: 'grader' }, seen, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgeSend({ ...send, agentId: undefined }, seen, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgeSend({ ...send, text: `${text} Then stop.` }, seen, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgeSend(send, seen, 30 * MINUTE, SETTINGS).drop).toBeNull()
  expect(judgeSend(send, seen, MINUTE, { ...SETTINGS, refusesRepeatSends: false }).drop).toBeNull()
  // Off, nothing is refused but the send is still keyed, so it is remembered for when it is on again.
  expect(judgeSend(send, seen, MINUTE, { ...SETTINGS, refusesRepeatSends: false }).key).toBe(first.key)
  // A short message is never refused, even as an exact repeat.
  const short = judgeSend({ ...send, text: 'proceed' }, EMPTY_LEDGER, 0, SETTINGS)
  const shortSeen = remember(EMPTY_LEDGER, short.key ?? '', short.digest, 0, SETTINGS.windowMs)
  expect(judgeSend({ ...send, text: 'proceed' }, shortSeen, MINUTE, SETTINGS).drop).toBeNull()
})

test('only a repeat of the last message to that recipient is refused: a status that changes back is news', () => {
  const live = 'Deploy 4127: LIVE, 3 of 3 instances ready in us-east-1, health checks passed, no errors reported'
  const back = 'Deploy 4127: waiting for health checks, 2 of 3 instances ready in us-east-1, no errors reported so far'
  const deliver = (ledger: typeof EMPTY_LEDGER, text: string, at: number) => {
    const verdict = judgeSend({ agentId: 'watch', to: 'main', text }, ledger, at, SETTINGS)
    expect(verdict.drop).toBeNull()

    return remember(ledger, verdict.key ?? '', verdict.digest, at, SETTINGS.windowMs)
  }
  const judge = (ledger: typeof EMPTY_LEDGER, text: string) => judgeSend({ agentId: 'watch', to: 'main', text }, ledger, 3 * MINUTE, SETTINGS).drop
  const afterBack = deliver(EMPTY_LEDGER, back, 0)
  expect(judge(afterBack, back)).toBe('repeat-send')
  const afterLive = deliver(afterBack, live, MINUTE)
  expect(judge(afterLive, live)).toBe('repeat-send')
  expect(judge(afterLive, back)).toBeNull()
  // A short message in between is the last message too.
  expect(judge(deliver(afterLive, 'rolled back', 2 * MINUTE), live)).toBeNull()
})

// `to` can name one recipient several ways (a name, an agent id, a `from` address) or all of them
// (`*`), so a slot per spelling could miss the message in between. One record per sender cannot.
test('a send to anyone else in between, however the recipient is spelled, makes the same message news again', () => {
  const text = 'Deploy 4127: waiting for health checks, 2 of 3 instances ready in us-east-1, no errors reported so far'
  const other = 'Deploy 4127: LIVE, 3 of 3 instances ready in us-east-1, health checks passed, no errors reported'
  const deliver = (ledger: typeof EMPTY_LEDGER, send: { to: string; text: string }, at: number) => {
    const verdict = judgeSend({ agentId: 'watch', ...send }, ledger, at, SETTINGS)
    expect(verdict.drop).toBeNull()

    return remember(ledger, verdict.key ?? '', verdict.digest, at, SETTINGS.windowMs)
  }
  const judge = (ledger: typeof EMPTY_LEDGER, to: string) => judgeSend({ agentId: 'watch', to, text }, ledger, 3 * MINUTE, SETTINGS).drop
  const once = deliver(EMPTY_LEDGER, { to: 'main', text }, 0)
  expect(judge(once, 'main')).toBe('repeat-send')
  for (const to of ['*', 'team-lead', 'a1b2c3d4']) {
    expect(judge(deliver(once, { to, text: other }, MINUTE), 'main')).toBeNull()
  }
  // The same text to another spelling is not refused either: only the same `to` is compared.
  expect(judge(once, '*')).toBeNull()
  // Another sender's message never touches this sender's record.
  const elsewhere = judgeSend({ agentId: 'grader', to: 'main', text: other }, once, MINUTE, SETTINGS)
  expect(judge(remember(once, elsewhere.key ?? '', elsewhere.digest, MINUTE, SETTINGS.windowMs), 'main')).toBe('repeat-send')
})

test('memory lets go of what is past the window', () => {
  const one = remember(EMPTY_LEDGER, 'task:a', 'x', 0, SETTINGS.windowMs)
  const two = remember(one, 'task:b', 'y', 31 * MINUTE, SETTINGS.windowMs)
  expect(Object.keys(two.seen)).toEqual(['task:b'])
})

test('counts, status line and report', () => {
  expect(statusLine(EMPTY_LEDGER)).toBeUndefined()
  expect(report(EMPTY_LEDGER, 0)).toBe('nothing dropped this session.')
  let ledger = EMPTY_LEDGER
  for (let i = 0; i < 12; i += 1) {
    ledger = countDrop(ledger, { at: i * MINUTE, kind: i % 2 === 0 ? 'waiting' : 'delivered', excerpt: `drop ${i}` })
  }
  expect(statusLine(ledger)).toBe('dedupe: 12 dropped')
  expect(ledger.drops).toHaveLength(10)
  const text = report(ledger, 12 * MINUTE)
  expect(text).toContain('12 dropped this session')
  expect(text).toContain('    6  waiting')
  expect(text).toContain('last 10:')
  expect(text).toContain('1m ago  delivered            drop 11')
  expect(text).not.toContain('drop 1\n')
  expect(excerptOf('x'.repeat(200))).toHaveLength(80)
})

const delivery = (text: string, loop = 'main') => {
  const parsed = parseTeammateMessage(text)
  if (parsed === null) {
    throw new Error('not one teammate message')
  }

  return { ...parsed, loop }
}
const REPORT = teammateMessage('builder-a', 'Live checks are done: two verified, one fixed.', 'Live checks done')
const IDLE = idleNotice('builder-a', 'Reported to the team lead.')

test('a teammate message parses only as one whole block', () => {
  expect(parseTeammateMessage(REPORT)).toEqual({ teammate: 'builder-a', body: 'Live checks are done: two verified, one fixed.' })
  expect(parseTeammateMessage(`Another Claude session sent a message:\n${REPORT}`)?.teammate).toBe('builder-a')
  expect(parseTeammateMessage(`${REPORT}\n${IDLE}`)).toBeNull()
  expect(parseTeammateMessage(`${IDLE} and more words`)).toBeNull()
  expect(parseTeammateMessage('<agent-message from="scout">hi</agent-message>')).toBeNull()
  expect(isTeammateDelivery({ kind: 'peer' }, IDLE)).toBe(true)
  expect(isTeammateDelivery({ kind: 'composer' }, IDLE)).toBe(false)
  expect(isTeammateDelivery({ kind: 'peer' }, 'Report: suite green.')).toBe(false)
})

test('an idle notice drops after that teammate\'s report, once', () => {
  const report = judgeTeammate(delivery(REPORT), EMPTY_LEDGER, 0, SETTINGS)
  expect(report).toMatchObject({ drop: null, key: 'report:main:builder-a' })
  const reported = remember(EMPTY_LEDGER, report.key ?? '', report.digest, 0, SETTINGS.windowMs, report.text)

  const idle = judgeTeammate(delivery(IDLE), reported, MINUTE, SETTINGS)
  expect(idle.drop).toBe('idle-after-report')
  expect(idle.excerpt).toContain('builder-a idle: Reported to the team lead.')
  // The report is spent: the next idle notice (new work, no message) is the only signal and passes.
  const spent = remember(reported, idle.key ?? '', idle.digest, MINUTE, SETTINGS.windowMs)
  expect(judgeTeammate(delivery(IDLE), spent, 2 * MINUTE, SETTINGS).drop).toBeNull()
})

test('an idle notice with no recent report from that teammate passes', () => {
  expect(judgeTeammate(delivery(IDLE), EMPTY_LEDGER, 0, SETTINGS).drop).toBeNull()
  const report = judgeTeammate(delivery(REPORT), EMPTY_LEDGER, 0, SETTINGS)
  const reported = remember(EMPTY_LEDGER, report.key ?? '', report.digest, 0, SETTINGS.windowMs)
  // Outside the window, from another teammate, to another loop, or with the rule off.
  expect(judgeTeammate(delivery(IDLE), reported, 30 * MINUTE, SETTINGS).drop).toBeNull()
  expect(judgeTeammate(delivery(idleNotice('builder-b', 'done')), reported, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgeTeammate(delivery(IDLE, 'a7'), reported, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgeTeammate(delivery(IDLE), reported, MINUTE, { ...SETTINGS, dropsIdleAfterReport: false }).drop).toBeNull()
})

test('any idle reason but plain availability passes, as does a failure or a forged sender', () => {
  const report = judgeTeammate(delivery(REPORT), EMPTY_LEDGER, 0, SETTINGS)
  const reported = remember(EMPTY_LEDGER, report.key ?? '', report.digest, 0, SETTINGS.windowMs)
  for (const idleReason of ['failed', 'interrupted', 'error', 'shutdown']) {
    expect(judgeTeammate(delivery(idleNotice('builder-a', 'x', { idleReason })), reported, MINUTE, SETTINGS).drop).toBeNull()
  }
  expect(judgeTeammate(delivery(idleNotice('builder-a', 'x', { failureReason: 'API error' })), reported, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgeTeammate(delivery(idleNotice('builder-a', 'x', { completedStatus: 'failed' })), reported, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgeTeammate(delivery(idleNotice('builder-a', 'x', { from: 'someone-else' })), reported, MINUTE, SETTINGS).drop).toBeNull()
})

test('what is not valid idle_notification JSON passes, and only prose counts as a report', () => {
  const report = judgeTeammate(delivery(REPORT), EMPTY_LEDGER, 0, SETTINGS)
  const reported = remember(EMPTY_LEDGER, report.key ?? '', report.digest, 0, SETTINGS.windowMs)
  const broken = teammateMessage('builder-a', '{"type":"idle_notification","from":"builder-a","idleReason":"available"')
  const other = teammateMessage('builder-a', '{"type":"shutdown_response","request_id":"r1","approve":true}')
  const untyped = teammateMessage('builder-a', '{"idleReason":"available"}')
  // Broken or untyped JSON is prose: it passes (and is itself a report). Another protocol message passes unread.
  expect(judgeTeammate(delivery(broken), reported, MINUTE, SETTINGS)).toMatchObject({ drop: null, key: 'report:main:builder-a' })
  expect(judgeTeammate(delivery(untyped), reported, MINUTE, SETTINGS).drop).toBeNull()
  expect(judgeTeammate(delivery(other), reported, MINUTE, SETTINGS)).toMatchObject({ drop: null, key: null })
  // A protocol message is no report: an idle notice after it alone passes.
  expect(judgeTeammate(delivery(IDLE), EMPTY_LEDGER, MINUTE, SETTINGS).drop).toBeNull()
})

const FRAME = (block: string) =>
  `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated notification, not something the user typed.\n${block}\n</system-reminder>`

test('a folded row that is only a "report was delivered" notification is replaced by one line', () => {
  const block = notification('a7e7c29c', 'completed', DELIVERED, 25_262, NOTE_DONE)
  expect(foldedStub(block)).toContain('task notification for a7e7c29c said only that its report was already delivered')
  expect(foldedStub(FRAME(block))).toBe(foldedStub(block))
})

test('every other folded row is kept: a failure, a real report, a waiting notice, several blocks, words around it', () => {
  for (const status of ['failed', 'stalled', 'killed', 'stopped']) {
    expect(foldedStub(notification('a', status, DELIVERED))).toBeNull()
    expect(foldedStub(FRAME(notification('a', status, 'Process exited with code 137.')))).toBeNull()
  }
  expect(foldedStub(notification('a', 'completed', 'All 14 tests pass.'))).toBeNull()
  expect(foldedStub(notification('a', 'completed', WAITING))).toBeNull()
  expect(foldedStub(notification('a', 'completed', `${DELIVERED} ${'More findings. '.repeat(40)}`))).toBeNull()
  const block = notification('a', 'completed', DELIVERED)
  expect(foldedStub(`${block}\n${block}`)).toBeNull()
  expect(foldedStub(`${'The person wrote a long message here. '.repeat(20)}\n${block}`)).toBeNull()
  expect(foldedStub('please fix the grader')).toBeNull()
})

const AGGRESSIVE: Settings = { ...SETTINGS, aggressiveIdle: true }
const REPORT_TEXT = 'Live checks are done: two verified, one fixed. The suite is green at e48dabb0 and the branch is pushed for review.'
/** The ledger after builder-a's report at time 0, under `settings`. */
function afterReport(settings: Settings) {
  const [verdict] = judgeTeammates([delivery(teammateMessage('builder-a', REPORT_TEXT))], EMPTY_LEDGER, 0, settings)

  return remember(EMPTY_LEDGER, verdict?.key ?? '', verdict?.digest ?? '', 0, settings.windowMs, verdict?.text)
}
const bare = (result: string, more: Record<string, unknown> = {}) => delivery(idleNotice('builder-a', result, { idleReason: undefined, ...more }))
const ECHO = { summary: '[to builder-b] Heads for the branch ledger' }

test('a bundle parses to its blocks, through the preamble and the trailer; anything looser to nothing', () => {
  expect(parseTeammateBundle(peerDelivery(IDLE))).toEqual([parseTeammateMessage(IDLE)])
  expect(parseTeammateBundle(peerDelivery(REPORT, IDLE))?.map(block => block.teammate)).toEqual(['builder-a', 'builder-a'])
  expect(parseTeammateBundle(`${IDLE}\n\n${IDLE}`)).toHaveLength(2)
  expect(parseTeammateBundle(`${IDLE}\nother words after it`)).toBeNull()
  expect(parseTeammateBundle(`${IDLE}\nwords between\n${IDLE}`)).toBeNull()
  expect(parseTeammateBundle(`words before ${IDLE}`)).toBeNull()
  expect(parseTeammateBundle(teammateMessage('builder-a', `quoting ${IDLE}`))).toBeNull()
  expect(parseTeammateBundle('just words')).toBeNull()
  // The switch off reads one whole block, in the harness's frame (as every live delivery comes) or not, and never a bundle.
  expect(parseTeammateDelivery(peerDelivery(IDLE), false)).toEqual([parseTeammateMessage(IDLE)])
  expect(parseTeammateDelivery(IDLE, false)).toHaveLength(1)
  expect(parseTeammateDelivery(peerDelivery(IDLE, IDLE), false)).toBeNull()
  expect(parseTeammateDelivery(`${IDLE}\nother words after it`, false)).toBeNull()
  expect(parseTeammateDelivery(peerDelivery(IDLE, IDLE), true)).toHaveLength(2)
})

test('signals, a pure waiting status and a restatement are told apart', () => {
  for (const text of ['Blocked on runner capacity.', 'Which head do I build?', 'Two tests failed.', 'I need the SHA.', "Waiting on the lead's decision.", 'An error in the feeder.', '309 passed at de86c575.', 'Oracle at 41/43.', 'Score 0.83.', '92% done']) {
    expect(hasSignal(text)).toBe(true)
  }
  expect(hasSignal('Waiting on the build 228 hand-off and the queued replay runs at `8c1738c4`.')).toBe(false)
  expect(isWaitingStatus('Waiting on the staging runs and the helper report.')).toBe(true)
  expect(isWaitingStatus('Still waiting for the six bisect runs.')).toBe(true)
  expect(isWaitingStatus('Standing by.')).toBe(true)
  expect(isWaitingStatus('No change since the last report.')).toBe(true)
  expect(isWaitingStatus('The merge is prepared; waiting on the lead.')).toBe(false)
  expect(isWaitingStatus(`Waiting on the staging server. ${'More words. '.repeat(20)}`)).toBe(false)
  expect(restates(REPORT_TEXT, REPORT_TEXT)).toBe(true)
  expect(restates(`  ${REPORT_TEXT.toUpperCase()}\n`, REPORT_TEXT)).toBe(true)
  expect(restates('The suite is green at e48dabb0 and the branch is pushed for review.', REPORT_TEXT)).toBe(true)
  expect(restates('The suite is green at e48dabb0 but the branch is not pushed, pending one more rerun of it.', REPORT_TEXT)).toBe(false)
  expect(restates('The suite is green', REPORT_TEXT)).toBe(false)
  expect(restates('', '')).toBe(false)
})

test('aggressive: an echo to a peer, a restatement and a pure waiting status drop after a report, as often as they come', () => {
  const reported = afterReport(AGGRESSIVE)
  const cases: [ReturnType<typeof delivery>, string][] = [
    [bare('Heads sent to builder-b; the watcher is armed.', ECHO), 'idle-peer-echo'],
    [bare('The suite is green at e48dabb0 and the branch is pushed for review.'), 'idle-restatement'],
    [bare('Waiting on the staging runs and the helper report.'), 'idle-waiting'],
  ]
  for (const [notice, kind] of cases) {
    // Dropped without spending the report or moving its window.
    expect(judgeTeammate(notice, reported, MINUTE, AGGRESSIVE)).toMatchObject({ drop: kind, key: null })
    expect(judgeTeammate(notice, reported, 29 * MINUTE, AGGRESSIVE).drop).toBe(kind)
    expect(judgeTeammate(notice, reported, 30 * MINUTE, AGGRESSIVE).drop).toBeNull()
    // With the switch off none of the three drops: each is aggressiveIdle's alone.
    expect(judgeTeammate(notice, afterReport(SETTINGS), MINUTE, SETTINGS).drop).toBeNull()
  }
  // The plain idle notice after a report still drops once, as with the switch off, and keeps the report's text.
  const idle = judgeTeammate(delivery(IDLE), reported, MINUTE, AGGRESSIVE)
  expect(idle).toMatchObject({ drop: 'idle-after-report', key: 'report:main:builder-a', text: REPORT_TEXT })
  // With no idleReason and none of the three classes, a notice passes.
  expect(judgeTeammate(bare('The merge is prepared and the worktree is clean.'), reported, MINUTE, AGGRESSIVE).drop).toBeNull()
})

test('aggressive: a signal, a first contact, a failure and anything that is no idle notice always pass', () => {
  const reported = afterReport(AGGRESSIVE)
  const signals = ['Blocked on runner capacity; waiting on the lead.', 'Waiting on the lead: which head do I build?', 'Waiting on the rerun; two tests failed.', 'Waiting on reviewer-2; I need its ruling.', "Waiting on the lead's decision.", 'Waiting on the rerun (309 passed so far).']
  for (const result of signals) {
    expect(judgeTeammate(bare(result), reported, MINUTE, AGGRESSIVE).drop).toBeNull()
    expect(judgeTeammate(bare(result, ECHO), reported, MINUTE, AGGRESSIVE).drop).toBeNull()
  }
  // A question in a summary that is not an echo's counts too.
  expect(judgeTeammate(bare('Waiting on the staging runs.', { summary: 'Which seed next?' }), reported, MINUTE, AGGRESSIVE).drop).toBeNull()
  // The only signal: no report from this teammate, or one past the window, to another loop, from another teammate.
  for (const notice of [bare('Waiting on the staging runs.'), bare('Heads sent.', ECHO)]) {
    expect(judgeTeammate(notice, EMPTY_LEDGER, MINUTE, AGGRESSIVE).drop).toBeNull()
    expect(judgeTeammate(notice, reported, 31 * MINUTE, AGGRESSIVE).drop).toBeNull()
    expect(judgeTeammate({ ...notice, loop: 'a7' }, reported, MINUTE, AGGRESSIVE).drop).toBeNull()
  }
  expect(judgeTeammate(delivery(idleNotice('builder-b', 'Waiting on the staging runs.')), reported, MINUTE, AGGRESSIVE).drop).toBeNull()
  for (const more of [{ idleReason: 'failed' }, { idleReason: 'interrupted' }, { failureReason: 'API error' }, { completedStatus: 'failed' }, { from: 'someone-else' }]) {
    expect(judgeTeammate(bare('Waiting on the staging runs.', { ...ECHO, ...more }), reported, MINUTE, AGGRESSIVE).drop).toBeNull()
  }
  const shutdown = teammateMessage('builder-a', '{"type":"shutdown_request","summary":"[to builder-b] x","result":"Waiting on the staging runs."}')
  expect(judgeTeammate(delivery(shutdown), reported, MINUTE, AGGRESSIVE)).toMatchObject({ drop: null, key: null })
  // Prose is a report whatever it says, and broken JSON is prose.
  expect(judgeTeammate(delivery(teammateMessage('builder-a', 'Waiting on the staging runs.')), reported, MINUTE, AGGRESSIVE)).toMatchObject({ drop: null, key: 'report:main:builder-a' })
  expect(judgeTeammate(delivery(teammateMessage('builder-a', '{"type":"idle_notification","from":"builder-a"')), reported, MINUTE, AGGRESSIVE).drop).toBeNull()
})

test('aggressive: the blocks of a bundle are judged in order, each after the ones before it', () => {
  const blocks = [teammateMessage('builder-a', REPORT_TEXT), idleNotice('builder-a', 'Waiting on the staging runs.')].map(text => delivery(text))
  expect(judgeTeammates(blocks, EMPTY_LEDGER, 0, AGGRESSIVE).map(verdict => verdict.drop)).toEqual([null, 'idle-waiting'])
  expect(judgeTeammates(blocks.slice(1), EMPTY_LEDGER, 0, AGGRESSIVE).map(verdict => verdict.drop)).toEqual([null])
})

// --- 0.2.0 ---

const same = (a: string, b: string) => expect(fingerprint(a)).toBe(fingerprint(b))
const differs = (a: string, b: string) => expect(fingerprint(a)).not.toBe(fingerprint(b))

test('fingerprints ignore timestamp prefixes and fields, prefixed ids, counter fields and session folders', () => {
  same('[2026-11-21T10:00:00.123Z] Built.', '[2026-11-21T10:07:41Z] Built.')
  same('2026-11-21 10:00 Built.', '2026-11-21 11:30 Built.')
  same('Head\n10:00:01 - checked the suite.', 'Head\n10:12:59 - checked the suite.')
  same('1763719200000: stamp.', '1763719299999: stamp.')
  same('{"timestamp":"2026-10-12T16:12:46.764Z","x":1}', '{"timestamp":"2026-10-12T16:20:01.002Z","x":1}')
  same('Built. created_at: 2026-11-21T10:00:00Z', 'Built. created_at: 2026-11-21T10:09:00Z')
  same('duration_ms: 5, tokens=1200, total_tokens: 99', 'duration_ms: 77, tokens=3, total_tokens: 4,100')
  same('Done <usage><total_tokens>5</total_tokens><duration_ms>9</duration_ms></usage>', 'Done <usage><total_tokens>6</total_tokens></usage>')
  same('<task-id>a6326e81f62f22495</task-id> is parked.', '<task-id>abf697dea4e358fda</task-id> is parked.')
  same('agentId: a6326e81f62f22495 is parked.', 'agentId: abf697dea4e358fda is parked.')
  same('{"agent_id":"a6326e81f62f22495"}', '{"agent_id":"abf697dea4e358fda"}')
  same('Run 7cc47792-7be2-41cb-af79-bbdba81adb7d failed.', 'Run 29bfc81a-2c32-45ce-b1a2-86ef325e1e6b failed.')
  same('Call toolu_01PiC3KxDR54gsVQKgHTrbDJ ended.', 'Call toolu_01D751w94cjLDWwYygi71x2M ended.')
  same('See /private/tmp/claude-1000/-Users-x/e7a9/tasks/a1.output for it.', 'See /private/tmp/claude-1000/-Users-x/9f2c/tasks/a1.output for it.')
  same('Wrote /private/tmp/claude-1000/-Users-x/e7a9/scratchpad/out.json.', 'Wrote /private/tmp/claude-1000/-Users-y/9f2c/scratchpad/out.json.')
  same('Saved ~/.claude/projects/p1/tool-results/b54.txt', 'Saved ~/.claude/projects/p2/tool-results/b54.txt')
})

test('fingerprints keep what a reader reads: shas, prose durations and dates, file names, bare ids', () => {
  const sha = (c: string) => c.repeat(40)
  differs(`Pushed ${sha('3')} to feat/x; please rebase.`, `Pushed ${sha('9')} to feat/x; please rebase.`)
  differs(`Pushed 3f9c${'0'.repeat(36)} to feat/x.`, `Pushed 3f9d${'0'.repeat(36)} to feat/x.`)
  differs('p50 latency 120ms.', 'p50 latency 45ms.')
  differs('Took 681683ms.', 'Took 12ms.')
  differs('Took 12.4s.', 'Took 3s.')
  differs('Took 3m 20s.', 'Took 4m05s.')
  differs('Took 1h2m3s.', 'Took 2h.')
  differs('Waited 5 seconds.', 'Waited 12 secs.')
  differs('Used 2,431 tokens.', 'Used 99 tokens.')
  differs('Built at 2026-11-21T10:00:00Z.', 'Built at 2026-11-22T10:00:00Z.')
  differs('Checked at 10:00:01.', 'Checked at 10:12:59.')
  differs('Deadline 2026-11-21.', 'Deadline 2026-11-22.')
  differs('Agent a6326e81f62f22495 is parked.', 'Agent abf697dea4e358fda is parked.')
  differs('Wrote /private/tmp/claude-1000/-Users-x/e7a9/scratchpad/a.md.', 'Wrote /private/tmp/claude-1000/-Users-x/e7a9/scratchpad/b.md.')
  differs('Wrote /Users/x/scratch/scratchpad/run-1/out.json.', 'Wrote /Users/x/scratch/scratchpad/run-2/out.json.')
  differs('See /private/tmp/claude-1000/-Users-x/e7a9/tasks/a1.output.', 'See /private/tmp/claude-1000/-Users-x/e7a9/tasks/b2.output.')
  differs('Saved ~/.claude/projects/p/tool-results/b54.txt', 'Saved ~/.claude/projects/p/tool-results/c99.txt')
  // A named field holding something other than its kind of value is left alone.
  differs('timestamp: soon, built', 'timestamp: later, built')
  differs('task-id: build-fix', 'task-id: build-feat')
})

test('regression: a changed sha, latency, scratchpad file or date is never a repeat, in any door', () => {
  const sha = (c: string) => `3f9c${c.repeat(36)}`
  const pairs = [
    [`Pushed ${sha('0')} to feat/x; please rebase onto it before your next run of the suite.`, `Pushed ${sha('1')} to feat/x; please rebase onto it before your next run of the suite.`],
    ['p50 latency 120ms on the new cache path after the warmup; p99 still pending, numbers in the doc.', 'p50 latency 45ms on the new cache path after the warmup; p99 still pending, numbers in the doc.'],
    ['Wrote the findings to /private/tmp/claude-1000/-Users-x/e7a9/scratchpad/a.md; read it before deciding.', 'Wrote the findings to /private/tmp/claude-1000/-Users-x/e7a9/scratchpad/b.md; read it before deciding.'],
    ['Freeze is set for 2026-11-21; every task must pass QC by then or it slips to the next cut, no exceptions.', 'Freeze is set for 2026-11-22; every task must pass QC by then or it slips to the next cut, no exceptions.'],
  ] as const
  const PEER = { kind: 'peer' }
  for (const [a, b] of pairs) {
    const peer = judgePeer(PEER, crossSession('s1', a), EMPTY_LEDGER, 0, SETTINGS)
    const peerSeen = remember(EMPTY_LEDGER, peer?.key ?? '', peer?.digest ?? '', 0, SETTINGS.windowMs)
    expect(judgePeer(PEER, crossSession('s1', b), peerSeen, MINUTE, SETTINGS)?.drop).toBeNull()
    expect(judgePeer(PEER, crossSession('s1', a), peerSeen, MINUTE, SETTINGS)?.drop).toBe('repeat-peer')

    const note = judgePrompt(TASK, notification('t', 'completed', a), EMPTY_LEDGER, 0, SETTINGS)
    const noteSeen = remember(EMPTY_LEDGER, note.key ?? '', note.digest, 0, SETTINGS.windowMs)
    expect(judgePrompt(TASK, notification('t', 'completed', b), noteSeen, MINUTE, SETTINGS).drop).toBeNull()
    expect(judgePrompt(TASK, notification('t', 'completed', a, 7), noteSeen, MINUTE, SETTINGS).drop).toBe('repeat-notification')

    const sent = judgeSend({ agentId: 'lead', to: 'peer', text: a }, EMPTY_LEDGER, 0, SETTINGS)
    const sentSeen = remember(EMPTY_LEDGER, sent.key ?? '', sent.digest, 0, SETTINGS.windowMs)
    expect(judgeSend({ agentId: 'lead', to: 'peer', text: b }, sentSeen, MINUTE, SETTINGS).drop).toBeNull()
    expect(judgeSend({ agentId: 'lead', to: 'peer', text: a }, sentSeen, MINUTE, SETTINGS).drop).toBe('repeat-send')
  }
})

test('fingerprints keep every ordinary number: an updated metric, count, share or commit is news', () => {
  differs('Interim: 3 of 9 images built.', 'Interim: 4 of 9 images built.')
  differs('AUC 0.71 on the held-out set.', 'AUC 0.74 on the held-out set.')
  differs('Pass rate 45%.', 'Pass rate 47%.')
  differs('5/7 seeds pass.', '6/7 seeds pass.')
  differs('Rebased onto e48dabb0.', 'Rebased onto f1c2d3e4.')
  differs('Edited /repo/tasks/a.py.', 'Edited /repo/tasks/b.py.')
  differs('Built 4m rows.', 'Built 5m rows.')
  differs('Exit code 137.', 'Exit code 1.')
  differs('In the 1990s.', 'In the 2000s.')
  differs('Released on 2026-11-21.', 'Released on 2026-11-22.')
})

test('a repeat check ignores volatile tokens, and boilerplate is still read from the text as written', () => {
  const at = (when: string, tokens: number) => notification('a', 'completed', `[${when}] Interim: 3 of 9 built, log in /private/tmp/claude-1000/p/s${tokens}/tasks/a.output.`, tokens)
  const first = judgePrompt(TASK, at('2026-11-21T10:00:00Z', 1), EMPTY_LEDGER, 0, SETTINGS)
  const seen = remember(EMPTY_LEDGER, 'task:a', first.digest, 0, SETTINGS.windowMs)
  expect(judgePrompt(TASK, at('2026-11-21T10:03:00Z', 2), seen, MINUTE, SETTINGS).drop).toBe('repeat-notification')
  expect(judgePrompt(TASK, notification('a', 'completed', '[2026-11-21T10:03:00Z] Interim: 4 of 9 built, log in /private/tmp/claude-1000/p/s2/tasks/a.output.'), seen, MINUTE, SETTINGS).drop).toBeNull()
  // A changed id in "report was delivered" is still that class; an id in other wording is not boilerplate.
  expect(boilerplateClass(parseNotification(notification('a', 'completed', DELIVERED.replace('a82785c8bcb821f53', 'a0000000000000001'))))).toBe('delivered')
  expect(boilerplateClass(parseNotification(notification('a', 'completed', DELIVERED.replace("This agent's report", 'The report'))))).toBeNull()
})

test('a scheduled prompt and a send are compared on their fingerprints too', () => {
  const cron = { kind: 'scheduled-trigger' }
  const first = judgePrompt(cron, '[2026-11-21T10:00:00Z] Check the suite.', EMPTY_LEDGER, 0, SETTINGS)
  const seen = remember(EMPTY_LEDGER, first.key ?? '', first.digest, 0, SETTINGS.windowMs)
  expect(judgePrompt(cron, '[2026-11-21T10:10:00Z] Check the suite.', seen, MINUTE, SETTINGS).drop).toBe('repeat-prompt')
  const text = (n: number) => `Rebase fix/cache-infra onto e48dabb0, rerun the full integration suite and report the pass rate; last run duration_ms: ${n}.`
  const sent = judgeSend({ agentId: 'lead', to: 'speed', text: text(12) }, EMPTY_LEDGER, 0, SETTINGS)
  const had = remember(EMPTY_LEDGER, sent.key ?? '', sent.digest, 0, SETTINGS.windowMs)
  expect(judgeSend({ agentId: 'lead', to: 'speed', text: text(40) }, had, MINUTE, SETTINGS).drop).toBe('repeat-send')
})

test('a near-miss is a short completed result about delivery, messages or "not reported" that matches neither class', () => {
  const probe = (result: string, status = 'completed') => probeOf(parseNotification(notification('a', status, result)))
  expect(probe(DELIVERED)).toBe('match')
  expect(probe(WAITING)).toBe('match')
  expect(probe('Your report was handed over as a message from "a1"; see it there.')).toBe('near-miss')
  expect(probe('This agent is still working and has not reported yet.')).toBe('near-miss')
  expect(probe('Report delivered via SubagentHandback.')).toBe('near-miss')
  expect(probe('All 14 tests pass.')).toBeNull()
  expect(probe(`The message ${'x '.repeat(300)}`)).toBeNull()
  expect(probe(DELIVERED, 'failed')).toBeNull()
})

test('a subagent\'s own hand-back is never a near-miss, however much it talks of messages or delivery', () => {
  const probe = (result: string) => probeOf(parseNotification(notification('a', 'completed', result)))
  // Real results from the demo sessions, each of which counted as a near-miss and raised the drift toast.
  const handBacks = [
    'Shard 4 is done. Its `.done` file contains one line: `accuracy 0.84`\n\nI sent the "still running" message to main once. A hook blocked the repeat sends as duplicates, so I kept checking without resending until the file appeared.',
    'Shard 2 finished. `logs/shard-2.done` contains one line: `accuracy 0.82`\n\nThe status message went to main once. A plugin hook blocked the repeat sends as duplicates, so I kept polling the file without messaging.',
    'Shard 1 is done. `logs/shard-1.done` reads: `accuracy 0.81`\n\nThe duplicate-message hook blocked my second "still running" message to main. I polled directly instead, and the file appeared on a later check.',
    'shard 3 finished. Its `.done` file reads: `accuracy 0.83`\n\nIt appeared on the third 10-second check. I sent the "still running" message to main after each of the two earlier misses.',
    'The `SubagentHandback` tool you asked for isn\'t available in this session. I searched for it and nothing matched, and it isn\'t in the tool list, so I couldn\'t use it.\n\nHere is the report:\n\nhi',
    'Done. I delivered the fix to the team lead as a message and pushed the branch.',
  ]
  for (const result of handBacks) {
    expect(probe(result)).toBeNull()
  }
  // The real "report was delivered" notice, with any agent id, is a match.
  expect(probe('This agent\'s report was delivered to you as a message from "a0140a0d5c0bc46a7" (its SubagentHandback call). Read it there; it is not repeated here.')).toBe('match')
})

test('drift: near-misses with no match in a session', () => {
  let ledger = EMPTY_LEDGER
  for (let i = 0; i < 2; i += 1) {
    ledger = countProbe(ledger, 'near-miss')
  }
  expect(isDrifting(ledger)).toBe(false)
  ledger = countProbe(ledger, 'near-miss')
  expect(isDrifting(ledger)).toBe(true)
  expect(isDrifting(countProbe(ledger, 'match'))).toBe(false)
  // A ledger an older version stored has neither field.
  expect(isDrifting({ counts: {}, drops: [], seen: {} })).toBe(false)
})

test('a cross-session message parses only as one whole block, in the frame or not', () => {
  const body = 'Your diagnosis is right: the verifier never received /app/outputs. Re-export with the artifacts fix.'
  expect(parseCrossSession(crossSession('uds:/tmp/cc-socks/1.sock', body))).toEqual({ from: 'uds:/tmp/cc-socks/1.sock', body })
  expect(parseCrossSession(crossSession('uds:/tmp/cc-socks/1.sock', body, false))).toEqual({ from: 'uds:/tmp/cc-socks/1.sock', body })
  expect(parseCrossSession(`${crossSession('s', body, false)}\nwords after`)).toBeNull()
  expect(parseCrossSession(`words before ${crossSession('s', body, false)}`)).toBeNull()
  expect(parseCrossSession(crossSession('s', body, false) + crossSession('s', body, false))).toBeNull()
  expect(parseCrossSession('<cross-session-message>no sender</cross-session-message>')).toBeNull()
  expect(parseCrossSession(body)).toBeNull()
})

test('a cross-session repeat drops per sender inside the window; short, new, other-origin or switched off it passes', () => {
  const PEER = { kind: 'peer' }
  const body = (n: string) => `${n} Status: the export is re-pushed as version 2 and the trial is re-running now; findings soon.`
  const first = judgePeer(PEER, crossSession('s1', body('10:00:00')), EMPTY_LEDGER, 0, SETTINGS)
  expect(first).toMatchObject({ drop: null, key: expect.stringContaining('peer:s1:') })
  const seen = remember(EMPTY_LEDGER, first?.key ?? '', first?.digest ?? '', 0, SETTINGS.windowMs)
  expect(judgePeer(PEER, crossSession('s1', body('10:05:31')), seen, MINUTE, SETTINGS)?.drop).toBe('repeat-peer')
  expect(judgePeer(PEER, crossSession('s2', body('10:00:00')), seen, MINUTE, SETTINGS)?.drop).toBeNull()
  expect(judgePeer(PEER, crossSession('s1', body('2 of 3')), seen, MINUTE, SETTINGS)?.drop).toBeNull()
  expect(judgePeer(PEER, crossSession('s1', body('10:00:00')), seen, 30 * MINUTE, SETTINGS)?.drop).toBeNull()
  expect(judgePeer(PEER, crossSession('s1', body('10:00:00')), seen, MINUTE, { ...SETTINGS, dropsPeerRepeats: false })?.drop).toBeNull()
  expect(judgePeer(PEER, crossSession('s1', 'ok'), seen, MINUTE, SETTINGS)?.key).toBeNull()
  // Not a peer, or not one block: not judged at all.
  expect(judgePeer({ kind: 'composer' }, crossSession('s1', body('10:00:00')), seen, MINUTE, SETTINGS)).toBeNull()
  expect(judgePeer(PEER, 'Report: suite green.', seen, MINUTE, SETTINGS)).toBeNull()
})

test('settings are read field by field and fall back to their defaults', () => {
  expect(settingsOf(undefined)).toEqual(DEFAULT_SETTINGS)
  expect(settingsOf(null)).toEqual(DEFAULT_SETTINGS)
  expect(settingsOf('junk')).toEqual(DEFAULT_SETTINGS)
  const odd = settingsOf({ dropWaiting: 'false', dropDelivered: 0, aggressiveIdle: 'true', showToasts: 'yes', windowMinutes: '10', sendMinChars: -5, foldMode: 'drop' })
  expect(odd).toMatchObject({ dropsWaiting: false, dropsDelivered: true, aggressiveIdle: true, showsToasts: false, windowMs: 10 * MINUTE, sendMinChars: 80, foldMode: 'empty' })
  for (const windowMinutes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e9, '', 'x']) {
    expect(settingsOf({ windowMinutes }).windowMs).toBe(30 * MINUTE)
  }
  expect(settingsOf({ foldMode: 'stub', dropPeerRepeats: false, dropRepeatFailures: false, showStatus: false, driftAlerts: false })).toMatchObject({
    foldMode: 'stub',
    dropsPeerRepeats: false,
    dropsRepeatFailures: false,
    showsStatus: false,
    alertsDrift: false,
  })
})

test('the ledger holds at most its cap under load, newest first, and the drop list ten', () => {
  let ledger = EMPTY_LEDGER
  for (let i = 0; i < 3 * MAX_SEEN; i += 1) {
    ledger = remember(ledger, `prompt:plugin:${i}`, String(i), i, SETTINGS.windowMs)
    ledger = countDrop(ledger, { at: i, kind: 'repeat-prompt', excerpt: String(i) })
  }
  expect(Object.keys(ledger.seen)).toHaveLength(MAX_SEEN)
  expect(ledger.seen[`prompt:plugin:${3 * MAX_SEEN - 1}`]).toBeDefined()
  expect(ledger.seen['prompt:plugin:0']).toBeUndefined()
  expect(ledger.drops).toHaveLength(10)
  expect(ledger.counts['repeat-prompt']).toBe(3 * MAX_SEEN)
})

test('stored counters are parsed defensively and added to', () => {
  expect(parseTotals(undefined, 5)).toBeNull()
  expect(parseTotals('junk', 5)).toBeNull()
  expect(parseTotals([], 5)).toBeNull()
  expect(parseTotals({}, 5)).toEqual(emptyTotals(5))
  const bad = parseTotals({ since: 'x', drops: { waiting: -3, delivered: 2.7, bogus: 9 }, folded: 'many', matches: 4, nearMisses: null, lastNearMiss: { at: 'x' }, lastDriftWarningAt: 'x' }, 5)
  expect(bad).toEqual({ since: 5, drops: { delivered: 2 }, folded: 0, matches: 4, nearMisses: 0 })
  let totals = emptyTotals(0)
  totals = addToTotals(totals, { drop: 'delivered', isFolded: true, probe: 'match', excerpt: 'x' }, MINUTE)
  totals = addToTotals(totals, { probe: 'near-miss', excerpt: 'handed over as a message' }, 2 * MINUTE, true)
  expect(totals).toMatchObject({ drops: { delivered: 1 }, folded: 1, matches: 1, nearMisses: 1, lastDriftWarningAt: 2 * MINUTE })
  expect(parseTotals(JSON.parse(JSON.stringify(totals)), 9)).toEqual(totals)
  const text = totalsReport(totals, 5 * MINUTE, INDIA)
  expect(text).toContain('all sessions since 1970-01-01: 1 dropped')
  expect(text).toContain('    1  delivered')
  expect(text).toContain('boilerplate matches 1, near-misses 1')
  expect(text).toContain('last near-miss 3m ago: handed over as a message')
  expect(text).toContain('wording-drift warning last raised 1970-01-01')
})

// Pinned zones, as `getTimezoneOffset` gives them (minutes west of UTC): the tests read the same on any machine.
const INDIA = () => -330
const LOS_ANGELES = () => 8 * 60

test('the "since" day is the local calendar day, not the UTC one', () => {
  // 2026-11-22 03:00 UTC: the evening of 11-21 in Los Angeles (UTC-8), already 11-22 in Auckland (UTC+13).
  const at = Date.UTC(2026, 10, 22, 3, 0, 0)
  expect(localDayOf(at, 8 * 60)).toBe('2026-11-21')
  expect(localDayOf(at, -13 * 60)).toBe('2026-11-22')
  expect(localDayOf(at, 0)).toBe('2026-11-22')
  // 2026-11-21 20:00 UTC is already 01:30 on 11-22 in India (UTC+5:30), a half-hour zone.
  expect(localDayOf(Date.UTC(2026, 10, 21, 20, 0), -330)).toBe('2026-11-22')
  expect(localDayOf(Date.UTC(2026, 10, 21, 18, 29), -330)).toBe('2026-11-21')
  expect(totalsReport(emptyTotals(at), at, LOS_ANGELES)).toContain('all sessions since 2026-11-21: 0 dropped')
  expect(totalsReport(emptyTotals(at), at, INDIA)).toContain('all sessions since 2026-11-22: 0 dropped')
})

test('the drift warning\'s day is the local calendar day too', () => {
  const at = Date.UTC(2026, 10, 21, 20, 0)
  expect(totalsReport({ ...emptyTotals(at), lastDriftWarningAt: at }, at, INDIA)).toContain('wording-drift warning last raised 2026-11-22')
  expect(totalsReport({ ...emptyTotals(at), lastDriftWarningAt: at }, at, LOS_ANGELES)).toContain('wording-drift warning last raised 2026-11-21')
})

test('the UTC day an older version stored seeds the warning time when it is today, so the toast is not raised twice on upgrade day', () => {
  const at = Date.UTC(2026, 10, 22, 4, 43)
  const legacy = (day: unknown, now: number) => parseTotals({ since: 0, drops: {}, folded: 0, matches: 0, nearMisses: 3, lastDriftWarning: day }, now)
  expect(legacy('2026-11-22', at)?.lastDriftWarningAt).toBe(at)
  expect(totalsReport(legacy('2026-11-22', at) ?? emptyTotals(at), at, INDIA)).toContain('last raised 2026-11-22')
  // Another day, or no day at all, is let go: it can only have been before today.
  for (const day of ['2026-11-21', '2026-11-23', 'junk', 7, null]) {
    expect(legacy(day, at)?.lastDriftWarningAt).toBeUndefined()
  }
  // A time a newer version stored wins over the old day.
  expect(parseTotals({ lastDriftWarning: '2026-11-22', lastDriftWarningAt: 5 }, at)?.lastDriftWarningAt).toBe(5)
})

test('a message from an agent of this session parses as one whole <agent-message> block, framed or bare', () => {
  const body = 'shard 1 is done. logs/shard-1.done contains: accuracy 0.81'
  expect(parseAgentMessage(agentMessage('shard-1-watch', body))).toEqual({ from: 'shard-1-watch', body })
  expect(parseAgentMessage(agentMessage('shard-1-watch', body, false))).toEqual({ from: 'shard-1-watch', body })
  expect(parseAgentMessage(`${agentMessage('s', body, false)}\nwords after`)).toBeNull()
  expect(parseAgentMessage(`words before ${agentMessage('s', body, false)}`)).toBeNull()
  expect(parseAgentMessage(agentMessage('s', body, false) + agentMessage('s', body, false))).toBeNull()
  expect(parseAgentMessage('<agent-message>no sender</agent-message>')).toBeNull()
  expect(parseAgentMessage(body)).toBeNull()
  expect(isAgentDelivery({ kind: 'peer' }, agentMessage('s', body))).toBe(true)
  expect(isAgentDelivery({ kind: 'composer' }, agentMessage('s', body))).toBe(false)
})

test('a closing status only says the teammate is finished, adding nothing its report lacked', () => {
  const report = 'shard 1 is done. logs/shard-1.done contains: accuracy 0.81'
  for (const notice of [
    "I've sent that line to main; I'm done.",
    'The team lead has received it. I have nothing further to do.',
    "Main has the result. Shard 1 is done. I'm stopping here.",
  ]) {
    expect(isClosingStatus(notice, report)).toBe(true)
  }
  // Real closing notices that reword the report (backticks, or words of their own around the phrases) now pass.
  for (const notice of [
    "Shard 1 is finished, so there is nothing left to wait for. `logs/shard-1.done` contains `accuracy 0.81`, and I've sent that line to main.",
    'Shard 1 reported `accuracy 0.81`, and the team lead has received it. I have nothing further to do.',
    "Main has the result, so the watch is finished and I'm stopping.",
  ]) {
    expect(isClosingStatus(notice, report)).toBe(false)
  }
  for (const notice of [
    'Nothing further; shard 2 has 3 failed tests.',
    'Nothing further. Should I take shard 2?',
    "I'm done. The brief's path was wrong, so I used scratchpad/v2/repo.",
    "I'm done. I wrote eval_notes.md for you.",
    'Blocked on the staging server; nothing more I can do.',
    'Shard 1 finished at accuracy 0.81.',
    `Nothing further. ${'I also looked at every other log in the folder and compared them. '.repeat(3)}`,
  ]) {
    expect(isClosingStatus(notice, report)).toBe(false)
  }
})

// Plain prose that carries news after a report, with no number, path, question or signal word the
// report lacked: each was dropped as a closing or waiting status once.
const SHARD_REPORT = 'shard 1 is done. logs/shard-1.done contains: accuracy 0.81'
const PROSE_NEWS = [
  "I'm done, pushed branch hotfix-grader.",
  "I'm done. Pushed to main by mistake, please revert.",
  'Task is done but the run crashed halfway; results are partial.',
  "I'm done; could not push, permission denied.",
  "I'm finished — but don't merge yet, the grader is wrong.",
  'Work is done. Please review and merge.',
  'Waiting for your approval to push to main.',
  'Waiting on you to confirm the merge target.',
  'Standing by. Note: the staging server is out of disk.',
  'No change. The reviewer rejected the PR.',
  "I'm done. Also deleted the shared cache directory.",
  'Nothing further. Heads up: the prod deploy went out with my change.',
  'Nothing more from me; the results look wrong though.',
  'Nothing further. Shard 1 accuracy is 1.0, not what I said.',
]
const afterShardReport = (settings: Settings) => {
  const verdict = judgeTeammate({ teammate: 'w', body: SHARD_REPORT, loop: 'main' }, EMPTY_LEDGER, 0, settings)

  return remember(EMPTY_LEDGER, verdict.key ?? '', verdict.digest, 0, settings.windowMs, verdict.text)
}
const shardIdle = (result: string, idleReason?: string) => ({ teammate: 'w', loop: 'main', body: JSON.stringify({ type: 'idle_notification', from: 'w', idleReason, result }) })

test('plain prose with news is never a closing status, though it says it is done', () => {
  for (const notice of PROSE_NEWS) {
    expect(isClosingStatus(notice, SHARD_REPORT)).toBe(false)
  }
})

test('an idle notice in plain prose with news passes after a report, whatever its reason; under aggressiveIdle all but a waiting status', () => {
  for (const settings of [DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, aggressiveIdle: true }]) {
    const reported = afterShardReport(settings)
    // aggressiveIdle drops a waiting status with no signal word, whatever follows it, as it always has.
    for (const notice of PROSE_NEWS.filter(text => !settings.aggressiveIdle || !isWaitingStatus(text))) {
      for (const idleReason of [undefined, 'available']) {
        expect({ notice, idleReason, drop: judgeTeammate(shardIdle(notice, idleReason), reported, MINUTE, settings).drop }).toEqual({ notice, idleReason, drop: null })
      }
    }
  }
})

test('a closing status may hold only its report\'s words, filler and the closing phrase itself', () => {
  for (const notice of ['I have nothing further to do.', 'Nothing left. Shard 1 is done.', "I'm stopping here.", 'Reported to the team lead; nothing more to add.', 'My task is complete.']) {
    expect(isClosingStatus(notice, SHARD_REPORT)).toBe(true)
  }
  // One word the report did not hold is enough to pass.
  for (const notice of ['I have nothing further to do, sorry.', 'Nothing left. Shard 2 is done.', "I'm stopping here; retry later.", 'My task is complete. Rollback ready.']) {
    expect(isClosingStatus(notice, SHARD_REPORT)).toBe(false)
  }
})

// Reports that hold every word of the notice after them, so only filler, word order or the report's
// state can let the notice drop. Each notice is news, and once dropped closing notices are no longer
// capped, the filler list is the whole defence.
const FINAL_REPORT = 'shard 1 is done. logs/shard-1.done contains: accuracy 0.81. tests pass, merged to main, deploy went out.'
const LONG_REPORT =
  'Shard 1 is done and the eval finished with accuracy 0.81. I read the run log, then the shared folder listing, and the cache warmup took a while. ' +
  'The directory layout matches the brief. Earlier I deleted my own temp files. The team channel and the main thread both have the summary; ' +
  'the lead asked for the result line, which I sent. Deploy went out on schedule. Tests pass on the branch and it is merged to main.'
const INTERIM_REPORT = 'shard 1: still running, no .done file yet. Will keep checking and hand back the accuracy when it lands.'
const ADVERSARIAL: readonly (readonly [string, string])[] = [
  // Filler that carried meaning: "main", "lead", "team", "sent", "result", "more", "nothing", "add".
  [FINAL_REPORT, "I'm done. Main is red."],
  ['shard 1 done; result sent to the team lead.', "I'm done; sent the result to the wrong team."],
  ['shard 1 done; the lead can check main.', 'Nothing further, the lead should check main.'],
  [FINAL_REPORT, 'Nothing further. Main, sent.'],
  ['shard 1 done; shard 2 has failures', "I'm done. More failures in shard 2."],
  ['shard 1 done; 3 failed tests in shard 2', "I'm done. Nothing failed in shard 2."],
  ['shard 1 done; docs for shard 2', "I'm done. Add docs for shard 2."],
  // Negation, contrast and alarm, even when the report held the word.
  [FINAL_REPORT, "I'm done, not merged."],
  ['tests pass on the branch, but main is broken', "I'm done. main is broken"],
  ['the fix is merged; i did not push to main', "I'm done. I did push to main."],
  [FINAL_REPORT, "I'm done. Tests don't pass."],
  [FINAL_REPORT, "I'm done. Main isn't green."],
  [FINAL_REPORT, "I'm done, merge reverted."],
  [FINAL_REPORT, "I'm done. Deploy went out to prod by mistake."],
  [FINAL_REPORT, "I'm done; the lead has it wrong."],
  [FINAL_REPORT, "I'm done. Tests pass on main only."],
  [FINAL_REPORT, "I'm done. Sent the result line to the team, not main."],
  // A report that left something open: being finished is the news.
  [INTERIM_REPORT, "I'm done."],
  [INTERIM_REPORT, 'Shard 1 is finished; nothing further.'],
  ['shard 1 done; deploy pending', "I'm done. Deploy done."],
  // A long report's words, scattered, rearranged into a new statement.
  [LONG_REPORT, "I'm done. Deleted the shared cache directory."],
  [LONG_REPORT, "I'm done. Sent the team the cache."],
  [LONG_REPORT, "I'm done. Main has the deploy log."],
  [LONG_REPORT, "I'm done. The lead deleted the temp files."],
  [LONG_REPORT, 'Nothing further. Deploy the branch to main.'],
]

test('a closing notice built from its report\'s words, filler and closing phrases still passes when it is news', () => {
  for (const [report, notice] of ADVERSARIAL) {
    expect({ notice, isClosing: isClosingStatus(notice, report) }).toEqual({ notice, isClosing: false })
    expect({ notice, addsNothing: addsNothing(notice, report) }).toEqual({ notice, addsNothing: false })
    // By default nothing drops it. (aggressiveIdle's paraphrase class, opt-in, may drop a rewording of a long report.)
    const verdict = judgeTeammate({ teammate: 'w', body: report, loop: 'main' }, EMPTY_LEDGER, 0, DEFAULT_SETTINGS)
    const reported = remember(EMPTY_LEDGER, verdict.key ?? '', verdict.digest, 0, DEFAULT_SETTINGS.windowMs, verdict.text)
    for (const idleReason of [undefined, 'available']) {
      expect({ notice, idleReason, drop: judgeTeammate(shardIdle(notice, idleReason), reported, MINUTE, DEFAULT_SETTINGS).drop }).toEqual({ notice, idleReason, drop: null })
    }
  }
})

test('a closing notice that is empty, or one whole sentence of its report, once its phrases are out, drops', () => {
  for (const [report, notice] of [
    [FINAL_REPORT, "I'm done. Shard 1 is done."],
    [FINAL_REPORT, 'Tests pass, merged to main, deploy went out. Nothing further.'],
    [LONG_REPORT, "Deploy went out on schedule. I'm done."],
    ['shard 1 done', 'Reported to the team lead; nothing more to add.'],
    ['shard 1 done', "I'm done, nothing left to wait for."],
    ['shard 1 done', "I've sent that line to main. I'm stopping here."],
    ['shard 1 done', '  NOTHING FURTHER TO ADD!  '],
    // Curly quotes, backticks and emphasis do not change what it says.
    ['shard 1 done', 'I’m done, nothing left to wait for.'],
  ] as const) {
    expect({ notice, isClosing: isClosingStatus(notice, report) }).toEqual({ notice, isClosing: true })
  }
})

test('real closing notices that reword the report now pass', () => {
  for (const [report, notice] of [
    [FINAL_REPORT, "I'm done. Shard 1 is finished, tests pass and it is merged to main."],
    [FINAL_REPORT, 'Shard 1 reported `accuracy 0.81`, and the team lead has received it. I have nothing further to do.'],
    [FINAL_REPORT, "Main has the result (shard 1 accuracy 0.81), so the watch is finished and I'm stopping."],
    [LONG_REPORT, "I'm done. Shard 1 is done; accuracy 0.81. Nothing further."],
  ] as const) {
    expect({ notice, isClosing: isClosingStatus(notice, report) }).toEqual({ notice, isClosing: false })
  }
})

test('the rule: plain text once markup is out, then empty or exactly one whole sentence of the report', () => {
  const report = 'Shard 1 is done. Tests pass on main, deploy went out!\nAccuracy is 0.81'
  // Case, whitespace and the punctuation at either end do not matter; the words and their order do.
  for (const notice of ['', '  ', '...', 'shard 1 is done', '  TESTS PASS ON MAIN,   deploy went out.  ', 'Accuracy is 0.81.', "I'm done.", 'Sent it to main.', 'I’m done.', '**Shard 1 is done.**', '`Shard 1 is done.`', 'Shard 1 is done.\u00a0']) {
    expect({ notice, adds: addsNothing(notice, report) }).toEqual({ notice, adds: true })
  }
  for (const notice of [
    'deploy went out, tests pass on main',
    'Tests pass on main',
    'Shard 1 is done. Accuracy is 0.81.',
    'Shard 1 is done and accuracy is 0.81',
    'Tests pass on main deploy went out',
    'Nothing further?',
    'Shard 1 is done?',
    '~~Shard 1 is done~~',
    'Shard 1 is done \u2705',
    'Shard 1 is done [again]',
  ]) {
    expect({ notice, adds: addsNothing(notice, report) }).toEqual({ notice, adds: false })
  }
})

test('plainOf: curly quotes and a non-breaking space become ASCII, backticks and emphasis markers go; strikethrough and a lone * stay', () => {
  expect(plainOf('I’m ‘done’, “really”. Done.')).toBe('I\'m \'done\', "really". Done.')
  expect(plainOf('`logs/x` and ```code```')).toBe('logs/x and code')
  expect(plainOf('**bold**, *em*, ***both***, __under__, _em_, **a _b_ c**')).toBe('bold, em, both, under, em, a b c')
  // A `_` inside a word is no marker.
  expect(plainOf('WATCH_CLOSING and my_file_name, _my_file_name_')).toBe('WATCH_CLOSING and my_file_name, my_file_name')
  expect(plainOf('~~struck~~, a lone * and ** with spaces **')).toBe('~~struck~~, a lone * and ** with spaces **')
  expect(plainOf('本番 ✅ 🚨')).toBe('本番 ✅ 🚨')
})

// The real watcher's report, and content-free closing notices written the way real ones are: backticks
// round paths and figures, curly apostrophes, emphasis and a non-breaking space.
const WATCH_REPORT = 'shard 1 is done. logs/shard-1.done contains: accuracy 0.81'
const MARKED_CLOSINGS = [
  '`logs/shard-1.done` contains: `accuracy 0.81`. I’ve sent that line to main; I’m done.',
  '**Shard 1 is done.** I’m stopping here.',
  '*Shard 1 is done.* The team lead has received it. I’m done.',
  'I’ve sent that to main. _Nothing further to add._',
  'I am done; nothing further to add.',
  '`logs/shard-1.done contains: accuracy 0.81`. I’m done.',
]

test('a content-free closing notice written with backticks, emphasis or curly quotes drops', () => {
  for (const notice of MARKED_CLOSINGS) {
    expect({ notice, isClosing: isClosingStatus(notice, WATCH_REPORT) }).toEqual({ notice, isClosing: true })
    expect({ notice, adds: addsNothing(notice, WATCH_REPORT) }).toEqual({ notice, adds: true })
    const verdict = judgeTeammate({ teammate: 'w', body: WATCH_REPORT, loop: 'main' }, EMPTY_LEDGER, 0, DEFAULT_SETTINGS)
    const reported = remember(EMPTY_LEDGER, verdict.key ?? '', verdict.digest, 0, DEFAULT_SETTINGS.windowMs, verdict.text)
    for (const idleReason of [undefined, 'available']) {
      expect({ notice, idleReason, drop: judgeTeammate(shardIdle(notice, idleReason), reported, MINUTE, DEFAULT_SETTINGS).drop }).toEqual({ notice, idleReason, drop: 'idle-closing' })
    }
  }
  // Markup in the report is read the same way: a backticked path matches the bare one, and the other way round.
  expect(isClosingStatus("logs/shard-1.done contains: accuracy 0.81. I'm done.", 'shard 1 is done. `logs/shard-1.done` contains: **accuracy 0.81**')).toBe(true)
  expect(isClosingStatus('`merged fix/my_branch_name`. I’m done.', 'merged fix/my_branch_name')).toBe(true)
})

test('markup does not hide news: strikethrough, a different backticked path or figure, a lone *, emoji and other scripts pass', () => {
  for (const notice of [
    // Strikethrough changes what it says.
    '~~Shard 1 is done.~~ I’m done.',
    '`~~logs/shard-1.done~~` contains: accuracy 0.81. I’m done.',
    'Shard 1 is ~~done~~. I’m done.',
    // A backticked path or figure the report did not give.
    '`logs/shard-2.done` contains: `accuracy 0.81`. I’m done.',
    '`logs/shard-1.done.bak` contains: accuracy 0.81. I’m done.',
    '`logs/shard-1.done` contains: `accuracy 0.18`. I’m done.',
    '`logs/shard-1.done` contains: `accuracy 0.81` I’m done. `WATCH_CLOSING`',
    // A lone `*`, as in a glob or a footnote.
    'Shard 1 is done *. I’m done.',
    '`rm -rf logs/*`. I’m done.',
    // Emoji and other scripts, with or without markup round them.
    '**Shard 1 is done.** I’m done ✅',
    '`Shard 1 is done.` 本番のデータを削除してしまいました. I’m done.',
    'I’m done. _Тесты упали._',
    'I’m done 🚨',
    'I’m done now.',
  ]) {
    expect({ notice, isClosing: isClosingStatus(notice, WATCH_REPORT) }).toEqual({ notice, isClosing: false })
    expect({ notice, adds: addsNothing(notice, WATCH_REPORT) }).toEqual({ notice, adds: false })
  }
})

test('after a report that left something open, closing phrases stay in and are news; a delivery phrase alone is not', () => {
  for (const notice of ["I'm done.", 'Nothing further.', 'Shard 1 is finished; nothing further.']) {
    expect(addsNothing(notice, INTERIM_REPORT)).toBe(false)
    expect(isClosingStatus(notice, INTERIM_REPORT)).toBe(false)
  }
  expect(addsNothing('Sent that to main.', INTERIM_REPORT)).toBe(true)
  expect(addsNothing('Will keep checking and hand back the accuracy when it lands.', INTERIM_REPORT)).toBe(true)
})

test('a report longer than is kept is cut at its last whole sentence, so a cut sentence never matches', () => {
  const long = `${'Shard 1 is done. '.repeat(470)}Deploy went out to prod and staging failed badly.`
  expect(reportKept('Short report.')).toBe('Short report.')
  const kept = reportKept(long)
  expect(kept.length).toBeLessThanOrEqual(8000)
  expect(kept.endsWith('Shard 1 is done.')).toBe(true)
  const verdict = judgeTeammate({ teammate: 'w', body: long, loop: 'main' }, EMPTY_LEDGER, 0, DEFAULT_SETTINGS)
  const reported = remember(EMPTY_LEDGER, verdict.key ?? '', verdict.digest, 0, DEFAULT_SETTINGS.windowMs, verdict.text)
  for (const notice of ['Deploy went out to prod.', 'Deploy went out. Nothing further.', 'Deploy']) {
    expect(judgeTeammate(shardIdle(notice, 'available'), reported, MINUTE, DEFAULT_SETTINGS).drop).toBeNull()
  }
})

test('by default only a closing status drops of the further classes; waiting and restating notices are aggressiveIdle\'s', () => {
  const reported = afterShardReport(DEFAULT_SETTINGS)
  for (const notice of ['Waiting on the lead.', 'Standing by.', 'No change.', SHARD_REPORT]) {
    expect(judgeTeammate(shardIdle(notice), reported, MINUTE, DEFAULT_SETTINGS).drop).toBeNull()
  }
  expect(judgeTeammate(shardIdle('I have nothing further to do.'), reported, MINUTE, DEFAULT_SETTINGS).drop).toBe('idle-closing')
})

test('every closing notice that adds nothing drops inside the window; the plain "available" one only once per report', () => {
  for (const settings of [DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, aggressiveIdle: true }]) {
    let ledger = afterShardReport(settings)
    const judge = (body: ReturnType<typeof shardIdle>, at: number) => {
      const verdict = judgeTeammate(body, ledger, at, settings)
      if (verdict.key !== null) {
        ledger = remember(ledger, verdict.key, verdict.digest, at, settings.windowMs, verdict.text)
      }

      return verdict.drop
    }
    expect(judge(shardIdle('I have nothing further to do.'), MINUTE)).toBe('idle-closing')
    expect(judge(shardIdle('Nothing left. Shard 1 is done.'), 2 * MINUTE)).toBe('idle-closing')
    // A closing notice with reason "available" is judged as a closing notice, and spends nothing.
    expect(judge(shardIdle("I'm stopping here.", 'available'), 3 * MINUTE)).toBe('idle-closing')
    // The plain "available" notice, with no closing phrase, still has its one allowance per report.
    expect(judge(shardIdle('Shard 1 is done.', 'available'), 4 * MINUTE)).toBe('idle-after-report')
    expect(judge(shardIdle('Shard 1 is done.', 'available'), 5 * MINUTE)).toBeNull()
    expect(judge(shardIdle('', 'available'), 6 * MINUTE)).toBeNull()
    // Closing notices go on dropping: they were never what the allowance counted.
    expect(judge(shardIdle("I'm stopping here."), 7 * MINUTE)).toBe('idle-closing')
    // Past the window the notice enters. A closing drop does not extend it; the plain drop above did, once.
    expect(judge(shardIdle("I'm stopping here."), 33 * MINUTE)).toBe('idle-closing')
    expect(judge(shardIdle("I'm stopping here."), 35 * MINUTE)).toBeNull()
  }
})

// An independent adversarial check: every notice below carries news its report did not, yet each
// dropped under the old word-bag rule. None may drop, whatever its reason.
const NEWS_AFTER_REPORT: readonly (readonly [string, string])[] = [
  // Quantity and scope.
  ['Pushed 3 of 4 branches to origin.', 'Pushed all branches to origin; nothing further.'],
  ['3 of 4 tests passed on shard 1.', '4 of 4 tests passed on shard 1. Nothing further.'],
  ['Some shards passed the grader.', 'All shards passed the grader. Nothing further.'],
  ['Accuracy 0.81 on shard 1, 0.62 on shard 2.', 'Accuracy 0.81 on shard 2. Nothing further.'],
  ['Shard 1: 12 passed, 0 failed. Shard 2: 0 passed, 12 failed.', 'Shard 2: 12 passed, 0 failed.'],
  // Word order.
  ['Merged develop into fix/grader.', 'Merged fix/grader into develop. Nothing further.'],
  // Tense and subject.
  ['The old checkpoints were deleted; new ones are saved.', 'The new ones were deleted. Nothing further.'],
  ['Deleted the stale cache, kept the model checkpoints.', 'Deleted the model checkpoints. Nothing further.'],
  // A failure word the report held, re-attached to something else.
  ['Retried the timed out shard; the suite passed on shard A and shard B.', 'The suite timed out on shard B. Nothing further.'],
  ['Killed the old eval job; the new eval job finished cleanly.', 'New eval job killed. Nothing further.'],
  ['Shard 1 crashed and I restarted it; shard 2 is running.', 'Shard 2 crashed.'],
  ['Rolled back the staging deploy, prod deploy is live.', 'Prod deploy rolled back. Nothing further.'],
  // Pronoun, agent and file.
  ['I fixed the bug in your branch.', 'I fixed the bug in my branch. Nothing further.'],
  ['Pushed fix/a for worker-a and fix/b for worker-b.', 'Pushed fix/b for worker-a. Nothing further.'],
  // Non-English, emoji and markdown.
  ['Pushed fix/a.', 'Nothing further. 本番のデータを削除してしまいました'],
  ['Pushed fix/a.', 'Nothing further. Тесты упали, данные потеряны.'],
  ['Pushed fix/a.', 'Pushed fix/a ❌ nothing further.'],
  ['Pushed fix/a.', '~~Pushed fix/a~~. Nothing further.'],
  ['Deploy is running.', 'テストが失敗しました'],
  // A very short report.
  ['Done.', 'Done. Nothing further. 🚨🚨'],
  ['ok', 'ok, nothing further 💥'],
]

test('adversarial: no notice with news drops after its report, whatever its reason', () => {
  const dropped: string[] = []
  for (const [report, notice] of NEWS_AFTER_REPORT) {
    const verdict = judgeTeammate({ teammate: 'w', body: report, loop: 'main' }, EMPTY_LEDGER, 0, DEFAULT_SETTINGS)
    const reported = remember(EMPTY_LEDGER, verdict.key ?? '', verdict.digest, 0, DEFAULT_SETTINGS.windowMs, verdict.text)
    for (const idleReason of [undefined, 'available']) {
      const drop = judgeTeammate(shardIdle(notice, idleReason), reported, MINUTE, DEFAULT_SETTINGS).drop
      if (drop !== null) {
        dropped.push(`${drop} | ${idleReason} | ${report} | ${notice}`)
      }
    }
  }
  expect(dropped).toEqual([])
})

test('adversarial: all 21 still pass when written with backticks, emphasis and curly quotes', () => {
  expect(NEWS_AFTER_REPORT).toHaveLength(21)
  const dropped: string[] = []
  const marked = (text: string) => [`\`${text}\``, `**${text}**`, text.replace(/'/g, '’').replace(/ /g, '\u00a0')]
  for (const [report, notice] of NEWS_AFTER_REPORT) {
    const verdict = judgeTeammate({ teammate: 'w', body: report, loop: 'main' }, EMPTY_LEDGER, 0, DEFAULT_SETTINGS)
    const reported = remember(EMPTY_LEDGER, verdict.key ?? '', verdict.digest, 0, DEFAULT_SETTINGS.windowMs, verdict.text)
    for (const text of marked(notice)) {
      for (const idleReason of [undefined, 'available']) {
        const drop = judgeTeammate(shardIdle(text, idleReason), reported, MINUTE, DEFAULT_SETTINGS).drop
        if (drop !== null) {
          dropped.push(`${drop} | ${idleReason} | ${report} | ${text}`)
        }
      }
    }
  }
  expect(dropped).toEqual([])
})
