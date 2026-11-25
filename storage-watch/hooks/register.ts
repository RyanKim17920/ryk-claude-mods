import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { asStoredCulprits, isFresh, parseLightSubcommands, parseMode, parsePatterns, refusalReason, refusalToast } from './gate'
import type { GateCall, GateRules, Refusal } from './gate'
import {
  alertPrompt,
  alertText,
  asAlert,
  asStoredReading,
  CACHE_DIRS,
  decide,
  diskHeavyWork,
  exact,
  isGated,
  owesToast,
  parseDf,
  parseDockerDf,
  parseDuKb,
  parseGateGb,
  parseTiers,
  spaceCulpritLines,
  statusLine,
} from './logic'
import type { Limits, Reading, SpaceUser } from './logic'
import type { AlertState } from '../types'

type Config = {
  limits: Limits
  intervalMs: number
  wakesMain: boolean
  showsStatus: boolean
  showsToasts: boolean
  notifies: boolean
  gates: boolean
  gateBelowGb: number
  rules: GateRules
}

const toastedFor = atom({ plugin: 'storage-watch', key: 'toastedFor' } as const, null)
/** The `$.store` key of the alert episode all of this plugin's sessions share. */
const ALERT = 'alert'
/** The `$.store` key of the latest reading, stamped `at`: what the gate reads instead of running df per tool call. */
const READING = 'reading'
const RUN = { timeoutMs: 10_000 }
/** The `$.store` key of the latest space users, stamped `at`: taken while gated or on an alert, read by the gate. */
const CULPRITS = 'culprits'
/** Measuring folders is slow, so the space users are taken again only after this long. */
const CULPRIT_TTL_MS = 30 * 60_000
/** Each `du` and `docker system df` gets this long; one that runs over only drops its own figure. */
const MEASURE_RUN = { timeoutMs: 15_000 }
/** The APFS data volume holds user data on macOS; `/` is the fallback where it does not exist. */
const DATA_VOLUME = '/System/Volumes/Data'
/** A claim is read back after one to two of these, so two sessions that tick together rarely both win. */
const CLAIM_WAIT_MS = 300

// One tick at a time: a slow command must not stack reads behind it.
let isBusy = false
// Whether a person is at this session's prompt, as `session.start` says; false for a `-p` run or the SDK.
let isInteractive = false

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

async function dfAt($: EngineInterface, path: string): Promise<Reading | null> {
  const df = await $.process.run(['df', '-k', path], RUN)

  return df.exitCode === 0 ? parseDf(df.stdout) : null
}

// Null on anything but a clean read: a missing command, odd output.
async function readStorage($: EngineInterface): Promise<Reading | null> {
  return (await dfAt($, DATA_VOLUME)) ?? (await dfAt($, '/'))
}

/** Runs a measuring command; its stdout whatever the exit code (du still prints a total past an unreadable folder), or nothing on a failure to run. */
async function output($: EngineInterface, argv: string[]): Promise<string> {
  try {
    return (await $.process.run(argv, MEASURE_RUN)).stdout
  } catch {
    return ''
  }
}

/** The biggest space users now: Docker's categories and the well-known cache folders. Deletes nothing. */
async function readCulprits($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const [docker, ...folders] = await Promise.all([
    output($, ['docker', 'system', 'df', '--format', '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}']),
    ...(home === '' ? [] : CACHE_DIRS.map(dir => output($, ['du', '-sk', `${home}/${dir}`]))),
  ])
  const users: SpaceUser[] = [...parseDockerDf(docker ?? ''), ...folders.flatMap(out => parseDuKb(out, home) ?? [])]

  return spaceCulpritLines(users)
}

/** The space users for this tick: the stored ones while younger than CULPRIT_TTL_MS, else measured and stored. */
async function culprits($: EngineInterface, now: number): Promise<string[]> {
  const stored = asStoredCulprits(await $.store.get(CULPRITS))
  if (stored !== null && now - stored.at < CULPRIT_TTL_MS) {
    return stored.lines
  }
  const lines = await readCulprits($)
  await $.store.set(CULPRITS, { at: now, lines })

  return lines
}

