import { parseSize } from './gate'
import type { AlertState } from '../types'

export type Reading = { freePercent: number; swapGb: number }
export type Limits = { minFreePercent: number; maxSwapGb: number; cooldownMs: number }
export type Proc = { rssKb: number; pid: number; command: string }

export const INITIAL_ALERT: AlertState = { isArmed: true, lastAlertAt: null, claimedBy: null }

/** What the shared store holds, read defensively: anything but a well-formed state is the initial one. */
export function asAlert(value: unknown): AlertState {
  if (typeof value !== 'object' || value === null) {
    return INITIAL_ALERT
  }
  const { isArmed, lastAlertAt, claimedBy } = value as Record<string, unknown>

  return {
    isArmed: isArmed !== false,
    lastAlertAt: typeof lastAlertAt === 'number' ? lastAlertAt : null,
    claimedBy: typeof claimedBy === 'string' ? claimedBy : null,
  }
}

/**
 * Whether this session still owes its toast for the shared alert: pressure now, an alert inside the
 * cooldown, and not the one it last showed. Every session shows one; only the claimant wakes its model.
 */
export function owesToast(alert: AlertState, toastedFor: number | null, reading: Reading, limits: Limits, now: number): boolean {
  const { lastAlertAt } = alert

  return isOver(reading, limits) && lastAlertAt !== null && lastAlertAt !== toastedFor && now - lastAlertAt < limits.cooldownMs
}

const GB_PER_UNIT: Record<string, number> = { K: 1 / (1024 * 1024), M: 1 / 1024, G: 1 }

/** `sysctl -n vm.swapusage`: `total = 6144.00M  used = 5123.25M  free = ...`. */
export function parseSwapUsedGb(out: string): number | null {
  const match = /used\s*=\s*(\d+(?:\.\d+)?)\s*([KMG])/i.exec(out)
  const perUnit = GB_PER_UNIT[(match?.[2] ?? '').toUpperCase()]
  if (match === null || perUnit === undefined) {
    return null
  }

  return Number(match[1]) * perUnit
}

/** `memory_pressure`: `System-wide memory free percentage: 34%`. */
export function parseFreePercent(out: string): number | null {
  const match = /memory free percentage:\s*(\d+(?:\.\d+)?)\s*%/i.exec(out)

  return match === null ? null : Number(match[1])
}

/** `ps -eo rss,pid,comm` (the same columns on macOS and Linux): the `count` largest by resident size (KB). */
export function parseTopProcesses(out: string, count: number): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (match !== null) {
      procs.push({ rssKb: Number(match[1]), pid: Number(match[2]), command: match[3] ?? '' })
    }
  }

  return procs.sort((a, b) => b.rssKb - a.rssKb).slice(0, count)
}

export function isOver(reading: Reading, limits: Limits): boolean {
  return reading.freePercent < limits.minFreePercent || reading.swapGb > limits.maxSwapGb
}

/**
 * One alert on entering the alert state, never more than one per cooldown,
 * and none again until both figures have recovered. `prev` is shared by every
 * session, so an alert any of them took counts, and a recovery any of them saw re-arms all.
 */
export function decide(
  prev: AlertState,
  reading: Reading,
  limits: Limits,
  now: number,
): { state: AlertState; shouldAlert: boolean } {
  if (!isOver(reading, limits)) {
    return { state: { ...prev, isArmed: true }, shouldAlert: false }
  }

  const isCool = prev.lastAlertAt === null || now - prev.lastAlertAt >= limits.cooldownMs
  if (prev.isArmed && isCool) {
    return { state: { ...prev, isArmed: false, lastAlertAt: now }, shouldAlert: true }
  }

  return { state: prev, shouldAlert: false }
}

/** The latest reading the tick stored for the gate, read defensively: null unless both figures and its stamp are numbers. */
export function asStoredReading(value: unknown): (Reading & { at: number }) | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { freePercent, swapGb, at } = value as Record<string, unknown>
  const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

  return isNumber(freePercent) && isNumber(swapGb) && isNumber(at) ? { freePercent, swapGb, at } : null
}

export function limitText(limits: Limits): string {
  return `free at least ${limits.minFreePercent}%, swap at most ${limits.maxSwapGb}G`
}

export function figures(reading: Reading): string {
  return `free ${Math.round(reading.freePercent)}% · swap ${Math.round(reading.swapGb)}G`
}

export function statusLine(reading: Reading, limits: Limits): string {
  return `${isOver(reading, limits) ? '! ' : ''}mem ${figures(reading)}`
}

/** One running container's memory, from `docker stats`. */
export type Container = { name: string; bytes: number; usage: string }

/** `docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'`: `web\t1.2GiB / 7.6GiB` per line, largest first. */
export function parseDockerStats(out: string, count: number): Container[] {
  const containers: Container[] = []
  for (const line of out.split('\n')) {
    const [name = '', memUsage = ''] = line.split('\t')
    const usage = memUsage.split('/')[0]?.trim() ?? ''
    const bytes = parseSize(usage)
    if (name.trim() !== '' && bytes !== null) {
      containers.push({ name: name.trim(), bytes, usage })
    }
  }

  return containers.sort((a, b) => b.bytes - a.bytes).slice(0, count)
}

/** How many of each kind of culprit are named. */
export const CULPRIT_COUNT = 3

/**
 * The biggest memory users, one short line each: the processes by resident size (`python3 (pid 4242)
 * 9.0 GB`), then the running containers (`container web 1.2GiB`). A container's memory is also inside
 * the Docker VM's process, so the two lists are not added up.
 */
export function culpritLines(procs: readonly Proc[], containers: readonly Container[]): string[] {
  return [
    ...procs.slice(0, CULPRIT_COUNT).map(proc => `${proc.command.slice(proc.command.lastIndexOf('/') + 1)} (pid ${proc.pid}) ${(proc.rssKb / (1024 * 1024)).toFixed(1)} GB`),
    ...containers.slice(0, CULPRIT_COUNT).map(container => `container ${container.name} ${container.usage}`),
  ]
}


export function alertPrompt(reading: Reading, limits: Limits, culprits: readonly string[]): string {
  return [
    `Memory is under pressure on this machine: ${figures(reading)}`,
    `(limits: ${limitText(limits)}).`,
    ...(culprits.length > 0 ? ['Largest memory users:', ...culprits.map(line => `- ${line}`)] : []),
    'Stop or move heavy jobs (to the VM, or run them one at a time) before starting anything new.',
    'Nothing has been killed.',
  ].join('\n')
}

/** The alert's toast: the figures, and the biggest user when known. */
export function alertToast(reading: Reading, culprits: readonly string[]): string {
  const [top] = culprits

  return `Memory under pressure: ${figures(reading)}${top === undefined ? '' : ` · top: ${top}`}`
}
