import type { Drop, DropClass, Ledger, Seen, Totals } from '../types'

export type Settings = {
  dropsWaiting: boolean
  dropsDelivered: boolean
  dropsRepeats: boolean
  dropsIdleAfterReport: boolean
  /** Off: one block per delivery, and idle notices that add nothing to a report. On: bundles, echoes and rewordings too. */
  aggressiveIdle: boolean
  refusesRepeatSends: boolean
  /** A `<cross-session-message>` identical to one the same sender already delivered inside the window drops. */
  dropsPeerRepeats: boolean
  /** A failed or killed notification identical to the last one for the same task inside the window drops. */
  dropsRepeatFailures: boolean
  /** A folded "report was delivered" row (which the engine cannot refuse) is emptied, or replaced by a one-line stub. */
  foldMode: FoldMode
  /** The status-line count of drops. */
  showsStatus: boolean
  /** A toast for each drop. */
  showsToasts: boolean
  /** The once-a-day toast when the harness's wording seems to have changed. */
  alertsDrift: boolean
  sendMinChars: number
  windowMs: number
}
export type FoldMode = 'empty' | 'stub'

/** The defaults, as the manifest states them. */
export const DEFAULT_SETTINGS: Settings = {
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

/** A flag as settings may hold it: a boolean, or the strings "true" and "false"; anything else is the default. */
function flagOf(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (value === 'true' || value === 'false') {
    return value === 'true'
  }

  return fallback
}

/** A number as settings may hold it (a numeric string too), inside [min, max]; anything else is the default. */
function numberOf(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback
  }

  return parsed
}

/** The settings from the plugin's options, each field read on its own: a bad value falls back to its default. */
export function settingsOf(options: unknown): Settings {
  const o = typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {}
  const d = DEFAULT_SETTINGS

  return {
    dropsWaiting: flagOf(o.dropWaiting, d.dropsWaiting),
    dropsDelivered: flagOf(o.dropDelivered, d.dropsDelivered),
    dropsRepeats: flagOf(o.dropRepeats, d.dropsRepeats),
    dropsIdleAfterReport: flagOf(o.dropIdleAfterReport, d.dropsIdleAfterReport),
    aggressiveIdle: flagOf(o.aggressiveIdle, d.aggressiveIdle),
    refusesRepeatSends: flagOf(o.refuseRepeatSends, d.refusesRepeatSends),
    dropsPeerRepeats: flagOf(o.dropPeerRepeats, d.dropsPeerRepeats),
    dropsRepeatFailures: flagOf(o.dropRepeatFailures, d.dropsRepeatFailures),
    foldMode: o.foldMode === 'stub' || o.foldMode === 'empty' ? o.foldMode : d.foldMode,
    showsStatus: flagOf(o.showStatus, d.showsStatus),
    showsToasts: flagOf(o.showToasts, d.showsToasts),
    alertsDrift: flagOf(o.driftAlerts, d.alertsDrift),
    sendMinChars: numberOf(o.sendMinChars, d.sendMinChars, 0, 100_000),
    // At least a minute, at most a day: a zero or negative window would make every check meaningless.
    windowMs: numberOf(o.windowMinutes, d.windowMs / 60_000, 1, 24 * 60) * 60_000,
  }
}
export type Notification = {
  taskId: string | null
  status: string | null
  summary: string | null
  /** The harness's own remark: whether the agent stopped with background work still running. */
  note: string | null
  result: string | null
}
/** How a completed notification compared with the boilerplate wording: matched it, or nearly did. */
export type Probe = 'match' | 'near-miss'
/** What to do with one item: let it through (remembering it under `key`, if any) or drop it. */
export type Verdict = {
  drop: DropClass | null
  key: string | null
  digest: string
  excerpt: string
  text?: string
  probe?: Probe
}

export const EMPTY_LEDGER: Ledger = { counts: {}, drops: [], seen: {} }
export const MAX_SEEN = 400
const MAX_DROPS = 10
/** A result longer than this is a report that quotes the boilerplate, not the boilerplate. */
const MAX_BOILERPLATE_CHARS = 400
/** Origins whose text nobody typed and no agent wrote as a report: safe to compare for repeats. */
const REPEATABLE_ORIGINS = new Set(['scheduled-trigger', 'plugin'])

/** What a passed "not reported yet" is remembered as: its task id is the key, its wording does not matter. */
const WAITING_DIGEST = 'waiting'

const tag = (text: string, name: string): string | null => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)

  return match === null ? null : (match[1] ?? '').trim()
}

/** The fields of one `<task-notification>` block; every field null when the text holds none or several. */
export function parseNotification(text: string): Notification {
  const blocks = text.split('<task-notification>').length - 1
  if (blocks !== 1) {
    return { taskId: null, status: null, summary: null, note: null, result: null }
  }

  return {
    taskId: tag(text, 'task-id'),
    status: tag(text, 'status'),
    summary: tag(text, 'summary'),
    note: tag(text, 'note'),
    result: tag(text, 'result'),
  }
}

/** Which boilerplate a completed notification's whole result is, if either. */
export function boilerplateClass(note: Notification): 'waiting' | 'delivered' | null {
  const result = note.result ?? ''
  if (note.status !== 'completed' || result.length > MAX_BOILERPLATE_CHARS) {
    return null
  }
  if (result.startsWith('This agent has not reported yet') && result.includes('SubagentHandback')) {
    return 'waiting'
  }
  if (result.startsWith("This agent's report was delivered to you as a message from") && result.includes('it is not repeated here')) {
    return 'delivered'
  }

  return null
}

/**
 * Marks of the harness's own wording in the two boilerplate notices: each is something the template
 * says about an agent and its report, and an agent's report about its own work does not. A hand-back
 * that mentions a message it sent, or a delivery, holds at most one.
 */