// The winner of the claim notifies (and, if enabled, wakes its model); every other session only shows the toast.
function raise($: EngineInterface, config: Config, tier: number, reading: Reading, lines: readonly string[], isClaimant: boolean): void {
  const text = alertText(tier, reading)
  if (config.showsToasts) {
    $.ui.toast(text, { timeoutMs: 15_000 })
  }
  if (!isClaimant) {
    return
  }
  if (config.notifies) {
    void $.ui.notify(text, { title: 'storage-watch' }).catch(() => undefined)
  }
  // Off by default; a scripted run is never prolonged by a prompt of ours.
  if (config.wakesMain && isInteractive) {
    // Resolves when the turn starts, which may be long after: never awaited.
    void $.prompt.submit({ text: alertPrompt(tier, reading, lines) }).catch(() => undefined)
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
 * at or below `gateBelowGb`. No command runs here; a missing or stale reading fails open.
 */
async function gateRefusal($: EngineInterface, config: Config, call: GateCall): Promise<string | null> {
  const rule = config.gates ? diskHeavyWork(call, config.rules) : null
  if (rule === null) {
    return null
  }
  const now = await $.clock.now()
  const reading = asStoredReading(await $.store.get(READING))
  if (reading === null || !isFresh(reading.at, now, config.intervalMs) || !isGated(reading, config.gateBelowGb)) {
    return null
  }
  const stored = asStoredCulprits(await $.store.get(CULPRITS).catch(() => undefined))
  const refusal: Refusal = {
    tool: call.tool,
    plugin: 'storage-watch',
    condition: 'Disk space is low',
    figure: `${exact(reading)} free`,
    limit: `heavy work pauses at or below ${config.gateBelowGb} GB free`,
    recovery: `free space is back above ${config.gateBelowGb} GB`,
    rule,
    culprits: stored !== null && now - stored.at <= 2 * CULPRIT_TTL_MS ? stored.lines : [],
    resource: 'disk space',
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
    const reading = await readStorage($)
    if (reading === null) {
      showStatus($, config, undefined)

      return
    }
    showStatus($, config, statusLine(reading, config.limits))
    const now = await $.clock.now()
    // Shared with every session's gate; any session's fresh reading counts.
    await $.store.set(READING, { ...reading, at: now })
    const prev = asAlert(await $.store.get(ALERT))
    const { state, shouldAlert } = decide(prev, reading, config.limits, now)
    // A re-arm, or a silent same-tier repeat inside its cooldown: on record for every session.
    if (!shouldAlert && state !== prev) {
      await $.store.set(ALERT, state)
    }
    // While gated, or on an alert, the space users are kept for the gate's refusals and the alert.
    const lines = shouldAlert || isGated(reading, config.gateBelowGb) ? await culprits($, now) : []
    const alert = shouldAlert ? await claim($, state) : state
    if (alert.lastTier !== null && owesToast(alert, await read($, toastedFor), reading, config.limits, now)) {
      await update($, toastedFor, () => alert.lastAlertAt)
      raise($, config, alert.lastTier, reading, lines, shouldAlert && alert.claimedBy === (await $.session.id()))
    }
  } catch {
    showStatus($, config, undefined)
  } finally {
    isBusy = false
  }
}

export const register: Register = (on, options) => {
  const config: Config = {
    limits: {
      tiersGb: parseTiers(options.tiersGb),
      cooldownMs: asNumber(options.cooldownMinutes, 60) * 60_000,
    },
    intervalMs: Math.max(5, asNumber(options.intervalSeconds, 300)) * 1000,
    // Opt-in only: an alert should inform, not drive the model.
    wakesMain: options.wakeMainOnAlert === true,
    showsStatus: options.showStatus !== false,
    showsToasts: options.showToasts !== false,
    notifies: options.systemNotifications !== false,
    gates: options.gateHeavyWork !== false,
    gateBelowGb: parseGateGb(options.gateBelowGb),
    rules: {
      mode: parseMode(options.gateMode),
      overrides: {
        extraBlock: parsePatterns(options.gateBlockPatterns),
        extraAllow: parsePatterns(options.gateAllowPatterns),
        lightSubcommands: parseLightSubcommands(options.gateLightSubcommands),
      },
    },
  }

  on('session.start', ($, e, next) => {
    isInteractive = e.isInteractive
    $.clock.every(config.intervalMs, () => void tick($, config))
    void tick($, config)

    return next(e)
  }).catch(($, e, next) => next(e))

  // The gate: new work is refused while free space is at or below gateBelowGb. Every error lets the call through.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const deny = await gateRefusal($, config, e)

    return deny === null ? next(e) : { deny }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await gateRefusal($, config, e)

    return deny === null ? next(e) : { deny }
  }).catch(($, e, next) => next(e))
}
