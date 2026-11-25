// Pure logic for goal-refresh: config parsing, the stored goal record, update/history rules,
// when a refresh is due, and every text the mod shows. No `$` here, so all of it is unit-tested.

export const GOAL_MAX = 1000
export const SUBGOAL_MAX = 300
export const SUBGOALS_MAX = 10
export const REASON_MAX = 300
export const HISTORY_MAX = 20
export const NATIVE_MAX = 400
export const STATUS_MAX = 40
export const TOAST_SIDE_MAX = 80

export type Config = {
  /** Refresh after this many main-thread turns since the last one; 0 turns the trigger off. */
  everyTurns: number
  /** Refresh at the first chance after the main conversation is compacted. */
  afterCompact: boolean
  /** Refresh once this long (ms) has passed since the last one; 0 turns the trigger off. */
  minIntervalMs: number
  /** Read the native /goal condition from the transcript and include it. */
  mirrorNative: boolean
  /** Least time (ms) between two transcript reads on main-thread turns; 0 reads on every turn. */
  nativeReadMs: number
  showStatus: boolean
  showToasts: boolean
  systemNotifications: boolean
}

export type Goal = { goal: string; subgoals: string[] }

export type HistoryEntry = {
  at: number
  by: 'command' | 'tool'
  reason: string
  from: Goal
  to: Goal
}

/** What `$.store` holds per session, under `goal:<sessionId>`. */
export type GoalRecord = Goal & { updatedAt: number; reason: string; history: HistoryEntry[] }

/** The in-memory refresh bookkeeping of one session. A hot reload starts it over. */
export type RefreshState = {
  /** Main-thread turns started so far. */
  turns: number
  /** `turns` when the reminder was last given; null before the first. */
  lastTurn: number | null
  /** When the reminder was last given; null before the first. */
  lastAt: number | null
  /** A compaction or a session start owes a refresh at the next chance. */
  isPending: boolean
}

export const freshRefresh = (): RefreshState => ({ turns: 0, lastTurn: null, lastAt: null, isPending: true })

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

/** Each option read on its own; a missing or bad value falls back to its default. */
export function parseConfig(options: Record<string, unknown> | undefined): Config {
  const o = options ?? {}

  return {
    everyTurns: Math.floor(num(o.everyTurns, 10)),
    afterCompact: bool(o.afterCompact, true),
    minIntervalMs: num(o.minIntervalMinutes, 20) * 60_000,
    mirrorNative: bool(o.mirrorNativeGoal, true),
    nativeReadMs: num(o.nativeReadMinutes, 10) * 60_000,
    showStatus: bool(o.showStatus, true),
    showToasts: bool(o.showToasts, true),
    systemNotifications: bool(o.systemNotifications, false),
  }
}

/** One line, whitespace collapsed, cut to `max` characters with an ellipsis. */
export function clip(text: unknown, max: number): string {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''

  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function cleanSubgoals(list: unknown): string[] {
  if (!Array.isArray(list)) return []

  return list
    .map(item => clip(item, SUBGOAL_MAX))
    .filter(item => item.length > 0)
    .slice(0, SUBGOALS_MAX)
}

/** `a | b | c` (or one per line) as typed after `/goal-refresh subgoals`. */
export const splitSubgoals = (text: string): string[] => cleanSubgoals(text.split(/\s*\|\s*|\n+/))

const asGoal = (value: unknown): Goal => {
  const v = (value ?? {}) as Record<string, unknown>

  return { goal: clip(v.goal, GOAL_MAX), subgoals: cleanSubgoals(v.subgoals) }
}

/** The stored record, or null when nothing (or nothing usable) is stored. Never throws. */
export function parseRecord(value: unknown): GoalRecord | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const history = Array.isArray(v.history)
    ? v.history.flatMap((h): HistoryEntry[] => {
        if (h === null || typeof h !== 'object') return []
        const e = h as Record<string, unknown>

        return [{
          at: num(e.at, 0),
          by: e.by === 'tool' ? 'tool' : 'command',
          reason: clip(e.reason, REASON_MAX),
          from: asGoal(e.from),
          to: asGoal(e.to),
        }]
      }).slice(-HISTORY_MAX)
    : []

  return { ...asGoal(v), updatedAt: num(v.updatedAt, 0), reason: clip(v.reason, REASON_MAX), history }
}

export const hasGoal = (g: Goal | null): boolean => g !== null && (g.goal.length > 0 || g.subgoals.length > 0)

export type Update = { goal?: string; subgoals?: string[]; clear?: boolean; reason?: string }

export type Applied = { record: GoalRecord; isChanged: boolean; from: Goal; to: Goal }

/**
 * The record after an update. `clear` empties goal and sub-goals; a given `goal` replaces the goal
 * (sub-goals are kept unless also given); given `subgoals` replace the list. History keeps the last 20.
 */