const BOILERPLATE_MARKS: readonly RegExp[] = [
  // It speaks of the agent in the third person, from its first words.
  /^\s*(?:this|the)\s+agent(?:'s)?\s/i,
  /\bSubagentHandback\b/,
  // The report's own delivery, or its absence.
  /\breport\s+(?:(?:was|is|has\s+been)\s+)?(?:delivered|sent|handed|passed)\b/i,
  /\bnot\s+(?:yet\s+)?reported\b|\bhasn't\s+(?:yet\s+)?reported\b/i,
  /\bas\s+a\s+message\s+from\b/i,
  /\bnot\s+repeated\s+here\b/i,
  /\bwaiting\s+on\s+its\s+own\b/i,
]
/** How many marks a short result must hold to read as reworded boilerplate. */
const MIN_BOILERPLATE_MARKS = 2

/**
 * Whether a completed notification matched the boilerplate, or nearly did: a short result that
 * matched neither class but holds at least two of the boilerplate's own marks. Near-misses with no
 * matches over a session mean the harness may have reworded its notices and the filter no longer
 * sees them; an ordinary hand-back, whatever it says about messages, is neither.
 */
export function probeOf(note: Notification): Probe | null {
  const result = note.result ?? ''
  if (note.status !== 'completed' || result.length > MAX_BOILERPLATE_CHARS) {
    return null
  }
  if (boilerplateClass(note) !== null) {
    return 'match'
  }
  const marks = BOILERPLATE_MARKS.filter(mark => mark.test(result)).length

  return marks >= MIN_BOILERPLATE_MARKS ? 'near-miss' : null
}

/** How much text a folded notification's row may hold around its one block (the harness's own frame). */
const MAX_FRAME_CHARS = 600

/**
 * Whether a text is nothing but one "report was delivered" notification, in at most the harness's
 * own frame: any longer text around the block may say something else, so it is kept.
 */
export function isBareDelivered(text: string): boolean {
  const block = /<task-notification>[\s\S]*<\/task-notification>/.exec(text)
  if (block === null || boilerplateClass(parseNotification(text)) !== 'delivered') {
    return false
  }

  return text.replace(block[0], '').replace(/<\/?system-reminder>/g, '').length <= MAX_FRAME_CHARS
}

/**
 * A notification the engine folds into a turn never passes `prompt.submit`: it is appended as a row
 * of its own. Given that row's text, this is the line to keep in its place when the row is nothing
 * but one "report was delivered" notification (in the harness's frame, if any), else null: keep it.
 */
export function foldedStub(text: string): string | null {
  return isBareDelivered(text)
    ? `[notice-dedupe: a task notification for ${parseNotification(text).taskId ?? 'an agent'} said only that its report was already delivered to you as a message; omitted]`
    : null
}

/** Whitespace collapsed, and the `<usage>` counters (which differ on every notification) left out. */
export function normalize(text: string): string {
  return text
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Characters a path runs over: not whitespace, quotes or brackets. */
const PATH = String.raw`[^\s"'\x60<>()[\]{}]`
/** One path segment: a path's characters, less the slash. */
const SEGMENT = String.raw`[^\s"'\x60<>()[\]{}/]`
/** A timestamp: an ISO 8601 date-time (seconds, fraction and zone optional), a clock time with seconds, or epoch milliseconds. */
const STAMP = String.raw`(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,2}:\d{2}:\d{2}(?:\.\d+)?|1[6-9]\d{11})(?!\w|:\d)`
/** How a named field opens: `name: `, `name=`, `"name":"`, or a tag `<name>`. */
const FIELD = String.raw`["']?(?:\s*[:=]\s*["']?|>\s*)`
/**
 * Tokens that carry no meaning to a reader and differ between two sendings of the same news, each
 * with what stands in for it. A token is masked only where its place says it is noise: a timestamp
 * as a line's prefix or a named time field, an id that is a UUID or carries an id prefix or field
 * name, a counter in a named counter field, and the session's own folder of a session path (the
 * file under it is kept). Anything in prose (a date, a duration, a latency, a full commit sha, a
 * file name) is kept as written, so a changed fact is never a repeat.
 */
const VOLATILE: readonly (readonly [RegExp, string])[] = [
  // A timestamp opening a line ("[2026-11-21T10:00:00Z] ...", "10:00:01 - ..."), or in a time field.
  [new RegExp(String.raw`^([ \t]*[[(]?)${STAMP}(?=[\])]?(?:[\s:,|-]|$))`, 'gm'), '$1<time>'],
  [new RegExp(String.raw`\b((?:timestamp|ts|time|(?:created|updated|started|finished|sent)(?:_?at)?)${FIELD})${STAMP}`, 'gi'), '$1<time>'],
  // UUIDs, ids with an API prefix, and agent or task ids in a field or tag named for one.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b(?:toolu|msg|req|call)_[A-Za-z0-9]{12,}\b/g, '<id>'],
  [new RegExp(String.raw`\b((?:agent|task|tool[_-]?use)[_-]?id${FIELD})a?[0-9a-f]{16,}\b`, 'gi'), '$1<id>'],
  // A session's own folder in a path to its scratchpad, tool-results or temporary files; what follows is kept.
  [new RegExp(String.raw`(?<![\w.~/-])[~/]${PATH}*?/(scratchpad|tool-results)/`, 'g'), '<session>/$1/'],
  [new RegExp(String.raw`(?<![\w.~/-])(?:/private)?/tmp/claude-\d+/${SEGMENT}+/${SEGMENT}+/`, 'g'), '<session>/'],
  // Counters in a field named as one: duration_ms: 5, tokens=1200, <total_tokens>99</total_tokens>.
  [new RegExp(String.raw`\b((?:duration|elapsed)(?:_ms)?|(?:total_|subagent_|output_|input_)?tokens|tool_uses)${FIELD}\d[\d.,_]*(?:ms|s)?\b`, 'gi'), '$1=<n>'],
]

/**
 * What a text is compared on for a repeat: the `<usage>` counters left out, each volatile token
 * replaced (line by line, so a prefix is still a prefix), then whitespace collapsed. Never used to
 * decide whether a text is boilerplate; that reads the text as written.
 */
export function fingerprint(text: string): string {
  const masked = VOLATILE.reduce((said, [pattern, stand]) => said.replace(pattern, stand), text.replace(/<usage>[\s\S]*?<\/usage>/g, ''))

  return normalize(masked)
}

/** A short fingerprint of a normalised text: its length and an FNV-1a hash. */
export function digestOf(normalized: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i += 1) {
    hash = Math.imul(hash ^ normalized.charCodeAt(i), 0x01000193)
  }

  return `${normalized.length}:${(hash >>> 0).toString(16)}`
}

export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

export function isRepeat(seen: Readonly<Record<string, Seen>>, key: string, digest: string, now: number, windowMs: number): boolean {
  const last = seen[key]

  return last !== undefined && last.digest === digest && now - last.at < windowMs
}

/** A teammate's report was let through and no idle notice has been dropped on the strength of it yet. */
const REPORTED = 'reported'
/** That report has paid for one dropped idle notice: the next one passes. */
const SPENT = 'spent'
/** Origins a teammate's delivery may reach the prompt under. */
const TEAMMATE_ORIGINS = new Set(['peer', 'peer-send-message', 'coordinator', 'unclassified'])
const PEER_PREAMBLE = /^Another Claude session sent a message:\s*/
const TEAMMATE_BLOCK = /^<teammate-message\s+teammate_id="([^"]+)"[^>]*>([\s\S]*)<\/teammate-message>$/

