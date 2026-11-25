import type { EngineInterface, Register } from 'claude-code'

import {
  USAGE,
  applyUpdate,
  buildReminder,
  changeContext,
  freshRefresh,
  hasGoal,
  historyText,
  isDue,
  isNativeReadDue,
  markGiven,
  nativeFromCommand,
  nativeFromTranscript,
  parseCommand,
  parseConfig,
  parseRecord,
  parseToolInput,
  pickNative,
  showText,
  statusText,
  toastText,
} from './logic'
import type { Applied, Config, GoalRecord, HistoryEntry, NativeRow, RefreshState, Update } from './logic'

export const COMMAND = 'goal-refresh'
export const TOOL_NAME = 'goal_update'
/** goal_update under any plugin's name; the hook answers only the one it registered (`tool`). */
const TOOL_PATTERN = new RegExp(`^mcp__.+__${TOOL_NAME}$`)
/** Most sessions whose goal the store keeps; the least recently updated go first. */
export const MAX_SESSIONS = 200
const KEY_PREFIX = 'goal:'

export const TOOL_DESCRIPTION = [
  "Update this session's standing goal and/or its sub-goals, which the goal-refresh plugin keeps",
  'reminding you of during long sessions.',
  'Call this ONLY after the user has explicitly agreed, in this conversation, to change the goal or',
  'sub-goals (for example they said "yes, make that the goal" or asked you to change it). Never call it',
  'on your own initiative, to record progress, or because you think the goal should change: propose the',
  'change in your reply and wait for the user to agree. Each call is shown to the user and logged.',
  'Pass `goal` to replace the goal (sub-goals are kept unless also passed), `subgoals` to replace the',
  'whole sub-goal list ([] empties it), or `clear: true` to clear both. `reason` says what the user agreed to.',
].join(' ')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'The new standing goal, one or two sentences (max 1000 chars).' },
    subgoals: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
      description: 'The full new list of current sub-goals, replacing the old list (max 10).',
    },
    clear: { type: 'boolean', description: 'Clear the goal and sub-goals.' },
    reason: { type: 'string', description: 'What the user explicitly agreed to, in a few words.' },
  },
  required: ['reason'],
  additionalProperties: false,
} as const

// This session's bookkeeping. A hot reload re-runs `session.start`, which starts it over.
let refresh: RefreshState = freshRefresh()
/**
 * goal_update's wire name, `mcp__<plugin>__goal_update`, as `$.tool.register` returned it: the
 * plugin's name is whatever its manifest says (a renamed copy too), so it is never written here.
 * Null until session.start registers the tool.
 */
let tool: string | null = null
let record: GoalRecord | null = null
let native: string | null = null
/** The native goal as this session saw it set or cleared (by /goal or SetGoal), stamped. */
let nativeLocal: { condition: string | null; at: number } | null = null
/** The last goal_status row of the transcript, as last read. */
let nativeRow: NativeRow | null = null
/** Whether this session has shown any sign of a native /goal; until then its transcript is never read. */
let nativeSeen = false
let isReadingNative = false
/** When a turn last read the transcript; null before the first read. */
let nativeReadAt: number | null = null
/** A compaction happened since that read: the next main turn reads again whatever the interval. */
let isNativeStale = false

const keyOf = (sessionId: string): string => `${KEY_PREFIX}${sessionId}`
const isActive = (c: Config): boolean => hasGoal(record) || (c.mirrorNative && native !== null)

const logged = ($: EngineInterface, what: string, error: unknown): void =>
  $.ui.log(`goal-refresh: ${what}: ${String(error)}`, { to: 'debug' })

function paint($: EngineInterface, c: Config): void {
  if (c.showStatus) $.ui.status(statusText(record, c.mirrorNative ? native : null))
}