export function applyUpdate(prev: GoalRecord | null, update: Update, now: number, by: HistoryEntry['by']): Applied {
  const from: Goal = { goal: prev?.goal ?? '', subgoals: prev?.subgoals ?? [] }
  const to: Goal = update.clear === true
    ? { goal: '', subgoals: [] }
    : {
        goal: update.goal === undefined ? from.goal : clip(update.goal, GOAL_MAX),
        subgoals: update.subgoals === undefined ? from.subgoals : cleanSubgoals(update.subgoals),
      }
  const isChanged = to.goal !== from.goal || to.subgoals.join('\n') !== from.subgoals.join('\n')
  if (!isChanged) return { record: prev ?? { ...to, updatedAt: now, reason: '', history: [] }, isChanged, from, to }
  const reason = clip(update.reason, REASON_MAX)
  const history = [...(prev?.history ?? []), { at: now, by, reason, from, to }].slice(-HISTORY_MAX)

  return { record: { ...to, updatedAt: now, reason, history }, isChanged, from, to }
}

/**
 * Whether a refresh is owed now. Never twice with no turn in between, except right after a
 * compaction or a start, which may have dropped the last one from context.
 */
export function isDue(s: RefreshState, now: number, c: Config): boolean {
  if (s.isPending) return true
  if (s.lastTurn === null || s.lastAt === null) return true
  const turnsSince = s.turns - s.lastTurn
  if (turnsSince <= 0) return false
  if (c.everyTurns > 0 && turnsSince >= c.everyTurns) return true

  return c.minIntervalMs > 0 && now - s.lastAt >= c.minIntervalMs
}

/**
 * Whether a turn re-reads the transcript for the native /goal: always when a compaction or a
 * start marked it stale or it was never read, else once `intervalMs` has passed (0: every turn).
 */
export function isNativeReadDue(lastReadAt: number | null, isStale: boolean, now: number, intervalMs: number): boolean {
  return isStale || lastReadAt === null || now - lastReadAt >= intervalMs
}

export const markGiven = (s: RefreshState, now: number): RefreshState => ({ ...s, lastTurn: s.turns, lastAt: now, isPending: false })

export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)

  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const numbered = (list: string[]): string => list.map((s, i) => `(${i + 1}) ${s}`).join('; ')

export const REMINDER_HEAD = '[goal-refresh] Standing-goal reminder from a plugin, not a new user message.'

/** The short reminder the model reads. Null when there is nothing to remind of. */
export function buildReminder(record: GoalRecord | null, native: string | null, now: number): string | null {
  const parts: string[] = []
  if (record !== null && record.goal.length > 0) parts.push(`Standing goal: ${record.goal}`)
  if (record !== null && record.subgoals.length > 0) parts.push(`Current sub-goals: ${numbered(record.subgoals)}`)
  if (record !== null && hasGoal(record)) {
    parts.push(`Last updated ${ago(now - record.updatedAt)}${record.reason ? ` (${record.reason})` : ''}.`)
  }
  const nativeText = native === null ? '' : clip(native, NATIVE_MAX)
  if (nativeText && nativeText !== record?.goal) parts.push(`Active /goal stop condition: ${nativeText}`)
  if (parts.length === 0) return null

  return [
    REMINDER_HEAD,
    ...parts,
    'Keep working toward it. Change it only with goal_update, and only after the user explicitly agrees to the change.',
  ].join('\n')
}

/** What the model is told when the goal is set or cleared, by the person's command or the model's goal_update. */
export function changeContext(to: Goal, by: HistoryEntry['by']): string {
  if (!hasGoal(to)) {
    return by === 'tool'
      ? '[goal-refresh] The standing goal was cleared through goal_update.'
      : '[goal-refresh] The standing goal was cleared by the user (/goal-refresh clear).'
  }
  const lines = ['[goal-refresh] The standing goal was updated.']
  if (to.goal) lines.push(`Standing goal: ${to.goal}`)
  if (to.subgoals.length > 0) lines.push(`Current sub-goals: ${numbered(to.subgoals)}`)

  return lines.join('\n')
}

export function statusText(record: GoalRecord | null, native: string | null): string | undefined {
  if (record !== null && record.goal) return `goal: ${clip(record.goal, STATUS_MAX)}`
  if (record !== null && record.subgoals.length > 0) return `goal: ${clip(record.subgoals[0], STATUS_MAX)}`
  if (native) return `/goal: ${clip(native, STATUS_MAX)}`

  return undefined
}

const side = (g: Goal): string => {
  if (!hasGoal(g)) return '(none)'
  const head = g.goal ? `"${clip(g.goal, TOAST_SIDE_MAX)}"` : '(no goal)'

  return g.subgoals.length > 0 ? `${head} +${g.subgoals.length} sub-goal${g.subgoals.length === 1 ? '' : 's'}` : head
}

export const toastText = (from: Goal, to: Goal): string => `Goal updated: ${side(from)} → ${side(to)}`

