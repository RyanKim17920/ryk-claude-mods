import type { On, PromptOrigin } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { FINISHED_PAIRS } from './finished-fixtures'
import { agentMessage, crossSession, DELIVERED, idleNotice, NOTE_DONE, NOTE_PARKED, notification, peerDelivery, PREAMBLE, teammateMessage, TRAILER, WAITING } from './samples'
import { DEFAULT_SETTINGS, EMPTY_LEDGER, judgeSend, localDayOf } from './logic'

const MINUTE = 60_000
const TASK: PromptOrigin = { kind: 'task-notification' }
const LONG = 'Rebase fix/cache-infra onto e48dabb0, rerun the full integration suite and report the pass rate.'

type World = { entered: string[]; received: string[]; sent: string[]; statuses: (string | undefined)[]; toasts: string[]; isRecipientGone: boolean }

// Stands for the engine beneath the plugin: the prompt queue, the mailbox, the display.
function world(on: On): World {
  const w: World = { entered: [], received: [], sent: [], statuses: [], toasts: [], isRecipientGone: false }
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('session.receive', ($, e) => {
    w.received.push(e.text)

    return { text: e.text }
  })
  on('prompt.submit', ($, e) => {
    w.entered.push(e.text)

    return { text: e.text, origin: e.origin }
  })
  on('session.send', ($, e) => {
    if (w.isRecipientGone) {
      return { isDelivered: false, reason: 'nobody by that name' }
    }
    w.sent.push(`${e.agentId ?? 'main'}>${e.to}: ${e.text}`)

    return { isDelivered: true }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)

    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  return w
}

const submit = ($: Engine, text: string, origin: PromptOrigin = TASK) => $.prompt.submit({ text, wait: false, origin })
// `from` is the sending loop's agent id; null stands for the main conversation, which carries none.
const send = ($: Engine, text: string, to = 'speed', from: string | null = 'lead') =>
  $.session.send({ to, text, origin: { kind: 'model' }, agentId: from ?? undefined })
const report = async ($: Engine) =>
  (await $.command.run({ command: 'notice-dedupe', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

test('"has not reported yet" enters once per task, then is dropped and counted', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  expect((await submit($, notification('a1', 'completed', WAITING, 1000))).drop).toBeUndefined()
  await clock.advance(MINUTE)
  expect((await submit($, notification('a1', 'completed', WAITING, 2000))).drop).toContain('still not reported')
  expect((await submit($, notification('a1', 'completed', WAITING, 3000))).drop).toBeDefined()
  // Another parked agent is told of once too.
  expect((await submit($, notification('a2', 'completed', WAITING))).drop).toBeUndefined()
  expect(w.entered).toHaveLength(2)
  expect(w.statuses.at(-1)).toBe('dedupe: 2 dropped')
  // Past the window main is reminded once more.
  await clock.advance(30 * MINUTE)
  expect((await submit($, notification('a1', 'completed', WAITING, 4000))).drop).toBeUndefined()
  expect((await submit($, notification('a1', 'completed', WAITING, 5000))).drop).toBeDefined()
})

test('"report was delivered" is dropped and counted', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  expect((await submit($, notification('a1', 'completed', DELIVERED))).drop).toContain('already arrived as a message')
  expect((await submit($, notification('a1', 'completed', DELIVERED))).drop).toBeDefined()
  expect(w.entered).toHaveLength(0)
  expect(w.statuses.at(-1)).toBe('dedupe: 2 dropped')
})

test('a stopped or stalled notification passes, boilerplate text or not, repeated or not', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  for (const status of ['stopped', 'stalled']) {
    const text = notification('a1', status, WAITING)
    expect((await submit($, text)).text).toBe(text)
    expect((await submit($, text)).drop).toBeUndefined()
  }
  expect(w.entered).toHaveLength(4)
  expect(w.statuses).toHaveLength(0)
})

test('a failed or killed notification always enters the first time; its exact repeat for the same task is dropped and counted', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  for (const [id, status] of [['f1', 'failed'], ['k1', 'killed']] as const) {
    const text = notification(id, status, WAITING)
    expect((await submit($, text)).text).toBe(text)
    await clock.advance(MINUTE)
    expect((await submit($, notification(id, status, WAITING, 5))).drop).toContain('last failure notification')
  }
  expect(w.entered).toHaveLength(2)
  expect(await report($)).toContain('2  repeat-failure')
})

test('dropRepeatFailures off: a repeated failure enters', { options: { dropRepeatFailures: false } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  for (let i = 0; i < 3; i += 1) {
    expect((await submit($, notification('a1', 'failed', 'Exit 137.'))).drop).toBeUndefined()
  }
  expect(w.entered).toHaveLength(3)
})

test('a real report passes, and one that quotes the boilerplate too', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await submit($, notification('a1', 'completed', 'All 14 tests pass. Branch fix/grader merged.'))
  await submit($, notification('a2', 'completed', `Earlier I saw: ${WAITING}`))
  expect(w.entered).toHaveLength(2)
})

test('an identical repeat for one task is dropped inside the window and passes outside it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const interim = (tokens: number) => notification('a1', 'completed', 'Interim: 3 of 9 images built.', tokens)
  expect((await submit($, interim(1000))).drop).toBeUndefined()
  await clock.advance(5 * MINUTE)
  expect((await submit($, interim(2000))).drop).toContain('identical to the last notification')
  await clock.advance(20 * MINUTE)
  expect((await submit($, interim(3000))).drop).toBeDefined()
  // Another task with the same words, and this task with new words, both pass.
  expect((await submit($, notification('a2', 'completed', 'Interim: 3 of 9 images built.'))).drop).toBeUndefined()
  await clock.advance(5 * MINUTE)
  // 30 minutes after the one that entered: it passes again, so a steady repeat still wakes main twice an hour.
  expect((await submit($, interim(4000))).drop).toBeUndefined()
  expect((await submit($, notification('a1', 'completed', 'Interim: 4 of 9 images built.'))).drop).toBeUndefined()
  expect(w.entered).toHaveLength(4)
  expect(w.statuses.at(-1)).toBe('dedupe: 2 dropped')
})

test('as seen live: a twice-parked agent wakes main once, and its final report still enters', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  expect((await submit($, notification('a5173', 'completed', 'PARKED', 25_359, NOTE_PARKED, true))).drop).toBeUndefined()
  await clock.advance(13_000)
  expect((await submit($, notification('a5173', 'completed', 'PARKED', 25_984, NOTE_PARKED, false))).drop).toBeDefined()
  await clock.advance(13_000)
  const done = notification('a5173', 'completed', 'both sleeps done.', 26_404, NOTE_DONE, false)
  expect((await submit($, done)).text).toBe(done)
  expect(w.entered).toHaveLength(2)
})

test('a scheduled prompt repeated inside the window is dropped', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const cron: PromptOrigin = { kind: 'scheduled-trigger' }
  expect((await submit($, 'Check the suite and report.', cron)).drop).toBeUndefined()
  await clock.advance(10 * MINUTE)
  expect((await submit($, 'Check the suite and report.', cron)).drop).toContain('already entered')
  expect((await submit($, 'Check the images and report.', cron)).drop).toBeUndefined()
  await clock.advance(20 * MINUTE)
  expect((await submit($, 'Check the suite and report.', cron)).drop).toBeUndefined()
  expect(w.entered).toHaveLength(3)
})

test('what a person typed is never dropped, however often', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const origins: PromptOrigin[] = [{ kind: 'composer' }, { kind: 'bridge' }, { kind: 'sdk' }, { kind: 'plugin', name: 'voice', asUser: true }]
  for (const origin of origins) {
    for (const text of ['continue', 'continue', notification('a1', 'completed', WAITING)]) {
      expect((await submit($, text, origin)).drop).toBeUndefined()
    }
  }
  expect(w.entered).toHaveLength(12)
  expect(w.statuses).toHaveLength(0)
})

test('a peer hand-back report is never dropped, repeated or not', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  for (const kind of ['peer', 'peer-send-message', 'coordinator', 'unclassified'] as const) {
    await submit($, 'Report: suite green at e48dabb0.', { kind })
    expect((await submit($, 'Report: suite green at e48dabb0.', { kind })).drop).toBeUndefined()
  }
  expect(w.entered).toHaveLength(8)
})

