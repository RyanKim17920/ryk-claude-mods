import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  agentCapReason,
  agentCount,
  asJobs,
  backgroundTaskId,
  jobCapReason,
  keepListed,
  liveJobs,
  notifiedTaskIds,
  parseCap,
  runningAgents,
  shortCommand,
  stoppedTaskId,
  withoutJobs,
} from './cap'
import type { CapLimits, Jobs } from './cap'
import { asStoredCulprits, heavyWork, isFresh, parseLightSubcommands, parseMode, parsePatterns, refusalReason, refusalToast } from './gate'
import type { GateCall, GateRules, Refusal } from './gate'
import {
  alertPrompt,
  alertToast,
  asAlert,
  asStoredReading,
  culpritLines,
  CULPRIT_COUNT,
  decide,
  figures,
  isOver,
  limitText,
  owesToast,
  parseDockerStats,
  parseFreePercent,
  parseSwapUsedGb,
  parseTopProcesses,
  statusLine,
} from './logic'
import type { Limits, Reading } from './logic'
import type { AlertState } from '../types'

type Config = {
  limits: Limits
  intervalMs: number
  wakesMain: boolean
  showsStatus: boolean
  showsToasts: boolean
  notifies: boolean
  gates: boolean
  rules: GateRules
  cap: CapLimits
}

const toastedFor = atom({ plugin: 'mem-watch', key: 'toastedFor' } as const, null)
const jobsAtom = atom({ plugin: 'mem-watch', key: 'jobs' } as const, {})
/** The `$.store` key of the alert episode all of this plugin's sessions share. */
const ALERT = 'alert'
/** The `$.store` key of the latest reading, stamped `at`: what the gate reads instead of running a command per tool call. */
const READING = 'reading'
/** The `$.store` key of the latest culprits, stamped `at`: taken by a tick while over a limit, read by the gate and the alert. */
const CULPRITS = 'culprits'
const RUN = { timeoutMs: 10_000 }
/** `docker stats` hangs on a daemon that is stuck: it gets less time, and a failure only drops the containers. */
const DOCKER_RUN = { timeoutMs: 5_000 }
/** A claim is read back after one to two of these, so two sessions that tick together rarely both win. */
const CLAIM_WAIT_MS = 300
/**
 * How long before a `Stop` hook runs its in-flight list may have been taken: a job recorded this
 * recently is kept even when the list does not name it.
 */
const STOP_SLACK_MS = 10_000
/** How many agent ids this session remembers having seen start: plenty for any live fan-out. */
const KNOWN_MAX = 500

// One tick at a time: a slow command must not stack reads behind it.
let isBusy = false
// Whether a person is at this session's prompt, as `session.start` says; false for a `-p` run or the SDK.
let isInteractive = false
/** When each subagent spawn this session let through, and that has not started yet, took its slot. */
const launchingAgents: number[] = []
/** The agents this session saw start through its own `agent.spawn` hook. */
const knownAgents = new Set<string>()
/** The agents a workflow script started: listed like main's own, but they hold no slot in its cap. */
const workflowAgents = new Set<string>()

/** Adds an agent id to one of the sets above, forgetting the oldest past KNOWN_MAX. */
function remember(ids: Set<string>, id: string): void {
  ids.add(id)
  if (ids.size > KNOWN_MAX) {
    ids.delete(ids.values().next().value ?? '')
  }
}
/** Background Bash calls let through whose task id has not come back yet. */
let launchingJobs = 0

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

// Null on anything but a clean read: another OS, a missing command, odd output.
async function readMemory($: EngineInterface): Promise<Reading | null> {
  const [swap, pressure] = await Promise.all([
    $.process.run(['sysctl', '-n', 'vm.swapusage'], RUN),
    $.process.run(['memory_pressure'], RUN),
  ])
  const swapGb = swap.exitCode === 0 ? parseSwapUsedGb(swap.stdout) : null
  const freePercent = pressure.exitCode === 0 ? parseFreePercent(pressure.stdout) : null

  return swapGb === null || freePercent === null ? null : { swapGb, freePercent }
}