export function showText(record: GoalRecord | null, native: string | null, now: number, s: RefreshState): string {
  const lines: string[] = []
  if (record !== null && hasGoal(record)) {
    lines.push(`Standing goal: ${record.goal || '(none)'}`)
    record.subgoals.forEach((g, i) => lines.push(`  ${i + 1}. ${g}`))
    lines.push(`Last updated ${ago(now - record.updatedAt)}${record.reason ? ` (${record.reason})` : ''}`)
  } else {
    lines.push('No standing goal set. Use /goal-refresh set <text>.')
  }
  if (native) lines.push(`Native /goal condition: ${clip(native, NATIVE_MAX)}`)
  const last = s.lastAt === null ? 'not yet this session' : ago(now - s.lastAt)
  lines.push(`Last reminder: ${last}; turns since: ${s.lastTurn === null ? s.turns : s.turns - s.lastTurn}`)

  return lines.join('\n')
}

export function historyText(record: GoalRecord | null, now: number): string {
  const history = record?.history ?? []
  if (history.length === 0) return 'No goal changes recorded for this session.'

  return history
    .slice()
    .reverse()
    .map(h => `${ago(now - h.at)} · ${h.by}${h.reason ? ` · ${h.reason}` : ''}\n  ${side(h.from)} → ${side(h.to)}`)
    .join('\n')
}

export type Command =
  | { kind: 'show' }
  | { kind: 'history' }
  | { kind: 'clear' }
  | { kind: 'set'; goal: string }
  | { kind: 'subgoals'; subgoals: string[] }
  | { kind: 'usage'; error?: string }

export const USAGE = [
  'Usage:',
  '  /goal-refresh set <goal>          set this session\'s standing goal',
  '  /goal-refresh subgoals <a | b>    replace the sub-goals (empty clears them)',
  '  /goal-refresh show                show the goal and the last reminder',
  '  /goal-refresh history             the last 20 changes',
  '  /goal-refresh clear               clear the goal and sub-goals',
].join('\n')

export function parseCommand(args: string): Command {
  const trimmed = args.trim()
  const word = trimmed.split(/\s+/)[0] ?? ''
  const tail = trimmed.slice(word.length).trim()
  switch (word.toLowerCase()) {
    case '':
    case 'show':
    case 'status':
      return { kind: 'show' }
    case 'history':
      return { kind: 'history' }
    case 'clear':
      return { kind: 'clear' }
    case 'set':
      return tail ? { kind: 'set', goal: tail } : { kind: 'usage', error: 'set needs the goal text.' }
    case 'subgoals':
    case 'sub':
      return { kind: 'subgoals', subgoals: splitSubgoals(tail) }
    default:
      return { kind: 'usage', error: `Unknown subcommand "${word}".` }
  }
}

export type NativeRow = { condition: string | null; at: number }

/**
 * The native /goal condition as the engine restores it on resume: the last `goal_status`
 * attachment row wins; met or failed means no goal. `lines` are transcript JSONL lines.
 * Null when the transcript holds no such row; `at` is the row's timestamp (0 when unreadable).
 */
export function nativeFromTranscript(lines: readonly string[]): NativeRow | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let row: unknown
    try {
      row = JSON.parse(lines[i] ?? '')
    } catch {
      continue
    }
    const r = row as {
      type?: unknown
      timestamp?: unknown
      attachment?: { type?: unknown; met?: unknown; failed?: unknown; condition?: unknown }
    }
    if (r?.type !== 'attachment' || r.attachment?.type !== 'goal_status') continue
    const parsed = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
    const at = Number.isFinite(parsed) ? parsed : 0
    if (r.attachment.met === true || r.attachment.failed === true) return { condition: null, at }
    const condition = r.attachment.condition

    return { condition: typeof condition === 'string' && condition.length > 0 ? condition : null, at }
  }

  return null
}

/** The words `/goal` takes to clear a goal (the engine's own list). */
const NATIVE_CLEAR = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])

/**
 * What a `/goal <args>` run did to the native goal: a condition, null for a clear, or undefined
 * when it only showed the status (no args).
 */
export function nativeFromCommand(args: string): string | null | undefined {
  const text = args.trim()
  if (!text) return undefined

  return NATIVE_CLEAR.has(text.toLowerCase()) ? null : text
}

/**
 * The native condition to believe: a transcript row only overrides what this session saw set
 * by hand (`local`, stamped `at`) when the row is at least as new.
 */
export function pickNative(local: { condition: string | null; at: number } | null, row: NativeRow | null): string | null {
  if (local === null) return row?.condition ?? null
  if (row === null || row.at < local.at) return local.condition

  return row.condition
}

/** Validates the model's goal_update input. A string is an error for the model. */
export function parseToolInput(input: Record<string, unknown>): Update | string {
  const reason = clip(input.reason, REASON_MAX)
  if (!reason) return 'goal_update needs a reason: what the user agreed to, in a few words.'
  const update: Update = { reason }
  if (input.clear === true) return { ...update, clear: true }
  if (input.goal !== undefined) {
    const goal = clip(input.goal, GOAL_MAX)
    if (!goal) return 'goal must be non-empty text; pass clear: true to clear the goal.'
    update.goal = goal
  }
  if (input.subgoals !== undefined) {
    if (!Array.isArray(input.subgoals)) return 'subgoals must be an array of strings.'
    update.subgoals = cleanSubgoals(input.subgoals)
  }
  if (update.goal === undefined && update.subgoals === undefined) return 'Pass goal, subgoals, or clear: true.'

  return update
}