/** Re-reads the native /goal condition from the transcript. Keeps the last value on any failure. */
async function readNative($: EngineInterface, c: Config): Promise<void> {
  if (!c.mirrorNative || isReadingNative) return
  isReadingNative = true
  isNativeStale = false
  try {
    const { transcriptPath } = await $.session.info()
    const run = await $.process.run(['grep', '-F', '"type":"goal_status"', transcriptPath], { timeoutMs: 5_000 })
    // grep: 0 matched, 1 matched nothing, anything else is an error (missing file and the like).
    if (run.exitCode === 0 || run.exitCode === 1) {
      nativeRow = run.exitCode === 0 ? nativeFromTranscript(run.stdout.split('\n')) : null
      native = pickNative(nativeLocal, nativeRow)
      if (native !== null) nativeSeen = true
    }
  } catch (error) {
    logged($, 'native goal not read', error)
  } finally {
    // A failed read counts too: the next try waits out the interval rather than grep every turn.
    nativeReadAt = await $.clock.now().catch(() => nativeReadAt)
    isReadingNative = false
  }
}

/**
 * A main turn's read: the whole transcript is grepped only when a compaction made it stale or
 * `nativeReadMinutes` have passed since the last read, not on every turn.
 */
async function readNativeIfDue($: EngineInterface, c: Config): Promise<void> {
  if (!isNativeReadDue(nativeReadAt, isNativeStale, await $.clock.now(), c.nativeReadMs)) return
  await readNative($, c)
}

function noteNative(condition: string | null, at: number): void {
  nativeLocal = { condition, at }
  native = pickNative(nativeLocal, nativeRow)
}

async function loadRecord($: EngineInterface): Promise<void> {
  record = parseRecord(await $.store.get(keyOf(await $.session.id())))
}

/** Keeps the store to MAX_SESSIONS goal records, dropping the least recently updated. */
async function prune($: EngineInterface, keep: string): Promise<void> {
  const keys = (await $.store.keys()).filter(k => k.startsWith(KEY_PREFIX) && k !== keep)
  if (keys.length < MAX_SESSIONS) return
  const dated = await Promise.all(keys.map(async k => ({ k, at: parseRecord(await $.store.get(k))?.updatedAt ?? 0 })))
  dated.sort((a, b) => a.at - b.at)
  for (const { k } of dated.slice(0, keys.length - MAX_SESSIONS + 1)) await $.store.delete(k)
}

/** Applies and stores an update; the model has just been told, so it counts as a refresh. */
async function save($: EngineInterface, c: Config, update: Update, by: HistoryEntry['by']): Promise<Applied> {
  const key = keyOf(await $.session.id())
  const now = await $.clock.now()
  const applied = applyUpdate(parseRecord(await $.store.get(key)), update, now, by)
  if (applied.isChanged) {
    await $.store.set(key, applied.record)
    void prune($, key).catch(error => logged($, 'prune failed', error))
  }
  record = applied.record
  refresh = markGiven(refresh, now)
  paint($, c)

  return applied
}

/** Claims a due refresh (synchronously, so parallel hooks can't both give it) and builds its text. */
async function takeReminder($: EngineInterface, c: Config): Promise<{ text: string; undo: () => void } | null> {
  if (!isActive(c)) return null
  const now = await $.clock.now()
  if (!isDue(refresh, now, c)) return null
  const before = refresh
  refresh = markGiven(refresh, now)
  if (nativeSeen) {
    await readNative($, c)
    paint($, c)
  }
  const text = buildReminder(record, c.mirrorNative ? native : null, now)
  const undo = (): void => {
    refresh = { ...refresh, lastTurn: before.lastTurn, lastAt: before.lastAt, isPending: before.isPending }
  }
  if (text === null) undo()

  return text === null ? null : { text, undo }
}

