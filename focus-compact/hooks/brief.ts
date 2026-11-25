// Pure logic of focus-compact: instructions, the brief, and when to escalate. No `$` here.

/** One conversation's compactions over the session's life: the main one or a subagent's. */
export type Loop = {
  /** Compactions that stood (not precomputed, not skipped). */
  count: number
  /** Tokens after over tokens before of the last one; null when not recorded. */
  lastRatio: number | null
  /** Where the last summary was written; null when none was. */
  lastBrief: string | null
  /** True from an escalation until a compaction shrinks properly again. */
  hasEscalated: boolean
  /**
   * A handoff note the model has not been given yet; null when none waits. A
   * row appended while the compaction runs is compacted away with the rest,
   * so the note rides the loop's next tool result or main's next prompt.
   */
  pendingNote: string | null
}

/** A session's loops, keyed by `main` or the subagent's id. */
export type Loops = Record<string, Loop>

/** One session's record in the store. */
export type SessionEntry = { updatedAt: number; loops: Loops }

/** What versions up to 0.1.0 kept under LEGACY_STORE_KEY: every session's loops in one value, by session id. */
export type Sessions = Record<string, SessionEntry>

/**
 * Each session is kept under a key of its own, `session:<id>`, so a session
 * writes only its own value: two sessions sharing the store never write over
 * each other's counts with a stale copy (the old one-value layout could).
 */
export const SESSION_KEY_PREFIX = 'session:'
/** The one-value layout of 0.1.0: read for a session with no key of its own, removed once every entry in it is stale. */
export const LEGACY_STORE_KEY = 'sessions'
/** A session not written to for this long is dropped from the store. */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000
/** The most sessions the store keeps; past it the least recently written go. Bounds the store under its 4 MiB limit. */
export const MAX_SESSIONS = 50
/** The most conversations one session keeps; past it the earliest recorded go (main and any with a note waiting stay). */
export const MAX_LOOPS = 200
export const DEFAULT_KEEP_BRIEFS = 30
export const DEFAULT_BRIEF_MAX_AGE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export const sessionKey = (sessionId: string): string => `${SESSION_KEY_PREFIX}${sessionId}`
export const DEFAULT_MIN_TOKENS_FOR_RATIO = 50_000
export const MAIN = 'main'
/** The folder in Claude's config folder that briefs go under when the `briefDir` option names no usable one. */
export const BRIEF_SUBDIR = 'compact-briefs'
export const DEFAULT_HANDOFF_AFTER = 3
export const DEFAULT_MIN_SHRINK_RATIO = 0.6
export const NEW_LOOP: Loop = { count: 0, lastRatio: null, lastBrief: null, hasEscalated: false, pendingNote: null }

/** The part of a transcript message this mod reads. */
export type Message = { role: 'user' | 'assistant'; text: string; handle?: string }

export type Limits = { handoffAfter: number; minShrinkRatio: number; minTokensForRatio: number }

export type Escalation = 'count' | 'ratio'

/** The standing focus first, then the person's own text verbatim, so theirs has the last word. */
export function withFocus(focus: string, instructions: string | undefined): string | undefined {
  const standing = focus.trim()
  if (standing === '') return instructions
  if (instructions === undefined || instructions.trim() === '') return standing
  if (instructions.includes(standing)) return instructions

  return `${standing}\n\nAdditional instructions from the user for this compaction (they take precedence over the above):\n${instructions}`
}

/**
 * The summary among a compaction's messages. Nothing marks it, so it is taken
 * to be the first message with text that the compacted transcript did not
 * hold (no handle, or a handle the input did not carry), a user-role one
 * preferred; when every message was kept, there is none.
 */
export function findSummary(before: readonly Message[], after: readonly Message[]): string | undefined {
  const kept = new Set(before.map(message => message.handle).filter(handle => handle !== undefined))
  const added = after.filter(
    message => message.text.trim() !== '' && (message.handle === undefined || !kept.has(message.handle)),
  )

  return (added.find(message => message.role === 'user') ?? added[0])?.text
}

/** Tokens after over tokens before; null unless both were recorded. */
export function shrinkRatio(tokensBefore: number | undefined, tokensAfter: number | undefined): number | null {
  if (tokensBefore === undefined || tokensAfter === undefined) return null
  if (!(tokensBefore > 0) || !(tokensAfter >= 0)) return null

  return tokensAfter / tokensBefore
}

/**
 * An option as a finite number: a number, or a string that spells one.
 * Anything else (null, '', a boolean, an object) is undefined, where Number()
 * would read null, '' and false as 0 and true as 1.
 */
export function numberOption(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN

  return Number.isFinite(n) ? n : undefined
}