/** Whether a prompt of this origin and opening could be one teammate's delivery; cheap, so every other prompt is not read further. */
export function isTeammateDelivery(origin: { kind: string }, text: string): boolean {
  return TEAMMATE_ORIGINS.has(origin.kind) && text.replace(PEER_PREAMBLE, '').startsWith('<teammate-message')
}

/** One whole `<teammate-message>` block and nothing else: who sent it and its body. Null for anything looser. */
export function parseTeammateMessage(text: string): { teammate: string; body: string } | null {
  const match = TEAMMATE_BLOCK.exec(text.replace(PEER_PREAMBLE, '').trim())
  const body = match?.[2] ?? ''
  if (match === null || body.includes('<teammate-message')) {
    return null
  }

  return { teammate: match[1] ?? '', body: body.trim() }
}

/**
 * The harness's closing paragraph after a peer's delivery, or after a message from an agent of this
 * same session, one line; any other words after the last block are not read past.
 */
const PEER_TRAILER = /^(?:This came from another Claude session|That "other Claude session" is an agent working inside this same session)\b[^\n]*$/
const TEAMMATE_BLOCKS = /<teammate-message\s+teammate_id="([^"]+)"[^>]*>([\s\S]*?)<\/teammate-message>/g

/**
 * Every block of a delivery that may bundle several and end in the harness's trailer, in order.
 * Null for anything looser: words between blocks, a block inside a block, any other ending.
 */
export function parseTeammateBundle(text: string): { teammate: string; body: string }[] | null {
  const rest = text.replace(PEER_PREAMBLE, '')
  const blocks: { teammate: string; body: string }[] = []
  let end = 0
  for (const match of rest.matchAll(TEAMMATE_BLOCKS)) {
    const body = match[2] ?? ''
    if (rest.slice(end, match.index).trim() !== '' || body.includes('<teammate-message')) {
      return null
    }
    blocks.push({ teammate: match[1] ?? '', body: body.trim() })
    end = match.index + match[0].length
  }
  const trailer = rest.slice(end).trim()

  return blocks.length === 0 || (trailer !== '' && !PEER_TRAILER.test(trailer)) ? null : blocks
}

/**
 * A delivery's blocks: exactly one whole block, in the harness's frame or not, or under `isTolerant` a
 * bundle of several. Null: not read.
 */
export function parseTeammateDelivery(text: string, isTolerant: boolean): { teammate: string; body: string }[] | null {
  const blocks = parseTeammateBundle(text)

  return isTolerant || blocks?.length === 1 ? blocks : null
}

const AGENT_BLOCK = /^<agent-message\s+from="([^"]+)"[^>]*>([\s\S]*)<\/agent-message>$/
const AGENT_CLOSE = '</agent-message>'

/** Whether a prompt of this origin and opening could be a message from an agent of this session; cheap, as `isTeammateDelivery`. */
export function isAgentDelivery(origin: { kind: string }, text: string): boolean {
  return TEAMMATE_ORIGINS.has(origin.kind) && text.replace(PEER_PREAMBLE, '').startsWith('<agent-message')
}

/**
 * One whole `<agent-message>` block (a subagent's or named teammate's SendMessage to main), in the
 * harness's preamble and trailer or bare as a delivery into a running turn carries it: who sent it
 * and its body. Null for anything looser: no block, several, or other words around it.
 */
export function parseAgentMessage(text: string): { from: string; body: string } | null {
  const rest = text.replace(PEER_PREAMBLE, '').trim()
  const close = rest.lastIndexOf(AGENT_CLOSE)
  if (close < 0) {
    return null
  }
  const end = close + AGENT_CLOSE.length
  const trailer = rest.slice(end).trim()
  const match = AGENT_BLOCK.exec(rest.slice(0, end))
  const body = match?.[2] ?? ''
  if (match === null || (trailer !== '' && !PEER_TRAILER.test(trailer)) || body.includes('<agent-message') || body.includes(AGENT_CLOSE)) {
    return null
  }

  return { from: match[1] ?? '', body: body.trim() }
}

/** The JSON object a protocol message is (an idle notice, a shutdown request), or null for prose. */
function protocolMessage(body: string): Record<string, unknown> | null {
  if (!body.startsWith('{')) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(body)
    const isTyped = typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string'

    return isTyped ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Whether a protocol message is an idle notice from `teammate` with no failure to report, whatever its reason. */
function isQuietIdle(message: Record<string, unknown>, teammate: string): boolean {
  const failure = message.failureReason
  const status = message.completedStatus

  return (
    message.type === 'idle_notification' &&
    message.from === teammate &&
    (failure === undefined || failure === null || failure === '') &&
    (status === undefined || status === null || status === 'completed')
  )
}

/** Whether a protocol message is a plain "available" idle notice from `teammate`, with no failure to report. */
function isPlainIdle(message: Record<string, unknown>, teammate: string): boolean {
  return isQuietIdle(message, teammate) && message.idleReason === 'available'
}

/** Whether it is an idle notice judged for what it says: "available", or with no reason (a teammate's turn ending, as most come). */
function isJudgedIdle(message: Record<string, unknown>, teammate: string): boolean {
  const reason = message.idleReason

  return isQuietIdle(message, teammate) && (reason === undefined || reason === 'available')
}

/** How much of a report is kept to compare a later idle notice with. */
const MAX_REPORT_CHARS = 8000
/** A report as kept: whole, or cut to its last whole sentence, so a cut sentence never reads as one the report made. */
export const reportKept = (report: string): string =>
  report.length <= MAX_REPORT_CHARS ? report : report.slice(0, MAX_REPORT_CHARS).replace(/[^.!?\n]*$/, '')
/** Words that mean the lead may have to act: a notice holding one is never dropped under `aggressiveIdle`. */
const SIGNAL = /\?|\b(?:block(?:er|ers|ed|ing|s)?|errors?|fail(?:ed|ure|ures|s|ing)?|need(?:s|ed)?|decisions?|decide[sd]?|questions?|stuck)\b/i
/** A result with numbers: a share, a ratio, a count of passes or failures, a decimal. */
const FIGURE = /\d\s*(?:%|\/\s*\d)|\b\d+\s+(?:passed|failed|of\s+\d)|\b\d+\.\d+\b/i
/** A status longer than this may hold a new fact and is not judged a pure one. */
const MAX_WAITING_CHARS = 200
const WAITING_STATUS = /^(?:still\s+)?(?:waiting\s+(?:on|for)\b|standing\s+by\b|no\s+change\b|nothing\s+(?:new|to\s+report|has\s+(?:changed|finished))\b)/i
/** A notice shorter than this restates a report only by saying exactly the same. */
const MIN_RESTATED_WORDS = 8
/** The share of a notice's three-word runs its teammate's report must hold for the notice to restate it. */
const MIN_RESTATED_SHARE = 0.8

export function hasSignal(text: string): boolean {
  return SIGNAL.test(text) || FIGURE.test(text)
}

/** An idle notice's signal: in its result, or in its summary unless that only names a message to another teammate. */
function hasIdleSignal(message: Record<string, unknown>): boolean {
  const result = typeof message.result === 'string' ? message.result : ''
  const summary = typeof message.summary === 'string' ? message.summary : ''

  return hasSignal(summary.startsWith('[to ') ? result : `${summary}\n${result}`)
}

/** What an idle notice says, read as `hasIdleSignal` reads it: an echo's summary only names its recipient. */
function idleSaid(message: Record<string, unknown>): string {
  const result = typeof message.result === 'string' ? message.result : ''
  const summary = typeof message.summary === 'string' ? message.summary : ''

  return summary.startsWith('[to ') || summary === '' ? result : `${summary}\n${result}`
}

/** A short notice that opens as nothing but "waiting on", "standing by" or "no change". */
export function isWaitingStatus(result: string): boolean {
  const said = result.trim()

  return said.length <= MAX_WAITING_CHARS && WAITING_STATUS.test(said)
}

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word !== '')
const runsOf = (words: readonly string[]): string[] => words.slice(2).map((word, i) => `${words[i]} ${words[i + 1]} ${word}`)

