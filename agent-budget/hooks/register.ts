import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  advance, capTracks, compacted, compactInstructions, COMPACT_DELAY_MS, contextTokens, cycleOf,
  DEFAULT_HANDOFF_MAX_AGE_DAYS, handoffNote, handoffPath, handoffState, IDLE_CYCLE,
  isOwnHandoff, isSessionFolder, isStaleHandoff, limitsFor, MAIN, mainCompactAt, MAX_COMPACT_ATTEMPTS, MAX_TRACKS, newTrack,
  nonNegativeOption, readThresholds, resolveHandoffDir, resumeNote, rotationNote, safeSegment, sessionCompactWindow, statusLine,
  subagentCompactAt, table, toastText, tracksOf, withInstructions, withSpawnRule,
} from './logic'
import type { BudgetEvent, HandoffState, Thresholds, Usage, WindowFacts } from './logic'
import type { MainCycle, Track } from '../types'

type Config = {
  limits: Thresholds
  includesMain: boolean
  addsRuleToSpawns: boolean
  /** The `handoffDir` option, resolved against the environment on first use and kept for the load. */
  handoffDir: { option: unknown; resolved: Promise<{ dir: string; isDefault: boolean }> | null }
  handoffMaxAgeDays: number
  showsStatus: boolean
  showsToasts: boolean
  /** Once per load of the module: a reload or a new session looks again. */
  pruning: { hasRun: boolean }
  /**
   * True while this load has main's compaction scheduled or running. A cycle held at
   * `compacting` with this false was claimed by an earlier load whose timer died with it.
   */
  compaction: { isInFlight: boolean }
  /** Main's window as last read with its breakdown, kept until the window changes (a model switch). */
  windows: { cached: { window: number; facts: WindowFacts } | null }
}

const agents = atom({ plugin: 'agent-budget', key: 'agents' } as const, {})
const mainCycle = atom({ plugin: 'agent-budget', key: 'main' } as const, IDLE_CYCLE)

/** The tracks as held, every entry an older version or a broken write left that is not a Track dropped. */
const readTracks = async ($: EngineInterface): Promise<Record<string, Track>> => tracksOf(await read($, agents))

/**
 * Main's window and where it auto-compacts, as the engine reports them; undefined when it cannot
 * say. The plain read is free; the breakdown (local estimates) is asked once per window size.
 */
async function windowFacts($: EngineInterface, config: Config): Promise<WindowFacts | undefined> {
  const plain = await $.session.usage().catch(() => undefined)
  if (plain === undefined) {
    return undefined
  }
  const { window } = plain.context
  const cached = config.windows.cached
  if (cached !== null && cached.window === window) {
    return cached.facts
  }
  const full = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
  if (full?.context.breakdown === undefined) {
    // Not kept: the breakdown is asked again at the next step.
    return { window }
  }
  const facts: WindowFacts = { window, breakdown: full.context.breakdown }
  config.windows.cached = { window, facts }

  return facts
}

// A loop's label and window, from the engine's own list; a loop it does not name, or a list that fails, keeps it unlisted.
async function identify($: EngineInterface, config: Config, id: string, now: number): Promise<Track> {
  if (id === MAIN) {
    return newTrack(MAIN, true, now)
  }
  const listed = await $.agent.list().catch(() => [])
  const info = listed.find(agent => agent.id === id)
  if (info === undefined) {
    return newTrack(id.slice(0, 8), false, now)
  }
  const compactAt = subagentCompactAt(info.contextWindowSize, sessionCompactWindow(await windowFacts($, config)))

  return newTrack(info.name || info.description || info.type || id.slice(0, 8), true, now, compactAt)
}