export function readLimits(handoffAfter: unknown, minShrinkRatio: unknown, minTokensForRatio: unknown): Limits {
  const after = numberOption(handoffAfter)
  const ratio = numberOption(minShrinkRatio)
  const tokens = numberOption(minTokensForRatio)

  return {
    handoffAfter: after !== undefined && after >= 1 ? Math.floor(after) : DEFAULT_HANDOFF_AFTER,
    minShrinkRatio: ratio !== undefined && ratio > 0 && ratio <= 1 ? ratio : DEFAULT_MIN_SHRINK_RATIO,
    minTokensForRatio: tokens !== undefined && tokens >= 0 ? tokens : DEFAULT_MIN_TOKENS_FOR_RATIO,
  }
}

/** How many briefs to keep and for how long; 0 turns either rule off. */
export type Retention = { keepBriefs: number; briefMaxAgeDays: number }

export function readRetention(keepBriefs: unknown, briefMaxAgeDays: unknown): Retention {
  const keep = numberOption(keepBriefs)
  const days = numberOption(briefMaxAgeDays)

  return {
    keepBriefs: keep !== undefined && keep >= 0 ? Math.floor(keep) : DEFAULT_KEEP_BRIEFS,
    briefMaxAgeDays: days !== undefined && days >= 0 ? days : DEFAULT_BRIEF_MAX_AGE_DAYS,
  }
}

/**
 * The loop after one more compaction, and whether to escalate now: at the
 * count, or on a poor ratio, once. After an escalation the next compaction
 * that shrinks properly re-arms it without escalating itself.
 *
 * The ratio is judged only for a conversation of at least
 * `minTokensForRatio` tokens (a small one hardly shrinks and proves
 * nothing); with no judged ratio nothing is known about the shrink, so the
 * ratio rule neither fires nor re-arms. The count rule is unaffected.
 */