/** Runs a read for the culprits; any failure (no Docker, a timeout) is no output. */
async function output($: EngineInterface, argv: string[], init: { timeoutMs: number }): Promise<string> {
  try {
    const run = await $.process.run(argv, init)

    return run.exitCode === 0 ? run.stdout : ''
  } catch {
    return ''
  }
}

/** The biggest memory users now: processes by resident size, and running containers. Never stops any. */
async function readCulprits($: EngineInterface): Promise<string[]> {
  const [ps, docker] = await Promise.all([
    output($, ['ps', '-axo', 'rss,pid,comm'], RUN),
    output($, ['docker', 'stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}'], DOCKER_RUN),
  ])

  return culpritLines(parseTopProcesses(ps, CULPRIT_COUNT), parseDockerStats(docker, CULPRIT_COUNT))
}

/** The culprits for this tick: the stored ones while any session took them inside this interval, else read and stored. */
async function culprits($: EngineInterface, config: Config, now: number): Promise<string[]> {
  const stored = asStoredCulprits(await $.store.get(CULPRITS))
  if (stored !== null && now - stored.at < config.intervalMs) {
    return stored.lines
  }
  const lines = await readCulprits($)
  await $.store.set(CULPRITS, { at: now, lines })

  return lines
}

// The winner of the claim notifies and wakes its model; every other session only shows the toast.
async function raise($: EngineInterface, config: Config, reading: Reading, lines: readonly string[], isClaimant: boolean): Promise<void> {
  const text = alertToast(reading, lines)
  if (config.showsToasts) {
    $.ui.toast(text, { timeoutMs: 15_000 })
  }
  if (!isClaimant) {
    return
  }
  if (config.notifies) {
    void $.ui.notify(text, { title: 'mem-watch' }).catch(() => undefined)
  }
  // A scripted run is never prolonged by a prompt of ours.
  if (config.wakesMain && isInteractive) {
    // Resolves when the turn starts, which may be long after: never awaited.
    void $.prompt.submit({ text: alertPrompt(reading, config.limits, lines) }).catch(() => undefined)
  }
}

// Takes the alert for this session if no other session takes it in the same moment. The store has no
// compare-and-set, so the claim is written, left a random moment, and read back: last writer wins.
async function claim($: EngineInterface, state: AlertState): Promise<AlertState> {
  const sessionId = await $.session.id()
  await $.store.set(ALERT, { ...state, claimedBy: sessionId })
  await $.clock.sleep(CLAIM_WAIT_MS + Math.floor(Math.random() * CLAIM_WAIT_MS))

  return asAlert(await $.store.get(ALERT))
}

function showStatus($: EngineInterface, config: Config, text: string | undefined): void {
  if (config.showsStatus) {
    $.ui.status(text)
  }
}

/**
 * The refusal for this call, or null to let it run: only while the latest stored reading is fresh and
 * over a limit. No command runs here; a missing or stale reading (another OS, a stalled tick) fails open.
 */
async function gateRefusal($: EngineInterface, config: Config, call: GateCall): Promise<string | null> {
  const rule = config.gates ? heavyWork(call, config.rules) : null
  if (rule === null) {
    return null
  }
  const now = await $.clock.now()
  const reading = asStoredReading(await $.store.get(READING))
  if (reading === null || !isFresh(reading.at, now, config.intervalMs) || !isOver(reading, config.limits)) {
    return null
  }
  const stored = asStoredCulprits(await $.store.get(CULPRITS).catch(() => undefined))
  const refusal: Refusal = {
    tool: call.tool,
    plugin: 'mem-watch',
    condition: 'Memory is low',
    figure: figures(reading),
    limit: limitText(config.limits),
    recovery: 'memory recovers',
    rule,
    culprits: stored !== null && isFresh(stored.at, now, config.intervalMs) ? stored.lines : [],
    resource: 'memory',
  }
  if (config.showsToasts) {
    $.ui.toast(refusalToast(refusal), { timeoutMs: 8_000 })
  }

  return refusalReason(refusal)
}