async function record($: EngineInterface, config: Config, agentId: string | undefined, usage: Usage | null) {
  const id = agentId ?? MAIN
  const tokens = usage === null ? 0 : contextTokens(usage)
  if (tokens === 0 || (id === MAIN && !config.includesMain)) {
    return
  }
  const now = await $.clock.now()
  const known = (await readTracks($))[id]
  // Asked again past the warning for a loop not yet named: it may have been listed since.
  const isUnsure = known === undefined || (!known.isListed && tokens >= limitsFor(config.limits, known.compactAt).warnTokens)
  const seed = isUnsure ? await identify($, config, id, now) : known
  // Main's point is read at every step: a model switch moves it.
  const compactAt = id === MAIN ? mainCompactAt(await windowFacts($, config)) : seed.compactAt
  const limits = limitsFor(config.limits, compactAt)
  const crossed: { event: BudgetEvent } = { event: null }
  const all = await update($, agents, held => {
    const tracks = tracksOf(held)
    const prev = { ...(tracks[id] ?? seed), label: seed.label, isListed: seed.isListed, compactAt }
    const next = prev.isListed ? advance(prev, tokens, limits) : { track: { ...prev, tokens }, event: null }
    crossed.event = next.event

    // Bounded: a long session that spawns many agents keeps the most recent MAX_TRACKS.
    return capTracks({ ...tracks, [id]: { ...next.track, at: now } }, MAX_TRACKS, id)
  })
  const track = all[id]
  if (track !== undefined && crossed.event !== null) {
    toast($, config, toastText(track, crossed.event, limits))
  }
  // With the status line off, undefined clears any entry an earlier load left.
  $.ui.status(config.showsStatus ? statusLine(all, config.limits, now) : undefined)
}

/** A toast, unless the showToasts option is off: display only, the budget runs the same. */
function toast($: EngineInterface, config: Config, text: string): void {
  if (config.showsToasts) {
    $.ui.toast(text, { timeoutMs: 10_000 })
  }
}

// Sets an agent's pending flag; true when this call changed it, so one of two racing calls wins.
async function setPending($: EngineInterface, id: string, isNotePending: boolean): Promise<boolean> {
  const changed = { is: false }
  await update($, agents, held => {
    const tracks = tracksOf(held)
    const track = tracks[id]
    changed.is = track !== undefined && track.isNotePending !== isNotePending

    return track !== undefined && changed.is ? { ...tracks, [id]: { ...track, isNotePending } } : held
  })

  return changed.is
}

/** Changes main's cycle and answers what `change` chose to report; one writer wins a race. */
async function changeCycle<T>(
  $: EngineInterface,
  change: (cycle: MainCycle) => { cycle: MainCycle; value: T },
): Promise<T> {
  const out: { value?: T } = {}
  await update($, mainCycle, held => {
    const changed = change(cycleOf(held))
    out.value = changed.value

    return changed.cycle
  })

  return out.value as T
}

/** The folder main's handoff goes under, from the option, `CLAUDE_CONFIG_DIR` and `HOME`; read once per load. */
function handoffDirOf($: EngineInterface, config: Config): Promise<{ dir: string; isDefault: boolean }> {
  config.handoffDir.resolved ??= (async () => {
    const [configDir, home] = await Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME')])

    return resolveHandoffDir(config.handoffDir.option, { configDir, home })
  })()

  return config.handoffDir.resolved
}

const pathOf = async ($: EngineInterface, config: Config): Promise<string> =>
  handoffPath((await handoffDirOf($, config)).dir, await $.session.id())

async function mtimeOf($: EngineInterface, path: string): Promise<number | null> {
  try {
    const stat = await $.fs.stat(path)

    return stat.kind === 'file' ? stat.mtimeMs : null
  } catch {
    return null
  }
}

/** The resume note waiting for main, taken so that it is given once. */
const takeResume = ($: EngineInterface): Promise<string | null> =>
  changeCycle($, cycle => ({ cycle: { ...cycle, resumeNote: null }, value: cycle.resumeNote }))

/**
 * What main is to read with its next tool result or prompt: the resume note
 * after a compaction, and the handoff note once main crossed the threshold.
 * Giving the handoff note starts the cycle: main's next answered turn end compacts.
 */