test('a duplicate send is refused with a reason; different text, sender or recipient is delivered', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  expect(await send($, LONG)).toEqual({ isDelivered: true })
  await clock.advance(4 * MINUTE)
  const again = await send($, `${LONG}\n`)
  expect(again.isDelivered).toBe(false)
  expect(again.reason).toContain('identical to your last message to "speed" (4m ago), which it already has')
  expect((await send($, `${LONG} Then stop.`)).isDelivered).toBe(true)
  expect((await send($, LONG, 'grader')).isDelivered).toBe(true)
  expect((await send($, LONG, 'speed', null)).isDelivered).toBe(true)
  await clock.advance(30 * MINUTE)
  expect((await send($, LONG, 'grader')).isDelivered).toBe(true)
  expect(w.sent).toHaveLength(5)
  expect(w.statuses.at(-1)).toBe('dedupe: 1 dropped')
})

test('the refusal tells the sender to keep working and send only new information; it never says to wait or stop', async ($, on) => {
  mock.clock(on)
  world(on)
  await send($, LONG)
  const { reason } = await send($, LONG)
  expect(reason).toContain('Nothing is wrong')
  expect(reason).toContain('Keep working on your task')
  expect(reason).toContain('When something changes, send the new information')
  expect(reason).toContain("don't reword the same status")
  for (const invites of ['wait for', 'what changed', 'Do not resend', 'stop']) {
    expect(reason?.toLowerCase()).not.toContain(invites.toLowerCase())
  }
})

// The bug a demo run found: a watcher forwarding 8 deploy checks with 3 states was refused on
// its repeats and, told to "wait for the reply", quit at check 3, so main never learned it went LIVE.
// Every repeat is refused, every change is delivered, and the last one, LIVE, always reaches main.
test('regression: a watcher refused on its repeats still delivers every later change, LIVE included', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const line = (ready: number) =>
    ready === 3
      ? 'Deploy 4127: LIVE, 3 of 3 instances ready in us-east-1, health checks passed, no errors reported'
      : `Deploy 4127: waiting for health checks, ${ready} of 3 instances ready in us-east-1, no errors reported so far`
  const checks = [1, 1, 1, 1, 2, 2, 2, 3].map(line)
  const results = []
  for (const check of checks) {
    results.push(await send($, check, 'main', 'watcher'))
    await clock.advance(5_000)
  }
  expect(results.map(result => result.isDelivered)).toEqual([true, false, false, false, true, false, false, true])
  expect(w.sent).toEqual([1, 2, 3].map(ready => `watcher>main: ${line(ready)}`))
  // The status rolls back, then goes live again: each change is news, though both were sent before.
  expect((await send($, line(2), 'main', 'watcher')).isDelivered).toBe(true)
  expect((await send($, line(3), 'main', 'watcher')).isDelivered).toBe(true)
  expect((await send($, line(3), 'main', 'watcher')).isDelivered).toBe(false)
  expect(w.statuses.at(-1)).toBe('dedupe: 6 dropped')
})

test('regression: a message to a broadcast or another spelling of the recipient in between makes the repeat news again', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const other = `${LONG} Suite is red again.`
  for (const to of ['*', 'team-lead']) {
    expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(true)
    expect((await send($, other, to, 'watcher')).isDelivered).toBe(true)
    expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(true)
    expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(false)
    // Reset the record so the next spelling starts from a message other than LONG.
    expect((await send($, 'ok', 'main', 'watcher')).isDelivered).toBe(true)
  }
  expect(w.sent).toHaveLength(8)
})

test('a short message in between makes the next long one news again; a short repeat is never refused', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  expect((await send($, LONG)).isDelivered).toBe(true)
  expect((await send($, 'ok, holding')).isDelivered).toBe(true)
  expect((await send($, 'ok, holding')).isDelivered).toBe(true)
  expect((await send($, LONG)).isDelivered).toBe(true)
  expect((await send($, LONG)).isDelivered).toBe(false)
  expect(w.sent).toHaveLength(4)
})

/**
 * A delivery held at a gate: the first send (or, given `holds`, the first with that text) waits there
 * until `release` settles it as `isDelivered`; every other send is delivered at once.
 */
function heldDelivery(on: On, holds?: string) {
  const reached: string[] = []
  const delivered: string[] = []
  let opened: (isDelivered: boolean) => void = () => {}
  const gate = new Promise<boolean>(resolve => {
    opened = resolve
  })
  let isFirstOpen = true
  on('session.send', async ($, e) => {
    reached.push(e.text)
    const isHeld = isFirstOpen && (holds === undefined || e.text === holds)
    const isDelivered = isHeld ? ((isFirstOpen = false), await gate) : true
    if (isDelivered) {
      delivered.push(e.text)
    }

    return isDelivered ? { isDelivered: true } : { isDelivered: false, reason: 'recipient busy' }
  })
  // Every drop recorded sets the status line once.
  const drops: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    drops.push(e.text)

    return { value: undefined }
  })

  return { reached, delivered, drops, release: (isDelivered: boolean) => opened(isDelivered) }
}
/** The runtime's timer: the hooks' type library names no host globals, so it is declared here. */
declare function setTimeout(callback: () => void, ms?: number): unknown

/** Lets every pending hook run as far as it can: a few turns of the event loop. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 1))
  }
}

// A send never waits on another. While another send of its sender is in delivery it is delivered,
// never refused: that one may land after it and be the last the recipient has.
test('a repeat sent while the first is still in flight is delivered at once, never refused or counted', async ($, on) => {
  mock.clock(on)
  const held = heldDelivery(on)
  const first = send($, LONG, 'main', 'shard-1')
  await settle()
  expect(await send($, LONG, 'main', 'shard-1')).toEqual({ isDelivered: true })
  expect(await send($, LONG, 'main', 'shard-1')).toEqual({ isDelivered: true })
  held.release(true)
  expect(await first).toEqual({ isDelivered: true })
  expect(held.drops).toEqual([])
  // The first landed after later-made ones were recorded, so the next is let through; then refusal resumes.
  expect((await send($, LONG, 'main', 'shard-1')).isDelivered).toBe(true)
  expect((await send($, LONG, 'main', 'shard-1')).isDelivered).toBe(false)
  expect(held.delivered).toEqual([LONG, LONG, LONG, LONG])
  expect(held.drops).toHaveLength(1)
})

test('an exact repeat with nothing of its sender in flight is still refused, and never reaches delivery', async ($, on) => {
  mock.clock(on)
  const held = heldDelivery(on)
  const first = send($, LONG, 'main', 'shard-1')
  await settle()
  held.release(true)
  expect(await first).toEqual({ isDelivered: true })
  const again = await send($, LONG, 'main', 'shard-1')
  expect(again.isDelivered).toBe(false)
  expect(again.reason).toContain('identical to your last message to "main"')
  expect(held.reached).toEqual([LONG])
  expect(held.drops).toHaveLength(1)
})

for (const [kind, other] of [['long', `${LONG} Suite is red again.`], ['short', 'ok, rolled back']] as const) {
  for (const isDelivered of [true, false]) {
    test(`regression: a repeat sent while a different (${kind}) message is in flight is delivered; that one ${isDelivered ? 'delivered' : 'not delivered'} after it`, async ($, on) => {
      mock.clock(on)
      const held = heldDelivery(on, other)
      expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(true)
      const inFlight = send($, other, 'main', 'watcher')
      await settle()
      expect(await send($, LONG, 'main', 'watcher')).toEqual({ isDelivered: true })
      held.release(isDelivered)
      expect((await inFlight).isDelivered).toBe(isDelivered)
      // Delivered after LONG, `other` may be the last main has, so LONG is news; not delivered, LONG stays last.
      expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(isDelivered)
      expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(false)
      expect(held.reached).toEqual(isDelivered ? [LONG, other, LONG, LONG] : [LONG, other, LONG])
      expect(held.drops).toHaveLength(isDelivered ? 1 : 2)
    })
  }
}

/**
 * Holds the first ledger read after `arm()` until `open()`: before it is read, or (`isStale`) after,
 * so the value it returns may be overtaken by a write while it is held.
 */
function heldLedgerRead(on: On, isStale: boolean) {
  let isArmed = false
  let open: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  on('state.get', async ($, e, next) => {
    if (!isArmed || e.key !== 'ledger') {
      return next(e)
    }
    isArmed = false
    if (!isStale) {
      await gate
    }
    const value = await next(e)
    await gate

    return value
  })

  return { arm: () => (isArmed = true), open: () => open() }
}

