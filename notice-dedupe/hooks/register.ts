import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  addToTotals,
  countDrop,
  countProbe,
  DRIFT_WARNING,
  dropReason,
  EMPTY_LEDGER,
  emptyTotals,
  excerptOf,
  foldedStub,
  isAgentDelivery,
  isBareDelivered,
  isDrifting,
  isJudged,
  isTeammateDelivery,
  judgePeer,
  judgePrompt,
  judgeSend,
  judgeTeammate,
  judgeTeammates,
  localDayOf,
  parseAgentMessage,
  parseNotification,
  parseTeammateDelivery,
  parseTotals,
  refusalReason,
  remember,
  report,
  settingsOf,
  statusLine,
  totalsReport,
} from './logic'
import type { Settings, TotalsEvent, Verdict } from './logic'
import type { DropClass } from '../types'

const ledger = atom({ plugin: 'notice-dedupe', key: 'ledger' } as const, EMPTY_LEDGER)
/**
 * How long a send may stay in delivery before it no longer stops its sender's sends being refused: a
 * delivery that never settles (a hung recipient, an interrupted dispatch) must not disable refusal for good.
 */
const IN_FLIGHT_EXPIRY_MS = 30_000
/** The `$.store` key of the counters kept across sessions. */
const TOTALS = 'totals'

/**
 * Adds one event to the counters kept across sessions and, when this session's notices look like
 * reworded boilerplate, raises the drift warning once a day. Best effort: a failure here is swallowed,
 * so counting never costs, delays past its own error or reverses a verdict.
 */
async function account($: EngineInterface, settings: Settings, event: TotalsEvent, now: number): Promise<void> {
  try {
    const held = event.probe === undefined ? null : await update($, ledger, was => countProbe(was, event.probe ?? 'match'))
    const was = parseTotals(await $.store.get(TOTALS), now) ?? emptyTotals(now)
    const isWarnedToday = was.lastDriftWarningAt !== undefined && localDayOf(was.lastDriftWarningAt) === localDayOf(now)
    const isWarned = settings.alertsDrift && held !== null && isDrifting(held) && !isWarnedToday
    await $.store.set(TOTALS, addToTotals(was, event, now, isWarned))
    // Raised only once the day is recorded, so a store that cannot be written never toasts every time.
    if (isWarned) {
      $.ui.toast(DRIFT_WARNING)
    }
  } catch {
    // Counters are best effort.
  }
}

async function recordDrop($: EngineInterface, settings: Settings, kind: DropClass, excerpt: string, now: number, more: Omit<TotalsEvent, 'drop' | 'excerpt'> = {}): Promise<void> {
  const held = await update($, ledger, was => countDrop(was, { at: now, kind, excerpt }))
  if (settings.showsStatus) {
    $.ui.status(statusLine(held))
  }
  if (settings.showsToasts) {
    $.ui.toast(`dropped (${kind}): ${excerpt}`)
  }
  await account($, settings, { ...more, drop: kind, excerpt }, now)
}

// Judges one delivery's blocks (one, or a bundle under aggressiveIdle) and keeps the ledger; resolves
// the reason when every block is to be dropped. One block worth reading lets the whole delivery through.
async function judgeDelivery(
  $: EngineInterface,
  deliveries: readonly { teammate: string; body: string; loop: string }[],
  settings: Settings,
): Promise<string | null> {
  const now = await $.clock.now()
  const verdicts = judgeTeammates(deliveries, await read($, ledger), now, settings)
  const isDropped = verdicts.every(verdict => verdict.drop !== null)
  // Remembered either way: a report as reported, a dropped idle notice as that report spent.
  for (const verdict of verdicts) {
    if (isDropped || verdict.drop === null) {
      await recordPass($, verdict, now, settings.windowMs)
    }
  }
  if (!isDropped) {
    return null
  }
  const reasons = new Set<string>()
  for (const verdict of verdicts) {
    if (verdict.drop !== null) {
      await recordDrop($, settings, verdict.drop, verdict.excerpt, now)
      reasons.add(dropReason(verdict.drop))
    }
  }

  return [...reasons].join(' ')
}

async function recordPass($: EngineInterface, verdict: Verdict, now: number, windowMs: number): Promise<void> {
  const { key, digest, text } = verdict
  if (key !== null) {
    await update($, ledger, was => remember(was, key, digest, now, windowMs, text))
  }
}

/**
 * Remembers a message from an agent of this session (a named teammate's or subagent's SendMessage to
 * main) as that agent's report, so its idle notices after it are judged as after any teammate's.
 * Only remembered, never dropped: a report always reaches main. The same report seen again (an
 * attachment asked about again on resume) is not remembered anew, so it never pays twice.
 */
async function rememberAgentReport($: EngineInterface, message: { from: string; body: string }, settings: Settings): Promise<void> {
  const now = await $.clock.now()
  const held = await read($, ledger)
  const verdict = judgeTeammate({ teammate: message.from, body: message.body, loop: 'main' }, held, now, settings)
  const isKnown = verdict.key !== null && held.seen[verdict.key]?.text === verdict.text
  if (verdict.drop === null && !isKnown) {
    await recordPass($, verdict, now, settings.windowMs)
  }
}

