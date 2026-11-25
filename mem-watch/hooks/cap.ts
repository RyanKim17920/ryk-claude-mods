/**
 * The concurrency cap, pure logic: how many subagents and background jobs this session has running,
 * whether one more may start, and the refusal. It holds whatever the memory reading says, so a fast
 * fan-out is stopped before the next reading would catch it.
 *
 * Subagents are counted from the engine's own list (`$.agent.list()`), so a finish is never missed. Only
 * top-level subagents count, those main spawned (no `parentId`): a subagent's own children are part of
 * its work, and refusing one would stall the parent waiting on it. A spawn made by a subagent is never
 * refused by the cap (the memory gate still applies to it). The list is the session's own, so each
 * session has its own quota. A workflow script's agents are not capped and hold no slot: the list shows
 * them like main's own, so their ids are recorded as each one starts and left out.
 * Teammates (`in_process_teammate`) are long-lived and rest between tasks, so one holds a slot only while
 * it works: its task's `taskStatus` stays `running` between turns, but its loop's `status` reads `idle`
 * there and `running`, `pending` or `waiting` (held on its own background work or a plan's approval)
 * while a task is in hand. `capTeammates: false` leaves them out altogether.
 * Background Bash jobs have no such list: each is recorded when its call returns a `backgroundTaskId`
 * and dropped when its task notification arrives, when a `Stop` hook's `background_tasks` no longer
 * lists it, when it is stopped with TaskStop, or, failing all of those, when it expires. A lost finish
 * therefore holds a slot for at most the expiry, never forever.
 */

/** The cap's limits: 0 turns a cap off. `countsTeammates`: working teammates count and new ones are capped. */
export type CapLimits = { maxAgents: number; maxJobs: number; jobExpiryMs: number; countsTeammates: boolean }

/** One background job this session started, as recorded when its call returned. */
export type Job = { id: string; at: number; command: string }
export type Jobs = Record<string, Job>

/** What the cap reads of one `$.agent.list()` entry. `parentId` names the agent that spawned it; absent when main did. */
export type AgentRow = { id: string; kind: string; taskStatus: string; startTime: number; status?: string; description?: string; parentId?: string }

/** A cap option: a whole number of at least 0, else the fallback. */
export function parseCap(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** A spawn's agent can reach the list a moment before the call that started it returns. */
const START_SLACK_MS = 1000

const NO_IDS: ReadonlySet<string> = new Set()

/** A task not yet ended. */
const isLive = (agent: AgentRow): boolean => agent.taskStatus === 'running' || agent.taskStatus === 'pending'

/**
 * A teammate's loop working a task. `idle` (waiting for a message) is not, nor is a missing or unknown
 * status: a teammate the list cannot place is left out rather than held against the cap for good.
 */
const isWorking = (agent: AgentRow): boolean => agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting'

/**
 * The agents of the list that hold a slot: top-level (main spawned them), started, not yet ended; a
 * teammate only while it works a task, and none when `countsTeammates` is false. A subagent's children
 * are its own work, so they hold none. A workflow script's agents are listed like main's own (a
 * `local_agent` with no `parentId`), so their ids, recorded as each one starts, are passed in `workflow`
 * and left out: the cap does not cover them.
 */
export function runningAgents(list: readonly AgentRow[], workflow: ReadonlySet<string> = NO_IDS, countsTeammates = true): AgentRow[] {
  return list.filter(agent => {
    if (agent.parentId !== undefined || workflow.has(agent.id) || !isLive(agent)) {
      return false
    }
    if (agent.kind === 'in_process_teammate') {
      return countsTeammates && isWorking(agent)
    }

    return agent.kind === 'local_agent'
  })
}

/**
 * How many subagents count against the cap: those running, plus spawns this module let through whose
 * agent is not on the list yet (`launching`, each the time its reservation was taken). A running agent
 * the module has not seen start (`known`) that started after the oldest reservation is taken to be one
 * of those, so a spawn is never counted twice.
 */
export function agentCount(
  list: readonly AgentRow[],
  launching: readonly number[],
  known: ReadonlySet<string>,
  workflow: ReadonlySet<string> = NO_IDS,
  countsTeammates = true,
): number {
  const running = runningAgents(list, workflow, countsTeammates)
  if (launching.length === 0) {
    return running.length
  }
  const since = Math.min(...launching) - START_SLACK_MS
  const listedLaunches = running.filter(agent => !known.has(agent.id) && agent.startTime >= since).length

  return running.length + Math.max(0, launching.length - listedLaunches)
}

/** The jobs still holding a slot at `now`: recorded no longer than `expiryMs` ago. */
export function liveJobs(jobs: Jobs, now: number, expiryMs: number): Job[] {
  return Object.values(jobs).filter(job => now - job.at < expiryMs)
}

/** The recorded jobs, read defensively: a malformed entry is dropped. */
export function asJobs(value: unknown): Jobs {
  const jobs: Jobs = {}
  if (typeof value !== 'object' || value === null) {
    return jobs
  }
  for (const [id, job] of Object.entries(value)) {
    const { at, command } = (job ?? {}) as Record<string, unknown>
    if (typeof at === 'number' && Number.isFinite(at)) {
      jobs[id] = { id, at, command: typeof command === 'string' ? command : '' }
    }
  }

  return jobs
}

/** `jobs` without the given ids. */
export function withoutJobs(jobs: Jobs, ids: Iterable<string>): Jobs {
  const out = { ...jobs }
  for (const id of ids) {
    delete out[id]
  }

  return out
}

/**
 * `jobs` keeping the ids a `Stop` hook still lists as in flight, and every job recorded at or after
 * `since`: the list is taken before the hook runs, so a job recorded in between is missing from it
 * without having ended.
 */
export function keepListed(jobs: Jobs, listed: readonly string[], since = Number.POSITIVE_INFINITY): Jobs {
  const keep = new Set(listed)

  return Object.fromEntries(Object.entries(jobs).filter(([id, job]) => keep.has(id) || job.at >= since))
}

/** The background task id a Bash call's result carries: `run_in_background`, Ctrl+B, or a timeout that moved it. */
export function backgroundTaskId(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }
  const inner = (result as { result?: unknown }).result
  const id = typeof inner === 'object' && inner !== null ? (inner as { backgroundTaskId?: unknown }).backgroundTaskId : undefined

  return typeof id === 'string' && id !== '' ? id : null
}