/** Whether `notice` says what `report` said: the same words, or nearly all its three-word runs found there. */
export function restates(notice: string, report: string): boolean {
  const said = wordsOf(notice)
  const had = wordsOf(report)
  if (said.length === 0 || said.join(' ') === had.join(' ')) {
    return said.length > 0
  }
  if (said.length < MIN_RESTATED_WORDS) {
    return false
  }
  const known = new Set(runsOf(had))
  const runs = runsOf(said)

  return runs.filter(run => known.has(run)).length / runs.length >= MIN_RESTATED_SHARE
}

/** The share of a notice's words its teammate's report must hold for the notice to paraphrase it. */
const MIN_PARAPHRASED_SHARE = 0.8
const SIGNAL_WORDS = new RegExp(SIGNAL.source, 'gi')
const signalWordsOf = (text: string): string[] => [...text.matchAll(SIGNAL_WORDS)].map(match => match[0].toLowerCase())
/** Every run holding a digit, kept whole across `.`, `/`, `:` and `%`, so 5/7 is not read as a 5 and a 7. */
const NUMBERS = /[\w.\/:%]*\d[\w.\/:%]*/g
const numbersOf = (text: string): string[] => [...text.toLowerCase().matchAll(NUMBERS)].map(match => match[0].replace(/[.\/:]+$/, ''))
/** Every path or identifier without a digit: a run holding a `/` or `_` (`logs/`, `fix/grader`, `eval_job.sh`). */
const IDENTIFIERS = /[\w.-]*[\/_][\w.\/-]*/g
const identifiersOf = (text: string): string[] => [...text.toLowerCase().matchAll(IDENTIFIERS)].map(match => match[0].replace(/[.:]+$/, ''))
/** Whether `text` holds `number` whole: not as part of a longer number or word (a path's tail counts). */
const holdsNumber = (text: string, number: string): boolean =>
  new RegExp(`(?<![\\w.])${number.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}(?!\\w)`).test(text)

/** Whether `notice` asks a question, or holds a number, identifier with a digit or signal word its teammate's `report` did not. */
function addsFigure(notice: string, report: string): boolean {
  const lowered = report.toLowerCase()
  const signalsHad = new Set(signalWordsOf(report))

  return notice.includes('?') || numbersOf(notice).some(number => !holdsNumber(lowered, number)) || signalWordsOf(notice).some(word => !signalsHad.has(word))
}

/** Whether `notice` holds a path or identifier (a `/` or `_` run) its teammate's `report` did not. */
function addsPath(notice: string, report: string): boolean {
  const lowered = report.toLowerCase()

  return identifiersOf(notice).some(path => path !== '' && !holdsNumber(lowered, path))
}

/**
 * Whether `notice` says nothing its teammate's `report` did not: it restates it, or it is a rewording
 * (a teammate's closing turn summarising the message it just sent) that holds no question, and no
 * number, identifier with a digit or signal word the report did not already hold, and whose words
 * are nearly all the report's. Measured on real pairs: rewordings share 0.2 to 0.45 of their
 * three-word runs with the report but 0.8 to 0.96 of their words.
 */
export function paraphrases(notice: string, report: string): boolean {
  if (restates(notice, report)) {
    return true
  }
  const said = wordsOf(notice)
  const had = new Set(wordsOf(report))
  if (said.length < MIN_RESTATED_WORDS || addsFigure(notice, report)) {
    return false
  }

  return said.filter(word => had.has(word)).length / said.length >= MIN_PARAPHRASED_SHARE
}

/**
 * What a notice may be written in and still be read, once `plainOf` has run: ASCII letters, digits,
 * whitespace and ordinary punctuation. Anything else (another script, an emoji, markdown's `~~`, a
 * lone `*`) may carry meaning this rule cannot read, so a notice holding it always passes.
 */