async function takeMainNotes($: EngineInterface, config: Config): Promise<string[]> {
  const notes: string[] = []
  const resume = await takeResume($)
  if (resume !== null) {
    notes.push(resume)
  }
  const track = (await readTracks($))[MAIN]
  if (track !== undefined && track.isNotePending && (await setPending($, MAIN, false))) {
    const now = await $.clock.now()
    await changeCycle($, cycle => ({
      cycle: cycle.phase === 'idle' ? { ...cycle, phase: 'asked', askedAt: now, attempts: 0 } : cycle,
      value: undefined,
    }))
    notes.push(handoffNote(track.tokens, limitsFor(config.limits, track.compactAt), await pathOf($, config)))
  }

  return notes
}

/** A compaction this cycle asked for did not stand: try again at a later turn end, a bounded number of times. */
async function compactionFailed($: EngineInterface, config: Config, reason: string): Promise<void> {
  $.ui.log(`agent-budget: main's compaction did not happen: ${reason}`, { to: 'debug' })
  const isGivingUp = await changeCycle($, cycle => {
    const attempts = cycle.attempts + 1
    const gives = attempts >= MAX_COMPACT_ATTEMPTS

    return { cycle: { ...cycle, attempts, phase: gives ? 'idle' : 'asked' }, value: gives }
  })
  if (isGivingUp) {
    toast($, config, 'main could not be compacted; it is asked again after more growth')
  }
}

type Found = { path: string; cycle: MainCycle; state: HandoffState }

/** Main's handoff file and cycle as a compaction about to run finds them. */
async function findHandoff($: EngineInterface, config: Config): Promise<Found> {
  const path = await pathOf($, config)
  const cycle = cycleOf(await read($, mainCycle))

  return { path, cycle, state: handoffState(await mtimeOf($, path), cycle.askedAt) }
}

/** Bytes read from a handoff's start to find its marker: room for a BOM and blank lines before it. */
const HEAD_BYTES = 256

/** True when the file at `path` is a handoff this mod asked for; a file that cannot be read is not. */
async function isHandoffFile($: EngineInterface, isDefaultDir: boolean, path: string): Promise<boolean> {
  try {
    const head = await $.fs.read(path, { offset: 0, length: HEAD_BYTES })

    return typeof head === 'string' && isOwnHandoff(head, isDefaultDir)
  } catch {
    return false
  }
}

/** Files one `rm` call is given at most. */
const RM_BATCH = 200
/** Session folders one pass looks at, at most: the rest wait for the next load. */
const MAX_PRUNE_DIRS = 1000

/**
 * Removes main's handoff files older than `handoffMaxAgeDays` from other
 * sessions' folders, then each folder it emptied. Only folders named like a
 * session id are looked in, and only a regular `main.md` that starts with
 * the handoff marker (or, in the default folder, one written before the marker) is
 * removed; a folder holding anything else is left. Best effort: a failure is
 * logged, never raised.
 */
async function pruneHandoffs($: EngineInterface, config: Config): Promise<void> {
  if (config.pruning.hasRun || config.handoffMaxAgeDays === 0) {
    return
  }
  config.pruning.hasRun = true
  try {
    const now = await $.clock.now()
    const own = safeSegment(await $.session.id())
    const { dir, isDefault } = await handoffDirOf($, config)
    const folders = (await $.fs.list(dir))
      .filter(entry => entry.kind === 'dir' && !entry.isLink && entry.name !== own && isSessionFolder(entry.name))
      .slice(0, MAX_PRUNE_DIRS)
    const stale: string[] = []
    for (const folder of folders) {
      const path = `${dir}/${folder.name}/main.md`
      const stat = await $.fs.stat(path).catch(() => undefined)
      if (
        stat?.kind === 'file' &&
        !stat.isLink &&
        isStaleHandoff(stat.mtimeMs, now, config.handoffMaxAgeDays) &&
        (await isHandoffFile($, isDefault, path))
      ) {
        stale.push(path)
      }
    }
    for (let at = 0; at < stale.length; at += RM_BATCH) {
      await $.process.run(['/bin/rm', '-f', '--', ...stale.slice(at, at + RM_BATCH)], { timeoutMs: 10_000 })
    }
    if (stale.length > 0) {
      // rmdir leaves a folder that still holds anything (a backup the person made) and says so; that is fine.
      const emptied = stale.map(path => path.slice(0, -'/main.md'.length))
      await $.process.run(['/bin/rmdir', ...emptied], { timeoutMs: 10_000 })
    }
  } catch (error) {
    $.ui.log(`agent-budget: old handoffs not pruned: ${String(error)}`, { to: 'debug' })
  }
}