export function step(
  was: Loop,
  ratio: number | null,
  brief: string | null,
  limits: Limits,
  tokensBefore: number | undefined,
): { loop: Loop; escalation: Escalation | undefined } {
  const count = was.count + 1
  const loop = { count, lastRatio: ratio, lastBrief: brief ?? was.lastBrief, pendingNote: was.pendingNote ?? null }
  const judged = tokensBefore !== undefined && tokensBefore >= limits.minTokensForRatio ? ratio : null
  const isPoor = judged !== null && judged > limits.minShrinkRatio
  if (was.hasEscalated) {
    const shrankProperly = judged !== null && !isPoor

    return { loop: { ...loop, hasEscalated: !shrankProperly }, escalation: undefined }
  }
  const escalation = isPoor ? 'ratio' : count >= limits.handoffAfter ? 'count' : undefined

  return { loop: { ...loop, hasEscalated: escalation !== undefined }, escalation }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isRatio = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** A stored loop read defensively: each field that is not of its type takes its default; a non-object is no loop. */
export function loopOf(value: unknown): Loop | undefined {
  if (!isRecord(value)) return undefined
  const count = numberOption(value.count)

  return {
    count: count !== undefined && count >= 0 ? Math.floor(count) : 0,
    lastRatio: isRatio(value.lastRatio) ? value.lastRatio : null,
    lastBrief: typeof value.lastBrief === 'string' ? value.lastBrief : null,
    hasEscalated: value.hasEscalated === true,
    pendingNote: typeof value.pendingNote === 'string' && value.pendingNote !== '' ? value.pendingNote : null,
  }
}

/** A session's loops read defensively: every entry that is not a loop dropped. */
export function loopsFrom(value: unknown): Loops {
  if (!isRecord(value)) return {}
  const loops: Loops = {}
  for (const [key, raw] of Object.entries(value)) {
    const loop = loopOf(raw)
    if (loop !== undefined) loops[key] = loop
  }

  return loops
}

/** A stored session entry, or undefined when the value is not one. */
export function entryOf(value: unknown): SessionEntry | undefined {
  if (!isRecord(value) || typeof value.updatedAt !== 'number' || !isRecord(value.loops)) return undefined

  return { updatedAt: value.updatedAt, loops: loopsFrom(value.loops) }
}

/** The loops the 0.1.0 one-value layout holds for a session; none when it holds nothing usable. */
export function loopsOf(stored: unknown, sessionId: string): Loops {
  if (!isRecord(stored) || !Object.hasOwn(stored, sessionId)) return {}
  const session = stored[sessionId]

  return isRecord(session) ? loopsFrom(session.loops) : {}
}

/** True when the entry was written within STALE_MS of `nowMs`. */
export function isFresh(entry: unknown, nowMs: number): boolean {
  return isRecord(entry) && typeof entry.updatedAt === 'number' && nowMs - entry.updatedAt <= STALE_MS
}

/** True when the 0.1.0 one-value layout holds no fresh session: no running session can still be reading it. */
export function isLegacySpent(stored: unknown, nowMs: number): boolean {
  return !isRecord(stored) || Object.values(stored).every(entry => !isFresh(entry, nowMs))
}

/**
 * At most `max` loops: past it the earliest recorded go first (object order is
 * insertion order), one with a note waiting after the rest; main and `keepKey` stay.
 */
export function capLoops(loops: Loops, max: number, keepKey: string): Loops {
  const keys = Object.keys(loops)
  if (keys.length <= max) return loops
  const droppable = keys.filter(key => key !== MAIN && key !== keepKey)
  const byNote = [
    ...droppable.filter(key => loops[key]?.pendingNote === null),
    ...droppable.filter(key => loops[key]?.pendingNote !== null),
  ]
  const dropped = new Set(byNote.slice(0, keys.length - max))

  return Object.fromEntries(Object.entries(loops).filter(([key]) => !dropped.has(key)))
}

/**
 * Which session keys a tidy of the store removes: every stale or unreadable
 * one, then the least recently written past `max`. `ownKey` always stays.
 */
export function sessionKeysToDrop(entries: readonly (readonly [string, unknown])[], nowMs: number, ownKey: string, max: number): string[] {
  const others = entries.filter(([key]) => key !== ownKey)
  const stale = others.filter(([, value]) => entryOf(value) === undefined || !isFresh(value, nowMs)).map(([key]) => key)
  const fresh = others
    .filter(([key]) => !stale.includes(key))
    .sort((a, b) => (entryOf(b[1])?.updatedAt ?? 0) - (entryOf(a[1])?.updatedAt ?? 0))
  // One place is the own session's.
  const overflow = fresh.slice(Math.max(0, max - 1)).map(([key]) => key)

  return [...stale, ...overflow]
}

/** A Claude session id, the name of every folder this mod writes briefs into. */
const SESSION_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a folder named like a Claude session id: pruning never descends into any other. */
export function isSessionFolder(name: string): boolean {
  return SESSION_FOLDER.test(name)
}

/** The line every brief starts with; pruning removes only a file whose content starts with it. */
export const BRIEF_HEADER = '# Compaction brief: '

/** True when `text` (a file's first bytes) starts as `formatBrief` starts every brief. */
export function isBriefText(text: string): boolean {
  return text.startsWith(BRIEF_HEADER)
}

/** A brief file's name: `<conversation>-<n>.md`, the conversation a safe segment. */
const BRIEF_NAME = /^([A-Za-z0-9._-]+)-(\d+)\.md$/

/** The briefs of one conversation past the newest `keep`, by number; none when `keep` is 0. */
export function briefsBeyond(names: readonly string[], loopKey: string, keep: number): string[] {
  if (keep <= 0) return []
  const segment = safeSegment(loopKey)
  const numbered = names
    .map(name => ({ name, match: BRIEF_NAME.exec(name) }))
    .filter(({ match }) => match !== null && match[1] === segment)
    .map(({ name, match }) => ({ name, n: Number(match?.[2]) }))
    .sort((a, b) => b.n - a.n)

  return numbered.slice(keep).map(({ name }) => name)
}

/** A listed file this mod wrote (by its name) that is older than the age limit; never with the limit at 0. */
export function isStaleBrief(
  entry: { name: string; kind: string; mtimeMs: number; isLink: boolean },
  nowMs: number,
  maxAgeDays: number,
): boolean {
  return (
    maxAgeDays > 0 &&
    entry.kind === 'file' &&
    !entry.isLink &&
    BRIEF_NAME.test(entry.name) &&
    entry.mtimeMs > 0 &&
    nowMs - entry.mtimeMs > maxAgeDays * DAY_MS
  )
}

/** The loop's waiting note, and the loops with it taken; undefined when none waits. */
export function takeNote(
  loops: Readonly<Record<string, Loop>>,
  loopKey: string,
): { note: string; loops: Record<string, Loop> } | undefined {
  const loop = loops[loopKey]
  if (loop === undefined || typeof loop.pendingNote !== 'string' || loop.pendingNote === '') return undefined

  return { note: loop.pendingNote, loops: { ...loops, [loopKey]: { ...loop, pendingNote: null } } }
}

/** A path segment that cannot leave its folder: no separators, no leading dot. */
export function safeSegment(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')

  return cleaned === '' ? '_' : cleaned.slice(0, 120)
}

/** The environment a folder is resolved against: `CLAUDE_CONFIG_DIR` and `HOME`, each unset when undefined or empty. */
export type DirEnv = { configDir?: string | undefined; home?: string | undefined }

/** `~` and `~/x` as the shell expands them; unchanged without a home. */
export function expandHome(path: string, home: string | undefined): string {
  if ((path !== '~' && !path.startsWith('~/')) || home === undefined || home === '') return path

  return `${home.replace(/\/+$/, '')}${path.slice(1)}`
}

/** A folder path that is absolute (after `~` is expanded) with no `..`, its trailing slashes dropped; else null. */
export function usableDir(value: unknown, home: string | undefined): string | null {
  const dir = expandHome(String(value ?? '').trim(), home).replace(/\/+$/, '')

  return dir.startsWith('/') && !dir.split('/').includes('..') ? dir : null
}

/**
 * Claude's config folder: `CLAUDE_CONFIG_DIR` when it is a usable folder, else `~/.claude`. With
 * neither known, `/tmp/.claude`, so a brief still has somewhere to go.
 */
export function claudeConfigDir({ configDir, home }: DirEnv): string {
  return usableDir(configDir, home) ?? `${usableDir(home, undefined) ?? '/tmp'}/.claude`
}

/** Where briefs go by default: `compact-briefs` in Claude's config folder. */
export function defaultBriefDir(env: DirEnv): string {
  return `${claudeConfigDir(env)}/${BRIEF_SUBDIR}`
}

/** The folder briefs go under: the option when it is an absolute path (or one under `~/`) with no `..`, else the default. */
export function resolveBriefDir(option: unknown, env: DirEnv): string {
  return usableDir(option, env.home) ?? defaultBriefDir(env)
}

export function briefPath(dir: string, sessionId: string, loopKey: string, n: number): string {
  return `${dir}/${safeSegment(sessionId)}/${safeSegment(loopKey)}-${n}.md`
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

export function formatBrief(brief: {
  loopKey: string
  sessionId: string
  trigger: string
  count: number
  nowMs: number
  tokensBefore: number | undefined
  tokensAfter: number | undefined
  ratio: number | null
  summary: string
}): string {
  const tokens =
    brief.ratio === null
      ? 'not recorded'
      : `${brief.tokensBefore} -> ${brief.tokensAfter} (${percent(brief.ratio)} kept)`

  return [
    `${BRIEF_HEADER}${brief.loopKey}, compaction ${brief.count}`,
    '',
    `- time: ${new Date(brief.nowMs).toISOString()}`,
    `- session: ${brief.sessionId}`,
    `- conversation: ${brief.loopKey}`,
    `- trigger: ${brief.trigger}`,
    `- tokens: ${tokens}`,
    `- compaction number: ${brief.count}`,
    '',
    '---',
    '',
    brief.summary.trimEnd(),
    '',
  ].join('\n')
}

function reasonText(escalation: Escalation, loop: Loop, limits: Limits): string {
  return escalation === 'count'
    ? `this conversation has now been compacted ${loop.count} time${loop.count === 1 ? '' : 's'} (limit ${limits.handoffAfter})`
    : `the last compaction kept ${percent(loop.lastRatio ?? 1)} of the tokens (more than ${percent(limits.minShrinkRatio)})`
}

/**
 * The model-visible note, for a subagent alone: it writes its brief and stops.
 * Main is never asked: it keeps compacting in place (agent-budget points it at its handoff file).
 */
export function handoffNote(escalation: Escalation, loop: Loop, limits: Limits): string {
  const brief = loop.lastBrief === null ? 'No brief could be written for it.' : `The latest compaction brief is at ${loop.lastBrief}.`
  const action =
    'Do not start new work. Write your handoff brief now, at most 60 lines: the goal, the constraints in force, what is done, partial and not started, the next steps in order, and every unmerged branch you created. Return it as your final message and stop.'

  return `[focus-compact] Compaction is no longer buying enough: ${reasonText(escalation, loop, limits)}. ${brief} ${action}`
}

/** Main's limits: it compacts as often as it needs, so the count never escalates; a poor shrink still toasts. */
export function mainLimits(limits: Limits): Limits {
  return { ...limits, handoffAfter: Number.POSITIVE_INFINITY }
}

export function toastText(escalation: Escalation, loopKey: string, loop: Loop, limits: Limits): string {
  const who = loopKey === MAIN ? 'main keeps compacting in place' : `subagent ${loopKey} was told to hand off`

  return `${reasonText(escalation, loop, limits)}; ${who}`
}

export function formatStatus(loops: Readonly<Record<string, Loop>>): string {
  const keys = Object.keys(loops).sort((a, b) => (a === MAIN ? -1 : b === MAIN ? 1 : a.localeCompare(b)))
  if (keys.length === 0) return 'no compaction yet this session.'

  return keys
    .map(key => {
      const loop = loops[key] ?? NEW_LOOP
      const ratio = loop.lastRatio === null ? 'not recorded' : `${percent(loop.lastRatio)} kept`
      const flag = !loop.hasEscalated ? '' : key === MAIN ? ', poor shrink' : ', handoff asked'

      return `${key}: ${loop.count} compaction${loop.count === 1 ? '' : 's'}, last ${ratio}${flag}, brief ${loop.lastBrief ?? 'none'}`
    })
    .join('\n')
}