const PLAIN_TEXT = /^[A-Za-z0-9 \t\r\n.,;:!?'"()\/_-]*$/
/** Typographic quotes and the non-breaking space, with the ASCII character each stands for. */
const TYPOGRAPHIC: Readonly<Record<string, string>> = { '’': "'", '‘': "'", '“': '"', '”': '"', ' ': ' ' }
/**
 * A markdown emphasis span: text wrapped in a matching run of one to three `*`, or of one to three `_`
 * at word edges (as markdown reads it, so `WATCH_CLOSING` or `my_file_name` holds none). The wrapped
 * text must neither start nor end with whitespace or its own marker.
 */
const EMPHASIS = /(\*{1,3})(?=[^\s*])([\s\S]*?[^\s*])\1|(?<![A-Za-z0-9])(_{1,3})(?=[^\s_])([\s\S]*?[^\s_])\3(?![A-Za-z0-9])/g
/**
 * `text` with the markup that does not change its meaning taken out: typographic quotes and a
 * non-breaking space made ASCII, backticks dropped, and emphasis markers unwrapped (`**done**` is
 * `done`). Strikethrough (`~~`) and a lone `*` stay, so `PLAIN_TEXT` still reads them as news.
 */
export function plainOf(text: string): string {
  let plain = text.replace(/[’‘“” ]/g, char => TYPOGRAPHIC[char] ?? char).replace(/`/g, '')
  // Unwrap until nothing changes, so nested emphasis (`**a _b_ c**`) is unwrapped too.
  for (let previous = ''; previous !== plain; ) {
    previous = plain
    plain = plain.replace(EMPHASIS, (_whole, _stars, starred: string | undefined, _bars, barred: string | undefined) => starred ?? barred ?? '')
  }

  return plain
}
/** A phrase that says only that the teammate is finished: "I have nothing further to do", "I'm stopping here". */
const CLOSING_PHRASE = [
  String.raw`\b(?:i\s+have\s+|i've\s+|there\s+is\s+|there's\s+)?nothing\s+(?:further|more|else|left)(?:\s+to\s+(?:add|report|do|say|wait\s+for|watch))?(?:\s+from\s+me)?\b`,
  String.raw`\b(?:i\s+have\s+|i've\s+)?nothing\s+to\s+(?:add|report|do)\b`,
  String.raw`\b(?:i'?m|i\s+am)\s+(?:done|finished|stopping)(?:\s+(?:here|now))?\b`,
  String.raw`\bstopping\s+(?:here|now)\b`,
  String.raw`\b(?:my\s+|the\s+)?(?:watch|task|job|work|part)\s+(?:is\s+)?(?:finished|done|complete)\b`,
].join('|')
const CLOSING = new RegExp(CLOSING_PHRASE, 'i')
const CLOSINGS = new RegExp(CLOSING_PHRASE, 'gi')
/** Who a report goes to: main, or the lead, named or as "you". */
const RECIPIENT = String.raw`(?:main|the\s+main\s+(?:thread|session)|the\s+(?:team\s+)?lead|you)`
/** What was delivered, named only as the report itself. */
const REPORTED_THING = String.raw`(?:it|that|this|them|(?:that|this|the)\s+(?:line|result|report|message|figure|number|update))`
/**
 * The report's own delivery, said as a whole phrase: "I've sent that line to main", "reported to the
 * team lead", "told main", "the team lead has received it", "main has the result".
 */
const DELIVERIES = new RegExp(
  [
    String.raw`\b(?:i\s+|i've\s+)?(?:already\s+)?(?:sent|reported|passed|handed|relayed|forwarded)\s+(?:${REPORTED_THING}\s+)?(?:back\s+|on\s+)?to\s+${RECIPIENT}\b`,
    String.raw`\b(?:i\s+|i've\s+)?(?:already\s+)?told\s+${RECIPIENT}\b`,
    String.raw`\b${RECIPIENT}\s+(?:has|have)\s+(?:already\s+|now\s+)?(?:(?:received|got|gotten)\s+)?${REPORTED_THING}\b`,
  ].join('|'),
  'gi',
)
/** A report that left something open: still under way, pending, negated, or with a signal word. No closing notice drops after one. */
const UNFINISHED =
  /\b(?:still|running|pending|waiting|queued|yet|in\s+progress|will|keep(?:s|ing)?|continu\w*|ongoing|start(?:s|ed|ing)?|until|remaining|partial(?:ly)?|next|later|soon|todo|not|no|never|but|however|except|unless|incomplete|unfinished)\b|n['’]t\b/i
const isFinal = (report: string): boolean => !UNFINISHED.test(report) && !SIGNAL.test(report)
/** Where a report's sentences end: `.`, `!` or `?` before whitespace, or a line break. A decimal point or a path's dot is no end. */
const SENTENCE_END = /(?<=[.!?])\s+|\n/
/** A sentence as compared: lower case, whitespace collapsed, and no `.,;:!` or whitespace at either end. A `?` is kept. */
const sentenceOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!]+|[\s.,;:!]+$/g, '')

/**
 * Whether an idle `notice` adds nothing to its teammate's `report`. Both are read with their markup
 * out (`plainOf`), and the notice must then be plain text (`PLAIN_TEXT`). Its delivery phrases are
 * taken out and, after a report that left nothing open, its closing phrases too. What is left,
 * compared as a sentence (`sentenceOf`), must be empty or exactly one whole sentence of the report,
 * its words in the same order. Anything else is news.
 */
export function addsNothing(notice: string, report: string): boolean {
  const plain = plainOf(notice)
  if (!PLAIN_TEXT.test(plain)) {
    return false
  }
  const unclosed = isFinal(report) ? plain.replace(CLOSINGS, '.') : plain
  const rest = sentenceOf(unclosed.replace(DELIVERIES, '.'))

  return rest === '' || plainOf(report).split(SENTENCE_END).some(sentence => sentenceOf(sentence) === rest)
}

/** Whether `notice` only says its teammate is finished: it holds a closing phrase, after a report that left nothing open, and adds nothing to that report. */
export function isClosingStatus(notice: string, report: string): boolean {
  return CLOSING.test(plainOf(notice)) && isFinal(report) && addsNothing(notice, report)
}

/**
 * Which further class an idle notice drops under, or null: none of them. It drops only when its
 * teammate reported to this loop inside the window (else it is the only signal), and only when it
 * says nothing new: as a closing status (`isClosingStatus`), as often as it comes. `isAggressive`
 * adds, with no signal, an echo of a message to another teammate, a restatement of the report or a
 * pure waiting status, as often as they come; and a paraphrase of the report whose every signal the
 * report already held.
 */
function furtherIdleClass(
  message: Record<string, unknown>,
  teammate: string,
  last: Seen | undefined,
  now: number,
  windowMs: number,
  isAggressive: boolean,
): DropClass | null {
  const result = typeof message.result === 'string' ? message.result : ''
  const isEcho = typeof message.summary === 'string' && message.summary.startsWith('[to ')
  if (!isJudgedIdle(message, teammate) || last === undefined || now - last.at >= windowMs) {
    return null
  }
  if (isAggressive && !hasIdleSignal(message)) {
    if (isEcho) {
      return 'idle-peer-echo'
    }
    if (last.text !== undefined && restates(result, last.text)) {
      return 'idle-restatement'
    }
    // A waiting status naming a run, a path or a figure its report did not is news of its own.
    if (isWaitingStatus(result) && !addsFigure(result, last.text ?? '') && !addsPath(result, last.text ?? '')) {
      return 'idle-waiting'
    }
  }
  const said = idleSaid(message)
  if (last.text !== undefined && isClosingStatus(said, last.text)) {
    return 'idle-closing'
  }

  return isAggressive && last.text !== undefined && paraphrases(said, last.text) ? 'idle-paraphrase' : null
}

/**
 * Judges one teammate's delivery to the loop `loop`. Prose is a report: it passes and is remembered.
 * An idle notice that only says it is finished, adding nothing to that report, drops by class
 * (`furtherIdleClass`). A plain "available" idle notice that adds nothing to it (`addsNothing`) drops
 * when that teammate reported inside the window and no plain one has been dropped since; otherwise it
 * passes. Everything else passes unread.
 */
export function judgeTeammate(
  delivery: { teammate: string; body: string; loop: string },
  ledger: Ledger,
  now: number,
  settings: Settings,
): Verdict {
  const key = `report:${delivery.loop}:${delivery.teammate}`
  const pass: Verdict = { drop: null, key: null, digest: REPORTED, excerpt: excerptOf(delivery.body) }
  const message = protocolMessage(delivery.body)
  if (message === null) {
    return delivery.body === '' ? pass : { ...pass, key, text: reportKept(delivery.body) }
  }
  const result = typeof message.result === 'string' ? message.result : ''
  const excerpt = excerptOf(`${delivery.teammate} idle: ${result}`)
  const last = ledger.seen[key]
  const further = settings.dropsIdleAfterReport ? furtherIdleClass(message, delivery.teammate, last, now, settings.windowMs, settings.aggressiveIdle) : null
  if (further !== null) {
    // A further class spends nothing and remembers nothing: the window stays the report's own. A
    // closing notice may drop as often as it comes, since it adds nothing to the report.
    return { drop: further, key: null, digest: REPORTED, excerpt }
  }
  // Only a notice that adds nothing to the report (`addsNothing`) may drop on the report's strength.
  const isNews = !addsNothing(idleSaid(message), last?.text ?? '')
  if (!settings.dropsIdleAfterReport || !isPlainIdle(message, delivery.teammate) || isNews) {
    return pass
  }
  const hasReported = isRepeat(ledger.seen, key, REPORTED, now, settings.windowMs)

  return hasReported ? { drop: 'idle-after-report', key, digest: SPENT, excerpt, ...(last?.text === undefined ? {} : { text: last.text }) } : pass
}

/** Judges a delivery's blocks in order, each seeing what the ones before it left remembered. */
export function judgeTeammates(
  deliveries: readonly { teammate: string; body: string; loop: string }[],
  ledger: Ledger,
  now: number,
  settings: Settings,
): Verdict[] {
  let held = ledger

  return deliveries.map(delivery => {
    const verdict = judgeTeammate(delivery, held, now, settings)
    if (verdict.key !== null) {
      held = remember(held, verdict.key, verdict.digest, now, settings.windowMs, verdict.text)
    }

    return verdict
  })
}

/**
 * Whether a prompt of this origin is looked at at all. A person's own prompt
 * (typed, bridged, or a plugin's `asUser`), a peer's message and every origin
 * not named here are not: they pass untouched and unread.
 */
export function isJudged(origin: { kind: string; asUser?: boolean }): boolean {
  return origin.kind === 'task-notification' || (REPEATABLE_ORIGINS.has(origin.kind) && origin.asUser !== true)
}

/** Judges a submitted prompt of a judged origin: boilerplate and exact repeats drop, the rest passes. */
export function judgePrompt(
  origin: { kind: string; asUser?: boolean },
  text: string,
  ledger: Ledger,
  now: number,
  settings: Settings,
): Verdict {
  const digest = digestOf(fingerprint(text))
  const pass: Verdict = { drop: null, key: null, digest, excerpt: excerptOf(text) }

  if (origin.kind === 'task-notification') {
    const note = parseNotification(text)
    // Compared on what it says, not its envelope: a resumed agent's later notifications leave out
    // the <tool-use-id> the first one carried, and the usage counters differ every time.
    const said = fingerprint([note.status, note.summary, note.note, note.result].join('\n'))
    const digest = note.taskId === null ? pass.digest : digestOf(said)
    const excerpt = excerptOf([note.summary, note.result].filter(Boolean).join(': ') || text)
    const probe = probeOf(note)
    const probed = probe === null ? {} : { probe }
    const boilerplate = boilerplateClass(note)
    if (boilerplate === 'delivered' && settings.dropsDelivered) {
      return { drop: 'delivered', key: null, digest, excerpt, ...probed }
    }
    // The first "not reported yet" of a task passes, so an idle main is told once that the agent is
    // parked on background work; the later ones inside the window say nothing new and drop.
    if (boilerplate === 'waiting' && settings.dropsWaiting && note.taskId !== null) {
      const key = `waiting:${note.taskId}`
      const isTold = isRepeat(ledger.seen, key, WAITING_DIGEST, now, settings.windowMs)

      return { drop: isTold ? 'waiting' : null, key, digest: WAITING_DIGEST, excerpt, ...probed }
    }
    // A completed or statusless notification of one known task is compared under dropRepeats; a
    // failed or killed one under dropRepeatFailures, against the last one for that task, so the
    // first failure (and any that differs from the last) always passes. Every other status passes.
    const key = note.taskId === null ? null : `task:${note.taskId}`
    const isQuiet = note.status === null || note.status === 'completed'
    const isFailure = note.status === 'failed' || note.status === 'killed'
    const isCompared = isQuiet ? settings.dropsRepeats : isFailure && settings.dropsRepeatFailures
    if (key !== null && isCompared && isRepeat(ledger.seen, key, digest, now, settings.windowMs)) {
      return { drop: isQuiet ? 'repeat-notification' : 'repeat-failure', key, digest, excerpt, ...probed }
    }

    return { ...pass, key, digest, excerpt, ...probed }
  }

  if (isJudged(origin)) {
    const key = `prompt:${origin.kind}:${digest}`
    const isDropped = settings.dropsRepeats && isRepeat(ledger.seen, key, digest, now, settings.windowMs)

    return { ...pass, drop: isDropped ? 'repeat-prompt' : null, key }
  }

  return pass
}

/**
 * Judges one outgoing agent message: only an exact repeat of the last message this sender delivered,
 * to the same `to`, is refused. The key is one record per sender, whoever the send went to, and the
 * digest covers `to` and the text: `to` can name one recipient several ways (a name, an agent id, a
 * `from` address) or everyone (`*`), so any delivered send in between (a short one too) replaces the
 * record and makes the next one news, even one a slot per spelling would have missed.
 * A plugin's `$.session.send` carries no agentId, so all of them share 'main' as their sender: one
 * more send in between can only let a repeat through, never refuse news.
 */
export function judgeSend(
  send: { agentId?: string; to: string; text: string },
  ledger: Ledger,
  now: number,
  settings: Settings,
): Verdict {
  const digest = digestOf(`${send.to}\n${fingerprint(send.text)}`)
  // Keyed whatever the option, so every delivered send is remembered: one turned off and on again
  // judges against the real last message, never one left from before it was turned off.
  const key = `send:${send.agentId ?? 'main'}`
  const isRefusable = settings.refusesRepeatSends && normalize(send.text).length >= settings.sendMinChars
  const isDropped = isRefusable && isRepeat(ledger.seen, key, digest, now, settings.windowMs)

  return { drop: isDropped ? 'repeat-send' : null, key, digest, excerpt: excerptOf(send.text) }
}

const CROSS_SESSION_OPEN = '<cross-session-message'
const CROSS_SESSION_CLOSE = '</cross-session-message>'
const CROSS_SESSION_BLOCK = /^<cross-session-message\s+from="([^"]+)"[^>]*>([\s\S]*)<\/cross-session-message>$/

