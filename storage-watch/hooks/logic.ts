import { heavyWork, parseSize, unwrap } from './gate'
import type { GateCall, GateRules } from './gate'
import type { AlertState } from '../types'

export type Reading = { freeGb: number; capacityPercent: number }
/** `tiersGb` is sorted descending; the first entry is the top tier. */
export type Limits = { tiersGb: readonly number[]; cooldownMs: number }

export const DEFAULT_TIERS_GB: readonly number[] = [20, 10, 5, 1]
/** Heavy work is refused at or below this many GB free unless `gateBelowGb` says otherwise. */
export const DEFAULT_GATE_GB = 5

/** A redirection of stdout (`>|`, `>`, `>>`, `1>`, `&>`), its file joined (`>f`) or the next word. */
const STDOUT_REDIRECT = /^(?:>\||1?>>?|&>>?)(.*)$/s

/** Whether a segment sends its output to a file: a stdout redirection to anything but `/dev/null` or another descriptor (`>&2`). */
function writesFile(words: readonly string[]): boolean {
  return words.some((word, i) => {
    const match = STDOUT_REDIRECT.exec(word)
    const target = match === null ? null : match[1] === '' ? words[i + 1] ?? '' : match[1] ?? ''

    return target !== null && target !== '/dev/null' && !target.startsWith('&')
  })
}

/**
 * What the disk gate refuses beyond the shared gate, in one simple command: a copy of a whole tree
 * (`cp -r`, `cp --archive`, `ditto`), light for memory but what fills a nearly full disk, and a `curl`
 * whose output is redirected to a file (`curl -o` the shared gate refuses already, and `wget` is not
 * light). The shared gate applies it to every part it reads, so `bash -c 'cp -r a b'` and
 * `find -exec cp -r` are caught too.
 */
export function diskHeavySegment(words: readonly string[]): string | null {
  const [head = '', ...args] = unwrap(words)
  const name = head.slice(head.lastIndexOf('/') + 1)
  if (name === 'ditto' || (name === 'cp' && args.some(word => /^-[A-Za-z]*[rRa]|^--(?:recursive|archive)$/.test(word)))) {
    return 'not on the light list: a copy of a whole tree (cp -r, ditto)'
  }

  return name === 'curl' && writesFile(words) ? 'not on the light list: curl saving a file' : null
}

/** What the disk gate refuses in this call: the shared gate's answer, with `diskHeavySegment` added to it in allowlist mode. */
export function diskHeavyWork(call: GateCall, rules: GateRules): string | null {
  if (rules.mode !== 'allowlist') {
    return heavyWork(call, rules)
  }

  return heavyWork(call, { ...rules, overrides: { ...rules.overrides, extraSegment: diskHeavySegment } })
}

/** Free space must climb this fraction above the top tier (22 GB for 20) before the tiers re-arm. */
const REARM_MARGIN = 0.1
/**
 * Added before rounding a figure down for display, so 4.2 GB that df reports as 4404019 KB
 * (4.1999998 GB) shows as 4.2G, not 4.1G. Far below the 0.1G display step.
 */
const EPSILON = 1e-4
/** A tier at or below this many GB is labelled urgent. */
const URGENT_GB = 1

export const INITIAL_ALERT: AlertState = { alertedTier: null, tierAlertedAt: {}, lastTier: null, lastAlertAt: null, claimedBy: null }

const KB_PER_GB = 1024 * 1024

const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * The `tiersGb` option: `"20,10,5,1"` (commas or spaces). Deduplicated and sorted descending.
 * Anything malformed (an empty list, a token that is not a positive number) is the default.
 */
export function parseTiers(value: unknown): number[] {
  if (isPositive(value)) {
    return [value]
  }
  if (typeof value !== 'string') {
    return [...DEFAULT_TIERS_GB]
  }
  const tokens = value.split(/[\s,]+/).filter(token => token !== '')
  const tiers = tokens.map(token => (/^\d+(?:\.\d+)?$/.test(token) ? Number(token) : Number.NaN))
  if (tiers.length === 0 || !tiers.every(isPositive)) {
    return [...DEFAULT_TIERS_GB]
  }

  return [...new Set(tiers)].sort((a, b) => b - a)
}