/** The counters kept across sessions, or null when none are stored or the store cannot be read. */
async function readTotals($: EngineInterface, now: number): Promise<string | null> {
  try {
    const totals = parseTotals(await $.store.get(TOTALS), now)

    return totals === null ? null : totalsReport(totals, now)
  } catch {
    return null
  }
}

/**
 * What this load knows of agent sends, only in memory: a crash or reload lets it go, so nothing here
 * outlives one to refuse a retry. Keyed by sender.
 */
type Sends = {
  /** Each sender's sends still in delivery: their order number, and when each was made. */
  inFlight: Map<string, Map<number, number>>
  /** Senders whose record may not be their last delivered send: they are never refused until one is saved again. */
  unsaved: Set<string>
  /** The order number of each sender's last send whose record was written, so an older one never overwrites it. */
  saved: Map<string, number>
  /** The next send's order number. */
  next: number
}

/** Puts a send among its sender's sends in delivery, with no await, and returns its order number and its release. */
function claimSend(sends: Sends, sender: string, now: number): { order: number; release: () => void } {
  const mine = sends.inFlight.get(sender) ?? new Map<number, number>()
  const order = sends.next
  sends.next += 1
  mine.set(order, now)
  sends.inFlight.set(sender, mine)
  const release = () => {
    mine.delete(order)
    if (mine.size === 0 && sends.inFlight.get(sender) === mine) {
      sends.inFlight.delete(sender)
    }
  }

  return { order, release }
}

/**
 * Whether another send of this sender is in delivery. One in delivery past the expiry is let go: it
 * is removed, and as it may have been delivered with no record its sender is marked unsaved.
 */
function hasCompany(sends: Sends, sender: string, order: number, now: number): boolean {
  let isAccompanied = false
  const mine = sends.inFlight.get(sender) ?? new Map<number, number>()
  for (const [other, madeAt] of mine) {
    if (other === order) {
      continue
    }
    if (now - madeAt > IN_FLIGHT_EXPIRY_MS) {
      mine.delete(other)
      sends.unsaved.add(sender)
    } else {
      isAccompanied = true
    }
  }

  return isAccompanied
}

/**
 * Remembers a delivered send. Best effort: a failure here must never reach `.catch`, which would send
 * it again. The sender is put in `unsaved` whenever the record may not be its last delivered send: the
 * write failed, or a send made later was recorded first (this one, delivered after it, may be the
 * last the recipient has). `unsaved` is cleared before the write, so an older send landing during it
 * marks it again.
 */
async function rememberSend($: EngineInterface, sends: Sends, sender: string, order: number, verdict: Verdict, now: number, windowMs: number): Promise<void> {
  const { key, digest } = verdict
  if (key === null) {
    return
  }
  const isNewest = () => order >= (sends.saved.get(sender) ?? -1)
  if (!isNewest()) {
    sends.unsaved.add(sender)

    return
  }
  sends.saved.set(sender, order)
  sends.unsaved.delete(sender)
  try {
    await update($, ledger, was => (isNewest() ? remember(was, key, digest, now, windowMs) : was))
  } catch {
    // The delivery stands; only the repeat check is let go.
    sends.unsaved.add(sender)
  }
}