/** A compaction of main stood: the cycle ends, the count starts over, and main is left its resume note. */
async function compactionStood($: EngineInterface, found: Found): Promise<void> {
  // A compaction below the threshold with no handoff on disk needs no note.
  const note = found.state === 'missing' && found.cycle.phase === 'idle' ? null : resumeNote(found.path, found.state)
  await update($, mainCycle, () => ({ ...IDLE_CYCLE, resumeNote: note }))
  await update($, agents, held => {
    const tracks = tracksOf(held)
    const track = tracks[MAIN]

    return track === undefined ? held : { ...tracks, [MAIN]: compacted(track) }
  })
}

/**
 * Compacts main in place, then starts its next turn with the resume note.
 * It records the compaction itself: its own session.compact hook need not see its own call.
 * Only a compaction that did not stand counts as a failed attempt: a failure after it
 * stood is logged, so main is never compacted a second time for one note.
 */
async function compactMain($: EngineInterface, config: Config): Promise<void> {
  const stood: { found?: Found } = {}
  try {
    const found = await findHandoff($, config)
    const instructions = compactInstructions(found.path, found.state)
    const done = await $.session.compact(instructions === undefined ? {} : { instructions })
    if (done.skip !== undefined) {
      await compactionFailed($, config, done.skip)

      return
    }
    stood.found = found
  } catch (error) {
    await compactionFailed($, config, String(error)).catch(() => undefined)

    return
  }
  if (stood.found === undefined) {
    return
  }
  try {
    await compactionStood($, stood.found)
    const note = await takeResume($)
    if (note !== null) {
      await $.prompt.submit({ text: note })
    }
  } catch (error) {
    $.ui.log(`agent-budget: main's compaction stood but was not recorded: ${String(error)}`, { to: 'debug' })
  }
  await pruneHandoffs($, config)
}

/** Reads the options; every bad value falls back to its default. */
function readConfig(options: Readonly<Record<string, unknown>>): Config {
  return {
    limits: readThresholds(options),
    includesMain: options.includeMain !== false,
    addsRuleToSpawns: options.addRuleToSpawns !== false,
    handoffDir: { option: options.handoffDir, resolved: null },
    handoffMaxAgeDays: nonNegativeOption(options.handoffMaxAgeDays, DEFAULT_HANDOFF_MAX_AGE_DAYS),
    showsStatus: options.showStatus !== false,
    showsToasts: options.showToasts !== false,
    pruning: { hasRun: false },
    compaction: { isInFlight: false },
    windows: { cached: null },
  }
}