async function tick($: EngineInterface, config: Config): Promise<void> {
  if (isBusy) {
    return
  }
  isBusy = true
  try {
    const reading = await readMemory($)
    if (reading === null) {
      showStatus($, config, undefined)

      return
    }
    showStatus($, config, statusLine(reading, config.limits))
    const now = await $.clock.now()
    // Shared with every session's gate; any session's fresh reading counts.
    await $.store.set(READING, { ...reading, at: now })
    // While over a limit the culprits are kept fresh for the gate's refusals and the alert.
    const lines = isOver(reading, config.limits) ? await culprits($, config, now) : []
    const prev = asAlert(await $.store.get(ALERT))
    const { state, shouldAlert } = decide(prev, reading, config.limits, now)
    if (!shouldAlert && state.isArmed !== prev.isArmed) {
      await $.store.set(ALERT, state)
    }
    const alert = shouldAlert ? await claim($, state) : state
    if (owesToast(alert, await read($, toastedFor), reading, config.limits, now)) {
      await update($, toastedFor, () => alert.lastAlertAt)
      await raise($, config, reading, lines, shouldAlert && alert.claimedBy === (await $.session.id()))
    }
  } catch {
    showStatus($, config, undefined)
  } finally {
    isBusy = false
  }
}

/** The recorded background jobs, read defensively. */
async function readJobs($: EngineInterface): Promise<Jobs> {
  return asJobs(await read($, jobsAtom))
}

async function dropJobs($: EngineInterface, ids: readonly string[]): Promise<void> {
  if (ids.length > 0) {
    await update($, jobsAtom, jobs => withoutJobs(asJobs(jobs), ids))
  }
}

/**
 * A Bash call past the memory gate: refused while `maxBackgroundJobs` jobs this session started still
 * run and it asks for the background; any call that comes back with a background task id (asked for,
 * Ctrl+B, or moved by a timeout) is recorded.
 */
async function runBash<R>($: EngineInterface, config: Config, e: GateCall, next: () => Promise<R>): Promise<R | { deny: string }> {
  const isCapped = e.run_in_background === true && config.cap.maxJobs > 0
  // The slot is taken before anything is awaited, so calls made together see each other.
  launchingJobs += isCapped ? 1 : 0
  try {
    if (isCapped) {
      const now = await $.clock.now()
      const live = liveJobs(await readJobs($), now, config.cap.jobExpiryMs)
      if (live.length + launchingJobs > config.cap.maxJobs) {
        return { deny: jobCapReason(live, launchingJobs, config.cap.maxJobs, config.cap.jobExpiryMs) }
      }
    }
    const result = await next()
    const id = backgroundTaskId(result)
    if (id !== null) {
      const now = await $.clock.now()
      await update($, jobsAtom, jobs => ({
        ...Object.fromEntries(liveJobs(asJobs(jobs), now, config.cap.jobExpiryMs).map(job => [job.id, job])),
        [id]: { id, at: now, command: shortCommand(e.command) },
      }))
    }

    return result
  } finally {
    launchingJobs -= isCapped ? 1 : 0
  }
}