export const register: Register = (on, options) => {
  // Each option is read on its own; a bad value falls back to its default rather than failing the load.
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'notice-dedupe', description: 'Show what notice-dedupe dropped, this session and across sessions' })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'notice-dedupe' }, async $ => {
    const now = await $.clock.now()
    const session = report(await read($, ledger), now)
    const totals = await readTotals($, now)

    return { text: totals === null ? session : `${session}\n\n${totals}` }
  }).catch(() => ({ text: 'could not read its counters.' }))

  // Every .catch below lets the prompt or message through: a bug here must never cost one.
  on('prompt.submit', async ($, e, next) => {
    const deliveries = isTeammateDelivery(e.origin, e.text) ? parseTeammateDelivery(e.text, settings.aggressiveIdle) : null
    if (deliveries !== null) {
      const reason = await judgeDelivery($, deliveries.map(delivery => ({ ...delivery, loop: 'main' })), settings)

      return reason === null ? next(e) : { drop: reason }
    }
    const agent = isAgentDelivery(e.origin, e.text) ? parseAgentMessage(e.text) : null
    if (agent !== null) {
      await rememberAgentReport($, agent, settings)

      return next(e)
    }
    // Another session's message: only a whole <cross-session-message> block is read, and only for a repeat.
    const peer = e.origin.kind === 'peer' ? judgePeer(e.origin, e.text, await read($, ledger), await $.clock.now(), settings) : null
    if (peer === null && !isJudged(e.origin)) {
      return next(e)
    }
    const now = await $.clock.now()
    const verdict = peer ?? judgePrompt(e.origin, e.text, await read($, ledger), now, settings)
    const probed = verdict.probe === undefined ? {} : { probe: verdict.probe }
    if (verdict.drop !== null) {
      await recordDrop($, settings, verdict.drop, verdict.excerpt, now, probed)

      return { drop: dropReason(verdict.drop) }
    }
    await recordPass($, verdict, now, settings.windowMs)
    if (verdict.probe !== undefined) {
      await account($, settings, { probe: verdict.probe, excerpt: verdict.excerpt }, now)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A notification delivered into a running turn reaches the model as a `queued_command` attachment,
  // which a hook may leave out of the request. Only "report was delivered" is left out here: the
  // answer holds per attachment and is asked again on resume, so only a judgement that needs no
  // memory (that class always drops) is made at this door, and only when the attachment holds
  // nothing but that notification in the harness's frame.
  // A message from an agent of this session delivered into a running turn is only remembered here.
  on('prompt.attachment', { type: 'queued_command' }, async ($, e, next) => {
    const agent = e.origin.kind === 'engine' ? parseAgentMessage(e.text) : null
    if (agent !== null) {
      await rememberAgentReport($, agent, settings)

      return next(e)
    }
    if (!settings.dropsDelivered || e.origin.kind !== 'engine' || !isBareDelivered(e.text)) {
      return next(e)
    }
    const note = parseNotification(e.text)
    await recordDrop($, settings, 'delivered', `(queued) ${excerptOf(note.result ?? e.text)}`, await $.clock.now(), { probe: 'match' })

    return { text: null }
  }).catch(($, e, next) => next(e))

  // A notification folded into a turn (the agent's hand-back turn, the person's next prompt) is no
  // submission: the engine appends it as a row of its own, which no hook may refuse, only rewrite.
  // Only that row is touched, never the person's, and only when it is one pointer notification:
  // emptied (the engine then stores its own "(no content)"), or under foldMode "stub" one line.
  on('session.append', { door: 'prompt', origin: { kind: 'task-notification' } }, async ($, e, next) => {
    const [only] = e.message.content
    const isOneText = e.message.content.length === 1 && only?.type === 'text' && typeof only.text === 'string'
    const text = isOneText ? String(only.text) : null
    const stub = settings.dropsDelivered && text !== null ? foldedStub(text) : null
    if (text === null || stub === null) {
      return next(e)
    }
    await recordDrop($, settings, 'delivered', `(folded) ${excerptOf(text)}`, await $.clock.now(), { isFolded: true, probe: 'match' })
    const content = settings.foldMode === 'stub' ? [{ type: 'text' as const, text: stub }] : []

    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => next(e))

  // The team mailbox's own door: the same rule, for a delivery that is one teammate's.
  on('session.receive', async ($, e, next) => {
    const wrapped = parseTeammateDelivery(e.text, settings.aggressiveIdle)
    const sender = 'teammate' in e.origin ? e.origin.teammate : undefined
    const deliveries = wrapped ?? (sender === undefined ? null : [{ teammate: sender, body: e.text.trim() }])
    if (deliveries === null || (sender !== undefined && deliveries.some(delivery => delivery.teammate !== sender))) {
      return next(e)
    }
    const loop = e.agentId ?? 'main'
    const reason = await judgeDelivery($, deliveries.map(delivery => ({ ...delivery, loop })), settings)

    return reason === null ? next(e) : { consumed: reason }
  }).catch(($, e, next) => next(e))

  const sends: Sends = { inFlight: new Map(), unsaved: new Set(), saved: new Map(), next: 0 }

  // A plugin's `$.session.send` carries no agentId, so all of them share 'main' as their sender with
  // the main conversation: a send in between only ever lets a repeat through (fails safe).
  on('session.send', async ($, e, next) => {
    const sender = e.agentId ?? 'main'
    let release = () => {}
    try {
      const now = await $.clock.now()
      const claim = claimSend(sends, sender, now)
      release = claim.release
      // A send never waits on another. While another of this sender's is in delivery, this one is not
      // refused: that one may land first and be the last the recipient has. At worst a missed repeat.
      const wasAccompanied = hasCompany(sends, sender, claim.order, now)
      const held = await read($, ledger)
      const judged = judgeSend(e, held, now, settings)
      const isAlone = !wasAccompanied && !hasCompany(sends, sender, claim.order, now)
      if (judged.drop !== null && isAlone && !sends.unsaved.has(sender)) {
        await recordDrop($, settings, judged.drop, `to ${e.to}: ${judged.excerpt}`, now)

        return { isDelivered: false, reason: refusalReason(e.to, held.seen[judged.key ?? '']?.at ?? now, now) }
      }
      // Remembered only once delivered: nothing is written before, so nothing can be left behind to refuse a retry.
      const sent = await next(e)
      if (sent.isDelivered) {
        await rememberSend($, sends, sender, claim.order, judged, now, settings.windowMs)
      }

      return sent
    } catch (error) {
      // `.catch` then sends it with nothing remembered, which leaves the record stale: fail open.
      sends.unsaved.add(sender)
      throw error
    } finally {
      release()
    }
  }).catch(($, e, next) => next(e))
}