/** What the shared store holds, read defensively: anything malformed is dropped field by field. */
export function asAlert(value: unknown): AlertState {
  if (typeof value !== 'object' || value === null) {
    return INITIAL_ALERT
  }
  const { alertedTier, tierAlertedAt, lastTier, lastAlertAt, claimedBy } = value as Record<string, unknown>
  const stamps: Record<string, number> = {}
  if (typeof tierAlertedAt === 'object' && tierAlertedAt !== null) {
    for (const [tier, at] of Object.entries(tierAlertedAt)) {
      if (typeof at === 'number') {
        stamps[tier] = at
      }
    }
  }

  return {
    alertedTier: isPositive(alertedTier) ? alertedTier : null,
    tierAlertedAt: stamps,
    lastTier: isPositive(lastTier) ? lastTier : null,
    lastAlertAt: typeof lastAlertAt === 'number' ? lastAlertAt : null,
    claimedBy: typeof claimedBy === 'string' ? claimedBy : null,
  }
}

/**
 * `df -k <path>`: a header row, then `Filesystem 1024-blocks Used Available Capacity ...`.
 * Reads the last row carrying `blocks used available capacity%`; null when none does.
 */
export function parseDf(out: string): Reading | null {
  let reading: Reading | null = null
  for (const line of out.split('\n')) {
    const match = /(?:^|\s)(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/.exec(line)
    if (match !== null) {
      reading = { freeGb: Number(match[3]) / KB_PER_GB, capacityPercent: Number(match[4]) }
    }
  }

  return reading
}

/** The deepest tier free space is below, or null when it is above them all. */
export function crossedTier(reading: Reading, limits: Limits): number | null {
  const below = limits.tiersGb.filter(tier => reading.freeGb < tier)

  return below.length === 0 ? null : Math.min(...below)
}

export function isOver(reading: Reading, limits: Limits): boolean {
  return crossedTier(reading, limits) !== null
}

/**
 * One alert per tier as free space falls through it. A deeper tier than the last one alerted in this
 * episode always alerts; the cooldown only holds back a repeat of the same tier. Climbing back above
 * the top tier (with a little hysteresis) ends the episode and re-arms every tier. `prev` is shared by
 * every session, so an alert any of them took counts, and a recovery any of them saw re-arms all.
 */
export function decide(
  prev: AlertState,
  reading: Reading,
  limits: Limits,
  now: number,
): { state: AlertState; shouldAlert: boolean } {
  const top = limits.tiersGb[0] ?? 0
  // `top + top * margin`, not `top * 1.1`: 50 * 1.1 is 55.000000000000007 in floating point.
  if (reading.freeGb >= top + top * REARM_MARGIN) {
    return { state: prev.alertedTier === null ? prev : { ...prev, alertedTier: null }, shouldAlert: false }
  }
  const tier = crossedTier(reading, limits)
  // Above every tier but inside the hysteresis band, or no deeper than this episode already reached.
  if (tier === null || (prev.alertedTier !== null && tier >= prev.alertedTier)) {
    return { state: prev, shouldAlert: false }
  }
  const at = prev.tierAlertedAt[String(tier)]
  if (at !== undefined && now - at < limits.cooldownMs) {
    // The same tier again inside its cooldown: on record for this episode, but silent.
    return { state: { ...prev, alertedTier: tier }, shouldAlert: false }
  }

  return {
    state: { ...prev, alertedTier: tier, lastTier: tier, lastAlertAt: now, tierAlertedAt: { ...prev.tierAlertedAt, [String(tier)]: now } },
    shouldAlert: true,
  }
}

/**
 * Whether this session still owes its toast for the shared alert: free space still below the tier
 * alerted, the alert inside the cooldown, and not the one it last showed. Every session shows one;
 * only the claimant notifies.
 */
export function owesToast(alert: AlertState, toastedFor: number | null, reading: Reading, limits: Limits, now: number): boolean {
  const { lastAlertAt, lastTier } = alert

  return (
    lastTier !== null &&
    reading.freeGb < lastTier &&
    lastAlertAt !== null &&
    lastAlertAt !== toastedFor &&
    now - lastAlertAt < limits.cooldownMs
  )
}

/** The latest reading the tick stored for the gate, read defensively: null unless its figures and stamp are numbers. */
export function asStoredReading(value: unknown): (Reading & { at: number }) | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { freeGb, capacityPercent, at } = value as Record<string, unknown>
  const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

  return isNumber(freeGb) && isNumber(capacityPercent) && isNumber(at) ? { freeGb, capacityPercent, at } : null
}