function announce($: EngineInterface, c: Config, applied: Applied): void {
  const text = toastText(applied.from, applied.to)
  if (c.showToasts) $.ui.toast(text, { timeoutMs: 10_000 })
  if (c.systemNotifications) void $.ui.notify(text, { title: 'goal-refresh' }).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const c = parseConfig(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    refresh = freshRefresh()
    tool = null
    record = null
    native = null
    nativeLocal = null
    nativeRow = null
    nativeSeen = false
    nativeReadAt = null
    isNativeStale = false
    try {
      await $.command.register({
        name: COMMAND,
        description: "Show or set this session's standing goal, which is re-injected periodically",
        argumentHint: 'set <goal> | subgoals <a | b> | show | history | clear',
        immediate: true,
      })
      tool = (await $.tool.register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: true })).tool
      await loadRecord($)
    } catch (error) {
      logged($, 'start', error)
    }
    paint($, c)
    // One transcript read per start (a resume restores a native goal); never awaited by the start.
    void readNative($, c).then(() => paint($, c))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      refresh = { ...refresh, turns: refresh.turns + 1 }
      if (nativeSeen) void readNativeIfDue($, c).then(() => paint($, c))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && done.skip === undefined) {
      isNativeStale = true
      if (c.afterCompact) refresh = { ...refresh, isPending: true }
    }

    return done
  }).catch(($, e, next) => next(e))

  // Rides on a prompt that is already being submitted (typed, notification, loop tick); never submits one.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) return next(e)
    const reminder = await takeReminder($, c)
    if (reminder === null) return next(e)
    const done = await next({ ...e, context: [...(e.context ?? []), reminder.text] })
    if (done.drop !== undefined) reminder.undo()

    return done
  }).catch(($, e, next) => next(e))

  // Rides on a main-thread tool result inside a long turn.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || e.tool === tool || ran.deny !== undefined || !('result' in ran)) return ran
    const reminder = await takeReminder($, c)

    return reminder === null ? ran : { ...ran, context: [...(ran.context ?? []), reminder.text] }
  }).catch(($, e, next) => next(e))

  // Answers goal_update. A matcher is fixed when the module loads, before the plugin's name is
  // known, so it takes any plugin's goal_update and the hook passes on all but its own.
  on('tool.call', { tool: TOOL_PATTERN }, async ($, e, next) => {
    if (tool === null || e.tool !== tool) return next(e)
    if (e.agentId !== undefined) return { deny: 'goal_update is for the main conversation only.' }
    const update = parseToolInput(e as unknown as Record<string, unknown>)
    if (typeof update === 'string') return { deny: update }
    try {
      const applied = await save($, c, update, 'tool')
      if (!applied.isChanged) return { result: 'No change: the goal and sub-goals already read that way.' }
      announce($, c, applied)

      return { result: `${changeContext(applied.to, 'tool')}\n(The user sees a notice of this change; /goal-refresh history lists it.)` }
    } catch (error) {
      logged($, 'goal_update not saved', error)

      return { deny: 'goal-refresh could not save the goal; ask the user to run /goal-refresh set <goal>.' }
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const cmd = parseCommand(e.args)
    const now = await $.clock.now()
    switch (cmd.kind) {
      case 'show':
        if (nativeSeen) await readNative($, c)

        return { text: showText(record, c.mirrorNative ? native : null, now, refresh) }
      case 'history':
        await loadRecord($)

        return { text: historyText(record, now) }
      case 'usage':
        return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
      default: {
        const update: Update = cmd.kind === 'clear'
          ? { clear: true, reason: 'cleared by /goal-refresh clear' }
          : cmd.kind === 'set'
            ? { goal: cmd.goal, reason: 'set by /goal-refresh set' }
            : { subgoals: cmd.subgoals, reason: 'set by /goal-refresh subgoals' }
        const applied = await save($, c, update, 'command')
        if (!applied.isChanged) return { text: 'No change.' }

        return { text: toastText(applied.from, applied.to), context: [changeContext(applied.to, 'command')] }
      }
    }
  }).catch(() => ({ text: 'goal-refresh: the command failed; the goal is unchanged.' }))

  // Signs of a native /goal: the person's /goal command or the model's SetGoal tool.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const done = await next(e)
    const set = nativeFromCommand(e.args)
    if (set !== undefined) noteNative(set, await $.clock.now())
    nativeSeen = true
    paint($, c)
    void readNative($, c).then(() => paint($, c))

    return done
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'SetGoal' }, async ($, e, next) => {
    const ran = await next(e)
    const condition = (ran.result as { condition?: unknown } | undefined)?.condition
    if (ran.deny === undefined && typeof condition === 'string' && condition.length > 0) {
      noteNative(condition, await $.clock.now())
      paint($, c)
    }
    if (ran.deny === undefined) {
      nativeSeen = true
      void readNative($, c).then(() => paint($, c))
    }

    return ran
  }).catch(($, e, next) => next(e))
}