test('regression: a send that becomes in flight while a repeat reads the ledger stops it being refused', async ($, on) => {
  mock.clock(on)
  const other = `${LONG} Suite is red again.`
  const held = heldDelivery(on, other)
  const read = heldLedgerRead(on, false)
  expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(true)
  read.arm()
  const repeat = send($, LONG, 'main', 'watcher')
  await settle()
  const inFlight = send($, other, 'main', 'watcher')
  await settle()
  read.open()
  expect(await repeat).toEqual({ isDelivered: true })
  held.release(true)
  expect(await inFlight).toEqual({ isDelivered: true })
  expect(held.drops).toEqual([])
})

test('regression: a send in flight when a repeat is made stops it being refused, even when it lands while the repeat reads the ledger', async ($, on) => {
  mock.clock(on)
  const other = `${LONG} Suite is red again.`
  const held = heldDelivery(on, other)
  const read = heldLedgerRead(on, true)
  expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(true)
  const inFlight = send($, other, 'main', 'watcher')
  await settle()
  read.arm()
  const repeat = send($, LONG, 'main', 'watcher')
  await settle()
  // `other` lands and is recorded while the repeat holds a ledger read from before it.
  held.release(true)
  expect(await inFlight).toEqual({ isDelivered: true })
  read.open()
  expect(await repeat).toEqual({ isDelivered: true })
  expect(held.drops).toEqual([])
})

test('sends are remembered in the order they were made: a short one made later is never overwritten by an earlier one finishing after it', async ($, on) => {
  mock.clock(on)
  const held = heldDelivery(on)
  const first = send($, LONG, 'main', 'shard-1')
  await settle()
  expect((await send($, 'ok, holding', 'main', 'shard-1')).isDelivered).toBe(true)
  held.release(true)
  expect(await first).toEqual({ isDelivered: true })
  // LONG landed last, but the record is the later-made short one: LONG again is let through, never refused news.
  expect((await send($, LONG, 'main', 'shard-1')).isDelivered).toBe(true)
  expect((await send($, LONG, 'main', 'shard-1')).isDelivered).toBe(false)
})

test('a send whose delivery never settles stops refusal for 30 s only; landing late, it makes the next send news', async ($, on) => {
  const clock = mock.clock(on)
  const other = `${LONG} Suite is red again.`
  const held = heldDelivery(on, other)
  expect((await send($, LONG, 'main', 'shard-1')).isDelivered).toBe(true)
  const hung = send($, other, 'main', 'shard-1')
  await settle()
  await clock.advance(29_000)
  expect((await send($, LONG, 'main', 'shard-1')).isDelivered).toBe(true)
  await clock.advance(2_000)
  // Expired: let go, and as it may have landed unrecorded, one send goes through before refusal resumes.
  expect((await send($, LONG, 'main', 'shard-1')).isDelivered).toBe(true)
  expect((await send($, LONG, 'main', 'shard-1')).isDelivered).toBe(false)
  expect((await send($, LONG, 'main', 'shard-1')).isDelivered).toBe(false)
  held.release(true)
  expect(await hung).toEqual({ isDelivered: true })
  expect((await send($, LONG, 'main', 'shard-1')).isDelivered).toBe(true)
  expect(held.reached).toEqual([LONG, other, LONG, LONG, LONG])
  expect(held.drops).toHaveLength(2)
})

test('every path delivers a send exactly once, and records a drop only for a refused one', async ($, on) => {
  mock.clock(on)
  const held = heldDelivery(on)
  const other = `${LONG} Suite is red again.`
  const first = send($, LONG, 'main', 'shard-1')
  await settle()
  const results = await Promise.all([LONG, other, 'ok', LONG].map(text => send($, text, 'main', 'shard-1')))
  held.release(false)
  expect(await first).toEqual({ isDelivered: false, reason: 'recipient busy' })
  expect(results.every(result => result.isDelivered)).toBe(true)
  const refused = await send($, LONG, 'main', 'shard-1')
  expect(refused.isDelivered).toBe(false)
  expect(held.reached).toEqual([LONG, LONG, other, 'ok', LONG])
  expect(held.drops).toHaveLength(1)
})

test('a send that is not delivered is tried once, even when the ledger cannot be written', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('state.set', () => ({ deny: 'no state' }))
  let tries = 0
  on('session.send', () => {
    tries += 1

    return { isDelivered: false, reason: 'nobody by that name' }
  })
  expect(await send($, LONG)).toEqual({ isDelivered: false, reason: 'nobody by that name' })
  expect(tries).toBe(1)
})

test('regression: a delivered send whose record could not be saved never lets the record before it refuse the next send', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  let writes = 0
  on('state.set', ($, e, next) => {
    writes += e.key === 'ledger' ? 1 : 0

    return writes === 2 ? { deny: 'disk full' } : next(e)
  })
  const other = `${LONG} Suite is red again.`
  expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(true)
  // Delivered, but its record is lost: the ledger still says LONG was last.
  expect((await send($, other, 'main', 'watcher')).isDelivered).toBe(true)
  expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(true)
  // That send was saved, so the sender is judged again.
  expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(false)
  // Another sender was never affected.
  expect((await send($, LONG, 'main', 'grader')).isDelivered).toBe(true)
  expect((await send($, LONG, 'main', 'grader')).isDelivered).toBe(false)
  expect(w.sent).toEqual([LONG, other, LONG].map(text => `watcher>main: ${text}`).concat(`grader>main: ${LONG}`))
})

test('a send let through by an error while judging it is never remembered, so its sender is not refused until one is', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  let isBroken = false
  on('state.get', ($, e, next) => (isBroken && e.key === 'ledger' ? { deny: 'no state' } : next(e)))
  const other = `${LONG} Suite is red again.`
  expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(true)
  isBroken = true
  expect((await send($, other, 'main', 'watcher')).isDelivered).toBe(true)
  isBroken = false
  expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(true)
  expect((await send($, LONG, 'main', 'watcher')).isDelivered).toBe(false)
  expect(w.sent).toHaveLength(3)
})

test('a send that was not delivered leaves nothing behind: the same text then goes through', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  w.isRecipientGone = true
  expect((await send($, LONG)).isDelivered).toBe(false)
  expect((await send($, LONG)).reason).toBe('nobody by that name')
  w.isRecipientGone = false
  expect((await send($, LONG)).isDelivered).toBe(true)
  expect((await send($, LONG)).isDelivered).toBe(false)
  expect(w.sent).toHaveLength(1)
})

test('a short message may be sent twice, and an undelivered one may be retried', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  expect((await send($, 'proceed')).isDelivered).toBe(true)
  expect((await send($, 'proceed')).isDelivered).toBe(true)
  w.isRecipientGone = true
  expect((await send($, LONG)).reason).toBe('nobody by that name')
  w.isRecipientGone = false
  expect((await send($, LONG)).isDelivered).toBe(true)
})

test('every switch off: nothing is dropped', { options: { dropWaiting: false, dropDelivered: false, dropRepeats: false, refuseRepeatSends: false } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await submit($, notification('a1', 'completed', WAITING))
  await submit($, notification('a1', 'completed', WAITING))
  await submit($, notification('a1', 'completed', DELIVERED))
  await send($, LONG)
  expect((await send($, LONG)).isDelivered).toBe(true)
  expect(w.entered).toHaveLength(3)
  expect(w.sent).toHaveLength(2)
})

// The kit cannot reload a module with new options, so the toggle is played in two halves: this load,
// off, keeps the ledger; the load that turns it on again judges against that ledger.
test('regression: with refuseRepeatSends off every delivered send is still remembered, so turning it on judges the real last one', { options: { refuseRepeatSends: false } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  let kept: Parameters<typeof judgeSend>[1] | undefined
  on('state.set', ($, e, next) => {
    if (e.key === 'ledger') {
      kept = e.value as Parameters<typeof judgeSend>[1]
    }

    return next(e)
  })
  const other = `${LONG} Suite is red again.`
  for (const text of [LONG, LONG, other]) {
    expect((await send($, text, 'main', 'watcher')).isDelivered).toBe(true)
  }
  expect(w.sent).toHaveLength(3)
  const onAgain = (text: string) => judgeSend({ agentId: 'watcher', to: 'main', text }, kept ?? EMPTY_LEDGER, MINUTE, DEFAULT_SETTINGS).drop
  // LONG was the last message before it was turned off; `other` came after, so LONG is news.
  expect(onAgain(LONG)).toBeNull()
  expect(onAgain(other)).toBe('repeat-send')
})