/**
 * One whole `<cross-session-message>` block, in the harness's preamble and trailer or not: who sent
 * it and its body. Null for anything looser: no block, several, or other words around it.
 */
export function parseCrossSession(text: string): { from: string; body: string } | null {
  const rest = text.replace(PEER_PREAMBLE, '').trim()
  const close = rest.lastIndexOf(CROSS_SESSION_CLOSE)
  if (!rest.startsWith(CROSS_SESSION_OPEN) || close < 0) {
    return null
  }
  const end = close + CROSS_SESSION_CLOSE.length
  const trailer = rest.slice(end).trim()
  const match = CROSS_SESSION_BLOCK.exec(rest.slice(0, end))
  const body = match?.[2] ?? ''
  if (match === null || (trailer !== '' && !PEER_TRAILER.test(trailer)) || body.includes(CROSS_SESSION_OPEN) || body.includes(CROSS_SESSION_CLOSE)) {
    return null
  }

  return { from: match[1] ?? '', body: body.trim() }
}

/**
 * Judges another session's message (origin `peer`): one identical, once normalised, to one the same
 * sender delivered inside the window drops. Null: not one cross-session message, so not judged here.
 * A body shorter than `sendMinChars` is never compared, so a short ping can be sent twice.
 */
export function judgePeer(origin: { kind: string }, text: string, ledger: Ledger, now: number, settings: Settings): Verdict | null {
  const message = origin.kind === 'peer' ? parseCrossSession(text) : null
  if (message === null) {
    return null
  }
  const digest = digestOf(fingerprint(message.body))
  const pass: Verdict = { drop: null, key: null, digest, excerpt: excerptOf(`${message.from}: ${message.body}`) }
  if (!settings.dropsPeerRepeats || normalize(message.body).length < settings.sendMinChars) {
    return pass
  }
  const key = `peer:${message.from}:${digest}`

  return { ...pass, key, drop: isRepeat(ledger.seen, key, digest, now, settings.windowMs) ? 'repeat-peer' : null }
}

