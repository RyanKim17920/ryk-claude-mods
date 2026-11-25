import { expect, test } from 'claude-code/testing'

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
import type { AgentRow } from './cap'

const row = (id: string, startTime: number, taskStatus = 'running', kind = 'local_agent'): AgentRow => ({ id, kind, taskStatus, startTime, description: `task ${id}` })
/** A teammate as the engine lists it: its task stays `running` between turns; `status` says whether it works one. */
const mate = (id: string, status: string, startTime = 0): AgentRow => ({ ...row(id, startTime, 'running', 'in_process_teammate'), status })

test('the cap options: a whole number of at least 0, else the default', () => {
  expect(parseCap(5, 3)).toBe(5)
  expect(parseCap(0, 3)).toBe(0)
  expect(parseCap(2.7, 3)).toBe(2)
  expect(parseCap(-1, 3)).toBe(3)
  expect(parseCap('4', 3)).toBe(3)
  expect(parseCap(undefined, 3)).toBe(3)
  expect(parseCap(Number.NaN, 3)).toBe(3)
})

test('only running or pending subagents hold a slot', () => {
  const list = [row('a', 0), row('b', 0, 'pending'), row('c', 0, 'completed'), row('d', 0, 'failed'), row('e', 0, 'killed'), mate('t', 'idle')]
  expect(runningAgents(list).map(agent => agent.id)).toEqual(['a', 'b'])
})

test('a teammate holds a slot only while it works a turn: idle between turns, or ended, it holds none', () => {
  const list = [
    row('a', 0),
    mate('busy', 'running'),
    mate('held', 'waiting'),
    mate('new', 'pending'),
    mate('idle', 'idle'),
    mate('done', 'completed'),
    { ...mate('stopped', 'running'), taskStatus: 'killed' },
    { ...mate('child', 'running'), parentId: 'a' },
    { ...row('unknown', 0, 'running', 'in_process_teammate') },
  ]
  expect(runningAgents(list).map(agent => agent.id)).toEqual(['a', 'busy', 'held', 'new'])
  expect(agentCount(list, [], new Set())).toBe(4)
  // capTeammates off: no teammate holds a slot, busy or not.
  expect(runningAgents(list, new Set(), false).map(agent => agent.id)).toEqual(['a'])
  expect(agentCount(list, [], new Set(), new Set(), false)).toBe(1)
  // A teammate just spawned and already listed busy is taken for its reservation, not counted twice.
  expect(agentCount([mate('t1', 'running', 5100)], [5000], new Set())).toBe(1)
})

test('only top-level subagents hold a slot: one a subagent spawned (it has a parentId) never does', () => {
  const list = [row('a', 0), { ...row('a-child', 0), parentId: 'a' }, { ...row('a-grandchild', 0, 'pending'), parentId: 'a-child' }, row('b', 0)]
  expect(runningAgents(list).map(agent => agent.id)).toEqual(['a', 'b'])
  expect(agentCount(list, [], new Set())).toBe(2)
  // A child started after a top-level reservation is not taken for that reservation's agent.
  expect(agentCount([{ ...row('c', 5100), parentId: 'a' }], [5000], new Set())).toBe(1)
})

test('a workflow agent never holds a slot: the list shows it like a top-level subagent, so its id is passed to be left out', () => {
  const workflow = new Set(['wf1', 'wf2'])
  const list = [row('a', 0), row('wf1', 0), row('wf2', 5100, 'pending')]
  expect(runningAgents(list, workflow).map(agent => agent.id)).toEqual(['a'])
  expect(agentCount(list, [], new Set(), workflow)).toBe(1)
  // A workflow agent that starts after a reservation is not taken for that reservation's agent.
  expect(agentCount(list, [5000], new Set(), workflow)).toBe(2)
})

test('agent count: the running ones plus the spawns still starting, each counted once', () => {
  const known = new Set(['a'])
  // Nothing starting: the list alone.
  expect(agentCount([row('a', 0), row('b', 0)], [], known)).toBe(2)
  // Two starting, neither listed yet.
  expect(agentCount([row('a', 0)], [5000, 5000], known)).toBe(3)
  // One of them already on the list (started after the reservation, not yet known): not counted twice.
  expect(agentCount([row('a', 0), row('new', 5200)], [5000, 5000], known)).toBe(3)
  // A running agent from before the reservations (another turn's) is never taken for one of them.
  expect(agentCount([row('a', 0), row('old', 1000)], [5000], known)).toBe(3)
  // Known agents are counted once, by the list.
  expect(agentCount([row('a', 5100)], [5000], known)).toBe(2)
  // More listed than starting never makes the count fall below the list.
  expect(agentCount([row('x', 5100), row('y', 5100), row('z', 5100)], [5000], new Set())).toBe(3)
})