export const register: Register = (on, options) => {
  const config = readConfig(options)

  // An agent told nothing of the rule reads the note as untrusted and ignores it. A workflow's
  // agent is left alone: its content is not rewritable.
  on('agent.spawn', ($, e, next) =>
    config.addsRuleToSpawns && e.workflow === undefined ? next({ ...e, prompt: withSpawnRule(e.prompt) }) : next(e),
  ).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-budget', description: 'Show every tracked agent by context size' })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'agent-budget' }, async $ => {
    try {
      return { text: table(await readTracks($), config.limits, await $.clock.now()) }
    } catch (error) {
      return { text: `could not read its state: ${String(error)}` }
    }
  }).catch(() => ({ text: 'could not read its state.' }))

  // `.catch` is replay-safe: where the hook had called next, next(e) answers what that
  // call settled to, so the request is never sent twice.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    try {
      await record($, config, e.agentId, response.usage)
    } catch {
      // The count is a convenience: the response stands whatever became of it.
    }

    return response
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) {
      const ran = await next(e)
      if (ran.deny !== undefined || !config.includesMain) {
        return ran
      }
      try {
        const notes = await takeMainNotes($, config)

        return notes.length === 0 ? ran : { ...ran, context: [...(ran.context ?? []), ...notes] }
      } catch {
        return ran
      }
    }
    const track = (await readTracks($))[id]
    // Nothing is asked of a subagent with no note due.
    if (track === undefined || !track.isNotePending || !(await setPending($, id, false))) {
      return next(e)
    }
    // The note was taken: a call that is denied or throws gives it back for the next result.
    const ran = await next(e).catch(async (error: unknown) => {
      await setPending($, id, true).catch(() => false)
      throw error
    })
    if (ran.deny !== undefined) {
      await setPending($, id, true)

      return ran
    }

    return { ...ran, context: [...(ran.context ?? []), rotationNote(track.tokens, limitsFor(config.limits, track.compactAt))] }
  }).catch(($, e, next) => next(e))

  // A turn of main that runs no tool still reads its notes, with the prompt that starts it.
  on('prompt.submit', async ($, e, next) => {
    // A slash command starts no turn of the model's: the notes wait for a real prompt.
    if (!config.includesMain || e.text.trimStart().startsWith('/')) {
      return next(e)
    }
    // A failing read sends the prompt as typed; the .catch replays a send already made, never repeats it.
    const notes = await takeMainNotes($, config).catch(() => [])

    return next(notes.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...notes] })
  }).catch(($, e, next) => next(e))

  // Main told to hand off has ended its turn: compact it in place, once, when the turn has let go.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') {
      return done
    }
    try {
      // `compacting` with nothing in flight here: an earlier load claimed it and its timer died
      // with that load (a hot reload), so this turn end claims it again rather than stick.
      const isOrphaned = !config.compaction.isInFlight
      const isClaimed = await changeCycle($, cycle =>
        cycle.phase === 'asked' || (cycle.phase === 'compacting' && isOrphaned)
          ? { cycle: { ...cycle, phase: 'compacting' }, value: true }
          : { cycle, value: false },
      )
      if (isClaimed) {
        config.compaction.isInFlight = true
        $.clock.after(COMPACT_DELAY_MS, () => {
          void compactMain($, config).finally(() => {
            config.compaction.isInFlight = false
          })
        })
      }
    } catch {
      // The answer stands; the cycle is tried again at the next turn end.
    }

    return done
  }).catch(($, e, next) => next(e))

  // Every compaction of main, whoever asked for it, points the summary at the handoff file
  // and leaves main a note to read it first. A subagent's compaction is left as it is.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute' || !config.includesMain) {
      return next(e)
    }
    // A failure before the compaction leaves it as asked; the .catch replays one that ran, never runs it twice.
    const found = await findHandoff($, config).catch(() => undefined)
    if (found === undefined) {
      return next(e)
    }
    const instructions = withInstructions(e.instructions, compactInstructions(found.path, found.state))
    const done = await next(instructions === e.instructions ? e : { ...e, instructions })
    if (done.skip !== undefined) {
      return done
    }
    try {
      await compactionStood($, found)
    } catch (error) {
      $.ui.log(`agent-budget: main's compaction not recorded: ${String(error)}`, { to: 'debug' })
    }
    await pruneHandoffs($, config)

    return done
  }).catch(($, e, next) => next(e))
}