test('windowMinutes is honoured', { options: { windowMinutes: 2 } }, async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  const text = notification('a1', 'completed', 'Interim.')
  await submit($, text)
  await clock.advance(MINUTE)
  expect((await submit($, text)).drop).toBeDefined()
  await clock.advance(MINUTE)
  expect((await submit($, text)).drop).toBeUndefined()
})

test('/notice-dedupe prints the counts and the last drops', async ($, on) => {
  const clock = mock.clock(on)
  world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(await report($)).toBe('nothing dropped this session.')
  await submit($, notification('a1', 'completed', WAITING))
  await submit($, notification('a1', 'completed', WAITING))
  await submit($, notification('a2', 'completed', DELIVERED))
  await send($, LONG)
  await send($, LONG)
  await clock.advance(3 * MINUTE)
  const text = await report($)
  expect(text).toContain('3 dropped this session')
  expect(text).toContain('1  waiting')
  expect(text).toContain('1  delivered')
  expect(text).toContain('1  repeat-send')
  expect(text).toContain('3m ago  waiting              Agent "R2: checkout latency survey" finished: This agent has not repor')
  expect(text).toContain('repeat-send          to speed: Rebase fix/cache-infra')
})

test('fails open: an error while judging lets the notification and the message through', async ($, on) => {
  const w = world(on)
  on('clock.now', () => ({ deny: 'no clock' }))
  const text = notification('a1', 'completed', DELIVERED)
  expect((await submit($, text)).text).toBe(text)
  expect((await send($, LONG)).isDelivered).toBe(true)
  expect((await send($, LONG)).isDelivered).toBe(true)
  expect(w.entered).toEqual([text])
  expect(w.sent).toHaveLength(2)
})

test('fails open: an error after judging (the ledger write) still lets them through', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  on('state.set', () => ({ deny: 'no state' }))
  const text = notification('a1', 'completed', DELIVERED)
  expect((await submit($, text)).text).toBe(text)
  expect((await send($, LONG)).isDelivered).toBe(true)
  expect(w.entered).toEqual([text])
  // Delivered once: the failed ledger write after delivery never sends it again.
  expect(w.sent).toHaveLength(1)
})

const PEER: PromptOrigin = { kind: 'peer' }
const REPORT = teammateMessage('builder-a', 'Live checks are done: two verified, one fixed.', 'Live checks done')
const IDLE = idleNotice('builder-a', 'Reported to the team lead.')

test('a teammate\'s idle notice after its report is dropped under its own class; the report always enters', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  expect((await submit($, REPORT, PEER)).text).toBe(REPORT)
  await clock.advance(11_000)
  expect((await submit($, IDLE, PEER)).drop).toContain('went idle after its report')
  expect(w.entered).toEqual([REPORT])
  expect(w.statuses.at(-1)).toBe('dedupe: 1 dropped')
  const text = await report($)
  expect(text).toContain('1  idle-after-report')
  expect(text).toContain('builder-a idle: Reported to the team lead.')

  // One report pays for one idle notice: the next is the only word of new work and enters.
  await clock.advance(5 * MINUTE)
  expect((await submit($, IDLE, PEER)).text).toBe(IDLE)
  // And the same report twice is still never dropped.
  expect((await submit($, REPORT, PEER)).drop).toBeUndefined()
  expect((await submit($, REPORT, PEER)).drop).toBeUndefined()
})

test('an idle notice with no recent message from that teammate enters', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  expect((await submit($, IDLE, PEER)).text).toBe(IDLE)
  await submit($, REPORT, PEER)
  expect((await submit($, idleNotice('builder-b', 'Both mods built.'), PEER)).drop).toBeUndefined()
  await clock.advance(31 * MINUTE)
  expect((await submit($, IDLE, PEER)).drop).toBeUndefined()
  expect(w.entered).toHaveLength(4)
  expect(w.statuses).toHaveLength(0)
})

test('a failed, interrupted or malformed idle notice enters even right after a report', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const notices = [
    idleNotice('builder-a', 'x', { idleReason: 'failed', failureReason: 'API error' }),
    idleNotice('builder-a', 'x', { idleReason: 'interrupted' }),
    idleNotice('builder-a', 'x', { idleReason: 'error' }),
    teammateMessage('builder-a', '{"type":"idle_notification","from":"builder-a","idleReason":"available"'),
    `${idleNotice('builder-a', 'x')}\ntrailing words`,
  ]
  for (const notice of notices) {
    await submit($, REPORT, PEER)
    expect((await submit($, notice, PEER)).text).toBe(notice)
  }
  expect(w.entered).toHaveLength(10)
  expect(w.statuses).toHaveLength(0)
})

test('dropIdleAfterReport off: the idle notice enters', { options: { dropIdleAfterReport: false } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await submit($, REPORT, PEER)
  expect((await submit($, IDLE, PEER)).text).toBe(IDLE)
  expect(w.entered).toHaveLength(2)
})

// A named teammate as seen live: its SendMessage report arrives as an <agent-message>, then several
// idle notices in the harness's frame, the first ones with no idleReason.
const WATCH_REPORT = agentMessage('shard-1-watch', 'shard 1 is done. logs/shard-1.done contains: accuracy 0.81')
const watchIdle = (result: string, more: Record<string, unknown> = { idleReason: undefined }) => peerDelivery(idleNotice('shard-1-watch', result, more))
const WATCH_FIRST = watchIdle(
  'Shard 1 is done: `logs/shard-1.done` says `accuracy 0.81`.\n\nThe path in your brief didn\'t exist, so I ran the checks from the repo\'s working directory instead. I sent one "still running" update before the file appeared.',
)
const WATCH_CLOSING = watchIdle('Shard 1 is finished, so there is nothing left to wait for. `logs/shard-1.done` contains `accuracy 0.81`, and I\'ve sent that line to main.')
const WATCH_LAST = watchIdle('Shard 1 reported `accuracy 0.81`, and the team lead has received it. I have nothing further to do.', { idleReason: 'available' })

test('a named teammate: after its SendMessage report, its repeated idle notices in the harness\'s frame are dropped', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  expect((await submit($, WATCH_REPORT, PEER)).text).toBe(WATCH_REPORT)
  await clock.advance(13_000)
  // The first says something the report did not (the brief's path was wrong): it enters.
  expect((await submit($, WATCH_FIRST, PEER)).text).toBe(WATCH_FIRST)
  // The live closing notices reword the report, with backticks: they enter.
  for (const text of [WATCH_CLOSING, WATCH_LAST]) {
    expect((await submit($, text, PEER)).text).toBe(text)
  }
  // Every content-free closing notice drops, whatever its reason and however many come inside the window.
  const closing = [watchIdle("I'm stopping here."), watchIdle('Nothing further to add.', { idleReason: 'available' }), watchIdle("I'm done.")]
  for (const text of closing) {
    expect((await submit($, text, PEER)).drop).toContain('only says it is finished')
  }
  // A waiting status (dropped only under aggressiveIdle) enters, as does a notice with words the report lacked.
  const later = [watchIdle('Waiting on the lead.'), watchIdle('Shard 1 watch wrapped up.', { idleReason: 'available' })]
  for (const text of later) {
    expect((await submit($, text, PEER)).text).toBe(text)
  }
  expect(w.entered).toEqual([WATCH_REPORT, WATCH_FIRST, WATCH_CLOSING, WATCH_LAST, ...later])
  const text = await report($)
  expect(text).toContain('3  idle-closing')
  expect(text).toContain('3 dropped this session')
})