/** The task ids a `<task-notification>` in this text reports on; none when the text holds no notification. */
export function notifiedTaskIds(text: string): string[] {
  if (!text.includes('<task-notification>')) {
    return []
  }

  return [...text.matchAll(/<task-id>\s*([^<\s]+)\s*<\/task-id>/g)].map(match => match[1] ?? '').filter(id => id !== '')
}

/** The id a TaskStop call names (`task_id`, or the older `shell_id`), or null. */
export function stoppedTaskId(call: Record<string, unknown>): string | null {
  const id = call.task_id ?? call.shell_id

  return typeof id === 'string' && id !== '' ? id : null
}

const clip = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

/** A command as the refusal lists it: its first line, clipped. */
export function shortCommand(command: unknown): string {
  return typeof command === 'string' ? clip(command.split('\n')[0]?.trim() ?? '') : ''
}

/**
 * The refusal of an agent past `maxConcurrentAgents`: how many run, which, and what to do. `isTeammate`
 * when the refused spawn is a teammate; `countsTeammates` as the `capTeammates` option says.
 */
export function agentCapReason(
  running: readonly AgentRow[],
  count: number,
  max: number,
  { isTeammate = false, countsTeammates = true }: { isTeammate?: boolean; countsTeammates?: boolean } = {},
): string {
  const names = running.slice(0, 3).map(agent => clip(agent.description ?? agent.id, 50))
  const what = countsTeammates ? 'top-level subagents and working teammates' : 'top-level subagents'
  const exempt = countsTeammates
    ? 'Subagents that a subagent starts are not capped, and a teammate waiting idle for a message holds no slot.'
    : 'Subagents that a subagent starts are not capped.'

  return [
    `mem-watch: this ${isTeammate ? 'teammate' : 'subagent'} was not started. ${count - 1} ${what} are already running or starting in this session, and the cap is ${max} at once (maxConcurrentAgents). ${exempt}`,
    ...(names.length > 0 ? [`Running: ${names.join('; ')}.`] : []),
    'Wait for one to finish (its notification will arrive), or stop one with TaskStop, then start this one. Do not retry it in a loop.',
  ].join('\n')
}

/** The refusal of a background job past `maxBackgroundJobs`: which jobs hold the slots, and what to do. */
export function jobCapReason(live: readonly Job[], launching: number, max: number, expiryMs: number): string {
  const names = live.slice(0, 3).map(job => `${job.id} (${job.command})`)

  return [
    `mem-watch: this background command was not started. ${live.length + launching - 1} background jobs this session started are still running or starting, and the cap is ${max} at once (maxBackgroundJobs).`,
    ...(names.length > 0 ? [`Running: ${names.join('; ')}.`] : []),
    `Wait for one to finish, stop one with TaskStop, or run this one in the foreground. A job whose finish is never seen stops counting after ${Math.round(expiryMs / 60_000)} minutes. Do not retry it in a loop.`,
  ].join('\n')
}