test('background jobs live until they expire', () => {
  const jobs = { b1: { id: 'b1', at: 0, command: 'x' }, b2: { id: 'b2', at: 50, command: 'y' } }
  expect(liveJobs(jobs, 99, 100).map(job => job.id)).toEqual(['b1', 'b2'])
  expect(liveJobs(jobs, 100, 100).map(job => job.id)).toEqual(['b2'])
  expect(liveJobs(jobs, 150, 100)).toEqual([])
})

test('recorded jobs are read defensively, dropped by id, and kept only when still listed', () => {
  expect(asJobs({ b1: { at: 5, command: 'ls' }, b2: { at: 'soon' }, b3: null, b4: { at: 6 } })).toEqual({
    b1: { id: 'b1', at: 5, command: 'ls' },
    b4: { id: 'b4', at: 6, command: '' },
  })
  expect(asJobs(undefined)).toEqual({})
  expect(asJobs('x')).toEqual({})
  const jobs = asJobs({ b1: { at: 1 }, b2: { at: 2 }, b3: { at: 3 } })
  expect(Object.keys(withoutJobs(jobs, ['b2', 'nope']))).toEqual(['b1', 'b3'])
  expect(Object.keys(keepListed(jobs, ['b3', 'a9']))).toEqual(['b3'])
  expect(keepListed(jobs, [])).toEqual({})
  // A job recorded at or after `since` (the in-flight list may predate it) is kept, listed or not.
  expect(Object.keys(keepListed(jobs, [], 2))).toEqual(['b2', 'b3'])
  expect(Object.keys(keepListed(jobs, ['b1'], 3))).toEqual(['b1', 'b3'])
})

test('a background task id is read from the Bash result, and nothing else is taken for one', () => {
  expect(backgroundTaskId({ result: { stdout: '', backgroundTaskId: 'b7' } })).toBe('b7')
  expect(backgroundTaskId({ result: { stdout: '' } })).toBeNull()
  expect(backgroundTaskId({ result: { backgroundTaskId: '' } })).toBeNull()
  expect(backgroundTaskId({ deny: 'no' })).toBeNull()
  expect(backgroundTaskId(null)).toBeNull()
  expect(backgroundTaskId({ result: 'text' })).toBeNull()
})

test('only a task notification reports finished ids', () => {
  const text = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>\n<task-notification><task-id> b2 </task-id></task-notification>'
  expect(notifiedTaskIds(text)).toEqual(['b1', 'b2'])
  expect(notifiedTaskIds(JSON.stringify([{ type: 'text', text }]))).toEqual(['b1', 'b2'])
  expect(notifiedTaskIds('<task-id>b1</task-id> was mentioned')).toEqual([])
  expect(notifiedTaskIds('')).toEqual([])
})

test('TaskStop names its task by task_id, or the older shell_id', () => {
  expect(stoppedTaskId({ task_id: 'b1' })).toBe('b1')
  expect(stoppedTaskId({ shell_id: 'b2' })).toBe('b2')
  expect(stoppedTaskId({})).toBeNull()
  expect(stoppedTaskId({ task_id: 3 })).toBeNull()
})

test('commands are listed by their first line, clipped', () => {
  expect(shortCommand('ls\nmake')).toBe('ls')
  expect(shortCommand('x'.repeat(100))).toHaveLength(60)
  expect(shortCommand(undefined)).toBe('')
})

test('the refusals say how many run, which, the cap and what to do', () => {
  const agents = agentCapReason([row('a', 0), row('b', 0), row('c', 0), row('d', 0)], 5, 4)
  expect(agents).toContain('mem-watch: this subagent was not started. 4 top-level subagents and working teammates are already running or starting')
  expect(agents).toContain('a teammate waiting idle for a message holds no slot')
  const mates = agentCapReason([mate('m', 'running')], 2, 1, { isTeammate: true })
  expect(mates).toContain('mem-watch: this teammate was not started. 1 top-level subagents and working teammates')
  const off = agentCapReason([row('a', 0)], 2, 1, { countsTeammates: false })
  expect(off).toContain('mem-watch: this subagent was not started. 1 top-level subagents are already running or starting')
  expect(off).not.toContain('teammate')
  expect(agents).toContain('the cap is 4 at once (maxConcurrentAgents)')
  expect(agents).toContain('Running: task a; task b; task c.')
  expect(agents).toContain('stop one with TaskStop')
  expect(agents).toContain('Subagents that a subagent starts are not capped')
  expect(agentCapReason([], 4, 3)).not.toContain('Running:')
  const jobs = jobCapReason([{ id: 'b1', at: 0, command: 'sleep 9' }], 3, 3, 30 * 60_000)
  expect(jobs).toContain('mem-watch: this background command was not started. 3 background jobs')
  expect(jobs).toContain('Running: b1 (sleep 9).')
  expect(jobs).toContain('after 30 minutes')
})