test('a named teammate: content-free closing notices written like the live ones (backticks, curly apostrophes) drop; marked-up news enters', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await submit($, WATCH_REPORT, PEER)
  const closing = [
    watchIdle('`logs/shard-1.done` contains: `accuracy 0.81`. I’ve sent that line to main. I’m done.'),
    watchIdle('**Shard 1 is done.** The team lead has received it. I have nothing further to do.', { idleReason: 'available' }),
    watchIdle('I’m stopping here.'),
  ]
  for (const text of closing) {
    expect((await submit($, text, PEER)).drop).toContain('only says it is finished')
  }
  const news = [
    watchIdle('~~Shard 1 is done.~~ I’m done.'),
    watchIdle('`logs/shard-2.done` contains: `accuracy 0.81`. I’m done.'),
    watchIdle('`logs/shard-1.done` contains: `accuracy 0.81`. I’m done ✅', { idleReason: 'available' }),
  ]
  for (const text of news) {
    expect((await submit($, text, PEER)).text).toBe(text)
  }
  // The live ones still reword the report, so they enter.
  for (const text of [WATCH_CLOSING, WATCH_LAST]) {
    expect((await submit($, text, PEER)).text).toBe(text)
  }
  expect(w.entered).toEqual([WATCH_REPORT, ...news, WATCH_CLOSING, WATCH_LAST])
  expect(await report($)).toContain(`${closing.length}  idle-closing`)
})

// Four named shard watchers as seen live (2026-11-22): each reports by SendMessage, then goes idle
// several times. The interim "still running" reports came first.
const interim = (n: number) => agentMessage(`shard-${n}-watch`, `shard ${n}: still running, no .done file yet. Will keep checking and hand back the accuracy when it lands.`)
const SHARD_REPORTS = [
  agentMessage('shard-1-watch', 'shard 1 is done. logs/shard-1.done contains: accuracy 0.81'),
  agentMessage('shard-2-watch', 'shard 2 done: logs/shard-2.done contains "accuracy 0.82".'),
  agentMessage('shard-3-watch', 'shard 3 done: accuracy 0.83'),
  agentMessage('shard-4-watch', 'shard 4 done: logs/shard-4.done says "accuracy 0.84"'),
]
const shardIdle = (n: number, result: string, idleReason?: string) => peerDelivery(idleNotice(`shard-${n}-watch`, result, { idleReason }))
/** The four that say only that the watcher is finished, rewording its report: under the sentence rule they enter. */
const SHARD_CLOSINGS = [
  shardIdle(1, "Shard 1 is finished, so there is nothing left to wait for. `logs/shard-1.done` contains `accuracy 0.81`, and I've sent that line to main."),
  shardIdle(1, 'Shard 1 reported `accuracy 0.81`, and the team lead has received it. I have nothing further to do.', 'available'),
  shardIdle(2, "Main has the result (shard 2 accuracy 0.82), so the watch is finished and I'm stopping.", 'available'),
  shardIdle(1, "Shard 1 is finished, so there is nothing left to wait for. `logs/shard-1.done` contains `accuracy 0.81`, and I've sent that line to main."),
]
/** The rest: a new fact, no closing phrase, or a word the report lacked ("still", "confirmed"). */
const SHARD_OTHERS = [
  shardIdle(1, "Shard 1 is done: `logs/shard-1.done` says `accuracy 0.81`.\n\nThe path in your brief didn't exist, so I ran the checks from the repo's working directory instead. I sent one \"still running\" update before the file appeared."),
  shardIdle(2, "Shard 2 is done: `logs/shard-2.done` contains `accuracy 0.82`, and I've sent that to main."),
  shardIdle(3, "Shard 3 is finished, so there is nothing left to watch. `logs/shard-3.done` contains `accuracy 0.83`, and you've confirmed you received it. I'm stopping here.", 'available'),
  shardIdle(4, "Shard 4 is done. `logs/shard-4.done` still reads `accuracy 0.84`, and I've already sent that to main, so I'm stopping here.", 'available'),
]

/** Content-free closing notices (not from the live session): each is empty once its phrases are out. */
const SHARD_EMPTY = [shardIdle(1, "I'm stopping here."), shardIdle(2, 'Nothing further to add.', 'available'), shardIdle(3, "I'm done."), shardIdle(4, "Sent that to main; I'm done."), shardIdle(1, "I'm stopping here."),
  // Written as the live ones are, with backticks and curly apostrophes.
  shardIdle(1, '`logs/shard-1.done` contains: `accuracy 0.81`. I’ve sent that line to main; I’m done.'),
  shardIdle(3, '`shard 3 done: accuracy 0.83`. I’m stopping here.', 'available'),
]

test('the live four-watcher session: its rewording closing notices and the rest enter; content-free ones drop, however many', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  for (const n of [1, 2, 3, 4]) {
    await submit($, interim(n), PEER)
  }
  for (const report of SHARD_REPORTS) {
    expect((await submit($, report, PEER)).text).toBe(report)
  }
  for (const text of [...SHARD_CLOSINGS, ...SHARD_OTHERS]) {
    expect((await submit($, text, PEER)).text).toBe(text)
  }
  for (const text of SHARD_EMPTY) {
    expect((await submit($, text, PEER)).drop).toContain('only says it is finished')
  }
  expect(w.entered).toHaveLength(4 + 4 + SHARD_CLOSINGS.length + SHARD_OTHERS.length)
  expect(await report($)).toContain(`${SHARD_EMPTY.length}  idle-closing`)
})

test('after only an interim "still running" report, a watcher saying it is finished is news and enters', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await submit($, interim(1), PEER)
  const closings = [shardIdle(1, "I'm done."), shardIdle(1, 'Shard 1 is finished; nothing further.'), shardIdle(1, 'Shard 1 is done.', 'available')]
  for (const text of closings) {
    expect((await submit($, text, PEER)).text).toBe(text)
  }
  expect(w.entered).toHaveLength(1 + closings.length)
})

test('a named teammate\'s report delivered into a running turn is remembered too', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const bare = agentMessage('shard-1-watch', 'shard 1 is done. logs/shard-1.done contains: accuracy 0.81', false)
  expect((await queued($, bare)).text).toBe(bare)
  expect((await submit($, watchIdle("I'm stopping here."), PEER)).drop).toBeDefined()
  expect((await submit($, watchIdle('Nothing further to add.', { idleReason: 'available' }), PEER)).drop).toBeDefined()
  expect(w.entered).toHaveLength(0)
})

test('a named teammate: an idle notice with new content after its report, or with no report before it, enters', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  // No report yet: the notice is the only word from it.
  expect((await submit($, WATCH_CLOSING, PEER)).drop).toBeUndefined()
  await submit($, WATCH_REPORT, PEER)
  const fresh = [
    WATCH_FIRST,
    watchIdle('I\'m done here, nothing further; but shard 2\'s log shows 3 failed tests.'),
    watchIdle('Nothing further from me. Should I watch shard 2 as well?'),
    watchIdle('My watch is finished. Note: the brief\'s path was wrong; I used scratchpad/v2/repo instead.'),
    watchIdle('Blocked: logs/ was deleted under me, nothing more I can do.'),
    watchIdle('Shard 1 is done and I kept going: I read every log in the folder, compared each shard against the previous run, and wrote up what changed for each of them in a file I have left for you to read when you have time.'),
    watchIdle('x', { idleReason: 'failed', failureReason: 'API error' }),
    // Another teammate that never reported.
    peerDelivery(idleNotice('shard-2-watch', 'Shard 2 is finished, nothing further to do.', { idleReason: undefined })),
  ]
  for (const text of fresh) {
    expect((await submit($, text, PEER)).text).toBe(text)
  }
  // Past the window the report no longer covers it.
  await clock.advance(31 * MINUTE)
  expect((await submit($, WATCH_CLOSING, PEER)).drop).toBeUndefined()
  expect(w.entered).toHaveLength(2 + fresh.length + 1)
})

test('a person pasting the same idle notice is never dropped', async ($, on) => {
  mock.clock(on)
  world(on)
  await submit($, REPORT, PEER)
  expect((await submit($, IDLE, { kind: 'composer' })).text).toBe(IDLE)
})

test('through the team mailbox: the report is queued, the idle notice after it consumed, a lone one queued', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const origin = { kind: 'peer', teammate: 'builder-a', isVerified: true } as const
  const body = JSON.stringify({ type: 'idle_notification', from: 'builder-a', idleReason: 'available', result: 'Reported to the team lead.' })
  expect((await $.session.receive({ origin, text: body })).text).toBe(body)
  expect((await $.session.receive({ origin, text: 'Live checks are done.' })).text).toBe('Live checks are done.')
  expect((await $.session.receive({ origin, text: body })).consumed).toContain('went idle after its report')
  expect((await $.session.receive({ origin, text: body })).text).toBe(body)
  // The wrapped form is read the same way; a delivery to another loop has its own memory.
  await $.session.receive({ origin, text: 'Second report: the live checks are finished.' })
  expect((await $.session.receive({ origin, text: IDLE, agentId: 'a7' })).text).toBe(IDLE)
  expect((await $.session.receive({ origin, text: IDLE })).consumed).toBeDefined()
  // A delivery that is no teammate's is not read at all.
  expect((await $.session.receive({ origin: { kind: 'bridge' }, text: body })).text).toBe(body)
  expect(w.received).toHaveLength(6)
  expect(w.statuses.at(-1)).toBe('dedupe: 2 dropped')
})