/** The ledger with `key` remembered at `now`; entries past the window, and the oldest past the cap, are let go. */
export function remember(ledger: Ledger, key: string, digest: string, now: number, windowMs: number, text?: string): Ledger {
  const live = Object.entries({ ...ledger.seen, [key]: { digest, at: now, ...(text === undefined ? {} : { text }) } })
    .filter(([, seen]) => now - seen.at < windowMs)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_SEEN)

  return { ...ledger, seen: Object.fromEntries(live) }
}

export function countDrop(ledger: Ledger, drop: Drop): Ledger {
  return {
    ...ledger,
    counts: { ...ledger.counts, [drop.kind]: (ledger.counts[drop.kind] ?? 0) + 1 },
    drops: [...ledger.drops, drop].slice(-MAX_DROPS),
  }
}

export function totalDropped(ledger: Ledger): number {
  return Object.values(ledger.counts).reduce((sum, count) => sum + (count ?? 0), 0)
}

export function statusLine(ledger: Ledger): string | undefined {
  const total = totalDropped(ledger)

  return total === 0 ? undefined : `dedupe: ${total} dropped`
}

export function minutesAgo(at: number, now: number): string {
  return `${Math.max(0, Math.round((now - at) / 60_000))}m ago`
}

export function report(ledger: Ledger, now: number): string {
  const total = totalDropped(ledger)
  if (total === 0) {
    return 'nothing dropped this session.'
  }
  const counts = Object.entries(ledger.counts).map(([kind, count]) => `  ${String(count).padStart(5)}  ${kind}`)
  const drops = ledger.drops.map(drop => `  ${minutesAgo(drop.at, now).padStart(8)}  ${drop.kind.padEnd(19)}  ${drop.excerpt}`)

  return [`${total} dropped this session`, ...counts, `last ${drops.length}:`, ...drops].join('\n')
}

export function dropReason(kind: DropClass): string {
  switch (kind) {
    case 'waiting':
      return 'notice-dedupe: the agent has still not reported (already said once); its report will notify again.'
    case 'delivered':
      return "notice-dedupe: the agent's report already arrived as a message."
    case 'repeat-notification':
      return 'notice-dedupe: identical to the last notification for this task.'
    case 'repeat-prompt':
      return 'notice-dedupe: identical to a prompt already entered inside the repeat window.'
    case 'repeat-send':
      return 'notice-dedupe: identical to a message already delivered inside the repeat window.'
    case 'repeat-failure':
      return 'notice-dedupe: identical to the last failure notification for this task, which already arrived inside the repeat window.'
    case 'repeat-peer':
      return 'notice-dedupe: identical to a message this session already received from the same sender inside the repeat window.'
    case 'idle-after-report':
      return 'notice-dedupe: the teammate went idle after its report, which already arrived as a message.'
    case 'idle-peer-echo':
      return 'notice-dedupe: the teammate went idle after messaging another teammate; it reported to you inside the repeat window and this notice holds no blocker, question or result.'
    case 'idle-restatement':
      return "notice-dedupe: the teammate's idle notice restates its last report, which already arrived as a message."
    case 'idle-waiting':
      return 'notice-dedupe: the teammate is only waiting, with nothing new since its last report.'
    case 'idle-paraphrase':
      return "notice-dedupe: the teammate's closing notice rewords its last report, which already arrived as a message, and adds no number, question or signal."
    case 'idle-closing':
      return 'notice-dedupe: the teammate only says it is finished; its report already arrived as a message, and once its closing phrases are out this notice is empty or one sentence of that report.'
  }
}

/**
 * Why a repeat send is refused; only ever given once the earlier send is known to have been delivered.
 * The sender reads it as the tool's result (inside the engine's "Not sent: a plugin hook refused it (…)").
 * It must never read as a failure to stop on, and never invite rewording the same status to get past it.
 */
