import type { MainCycle, Track } from '../types'

export type Thresholds = { warnTokens: number; rotateTokens: number; repeatTokens: number }
export type BudgetEvent = 'warn' | 'rotate' | null
export type Usage = {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const MAIN = 'main'
/** An agent that made no request for this long is left out of the status line. */
export const STALE_MS = 60 * 60_000
/** The most agents the session keeps a track of; past it the longest idle are dropped (main never is). */
export const MAX_TRACKS = 200
export const DEFAULT_LIMITS: Thresholds = { warnTokens: 300_000, rotateTokens: 400_000, repeatTokens: 50_000 }
export const DEFAULT_HANDOFF_MAX_AGE_DAYS = 30
const DAY_MS = 24 * 60 * 60_000

/** An option as a finite number: a number, or a string that spells one; anything else is undefined. */
function numberOf(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN

  return Number.isFinite(n) ? n : undefined
}

/** A positive number from an option, else the fallback: a missing, zero, negative or garbage value never disables a limit. */
export function positiveOption(value: unknown, fallback: number): number {
  const n = numberOf(value)

  return n !== undefined && n > 0 ? n : fallback
}

/** Zero or more from an option (0 turns the rule off), else the fallback. */
export function nonNegativeOption(value: unknown, fallback: number): number {
  const n = numberOf(value)

  return n !== undefined && n >= 0 ? n : fallback
}

/** Shares of an agent's auto-compact point it is warned at and told to hand off at: room is left for the handoff. */
export const WARN_SHARE = 0.6
export const HANDOFF_SHARE = 0.75
/**
 * Where auto-compaction runs, as a share of a window, when the engine does not say (a subagent's):
 * at or under where it runs on a 200k window (about 167k), so an estimate is never late.
 */
export const ESTIMATED_COMPACT_SHARE = 0.8
/** The window taken for an agent whose window cannot be learned: the smallest in common use, so the cap errs early. */
export const FALLBACK_WINDOW = 200_000

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/** Where auto-compaction is taken to run on a window of this size; an unknown window is the fallback one. */
export function estimatedCompactAt(window: number | undefined): number {
  return Math.floor((positive(window) ?? FALLBACK_WINDOW) * ESTIMATED_COMPACT_SHARE)
}

/** The slice of `$.session.usage().context` (SessionContextUsage) the caps read. */
export type WindowFacts = {
  window?: number
  breakdown?: { autoCompactThreshold?: number; isAutoCompactEnabled?: boolean; rawMaxTokens?: number }
}

/**
 * Main's auto-compact point: the engine's own threshold; with auto-compaction off, the window it
 * would run out of; with no breakdown, an estimate from its window; with nothing, the fallback's.
 */
export function mainCompactAt(facts: WindowFacts | undefined): number {
  const breakdown = facts?.breakdown
  const threshold = positive(breakdown?.autoCompactThreshold)
  if (threshold !== undefined) {
    return threshold
  }
  const raw = positive(breakdown?.rawMaxTokens)
  if (raw !== undefined && breakdown?.isAutoCompactEnabled === false) {
    return raw
  }

  return estimatedCompactAt(raw ?? facts?.window)
}

/** The compaction window set for the session (env or settings), when it is below the model's own; else undefined. */
export function sessionCompactWindow(facts: WindowFacts | undefined): number | undefined {
  const raw = positive(facts?.breakdown?.rawMaxTokens)
  const window = positive(facts?.window)

  return raw !== undefined && window !== undefined && raw < window ? raw : undefined
}

/**
 * A subagent's auto-compact point, which the engine does not report: estimated from its model's
 * window, lowered by a compaction window set for the session (a subagent's never exceeds it).
 */
export function subagentCompactAt(window: number | undefined, compactWindow: number | undefined): number {
  const own = positive(window) ?? FALLBACK_WINDOW

  return estimatedCompactAt(Math.min(own, positive(compactWindow) ?? own))
}

/**
 * The thresholds one agent is held to: the set ones, each capped at its share of the agent's
 * auto-compact point, so the handoff comes before the engine compacts on any window.
 * An unknown point (null) is the fallback window's.
 */
export function limitsFor(limits: Thresholds, compactAt: number | null): Thresholds {
  const point = compactAt ?? estimatedCompactAt(undefined)

  return {
    warnTokens: Math.min(limits.warnTokens, Math.floor(point * WARN_SHARE)),
    rotateTokens: Math.min(limits.rotateTokens, Math.floor(point * HANDOFF_SHARE)),
    repeatTokens: limits.repeatTokens,
  }
}

export function readThresholds(options: Readonly<Record<string, unknown>>): Thresholds {
  return {
    warnTokens: positiveOption(options.warnTokens, DEFAULT_LIMITS.warnTokens),
    rotateTokens: positiveOption(options.rotateTokens, DEFAULT_LIMITS.rotateTokens),
    repeatTokens: positiveOption(options.repeatTokens, DEFAULT_LIMITS.repeatTokens),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** True for a value shaped like a Track: what an older version or a broken write left is not one. */
export function isTrack(value: unknown): value is Track {
  return (
    isRecord(value) &&
    typeof value.label === 'string' &&
    typeof value.isListed === 'boolean' &&
    typeof value.tokens === 'number' &&
    Number.isFinite(value.tokens) &&
    typeof value.at === 'number' &&
    typeof value.hasWarned === 'boolean' &&
    (value.notedAt === null || typeof value.notedAt === 'number') &&
    typeof value.isNotePending === 'boolean'
  )
}

/** The tracks a held value holds, every entry that is not a Track dropped. */
export function tracksOf(held: unknown): Record<string, Track> {
  if (!isRecord(held)) {
    return {}
  }

  // A track an older version left has no auto-compact point: it reads as unknown.
  return Object.fromEntries(
    Object.entries(held)
      .filter((entry): entry is [string, Track] => isTrack(entry[1]))
      .map(([id, track]) => [id, { ...track, compactAt: positive(track.compactAt) ?? null }]),
  )
}

/** Main's cycle as held, or idle when what is held is not one. */
export function cycleOf(held: unknown): MainCycle {
  if (!isRecord(held) || !['idle', 'asked', 'compacting'].includes(String(held.phase))) {
    return IDLE_CYCLE
  }

  return {
    phase: held.phase as MainCycle['phase'],
    askedAt: typeof held.askedAt === 'number' ? held.askedAt : null,
    attempts: typeof held.attempts === 'number' && Number.isFinite(held.attempts) ? held.attempts : 0,
    resumeNote: typeof held.resumeNote === 'string' ? held.resumeNote : null,
  }
}

/**
 * At most `keep` tracks: past it the ones idle longest go first, a track with a
 * note waiting last; main and `keepId` (the agent just stepped) always stay.
 */
export function capTracks(agents: Record<string, Track>, keep: number, keepId: string): Record<string, Track> {
  const ids = Object.keys(agents)
  if (ids.length <= keep) {
    return agents
  }
  const byDropOrder = (a: string, b: string): number => {
    const ta = agents[a] as Track
    const tb = agents[b] as Track

    return Number(ta.isNotePending) - Number(tb.isNotePending) || ta.at - tb.at
  }
  const droppable = ids.filter(id => id !== MAIN && id !== keepId).sort(byDropOrder)
  const dropped = new Set(droppable.slice(0, ids.length - keep))

  return Object.fromEntries(Object.entries(agents).filter(([id]) => !dropped.has(id)))
}

/** True when main's handoff file is older than the age limit; a limit of 0 keeps every file. */
export function isStaleHandoff(mtimeMs: number, now: number, maxAgeDays: number): boolean {
  return maxAgeDays > 0 && mtimeMs > 0 && now - mtimeMs > maxAgeDays * DAY_MS
}

/** What one request was answered over: the context the agent holds at that step. */
export function contextTokens(usage: Usage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

export function newTrack(label: string, isListed: boolean, at: number, compactAt: number | null = null): Track {
  return { label, isListed, tokens: 0, at, hasWarned: false, notedAt: null, isNotePending: false, compactAt }
}

/**
 * The agent's track after a step of `tokens`, and what that step crossed:
 * `warn` once, `rotate` on crossing and again per `repeatTokens` of growth.
 * A context that fell by more than half was compacted: its flags start over.
 */
export function advance(prev: Track, tokens: number, limits: Thresholds): { track: Track; event: BudgetEvent } {
  const hasShrunk = tokens < prev.tokens / 2
  const base: Track = hasShrunk ? compacted(prev) : prev
  const track: Track = { ...base, tokens }

  if (tokens >= limits.rotateTokens) {
    const isDue = base.notedAt === null || tokens - base.notedAt >= limits.repeatTokens

    return isDue
      ? { track: { ...track, hasWarned: true, notedAt: tokens, isNotePending: true }, event: 'rotate' }
      : { track, event: null }
  }
  if (tokens >= limits.warnTokens && !base.hasWarned) {
    return { track: { ...track, hasWarned: true }, event: 'warn' }
  }

  return { track, event: null }
}

/** What every note of this mod starts with, and what the standing rule tells an agent to look for. */
export const MARKER = '[agent-budget]'

export const SPAWN_RULE = `Standing rule: if a tool result carries a note starting with ${MARKER}, follow it: finish the current step, write your handoff brief (at most 60 lines, listing your unmerged branches) and stop.`

/** The spawn prompt with the standing rule appended, once: a prompt that already names the marker is left as it is. */
export function withSpawnRule(prompt: string): string {
  return prompt.includes(MARKER) ? prompt : `${prompt}\n\n${SPAWN_RULE}`
}

export function formatK(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`
}

export function rotationNote(tokens: number, limits: Thresholds): string {
  return [
    `${MARKER} Your context is now about ${formatK(tokens)} tokens, past the ${formatK(limits.rotateTokens)} rotation threshold.`,
    'Finish the current step, then write your handoff brief (at most 60 lines) to the handoff folder your instructions name',
    '(scratchpad/handoff/<role>.md if they name none), list your unmerged branches in it, and stop. Start no new work.',
  ].join(' ')
}

export const IDLE_CYCLE: MainCycle = { phase: 'idle', askedAt: null, attempts: 0, resumeNote: null }

/** A track after its conversation was compacted: warned and noted afresh as it grows again. */
export function compacted(track: Track): Track {
  return { ...track, hasWarned: false, notedAt: null, isNotePending: false }
}

/** The folder in Claude's config folder that main's handoff goes under when the `handoffDir` option names no usable one. */
export const HANDOFF_SUBDIR = 'handoffs'
/** How long after main's turn ends the compaction is asked for: the turn must have let go first. */
export const COMPACT_DELAY_MS = 500
/** Turn ends that may each try the compaction before the cycle gives up until the next note. */
export const MAX_COMPACT_ATTEMPTS = 3

/** The environment a folder is resolved against: `CLAUDE_CONFIG_DIR` and `HOME`, each unset when undefined or empty. */
export type DirEnv = { configDir?: string | undefined; home?: string | undefined }

/** `~` and `~/x` as the shell expands them; unchanged without a home. */
export function expandHome(path: string, home: string | undefined): string {
  if ((path !== '~' && !path.startsWith('~/')) || home === undefined || home === '') {
    return path
  }

  return `${home.replace(/\/+$/, '')}${path.slice(1)}`
}

/** A folder path that is absolute (after `~` is expanded) with no `..`, its trailing slashes dropped; else null. */
export function usableDir(value: unknown, home: string | undefined): string | null {
  const dir = expandHome(String(value ?? '').trim(), home).replace(/\/+$/, '')

  return dir.startsWith('/') && !dir.split('/').includes('..') ? dir : null
}

/**
 * Claude's config folder: `CLAUDE_CONFIG_DIR` when it is a usable folder, else `~/.claude`. With
 * neither known, `/tmp/.claude`, so a handoff still has somewhere to go.
 */
export function claudeConfigDir({ configDir, home }: DirEnv): string {
  return usableDir(configDir, home) ?? `${usableDir(home, undefined) ?? '/tmp'}/.claude`
}

/** Where main's handoff goes by default: `handoffs` in Claude's config folder. */
export function defaultHandoffDir(env: DirEnv): string {
  return `${claudeConfigDir(env)}/${HANDOFF_SUBDIR}`
}

/**
 * The folder main's handoff goes under: the option when it is an absolute path (or one under `~/`)
 * with no `..`, else the default. `isDefault` says the folder is the default one, however it was named.
 */
export function resolveHandoffDir(option: unknown, env: DirEnv): { dir: string; isDefault: boolean } {
  const fallback = defaultHandoffDir(env)
  const dir = usableDir(option, env.home) ?? fallback

  return { dir, isDefault: dir === fallback }
}

/** A path segment that cannot leave its folder: no separators, no leading dot. */
export function safeSegment(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')

  return cleaned === '' ? '_' : cleaned.slice(0, 120)
}

/** A Claude session id, the name of every folder main's handoff goes in. */
const SESSION_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a folder named like a Claude session id: pruning never looks in any other. */
export function isSessionFolder(name: string): boolean {
  return SESSION_FOLDER.test(name)
}

/** The line main is told to start its handoff file with; pruning keys on it. */
export const HANDOFF_MARKER = '<!-- agent-budget handoff -->'

/**
 * Whether a file whose first bytes are `head` is a handoff this mod asked for: it starts with
 * the marker, or (written before the marker existed) it lies in the default folder.
 */
export function isOwnHandoff(head: string, isDefaultDir: boolean): boolean {
  return head.replace(/^\uFEFF/, '').trimStart().startsWith(HANDOFF_MARKER) || isDefaultDir
}

/** Main's one handoff file per session: every cycle overwrites it. */
export function handoffPath(dir: string, sessionId: string): string {
  return `${dir}/${safeSegment(sessionId)}/main.md`
}

/**
 * The handoff file as a compaction finds it: written since this cycle's note
 * (`fresh`), left by an earlier cycle (`earlier`), or not there (`missing`).
 */
export type HandoffState = 'fresh' | 'earlier' | 'missing'

export function handoffState(mtimeMs: number | null, askedAt: number | null): HandoffState {
  if (mtimeMs === null) {
    return 'missing'
  }

  return askedAt !== null && mtimeMs >= askedAt ? 'fresh' : 'earlier'
}

/** The note main is given past the threshold: refresh the handoff file, then end the turn; it is compacted in place. */
export function handoffNote(tokens: number, limits: Thresholds, path: string): string {
  return [
    `${MARKER} Your context is now about ${formatK(tokens)} tokens, past the ${formatK(limits.rotateTokens)} handoff threshold.`,
    `Finish the current step, then write your handoff to ${path}, replacing what is there (at most 80 lines),`,
    `its first line exactly ${HANDOFF_MARKER}:`,
    "the current goal, the user's constraints and decisions quoted exactly, what is done, partial and not started,",
    'decisions made and why, the next steps in order, exact file paths, and open branches and running agents.',
    'Then end your turn with one line. This conversation is compacted in place when the turn ends and you continue',
    'from that file. Do not start a new session or ask anyone to hand off.',
  ].join(' ')
}

/** What the summarizer is told on main's compaction; undefined when there is no handoff file to point at. */
export function compactInstructions(path: string, state: HandoffState): string | undefined {
  if (state === 'missing') {
    return undefined
  }
  const age = state === 'fresh' ? 'just before this compaction' : 'at an earlier compaction; it may be out of date'

  return `The agent wrote its handoff to ${path} ${age}. Start the summary with this line, verbatim: "Read ${path} first: it is your handoff from before this compaction."`
}

/** Instructions already given with the handoff's appended after them, once. */
export function withInstructions(given: string | undefined, added: string | undefined): string | undefined {
  if (added === undefined) {
    return given
  }
  if (given === undefined || given.trim() === '') {
    return added
  }

  return given.includes(added) ? given : `${given}\n\n${added}`
}

/** What main reads first after its compaction. */
export function resumeNote(path: string, state: HandoffState): string {
  if (state === 'fresh') {
    return `${MARKER} Your context was just compacted. Read ${path} first: it is your handoff from before the compaction. Then continue the work it lists; if it says you were waiting on the user, say so in one line and stop.`
  }
  if (state === 'earlier') {
    return `${MARKER} Your context was just compacted and no handoff was written this time. ${path} holds one from an earlier compaction and may be out of date: read it, trust the summary where they differ, and continue.`
  }

  return `${MARKER} Your context was just compacted and no handoff file was written to ${path}. Continue from the summary.`
}

export function toastText(track: Track, event: 'warn' | 'rotate', limits: Thresholds): string {
  const size = `${track.label}: context ${formatK(track.tokens)}`
  if (event === 'warn') {
    return `${size}, past the ${formatK(limits.warnTokens)} warning`
  }

  return track.label === MAIN
    ? `${size}, past ${formatK(limits.rotateTokens)}: writing its handoff, then compacting in place`
    : `${size}, past ${formatK(limits.rotateTokens)}: told to hand off and stop`
}

const bySize = (a: readonly [string, Track], b: readonly [string, Track]): number => b[1].tokens - a[1].tokens

/** `agents: 4 · max 312k (speed)`, over the subagents that stepped lately; undefined with none. */
export function statusLine(agents: Readonly<Record<string, Track>>, limits: Thresholds, now: number): string | undefined {
  const live = Object.entries(agents)
    .filter(([id, track]) => id !== MAIN && track.isListed && track.tokens > 0 && now - track.at <= STALE_MS)
    .sort(bySize)
  const top = live[0]?.[1]
  if (top === undefined) {
    return undefined
  }
  const own = limitsFor(limits, top.compactAt)
  const mark = top.tokens >= own.rotateTokens ? ' !! ROTATE' : top.tokens >= own.warnTokens ? ' !' : ''

  return `agents: ${live.length} · max ${formatK(top.tokens)} (${top.label})${mark}`
}

export function table(agents: Readonly<Record<string, Track>>, limits: Thresholds, now: number): string {
  const rows = Object.entries(agents).sort(bySize)
  if (rows.length === 0) {
    return 'no agent has made a request yet.'
  }
  const lines = rows.map(([id, track]) => {
    const own = limitsFor(limits, track.compactAt)
    const state = !track.isListed
      ? 'untracked'
      : track.tokens >= own.rotateTokens
        ? 'ROTATE'
        : track.tokens >= own.warnTokens
          ? 'warn'
          : 'ok'
    const age = Math.max(0, Math.round((now - track.at) / 60_000))
    const handoff = track.isListed ? `  hand off at ${formatK(own.rotateTokens)}` : ''

    return `${formatK(track.tokens).padStart(6)}  ${state.padEnd(9)}  ${String(age).padStart(4)}m ago  ${track.label}  [${id}]${handoff}`
  })

  return [
    `warn ${formatK(limits.warnTokens)}, rotate ${formatK(limits.rotateTokens)}, each capped at ${WARN_SHARE * 100}% and ${HANDOFF_SHARE * 100}% of the agent's auto-compact point`,
    'context  state      last step  agent',
    ...lines,
  ].join('\n')
}