test('fails open: an error while judging a teammate delivery lets it through on both doors', async ($, on) => {
  const w = world(on)
  on('clock.now', () => ({ deny: 'no clock' }))
  const origin = { kind: 'peer', teammate: 'builder-a', isVerified: true } as const
  expect((await submit($, REPORT, PEER)).text).toBe(REPORT)
  expect((await submit($, IDLE, PEER)).text).toBe(IDLE)
  expect((await $.session.receive({ origin, text: IDLE })).text).toBe(IDLE)
  expect(w.entered).toHaveLength(2)
  expect(w.received).toHaveLength(1)
})

// A row as the engine appends it: a notification folded into a turn arrives here and never at prompt.submit.
const appended = ($: Engine, text: string, origin: PromptOrigin, uuid: string) =>
  $.session.append({ door: 'prompt', origin, uuid, message: { type: 'user', role: 'user', content: [{ type: 'text', text }] } })
const textOf = (row: Awaited<ReturnType<typeof appended>>) =>
  'message' in row && row.message !== undefined ? row.message.content.map(block => (block.type === 'text' ? String(block.text) : '')).join('') : undefined

test('a folded "report was delivered" notification is emptied (the engine keeps "(no content)"), and the person\'s row beside it byte-for-byte', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const session = mock.session(on)
  const block = notification('a7e7c29c', 'completed', DELIVERED, 25_262, NOTE_DONE)
  const typed = `  please rerun the suite\n\n${block}\n  (I pasted that on purpose) `

  // An engine row cannot be refused: emptied is the least it can be.
  expect(textOf(await appended($, block, TASK, 'u1'))).toBe('(no content)')
  expect(textOf(await appended($, typed, { kind: 'composer' }, 'u2'))).toBe(typed)
  expect(textOf(await appended($, typed, { kind: 'sdk' }, 'u3'))).toBe(typed)
  expect(session.appended()).toHaveLength(3)
  expect(w.statuses.at(-1)).toBe('dedupe: 1 dropped')
  expect(await report($)).toContain('delivered            (folded) <task-notification>')
})

test('foldMode "stub": a folded "report was delivered" notification is stored as one line', { options: { foldMode: 'stub' } }, async ($, on) => {
  mock.clock(on)
  world(on)
  const block = notification('a7e7c29c', 'completed', DELIVERED, 25_262, NOTE_DONE)
  expect(textOf(await appended($, block, TASK, 's1'))).toContain('[notice-dedupe: a task notification for a7e7c29c said only')
})

test('a folded failed or stalled notification, a real report and a waiting notice are stored as they came', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const kept = [
    notification('a1', 'failed', DELIVERED),
    notification('a1', 'stalled', 'No output for 20 minutes.'),
    notification('a1', 'killed', DELIVERED),
    notification('a1', 'completed', 'All 14 tests pass.'),
    notification('a1', 'completed', WAITING),
  ]
  for (const [i, text] of kept.entries()) {
    expect(textOf(await appended($, text, TASK, `k${i}`))).toBe(text)
  }
  expect(w.statuses).toHaveLength(0)
})

test('a notification that entered through prompt.submit is not touched again when its row is appended', async ($, on) => {
  mock.clock(on)
  world(on)
  const text = notification('a1', 'completed', 'Interim: 3 of 9 images built.')
  expect((await submit($, text)).text).toBe(text)
  expect(textOf(await appended($, text, TASK, 'p1'))).toBe(text)
})

test('dropDelivered off, or an error, leaves the folded row as it came', { options: { dropDelivered: false } }, async ($, on) => {
  mock.clock(on)
  world(on)
  const block = notification('a1', 'completed', DELIVERED)
  expect(textOf(await appended($, block, TASK, 'o1'))).toBe(block)
})

test('fails open: an error while rewriting a folded row stores it as it came', async ($, on) => {
  world(on)
  on('clock.now', () => ({ deny: 'no clock' }))
  const block = notification('a1', 'completed', DELIVERED)
  expect(textOf(await appended($, block, TASK, 'e1'))).toBe(block)
})

const ON = { options: { aggressiveIdle: true } }
const ECHO = idleNotice('builder-a', 'Heads sent to builder-b; the watcher is armed.', { idleReason: undefined, summary: '[to builder-b] Heads for the ledger' })
const WAIT = idleNotice('builder-a', 'Waiting on the staging runs and the helper report.', { idleReason: undefined })
const BLOCKED = idleNotice('builder-a', 'Blocked on runner capacity; waiting on the lead.', { idleReason: undefined, summary: '[to builder-b] Bisect split' })

test('aggressiveIdle off (the default): the idle notice in the harness\'s frame drops; a waiting status, an echo and a bundle enter', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await submit($, REPORT, PEER)
  expect((await submit($, peerDelivery(IDLE), PEER)).drop).toContain('went idle after its report')
  for (const text of [peerDelivery(WAIT), ECHO, peerDelivery(ECHO), peerDelivery(ECHO, WAIT)]) {
    expect((await submit($, text, PEER)).text).toBe(text)
  }
  expect(w.entered).toHaveLength(5)
  expect(w.statuses.at(-1)).toBe('dedupe: 1 dropped')
})

test('aggressiveIdle: framed echoes, waiting statuses and restatements are dropped by class after a report', ON, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const said = 'Live checks are done: two verified, one fixed, and the branch is pushed for review at e48dabb0.'
  const reportText = peerDelivery(teammateMessage('builder-a', said, 'Live checks done'))
  expect((await submit($, reportText, PEER)).text).toBe(reportText)
  await clock.advance(MINUTE)
  expect((await submit($, peerDelivery(ECHO), PEER)).drop).toContain('messaging another teammate')
  expect((await submit($, peerDelivery(WAIT), PEER)).drop).toContain('only waiting')
  expect((await submit($, peerDelivery(WAIT), PEER)).drop).toBeDefined()
  expect((await submit($, peerDelivery(idleNotice('builder-a', said, { idleReason: undefined })), PEER)).drop).toContain('restates its last report')
  // The plain idle notice after the report is still dropped once, now through the frame too.
  expect((await submit($, peerDelivery(IDLE), PEER)).drop).toContain('went idle after its report')
  expect((await submit($, peerDelivery(IDLE), PEER)).drop).toBeUndefined()
  expect(w.entered).toHaveLength(2)
  const text = await report($)
  expect(text).toContain('5 dropped this session')
  expect(text).toContain('1  idle-peer-echo')
  expect(text).toContain('2  idle-waiting')
  expect(text).toContain('1  idle-restatement')
  expect(text).toContain('1  idle-after-report')
})

test('aggressiveIdle: a closing notice that rewords the report is dropped and counted; one adding a blocker enters', ON, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const pair = FINISHED_PAIRS.find(candidate => candidate.id === 'pricing-model-handoff')
  const reportText = `${PREAMBLE}${pair?.report[1] ?? ''}${TRAILER}`
  const noticeText = `${PREAMBLE}${pair?.notice[1] ?? ''}${TRAILER}`
  expect((await submit($, reportText, PEER)).text).toBe(reportText)
  await clock.advance(25_000)
  expect((await submit($, noticeText, PEER)).drop).toContain('rewords its last report')
  const blocked = peerDelivery(idleNotice('pricing-model', "I've drafted the scoring redesign. Blocked: the staging server is gone.", { idleReason: undefined }))
  expect((await submit($, blocked, PEER)).text).toBe(blocked)
  expect(w.entered).toEqual([reportText, blocked])
  const text = await report($)
  expect(text).toContain('1  idle-paraphrase')
  expect(text).toContain("pricing-model idle: I've drafted the graded discount scoring redesign")
})