export const register: Register = (on, options) => {
  const config: Config = {
    limits: {
      minFreePercent: asNumber(options.minFreePercent, 28),
      maxSwapGb: asNumber(options.maxSwapGb, 28),
      cooldownMs: asNumber(options.cooldownMinutes, 30) * 60_000,
    },
    intervalMs: Math.max(5, asNumber(options.intervalSeconds, 60)) * 1000,
    wakesMain: options.wakeMainOnAlert !== false,
    showsStatus: options.showStatus !== false,
    showsToasts: options.showToasts !== false,
    notifies: options.systemNotifications !== false,
    gates: options.gateHeavyWork !== false,
    rules: {
      mode: parseMode(options.gateMode),
      overrides: {
        extraBlock: parsePatterns(options.gateBlockPatterns),
        extraAllow: parsePatterns(options.gateAllowPatterns),
        lightSubcommands: parseLightSubcommands(options.gateLightSubcommands),
      },
    },
    cap: {
      maxAgents: parseCap(options.maxConcurrentAgents, 4),
      maxJobs: parseCap(options.maxBackgroundJobs, 3),
      countsTeammates: options.capTeammates !== false,
      jobExpiryMs: Math.max(1, asNumber(options.backgroundJobExpiryMinutes, 30)) * 60_000,
    },
  }

  on('session.start', ($, e, next) => {
    isInteractive = e.isInteractive
    $.clock.every(config.intervalMs, () => void tick($, config))
    void tick($, config)

    return next(e)
  }).catch(($, e, next) => next(e))

  // The gate: new work is refused while memory is over a limit. Every error lets the call through.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const deny = await gateRefusal($, config, e)

    return deny === null ? next(e) : { deny }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await gateRefusal($, config, e)

    return deny === null ? runBash($, config, e, () => next(e)) : { deny }
  }).catch(($, e, next) => next(e))

  // The cap on top-level agents, whatever the reading: counted from the engine's own list when each one
  // is about to start, so a finish is never missed. New subagents and teammates from main are capped
  // alike (teammates only while `capTeammates`); a workflow's agent, a spawn made by a subagent or
  // teammate (`parentAgentId`) and a teammate brought back from disk (`resume`) are not, and the memory
  // gate still holds them.
  on('agent.spawn', async ($, e, next) => {
    if (e.workflow !== undefined) {
      // Not capped, and recorded so its row on the list (no parentId, like main's own) holds no slot.
      const result = await next(e)
      if ('agentId' in result && typeof result.agentId === 'string') {
        remember(workflowAgents, result.agentId)
      }

      return result
    }
    const isTeammate = e.isTeammate === true
    if (config.cap.maxAgents === 0 || e.parentAgentId !== undefined || (isTeammate && (!config.cap.countsTeammates || e.resume !== undefined))) {
      return next(e)
    }
    const at = await $.clock.now()
    launchingAgents.push(at)
    try {
      // No list (an error) fails open: the cap is skipped, never guessed.
      const list = await $.agent.list().catch(() => null)
      const { countsTeammates } = config.cap
      const count = list === null ? 0 : agentCount(list, launchingAgents, knownAgents, workflowAgents, countsTeammates)
      if (list !== null && count > config.cap.maxAgents) {
        const running = runningAgents(list, workflowAgents, countsTeammates)

        return { deny: agentCapReason(running, count, config.cap.maxAgents, { isTeammate, countsTeammates }) }
      }
      const result = await next(e)
      if ('agentId' in result && typeof result.agentId === 'string') {
        remember(knownAgents, result.agentId)
      }

      return result
    } finally {
      launchingAgents.splice(launchingAgents.indexOf(at), 1)
    }
  }).catch(($, e, next) => next(e))

  // A background job's finish: its task notification, as whichever row of whichever loop it lands in.
  on('session.append', async ($, e, next) => {
    const jobs = await readJobs($)
    if (Object.keys(jobs).length > 0) {
      const ids = notifiedTaskIds(JSON.stringify(e.message.content))
      await dropJobs($, ids.filter(id => id in jobs))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A job stopped by the model.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const result = await next(e)
    const id = stoppedTaskId(e)
    if (id !== null && !('deny' in result && typeof result.deny === 'string')) {
      await dropJobs($, [id])
    }

    return result
  }).catch(($, e, next) => next(e))

  // At the end of each main turn the engine lists the background work still in flight: a recorded job
  // missing from it has ended, whether or not its notification was seen, unless it was recorded after
  // the list was taken (a subagent's job, started while the hook was on its way).
  on('classic.Stop', async ($, e, next) => {
    const listed = e.background_tasks
    if (Array.isArray(listed)) {
      const since = (await $.clock.now()) - STOP_SLACK_MS
      await update($, jobsAtom, jobs => keepListed(asJobs(jobs), listed.map(task => task.id), since))
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