/** The gate holds at or below its tier, unlike the alert tiers, which hold strictly below theirs. */
export function isGated(reading: Reading, gateBelowGb: number): boolean {
  return reading.freeGb <= gateBelowGb
}

/** The `gateBelowGb` option: a positive number, else the default 5. */
export function parseGateGb(value: unknown): number {
  return isPositive(value) ? value : DEFAULT_GATE_GB
}

/** Rounded down, so a figure shown under a tier never reads as the tier itself. */
export function freeText(reading: Reading): string {
  return `${Math.floor(reading.freeGb + EPSILON)}G free`
}

export function statusLine(reading: Reading, limits: Limits): string {
  return `${isOver(reading, limits) ? '! ' : ''}storage ${freeText(reading)}`
}

/** Truncated to one decimal, for the same reason as `freeText`. */
export const exact = (reading: Reading): string => `${(Math.floor(reading.freeGb * 10 + EPSILON) / 10).toFixed(1)}G`

export function alertText(tier: number, reading: Reading): string {
  return `${tier <= URGENT_GB ? 'URGENT: ' : ''}Disk below ${tier} GB free (${exact(reading)})`
}

/** Deliberately short and calm: a fact, the biggest space users when known, and a guard; no instructions to act. */
export function alertPrompt(tier: number, reading: Reading, culprits: readonly string[] = []): string {
  return [
    `${alertText(tier, reading)} on this machine.`,
    ...(culprits.length > 0 ? [`Largest space users: ${culprits.join('; ')}.`] : []),
    'Nothing has been deleted; do not delete files unless the user asks.',
  ].join('\n')
}

/** One thing taking disk space: a Docker category or a well-known cache folder. */
export type SpaceUser = { name: string; bytes: number }

/**
 * Well-known folders that grow large on a developer's Mac or Linux machine, under the home folder. Each
 * is measured on its own with `du -sk` under a timeout, so one slow folder costs only itself, and one
 * missing on this OS prints nothing. None is inside another, so no space is counted twice. Root-owned
 * stores (Docker's `/var/lib/docker` on Linux) are left to `docker system df`.
 */
export const CACHE_DIRS: readonly string[] = [
  'Library/Caches',
  '.cache',
  '.npm',
  '.cargo/registry',
  'Library/Developer/Xcode/DerivedData',
  'Library/Containers/com.docker.docker/Data',
  '.Trash',
  'miniconda3/pkgs',
  '.gradle/caches',
  'go/pkg/mod',
  // Linux: the desktop trash, rootless Podman and Docker storage, and Maven's repository.
  '.local/share/Trash',
  '.local/share/containers',
  '.local/share/docker',
  '.m2/repository',
]

/** How many space users are named. */
export const CULPRIT_COUNT = 3

/**
 * `docker system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}'`: one row per category
 * (`Images\t40.2GB\t30.1GB (74%)`), named with what pruning would give back.
 */
export function parseDockerDf(out: string): SpaceUser[] {
  const users: SpaceUser[] = []
  for (const line of out.split('\n')) {
    const [type = '', size = '', reclaimable = ''] = line.split('\t').map(part => part.trim())
    const bytes = parseSize(size)
    if (type !== '' && bytes !== null) {
      users.push({ name: `Docker ${type.toLowerCase()}${reclaimable === '' ? '' : ` (reclaimable ${reclaimable})`}`, bytes })
    }
  }

  return users
}

/** `du -sk <dir>`: `12345\t/Users/me/.cache`, read as a folder shown under `~`; null on anything else. */
export function parseDuKb(out: string, home: string): SpaceUser | null {
  const match = /^(\d+)\s+(.+?)\s*$/m.exec(out)
  if (match === null) {
    return null
  }
  const path = match[2] ?? ''

  return { name: path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path, bytes: Number(match[1]) * 1024 }
}

/** The biggest space users, largest first, one short line each: `~/Library/Caches 12.3 GB`. */
export function spaceCulpritLines(users: readonly SpaceUser[]): string[] {
  return [...users]
    .filter(user => user.bytes >= 1e8)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, CULPRIT_COUNT)
    .map(user => `${user.name} ${(user.bytes / 1e9).toFixed(1)} GB`)
}