test('aggressiveIdle: a blocker, a first contact and a notice past the window enter', ON, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  // No report yet: each is the only signal.
  for (const text of [peerDelivery(ECHO), peerDelivery(WAIT)]) {
    expect((await submit($, text, PEER)).text).toBe(text)
  }
  await submit($, peerDelivery(REPORT), PEER)
  expect((await submit($, peerDelivery(BLOCKED), PEER)).text).toBe(peerDelivery(BLOCKED))
  expect((await submit($, peerDelivery(idleNotice('builder-b', 'Waiting on the staging runs.')), PEER)).drop).toBeUndefined()
  await clock.advance(31 * MINUTE)
  expect((await submit($, peerDelivery(WAIT), PEER)).drop).toBeUndefined()
  expect(w.entered).toHaveLength(6)
  expect(w.statuses).toHaveLength(0)
})

test('aggressiveIdle: a bundle is dropped only when every block is; otherwise it enters whole and counts nothing', ON, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await submit($, peerDelivery(REPORT), PEER)
  const other = idleNotice('builder-b', 'Waiting on the staging runs.')
  const mixed = [peerDelivery(ECHO, BLOCKED), peerDelivery(WAIT, other), peerDelivery(WAIT, REPORT), `${peerDelivery(WAIT)}\nwords nobody framed`]
  for (const text of mixed) {
    expect((await submit($, text, PEER)).text).toBe(text)
  }
  expect(w.statuses).toHaveLength(0)
  expect((await submit($, peerDelivery(ECHO, WAIT), PEER)).drop).toBeDefined()
  expect(w.entered).toHaveLength(5)
  expect(w.statuses.at(-1)).toBe('dedupe: 2 dropped')
})

test('aggressiveIdle through the team mailbox: an idle notice with no idleReason is consumed after a report, a blocker queued', ON, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const origin = { kind: 'peer', teammate: 'builder-a', isVerified: true } as const
  const body = (result: string) => JSON.stringify({ type: 'idle_notification', from: 'builder-a', result })
  expect((await $.session.receive({ origin, text: body('Waiting on the staging runs.') })).text).toBeDefined()
  await $.session.receive({ origin, text: 'Live checks are done.' })
  expect((await $.session.receive({ origin, text: body('Waiting on the staging runs.') })).consumed).toContain('only waiting')
  expect((await $.session.receive({ origin, text: peerDelivery(ECHO, WAIT) })).consumed).toBeDefined()
  expect((await $.session.receive({ origin, text: body('Waiting on the staging runs; two tests failed.') })).text).toBeDefined()
  // A bundle holding another teammate's block than the mailbox names is not read.
  const foreign = peerDelivery(WAIT, idleNotice('builder-b', 'Waiting on the staging runs.'))
  expect((await $.session.receive({ origin, text: foreign })).text).toBe(foreign)
  expect(w.received).toHaveLength(4)
  expect(w.statuses.at(-1)).toBe('dedupe: 3 dropped')
})

// --- 0.2.0 ---

const DAY = 24 * 60 * MINUTE
const NEAR = 'Your report was handed over as a message from "a1"; see it there.'
const PEER_BODY = 'Your diagnosis is right: the verifier never received /app/outputs. Re-export with the artifacts fix and push it as version 2.'
/** The plugin's store, held in memory and readable by the test: `mock.store` answers the plugin, not the test. */
function memoryStore(on: On, entries: Record<string, unknown> = {}): Map<string, unknown> {
  const held = new Map<string, unknown>(Object.entries(entries))
  on('store.get', ($, e) => ({ value: held.get(e.key) }))
  on('store.set', ($, e) => {
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })

  return held
}
const queued = ($: Engine, text: string, origin: { kind: 'engine' } | { kind: 'hook'; event: string } = { kind: 'engine' }) =>
  $.prompt.attachment({ type: 'queued_command', text, origin })

test('another session\'s repeated message is dropped per sender inside the window; a person pasting it never is', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const first = crossSession('uds:/tmp/cc-socks/1.sock', `${PEER_BODY} Sent: 2026-11-21T10:00:00Z.`)
  expect((await submit($, first, PEER)).text).toBe(first)
  await clock.advance(MINUTE)
  expect((await submit($, crossSession('uds:/tmp/cc-socks/1.sock', `${PEER_BODY} Sent: 2026-11-21T10:01:00Z.`), PEER)).drop).toContain('same sender')
  expect((await submit($, crossSession('uds:/tmp/cc-socks/2.sock', PEER_BODY), PEER)).drop).toBeUndefined()
  expect((await submit($, crossSession('uds:/tmp/cc-socks/1.sock', `${PEER_BODY} Also: 2 of 3 seeds pass.`), PEER)).drop).toBeUndefined()
  // Short pings pass twice; a person's prompt holding the same block passes however often.
  for (let i = 0; i < 2; i += 1) {
    expect((await submit($, crossSession('uds:/tmp/cc-socks/1.sock', 'ok'), PEER)).drop).toBeUndefined()
    expect((await submit($, first, { kind: 'composer' })).text).toBe(first)
  }
  expect(w.entered).toHaveLength(7)
  expect(await report($)).toContain('1  repeat-peer')
})

test('dropPeerRepeats off: a repeated cross-session message enters', { options: { dropPeerRepeats: false } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  for (let i = 0; i < 3; i += 1) {
    await submit($, crossSession('s1', PEER_BODY), PEER)
  }
  expect(w.entered).toHaveLength(3)
})

test('a "report was delivered" notification delivered into a running turn is left out of the request; anything else is not', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const framed = `[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n${notification('a1', 'completed', DELIVERED)}`
  expect((await queued($, framed)).text).toBeNull()
  for (const text of [notification('a1', 'completed', 'All 14 tests pass.'), notification('a1', 'failed', DELIVERED), notification('a1', 'completed', WAITING)]) {
    expect((await queued($, text)).text).toBe(text)
  }
  // Text a settings hook injected is not the engine's notification.
  expect((await queued($, framed, { kind: 'hook', event: 'UserPromptSubmit' })).text).toBe(framed)
  expect(w.statuses.at(-1)).toBe('dedupe: 1 dropped')
  expect(await report($)).toContain('delivered            (queued)')
})

test('a queued "report was delivered" with more than the harness\'s frame around it stays in the request', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const block = notification('a1', 'completed', DELIVERED)
  const longer = `${block}\n\n${'Also: the main build broke on the merge; please look before the freeze. '.repeat(10)}`
  expect((await queued($, longer)).text).toBe(longer)
  // Up to the frame limit it is still the harness's frame, and drops.
  const framed = `${'x'.repeat(600)}${block}`
  expect((await queued($, framed)).text).toBeNull()
  expect((await queued($, `${'x'.repeat(601)}${block}`)).text).not.toBeNull()
  expect(w.statuses.at(-1)).toBe('dedupe: 1 dropped')
})

test('dropDelivered off: a queued "report was delivered" stays in the request', { options: { dropDelivered: false } }, async ($, on) => {
  mock.clock(on)
  world(on)
  const text = notification('a1', 'completed', DELIVERED)
  expect((await queued($, text)).text).toBe(text)
})

test('fails open: an error while judging a queued attachment keeps it', async ($, on) => {
  world(on)
  on('clock.now', () => ({ deny: 'no clock' }))
  const text = notification('a1', 'completed', DELIVERED)
  expect((await queued($, text)).text).toBe(text)
})

test('drops, folded rows, matches and near-misses are counted across sessions and shown by /notice-dedupe', async ($, on) => {
  const clock = mock.clock(on)
  const store = memoryStore(on)
  world(on)
  await submit($, notification('a1', 'completed', WAITING))
  await submit($, notification('a1', 'completed', WAITING))
  await submit($, notification('a2', 'completed', DELIVERED))
  await appended($, notification('a3', 'completed', DELIVERED), TASK, 'f1')
  await submit($, notification('a4', 'completed', NEAR))
  await submit($, notification('a5', 'completed', 'All 14 tests pass.'))
  await clock.advance(2 * MINUTE)
  const totals = store.get('totals')
  expect(totals).toMatchObject({ drops: { waiting: 1, delivered: 2 }, folded: 1, matches: 4, nearMisses: 1 })
  const text = await report($)
  expect(text).toContain('3 dropped this session')
  expect(text).toContain(`all sessions since ${localDayOf(0)}: 3 dropped`)
  expect(text).toContain('folded rows emptied or stubbed')
  expect(text).toContain('boilerplate matches 4, near-misses 1')
  expect(text).toContain('last near-miss 2m ago: Agent "R2: checkout latency survey" finished: Your report was handed')
})