export function refusalReason(to: string, lastAt: number, now: number): string {
  return [
    `notice-dedupe: identical to your last message to "${to}" (${minutesAgo(lastAt, now)}), which it already has. Nothing is wrong.`,
    "Keep working on your task. When something changes, send the new information; don't reword the same status.",
  ].join(' ')
}

/** Near-misses in one session, with no match, after which the wording is taken to have drifted. */
export const DRIFT_NEAR_MISSES = 3

/** The session's ledger with one more match or near-miss counted (a ledger an older version stored counts from 0). */
export function countProbe(ledger: Ledger, probe: Probe): Ledger {
  return probe === 'match' ? { ...ledger, matches: (ledger.matches ?? 0) + 1 } : { ...ledger, nearMisses: (ledger.nearMisses ?? 0) + 1 }
}

/** Whether this session saw notices that nearly matched the boilerplate and none that matched. */
export function isDrifting(ledger: Ledger): boolean {
  return (ledger.matches ?? 0) === 0 && (ledger.nearMisses ?? 0) >= DRIFT_NEAR_MISSES
}

export const DRIFT_WARNING =
  "task notifications look like the harness's \"report was delivered\" or \"not reported yet\" notices but no longer match them. The wording may have changed and the filter needs updating; /notice-dedupe shows the last one."

/**
 * The local calendar day of a time, as `YYYY-MM-DD`: what a person reading the report calls that day.
 * Every date the mod prints, and the drift warning's once-a-day key, go through this one formatter.
 * `offsetMinutes` is minutes west of UTC, as `getTimezoneOffset` gives it; it defaults to this machine's at that instant.
 */
export function localDayOf(now: number, offsetMinutes: number = new Date(now).getTimezoneOffset()): string {
  return new Date(now - offsetMinutes * 60_000).toISOString().slice(0, 10)
}

/** What one event adds to the counters kept across sessions. */
export type TotalsEvent = { drop?: DropClass; isFolded?: boolean; probe?: Probe; excerpt: string }

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)
const DROP_CLASSES: readonly DropClass[] = [
  'waiting',
  'delivered',
  'repeat-notification',
  'repeat-failure',
  'repeat-prompt',
  'repeat-send',
  'repeat-peer',
  'idle-after-report',
  'idle-peer-echo',
  'idle-restatement',
  'idle-waiting',
  'idle-paraphrase',
  'idle-closing',
]

/**
 * The counters as stored, read field by field: whatever a hand edit, an older version or a torn write
 * left there, a bad field counts as empty. Null when nothing is stored yet.
 */
export function parseTotals(raw: unknown, now: number): Totals | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const t = raw as Record<string, unknown>
  const drops = typeof t.drops === 'object' && t.drops !== null ? (t.drops as Record<string, unknown>) : {}
  const last = typeof t.lastNearMiss === 'object' && t.lastNearMiss !== null ? (t.lastNearMiss as Record<string, unknown>) : null
  // An older version stored the UTC day as a string. Today's means the toast was raised today, so it
  // stands as raised now (not twice on upgrade day); any other day can only be past, and is let go.
  const isWarnedTodayUtc = typeof t.lastDriftWarning === 'string' && t.lastDriftWarning === new Date(now).toISOString().slice(0, 10)
  const warnedAt = typeof t.lastDriftWarningAt === 'number' && Number.isFinite(t.lastDriftWarningAt) ? t.lastDriftWarningAt : isWarnedTodayUtc ? now : undefined
  const kept: Partial<Record<DropClass, number>> = {}
  for (const kind of DROP_CLASSES) {
    if (count(drops[kind]) > 0) {
      kept[kind] = count(drops[kind])
    }
  }

  return {
    since: typeof t.since === 'number' && Number.isFinite(t.since) ? t.since : now,
    drops: kept,
    folded: count(t.folded),
    matches: count(t.matches),
    nearMisses: count(t.nearMisses),
    ...(last !== null && typeof last.at === 'number' && typeof last.excerpt === 'string'
      ? { lastNearMiss: { at: last.at, excerpt: excerptOf(last.excerpt) } }
      : {}),
    ...(warnedAt === undefined ? {} : { lastDriftWarningAt: warnedAt }),
  }
}

export const emptyTotals = (now: number): Totals => ({ since: now, drops: {}, folded: 0, matches: 0, nearMisses: 0 })

/** The counters with one event added; `isWarned` records that a drift warning was raised at `now`. */
export function addToTotals(totals: Totals, event: TotalsEvent, now: number, isWarned = false): Totals {
  const { drop, isFolded = false, probe } = event

  return {
    ...totals,
    drops: drop === undefined ? totals.drops : { ...totals.drops, [drop]: (totals.drops[drop] ?? 0) + 1 },
    folded: totals.folded + (isFolded ? 1 : 0),
    matches: totals.matches + (probe === 'match' ? 1 : 0),
    nearMisses: totals.nearMisses + (probe === 'near-miss' ? 1 : 0),
    ...(probe === 'near-miss' ? { lastNearMiss: { at: now, excerpt: event.excerpt } } : {}),
    ...(isWarned ? { lastDriftWarningAt: now } : {}),
  }
}

/** This machine's offset from UTC at a time, in minutes west, as `localDayOf` takes it. */
const machineOffset = (at: number): number => new Date(at).getTimezoneOffset()

/** The counters kept across sessions, for /notice-dedupe; `offsetOf` gives the zone its days are printed in. */
export function totalsReport(totals: Totals, now: number, offsetOf: (at: number) => number = machineOffset): string {
  const dayOf = (at: number) => localDayOf(at, offsetOf(at))
  const dropped = Object.values(totals.drops).reduce((sum, n) => sum + (n ?? 0), 0)
  const kinds = Object.entries(totals.drops).map(([kind, n]) => `  ${String(n).padStart(5)}  ${kind}`)
  const last = totals.lastNearMiss === undefined ? [] : [`  last near-miss ${minutesAgo(totals.lastNearMiss.at, now)}: ${totals.lastNearMiss.excerpt}`]
  const warned = totals.lastDriftWarningAt === undefined ? [] : [`  wording-drift warning last raised ${dayOf(totals.lastDriftWarningAt)}`]

  return [
    `all sessions since ${dayOf(totals.since)}: ${dropped} dropped`,
    ...kinds,
    `  ${String(totals.folded).padStart(5)}  folded rows emptied or stubbed (counted under delivered too)`,
    `  boilerplate matches ${totals.matches}, near-misses ${totals.nearMisses}`,
    ...last,
    ...warned,
  ].join('\n')
}