test('counters already stored are added to, and a corrupt store starts over without costing a drop', async ($, on) => {
  mock.clock(on)
  const store = memoryStore(on, { totals: { since: 0, drops: { delivered: 40 }, folded: 'x', matches: 40, nearMisses: 0 } })
  const w = world(on)
  expect((await submit($, notification('a1', 'completed', DELIVERED))).drop).toBeDefined()
  expect(store.get('totals')).toMatchObject({ drops: { delivered: 41 }, folded: 0, matches: 41 })
  store.set('totals', 'garbage')
  expect((await submit($, notification('a1', 'completed', DELIVERED))).drop).toBeDefined()
  expect(store.get('totals')).toMatchObject({ drops: { delivered: 1 }, matches: 1 })
  expect(w.entered).toHaveLength(0)
})

test('fails open: a store that cannot be read or written still drops, and /notice-dedupe still answers', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  on('store.get', () => ({ deny: 'no store' }))
  on('store.set', () => ({ deny: 'no store' }))
  for (let i = 0; i < 4; i += 1) {
    expect((await submit($, notification('a1', 'completed', DELIVERED))).drop).toBeDefined()
    await submit($, notification(`n${i}`, 'completed', NEAR))
  }
  expect(w.entered).toHaveLength(4)
  expect(w.toasts).toHaveLength(0)
  expect(await report($)).toContain('4 dropped this session')
})

test('wording drift: near-misses with no match raise one toast a day', async ($, on) => {
  const clock = mock.clock(on)
  const store = memoryStore(on)
  const w = world(on)
  for (let i = 0; i < 6; i += 1) {
    expect((await submit($, notification(`n${i}`, 'completed', NEAR))).drop).toBeUndefined()
  }
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('wording may have changed')
  expect(store.get('totals')).toMatchObject({ nearMisses: 6, lastDriftWarningAt: 0 })
  await clock.advance(DAY)
  await submit($, notification('n9', 'completed', NEAR))
  expect(w.toasts).toHaveLength(2)
  expect(await report($)).toContain(`wording-drift warning last raised ${localDayOf(DAY)}`)
})

test('wording drift: counted once a local day, whatever the machine\'s zone, and printed through the one day formatter', async ($, on) => {
  // Every zone's midnight falls on a quarter hour of UTC, so 23:05 and 23:10 UTC are one local day
  // anywhere, and two days later is another one anywhere. (The zone arithmetic itself is pinned in logic.test.ts.)
  const start = Date.UTC(2026, 10, 21, 23, 5)
  const clock = mock.clock(on, { now: start })
  memoryStore(on)
  const w = world(on)
  for (let i = 0; i < 3; i += 1) {
    await submit($, notification(`n${i}`, 'completed', NEAR))
  }
  await clock.advance(5 * MINUTE)
  await submit($, notification('n8', 'completed', NEAR))
  expect(w.toasts).toHaveLength(1)
  await clock.advance(2 * DAY)
  await submit($, notification('n9', 'completed', NEAR))
  expect(w.toasts).toHaveLength(2)
  const text = await report($)
  expect(text).toContain(`all sessions since ${localDayOf(start)}`)
  expect(text).toContain(`wording-drift warning last raised ${localDayOf(start + 5 * MINUTE + 2 * DAY)}`)
})

test('wording drift: no toast once the boilerplate has matched this session, or below three near-misses', async ($, on) => {
  mock.clock(on)
  const store = memoryStore(on)
  const w = world(on)
  await submit($, notification('n1', 'completed', NEAR))
  await submit($, notification('n2', 'completed', NEAR))
  expect(w.toasts).toHaveLength(0)
  await submit($, notification('a1', 'completed', DELIVERED))
  for (let i = 0; i < 5; i += 1) {
    await submit($, notification(`m${i}`, 'completed', NEAR))
  }
  expect(w.toasts).toHaveLength(0)
})

test('wording drift: a normal session of subagent hand-backs counts no near-miss and raises no toast', async ($, on) => {
  mock.clock(on)
  const store = memoryStore(on)
  const w = world(on)
  const handBacks = [
    'Shard 1 is done. `logs/shard-1.done` reads: `accuracy 0.81`\n\nThe duplicate-message hook blocked my second "still running" message to main.',
    'Shard 2 finished. `logs/shard-2.done` contains one line: `accuracy 0.82`\n\nThe status message went to main once.',
    'Shard 4 is done. Its `.done` file contains one line: `accuracy 0.84`\n\nI sent the "still running" message to main once.',
    'I delivered the fix to the team lead as a message.',
  ]
  for (const [i, result] of handBacks.entries()) {
    expect((await submit($, notification(`h${i}`, 'completed', result))).drop).toBeUndefined()
  }
  // The real "report was delivered" notice of one of them: a match, and the counters are written.
  await submit($, notification('h0', 'completed', DELIVERED))
  expect(w.toasts).toHaveLength(0)
  expect(store.get('totals')).toMatchObject({ nearMisses: 0 })
  expect(await report($)).toContain('near-misses 0')
})

test('driftAlerts off: near-misses are counted but raise no toast', { options: { driftAlerts: false } }, async ($, on) => {
  mock.clock(on)
  const store = memoryStore(on)
  const w = world(on)
  for (let i = 0; i < 5; i += 1) {
    await submit($, notification(`n${i}`, 'completed', NEAR))
  }
  expect(w.toasts).toHaveLength(0)
  expect(store.get('totals')).toMatchObject({ nearMisses: 5 })
})

test('showStatus off: drops leave the status line alone', { options: { showStatus: false } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await submit($, notification('a1', 'completed', DELIVERED))
  await appended($, notification('a2', 'completed', DELIVERED), TASK, 'f1')
  await send($, LONG)
  await send($, LONG)
  expect(w.statuses).toHaveLength(0)
  expect(await report($)).toContain('3 dropped this session')
})

test('showToasts: off by default; on, every drop raises one', { options: { showToasts: true } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await submit($, notification('a1', 'completed', DELIVERED))
  await queued($, notification('a2', 'completed', DELIVERED))
  await submit($, notification('a3', 'completed', 'All 14 tests pass.'))
  expect(w.toasts).toEqual([expect.stringContaining('dropped (delivered)'), expect.stringContaining('(queued)')])
})

test('showToasts default: no toast for a drop', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await submit($, notification('a1', 'completed', DELIVERED))
  await send($, LONG)
  await send($, LONG)
  expect(w.toasts).toHaveLength(0)
})

test('bad option values fall back to their defaults and the mod still works', { options: { windowMinutes: -4, sendMinChars: -1 } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const text = notification('a1', 'completed', 'Interim.')
  await submit($, text)
  await clock.advance(29 * MINUTE)
  expect((await submit($, text)).drop).toBeDefined()
  await send($, LONG)
  expect((await send($, LONG)).isDelivered).toBe(false)
  expect(w.entered).toHaveLength(1)
})

test('under load: hundreds of distinct notifications, prompts and sends keep working and stay bounded', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const cron: PromptOrigin = { kind: 'scheduled-trigger' }
  for (let i = 0; i < 500; i += 1) {
    await submit($, notification(`t${i}`, 'completed', `Interim ${i}.`))
    await submit($, `Check job ${i}.`, cron)
    await clock.advance(1000)
  }
  expect(w.entered).toHaveLength(1000)
  // The newest are still remembered and their repeats dropped.
  expect((await submit($, notification('t499', 'completed', 'Interim 499.'))).drop).toBeDefined()
  expect((await submit($, 'Check job 499.', cron)).drop).toBeDefined()
})

test('a named teammate\'s report seen twice (mid-turn, then again) pays for one plain idle notice only', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const body = 'shard 1 is done. logs/shard-1.done contains: accuracy 0.81'
  const plain = watchIdle('Shard 1 is done.', { idleReason: 'available' })
  await queued($, agentMessage('shard-1-watch', body, false))
  expect((await submit($, plain, PEER)).drop).toContain('went idle after its report')
  await queued($, agentMessage('shard-1-watch', body, false))
  await submit($, agentMessage('shard-1-watch', body), PEER)
  expect((await submit($, plain, PEER)).text).toBe(plain)
  expect(w.entered).toHaveLength(2)
})
