import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const HEADLESS = { cwd: '/work', surface: null, isInteractive: false } as const
const alertOf = (w: World) => w.store.get('alert') as Alert | undefined
const MINUTE = 60_000
const PS = '   RSS   PID COMM\n9437184  4242 python3\n 21376     1 /sbin/launchd\n'

type Alert = { isArmed: boolean; lastAlertAt: number | null; claimedBy: string | null }

type World = {
  /** The plugin's store file, which every session of this config directory shares. */
  store: Map<string, unknown>
  /** Called after each write of the alert the session under test makes: where another session gets its word in. */
  afterSet: (() => void) | null
  isStoreBroken: boolean
  isInteractive: boolean
  free: number
  swap: string
  isBroken: boolean
  /** Which memory commands answer: macOS's sysctl and memory_pressure, Linux's /proc/meminfo, or neither. */
  os: 'macos' | 'linux' | 'other'
  /** `sysctl -n hw.memsize` on macOS: 24 GB unless a test says otherwise. */
  ramBytes: number
  /** What `cat /proc/meminfo` prints on Linux. */
  meminfo: string
  /** What the plugin logged to the transcript. */
  logs: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  notices: string[]
  prompts: string[]
  /** Tool calls that got past the gate. */
  ran: string[]
  /** What `docker stats` prints; null when Docker is not running (the command fails). */
  docker: string | null
  /** Every command the plugin ran, by its first word. */
  argv0: string[]
  /** The session's agents, as `$.agent.list()` answers; null makes the list fail. */
  agents: Agent[] | null
  /** The agents started, in order. */
  spawned: string[]
}

type Agent = { id: string; kind: string; taskStatus: string; startTime: number; description: string; type: string; status: string; parentId?: string }

/** A running subagent, as the engine lists it. */
const agent = (id: string, startTime = 0, taskStatus = 'running'): Agent => ({ id, kind: 'local_agent', taskStatus, status: taskStatus, startTime, description: `task ${id}`, type: 'general-purpose' })

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Stands for the host beneath the plugin: the three commands, the display, the prompt queue.
function world(on: On, clock?: { now: () => number }): World {
  const w: World = { store: new Map(), afterSet: null, isStoreBroken: false, isInteractive: true, free: 60, swap: '5123.25M', isBroken: false, os: 'macos', ramBytes: 24 * 1024 ** 3, meminfo: '', logs: [], statuses: [], toasts: [], notices: [], prompts: [], ran: [], docker: null, argv0: [], agents: [], spawned: [] }
  let jobs = 0
  on('process.run', ($, e) => {
    w.argv0.push(e.argv[0] ?? '')
    if (e.argv[0] === 'docker') {
      return w.docker === null ? ran('', 1) : ran(w.docker)
    }
    if (w.isBroken) {
      throw new Error('spawn sysctl ENOENT')
    }
    if (e.argv[0] === 'cat') {
      return w.os === 'linux' ? ran(w.meminfo) : ran('', 1)
    }
    if (e.argv[0] === 'sysctl') {
      if (w.os !== 'macos') {
        return ran('', 255)
      }

      return e.argv[2] === 'hw.memsize' ? ran(`${w.ramBytes}\n`) : ran(`total = 43008.00M  used = ${w.swap}  free = 1.00M  (encrypted)`)
    }
    if (e.argv[0] === 'memory_pressure') {
      if (w.os !== 'macos') {
        throw new Error('spawn memory_pressure ENOENT')
      }

      return ran(`Pageouts: 1 \n\nSystem-wide memory free percentage: ${w.free}%\n`)
    }

    return ran(PS)
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', ($, e) => {
    w.notices.push(e.text)

    return { value: { isSent: false, reason: 'no-surface' } }
  })
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)

    return { text: e.text }
  })
  // The tools beneath the gate: a call that reaches here ran. A background one answers with its task id.
  on('tool.call', ($, e) => {
    w.ran.push(e.tool === 'Bash' ? `Bash: ${e.command}` : e.tool)
    const isBackground = e.tool === 'Bash' && (e.run_in_background === true || e.command.startsWith('slow '))

    return { result: { stdout: '', stderr: '', interrupted: false, ...(isBackground ? { backgroundTaskId: `b${++jobs}` } : {}) } }
  })
  on('agent.list', () => {
    if (w.agents === null) {
      throw new Error('no list')
    }

    return { value: w.agents as never }
  })
  // The engine starting an agent: it is on the list from here on.
  on('agent.spawn', ($, e) => {
    const id = `a${w.spawned.length + 1}`
    w.spawned.push(id)
    // A teammate starts on its first turn: its task and its loop both read `running`.
    w.agents?.push({
      ...agent(id, clock?.now() ?? 0),
      ...(e.isTeammate === true ? { kind: 'in_process_teammate', type: 'teammate' } : {}),
      ...(e.parentAgentId === undefined ? {} : { parentId: e.parentAgentId }),
    })

    return { model: 'm', agentId: id }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('session.id', () => ({ value: 'session-A' }))
  on('store.get', ($, e) => (w.isStoreBroken ? { deny: 'no store' } : { value: w.store.get(e.key) }))
  on('store.set', ($, e) => {
    w.store.set(e.key, e.value)
    if (e.key === 'alert') {
      w.afterSet?.()
    }

    return { value: undefined }
  })

  return w
}

test('shows both figures and stays quiet while memory is fine', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  // One second past each tick from here on: a claim's wait (under 600 ms) is over when a test looks.
  await clock.advance(1000)
  expect(w.statuses.at(-1)).toBe('mem free 60% · swap 5G')
  await clock.advance(3 * MINUTE)
  expect(w.toasts).toHaveLength(0)
  expect(w.prompts).toHaveLength(0)
})

test('alerts once on crossing, not inside the cooldown, again after recovery', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  // One second past each tick from here on: a claim's wait (under 600 ms) is over when a test looks.
  await clock.advance(1000)

  w.free = 12
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual(['Memory under pressure: free 12% · swap 5G · top: python3 (pid 4242) 9.0 GB'])
  expect(w.notices).toHaveLength(1)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('free 12% · swap 5G')
  expect(w.prompts[0]).toContain('- python3 (pid 4242) 9.0 GB')
  expect(w.statuses.at(-1)).toBe('! mem free 12% · swap 5G')

  // Pressure lasts: no repeat on later ticks.
  await clock.advance(5 * MINUTE)
  expect(w.prompts).toHaveLength(1)

  // Recovers and crosses again inside the cooldown: still one alert.
  w.free = 60
  await clock.advance(MINUTE)
  w.free = 10
  await clock.advance(MINUTE)
  expect(w.prompts).toHaveLength(1)

  // Recovers, the cooldown passes, it crosses on swap this time: a second alert.
  w.free = 60
  await clock.advance(30 * MINUTE)
  expect(w.prompts).toHaveLength(1)
  w.swap = '31.50G'
  await clock.advance(MINUTE)
  expect(w.prompts).toHaveLength(2)
  expect(w.prompts[1]).toContain('swap 32G')
  expect(w.toasts).toHaveLength(2)
})

test('wakeMainOnAlert off: toast and notification only', { options: { wakeMainOnAlert: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 5
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.toasts).toHaveLength(1)
  expect(w.notices).toHaveLength(1)
  expect(w.prompts).toHaveLength(0)
})

test('custom limits and interval are honoured', { options: { minFreePercent: 70, intervalSeconds: 10 } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.prompts).toHaveLength(1)
  const before = w.statuses.length
  await clock.advance(30_000)
  expect(w.statuses.length - before).toBe(3)
})

test('a failing command shows nothing, does not throw, and the watch goes on', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.isBroken = true
  await expect($.session.start(START)).resolves.toEqual({ cwd: '/work' })
  await clock.advance(2 * MINUTE)
  expect(w.statuses.every(text => text === undefined)).toBe(true)
  expect(w.toasts).toHaveLength(0)

  w.isBroken = false
  await clock.advance(MINUTE)
  expect(w.statuses.at(-1)).toBe('mem free 60% · swap 5G')
})

test('output that does not parse is treated as no reading', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.swap = 'unknown'
  await $.session.start(START)
  await clock.advance(MINUTE)
  expect(w.statuses.every(text => text === undefined)).toBe(true)
  expect(w.prompts).toHaveLength(0)
})

test('two sessions tick together: the one whose claim is overwritten toasts and does not wake its model', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  // One second past each tick from here on: a claim's wait (under 600 ms) is over when a test looks.
  await clock.advance(1000)

  // Session B writes its claim just after ours, inside our wait: last writer wins.
  w.afterSet = () => {
    w.afterSet = null
    w.store.set('alert', { ...(alertOf(w) as Alert), claimedBy: 'session-B' })
  }
  w.free = 12
  await clock.advance(MINUTE)
  expect(alertOf(w)?.claimedBy).toBe('session-B')
  expect(w.toasts).toHaveLength(1)
  expect(w.notices).toHaveLength(0)
  expect(w.prompts).toHaveLength(0)
  // And nothing more on later ticks: the episode is B's.
  await clock.advance(5 * MINUTE)
  expect(w.toasts).toHaveLength(1)
  expect(w.prompts).toHaveLength(0)
})

test('another session alerted already: this one toasts once and submits nothing inside the cooldown', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on)
  w.store.set('alert', { isArmed: false, lastAlertAt: 98 * MINUTE, claimedBy: 'session-B' })
  w.free = 12
  await $.session.start(START)
  await clock.advance(10 * MINUTE)
  expect(w.toasts).toHaveLength(1)
  expect(w.prompts).toHaveLength(0)
  expect(alertOf(w)).toEqual({ isArmed: false, lastAlertAt: 98 * MINUTE, claimedBy: 'session-B' })
})

test('one alert between the sessions per cooldown, and a recovery either sees re-arms both', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  // One second past each tick from here on: a claim's wait (under 600 ms) is over when a test looks.
  await clock.advance(1000)

  // We take the first alert; it is on record for every session.
  w.free = 12
  await clock.advance(MINUTE)
  expect(w.prompts).toHaveLength(1)
  expect(alertOf(w)).toMatchObject({ isArmed: false, claimedBy: 'session-A' })

  // We see the recovery and re-arm the shared state: B is armed by it too.
  w.free = 60
  await clock.advance(MINUTE)
  expect(alertOf(w)?.isArmed).toBe(true)

  // Past the cooldown B takes the next alert between our ticks: we toast for it and stay quiet.
  await clock.advance(30 * MINUTE)
  w.store.set('alert', { isArmed: false, lastAlertAt: clock.now(), claimedBy: 'session-B' })
  w.free = 10
  await clock.advance(MINUTE)
  expect(w.toasts).toHaveLength(2)
  expect(w.prompts).toHaveLength(1)

  // B sees the recovery this time; armed again, and past the cooldown the next alert is ours.
  w.free = 60
  w.store.set('alert', { ...(alertOf(w) as Alert), isArmed: true })
  await clock.advance(31 * MINUTE)
  w.free = 10
  await clock.advance(MINUTE)
  expect(w.prompts).toHaveLength(2)
  expect(alertOf(w)?.claimedBy).toBe('session-A')
})

test('a headless session toasts and notifies and never submits a prompt', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 5
  await $.session.start(HEADLESS)
  await clock.advance(5 * MINUTE)
  expect(w.toasts).toHaveLength(1)
  expect(w.notices).toHaveLength(1)
  expect(w.prompts).toHaveLength(0)
  expect(alertOf(w)?.claimedBy).toBe('session-A')
})

test('a store that cannot be read or written does not throw; the watch goes on', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.isStoreBroken = true
  w.free = 5
  await expect($.session.start(START)).resolves.toEqual({ cwd: '/work' })
  await clock.advance(2 * MINUTE)
  expect(w.prompts).toHaveLength(0)
  w.isStoreBroken = false
  await clock.advance(2 * MINUTE)
  expect(w.prompts).toHaveLength(1)
})

// ---- The heavy-work gate ----

const DOCKER = { tool: 'Bash', command: 'docker run --rm big-image' } as const
const AGENT = { tool: 'Agent', description: 'x', prompt: 'do it', subagent_type: 'general-purpose' } as const

test('over a limit: heavy Bash and the Agent tool are refused with a calm reason; reads, kills and other tools run', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 12
  await $.session.start(START)
  await clock.advance(1000)
  const toastsBefore = w.toasts.length

  const refused = await $.tool.call(DOCKER)
  expect(refused.deny).toContain('this command was not run')
  expect(refused.deny).toContain('this command was not run')
  expect(refused.deny).toContain('free 12% · swap 5G')
  expect(refused.deny).toContain('free at least 28%, swap at most 24G')
  expect(refused.deny).toContain('lifts by itself when memory recovers')
  expect(w.toasts.length - toastsBefore).toBe(1)
  expect(w.toasts.at(-1)).toBe('paused docker run: free 12% · swap 5G')

  expect((await $.tool.call(AGENT)).deny).toContain('this subagent was not started')
  await $.tool.call({ tool: 'Bash', command: 'ls && docker run x' })
  await $.tool.call({ tool: 'Bash', command: 'docker ps' })
  await $.tool.call({ tool: 'Bash', command: 'pkill -f train.py' })
  await $.tool.call({ tool: 'Read', file_path: '/work/a.txt' })
  expect(w.ran).toEqual(['Bash: docker ps', 'Bash: pkill -f train.py', 'Read'])
})

test('under the limits nothing is gated', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call(DOCKER)
  await $.tool.call(AGENT)
  expect(w.ran).toEqual([`Bash: ${DOCKER.command}`, 'Agent'])
  expect(w.toasts).toHaveLength(0)
})

test('recovery lifts the gate on the next check', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 12
  await $.session.start(START)
  await clock.advance(1000)
  expect((await $.tool.call(DOCKER)).deny).toContain('was not run')
  w.free = 60
  await clock.advance(MINUTE)
  await $.tool.call(DOCKER)
  expect(w.ran).toEqual([`Bash: ${DOCKER.command}`])
})

test('a reading older than three intervals fails open (the commands stopped answering)', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 12
  await $.session.start(START)
  await clock.advance(1000)
  w.isBroken = true
  await clock.advance(2 * MINUTE)
  expect((await $.tool.call(DOCKER)).deny).toContain('was not run')
  await clock.advance(MINUTE + 1000)
  await $.tool.call(DOCKER)
  expect(w.ran).toEqual([`Bash: ${DOCKER.command}`])
})

test('no reading at all (neither macOS nor Linux) leaves the gate open', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.isBroken = true
  await $.session.start(START)
  await clock.advance(5 * MINUTE)
  await $.tool.call(DOCKER)
  expect(w.ran).toHaveLength(1)
})

test('another session\'s fresh reading gates this one before its own first check', async ($, on) => {
  mock.clock(on, { now: 100 * MINUTE })
  const w = world(on)
  w.store.set('reading', { freePercent: 9, swapGb: 3, at: 100 * MINUTE - 30_000 })
  expect((await $.tool.call(DOCKER)).deny).toContain('free 9% · swap 3G')
  // And a stale one from a session long gone does not.
  w.store.set('reading', { freePercent: 9, swapGb: 3, at: 90 * MINUTE })
  await $.tool.call(DOCKER)
  expect(w.ran).toHaveLength(1)
})

test('a headless (-p or SDK) session is gated too', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 5
  await $.session.start(HEADLESS)
  await clock.advance(1000)
  expect((await $.tool.call(DOCKER)).deny).toContain('was not run')
  expect(w.ran).toHaveLength(0)
})

test('gateHeavyWork off: nothing is refused', { options: { gateHeavyWork: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 5
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call(DOCKER)
  await $.tool.call(AGENT)
  expect(w.ran).toHaveLength(2)
})

test('user patterns block and allow more', { options: { gateBlockPatterns: '^rsync\\b', gateAllowPatterns: '^docker run --rm big-image' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 5
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call(DOCKER)
  expect((await $.tool.call({ tool: 'Bash', command: 'rsync -a a b' })).deny).toContain('was not run')
  expect(w.ran).toEqual([`Bash: ${DOCKER.command}`])
})

test('gateLightSubcommands lets a tool\'s listed subcommands run while gated', { options: { gateLightSubcommands: 'mytool status ;; mytool list' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 5
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: 'mytool status' })
  await $.tool.call({ tool: 'Bash', command: 'mytool list mygroup' })
  expect((await $.tool.call({ tool: 'Bash', command: 'mytool run job-1' })).deny).toContain('(not on the light list: mytool run)')
  expect(w.ran).toEqual(['Bash: mytool status', 'Bash: mytool list mygroup'])
})

test('a store that cannot be read fails the gate open', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 5
  await $.session.start(START)
  await clock.advance(1000)
  w.isStoreBroken = true
  await $.tool.call(DOCKER)
  expect(w.ran).toHaveLength(1)
})

test('all UI off: no status, toast or notification, the model is still woken and the gate still holds',
  { options: { showStatus: false, showToasts: false, systemNotifications: false } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    w.free = 5
    await $.session.start(START)
    await clock.advance(1000)
    expect((await $.tool.call(DOCKER)).deny).toContain('was not run')
    expect(w.statuses).toHaveLength(0)
    expect(w.toasts).toHaveLength(0)
    expect(w.notices).toHaveLength(0)
    expect(w.prompts).toHaveLength(1)
  })

test('each visibility toggle silences only its own surface', { options: { systemNotifications: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 5
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.notices).toHaveLength(0)
  expect(w.toasts).toHaveLength(1)
  expect(w.statuses.at(-1)).toBe('! mem free 5% · swap 5G')
})

test('showToasts off keeps the status line and notification', { options: { showToasts: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 5
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call(DOCKER)
  expect(w.toasts).toHaveLength(0)
  expect(w.notices).toHaveLength(1)
  expect(w.statuses.at(-1)).toBe('! mem free 5% · swap 5G')
})

// ---- allowlist mode and the culprits ----

test('over a limit only light commands run: renamed scripts, wrapped Docker and compound commands are refused', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 12
  await $.session.start(START)
  await clock.advance(1000)
  for (const command of ['python -m train', './run.sh', 'docker run img -h', '(( x = 1 << 2 ))\nmake', 'ls && bash -c "npm test"', 'echo "$(docker build .)"']) {
    expect([command, (await $.tool.call({ tool: 'Bash', command })).deny]).toEqual([command, expect.stringContaining('was not run')])
  }
  for (const command of ['ls -la', 'kill $(pgrep -f train)', 'docker ps && docker stats --no-stream', 'rm -rf build/', 'git status', 'docker run --help']) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect(w.ran).toEqual(['Bash: ls -la', 'Bash: kill $(pgrep -f train)', 'Bash: docker ps && docker stats --no-stream', 'Bash: rm -rf build/', 'Bash: git status', 'Bash: docker run --help'])
})

test('gateMode "patterns" brings back the old gate: only heavy rules are refused', { options: { gateMode: 'patterns' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 12
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: 'python serve.py' })
  expect((await $.tool.call({ tool: 'Bash', command: 'python -m train' })).deny).toContain('train/eval script')
  expect((await $.tool.call(DOCKER)).deny).toContain('(docker run)')
  expect(w.ran).toEqual(['Bash: python serve.py'])
})

test('over a limit the refusal and the alert name the top memory users, Docker containers included', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.docker = 'web\t1.5GiB / 7.6GiB\ndb\t300MiB / 7.6GiB\n'
  w.free = 12
  await $.session.start(START)
  await clock.advance(1000)
  const deny = (await $.tool.call(DOCKER)).deny ?? ''
  expect(deny).toContain('Largest users of memory now: python3 (pid 4242) 9.0 GB; launchd (pid 1) 0.0 GB; container web 1.5GiB; container db 300MiB. Nothing has been stopped')
  expect(w.prompts[0]).toContain('- container web 1.5GiB')
  expect(w.prompts[0]).toContain('Nothing has been killed.')
})

test('the culprits are not read while memory is fine, and Docker not running only drops the containers', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(3 * MINUTE)
  expect(w.argv0).not.toContain('ps')
  expect(w.argv0).not.toContain('docker')
  w.free = 12
  await clock.advance(MINUTE)
  expect(w.argv0.filter(word => word === 'ps')).toHaveLength(1)
  const deny = (await $.tool.call(DOCKER)).deny ?? ''
  expect(deny).toContain('python3 (pid 4242) 9.0 GB')
  expect(deny).not.toContain('container')
})

test('culprits another session took this interval are reused, not read again', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on)
  w.store.set('culprits', { at: 100 * MINUTE - 10_000, lines: ['java (pid 9) 20.0 GB'] })
  w.free = 12
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.argv0).not.toContain('ps')
  expect((await $.tool.call(DOCKER)).deny).toContain('java (pid 9) 20.0 GB')
})

test('a refusal leaves out culprits that are stale', async ($, on) => {
  mock.clock(on, { now: 100 * MINUTE })
  const w = world(on)
  w.store.set('reading', { freePercent: 9, swapGb: 3, at: 100 * MINUTE - 30_000 })
  w.store.set('culprits', { at: 80 * MINUTE, lines: ['java (pid 9) 20.0 GB'] })
  const deny = (await $.tool.call(DOCKER)).deny ?? ''
  expect(deny).toContain('was not run')
  expect(deny).not.toContain('java')
})

// ---- the concurrency cap ----

const spawn = (description = 'work', extra: Record<string, unknown> = {}) =>
  ({ tool_use_id: `t-${description}`, prompt: 'do it', description, subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: true, fork: false, ...extra }) as never

const BG = (command: string) => ({ tool: 'Bash', command, run_in_background: true }) as const

test('subagents: past maxConcurrentAgents (4) a top-level spawn is refused, whatever memory says; a finish frees a slot', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const description of ['one', 'two', 'three', 'four']) {
    expect(await $.agent.spawn(spawn(description))).toMatchObject({ agentId: expect.any(String) })
  }
  const refused = await $.agent.spawn(spawn('five'))
  expect('deny' in refused ? refused.deny : '').toContain('this subagent was not started. 4 top-level subagents and working teammates are already running or starting in this session, and the cap is 4 at once (maxConcurrentAgents)')
  expect('deny' in refused ? refused.deny : '').toContain('Running: task a1; task a2; task a3.')
  expect(w.spawned).toEqual(['a1', 'a2', 'a3', 'a4'])
  // One ends: the engine's list says so.
  ;(w.agents ?? [])[0]!.taskStatus = 'completed'
  await $.agent.spawn(spawn('five'))
  expect(w.spawned).toEqual(['a1', 'a2', 'a3', 'a4', 'a5'])
})

test('subagents: a child spawned while the top-level cap is full is allowed, and children hold no slot', { options: { maxConcurrentAgents: 3 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const description of ['one', 'two', 'three']) {
    await $.agent.spawn(spawn(description))
  }
  // Each of the three spawns two children, and one child spawns a grandchild: none is refused.
  for (const parent of ['a1', 'a2', 'a3']) {
    for (const n of [1, 2]) {
      expect('deny' in (await $.agent.spawn(spawn(`${parent}-${n}`, { parentAgentId: parent })))).toBe(false)
    }
  }
  expect('deny' in (await $.agent.spawn(spawn('grandchild', { parentAgentId: 'a4' })))).toBe(false)
  expect(w.spawned).toHaveLength(10)
  // The top level is still full, children or not; a top-level finish frees a slot children never took.
  expect('deny' in (await $.agent.spawn(spawn('four')))).toBe(true)
  ;(w.agents ?? [])[0]!.taskStatus = 'completed'
  expect('deny' in (await $.agent.spawn(spawn('four')))).toBe(false)
})

test('subagents: a child is still refused by the memory gate while memory is low', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, clock)
  w.free = 12
  await $.session.start(START)
  await clock.advance(1000)
  expect((await $.tool.call({ tool: 'Agent', agentId: 'a1', prompt: 'x', description: 'child' } as never)).deny).toContain('this subagent was not started')
  expect(w.ran).toEqual([])
})

test('subagents: spawns made together count each other, and an agent already listed is not counted twice', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  w.agents = [agent('old', 0)]
  const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(description => $.agent.spawn(spawn(description))))
  expect(results.filter(result => 'deny' in result)).toHaveLength(2)
  expect(w.spawned).toEqual(['a1', 'a2', 'a3'])
})

test('subagents: idle teammates, finished and failed agents, and workflow agents hold no slot', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  w.agents = [
    { ...agent('t1'), kind: 'in_process_teammate', status: 'idle' },
    agent('done', 0, 'completed'),
    agent('bad', 0, 'failed'),
    agent('r1'),
    agent('r2'),
    agent('r3'),
  ]
  // Three running subagents and an idle teammate: one slot is free.
  expect('deny' in (await $.agent.spawn(spawn('x')))).toBe(false)
  expect('deny' in (await $.agent.spawn(spawn('y')))).toBe(true)
  await $.agent.spawn(spawn('wf', { workflow: { runId: 'wf_1', agentIndex: 1 } }))
  expect(w.spawned).toHaveLength(2)
})

const mateSpawn = (name: string, extra: Record<string, unknown> = {}) => spawn(name, { name, isTeammate: true, subagentType: 'teammate', ...extra })

test('teammates: past maxConcurrentAgents a new teammate from main is refused; a teammate gone idle frees its slot', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const name of ['scout', 'builder', 'tester', 'writer']) {
    expect('deny' in (await $.agent.spawn(mateSpawn(name)))).toBe(false)
  }
  const refused = await $.agent.spawn(mateSpawn('reviewer'))
  expect('deny' in refused ? refused.deny : '').toContain('this teammate was not started. 4 top-level subagents and working teammates are already running or starting in this session, and the cap is 4 at once (maxConcurrentAgents)')
  // Working teammates fill the cap for subagents too.
  expect('deny' in (await $.agent.spawn(spawn('sub')))).toBe(true)
  expect(w.spawned).toEqual(['a1', 'a2', 'a3', 'a4'])
  // One ends its turn and waits for a message: its task still reads running, its loop idle.
  ;(w.agents ?? [])[0]!.status = 'idle'
  expect('deny' in (await $.agent.spawn(mateSpawn('reviewer')))).toBe(false)
  expect('deny' in (await $.agent.spawn(spawn('sub')))).toBe(true)
  // A message wakes it: it holds a slot again.
  ;(w.agents ?? [])[1]!.status = 'idle'
  ;(w.agents ?? [])[0]!.status = 'running'
  expect('deny' in (await $.agent.spawn(spawn('sub')))).toBe(true)
})

test('teammates: idle teammates hold no slot, however many there are', { options: { maxConcurrentAgents: 2 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const name of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) {
    expect('deny' in (await $.agent.spawn(mateSpawn(name)))).toBe(false)
    // Each finishes its first task and goes idle before the next is spawned.
    ;(w.agents ?? []).at(-1)!.status = 'idle'
  }
  expect('deny' in (await $.agent.spawn(spawn('one')))).toBe(false)
  expect('deny' in (await $.agent.spawn(spawn('two')))).toBe(false)
  expect('deny' in (await $.agent.spawn(spawn('three')))).toBe(true)
  expect(w.spawned).toHaveLength(8)
})

test('teammates: their own children are never capped, and a teammate brought back from disk is not refused', { options: { maxConcurrentAgents: 1 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  await $.agent.spawn(mateSpawn('lead'))
  expect('deny' in (await $.agent.spawn(spawn('child', { parentAgentId: 'a1' })))).toBe(false)
  expect('deny' in (await $.agent.spawn(spawn('child2', { parentAgentId: 'a1' })))).toBe(false)
  expect('deny' in (await $.agent.spawn(mateSpawn('second')))).toBe(true)
  expect('deny' in (await $.agent.spawn(mateSpawn('old', { resume: { agentId: 'old-id' } })))).toBe(false)
  expect(w.spawned).toEqual(['a1', 'a2', 'a3', 'a4'])
})

test('teammates: a list that cannot be read fails open for them too', { options: { maxConcurrentAgents: 1 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  w.agents = null
  for (const name of ['m1', 'm2', 'm3']) {
    await $.agent.spawn(mateSpawn(name))
  }
  expect(w.spawned).toHaveLength(3)
})

test('teammates: capTeammates false leaves them uncapped and holding no slot', { options: { capTeammates: false, maxConcurrentAgents: 2 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const name of ['m1', 'm2', 'm3', 'm4']) {
    expect('deny' in (await $.agent.spawn(mateSpawn(name)))).toBe(false)
  }
  expect('deny' in (await $.agent.spawn(spawn('one')))).toBe(false)
  expect('deny' in (await $.agent.spawn(spawn('two')))).toBe(false)
  const refused = await $.agent.spawn(spawn('three'))
  expect('deny' in refused ? refused.deny : '').toContain('this subagent was not started. 2 top-level subagents are already running')
  expect(w.spawned).toHaveLength(6)
})

test('subagents: running workflow agents, listed like top-level ones, do not fill main\'s cap', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  w.agents = [agent('r1'), agent('r2'), agent('r3')]
  for (const index of [1, 2, 3]) {
    expect('deny' in (await $.agent.spawn(spawn(`wf${index}`, { workflow: { runId: 'wf_1', agentIndex: index } })))).toBe(false)
  }
  // The mock lists each workflow agent as a running row with no parentId, as the engine was seen to.
  expect((w.agents ?? []).filter(row => row.taskStatus === 'running' && row.parentId === undefined)).toHaveLength(6)
  expect('deny' in (await $.agent.spawn(spawn('fourth')))).toBe(false)
  const refused = await $.agent.spawn(spawn('fifth'))
  expect('deny' in refused ? refused.deny : '').toContain('4 top-level subagents and working teammates are already running')
})

test('subagents: a list that cannot be read fails open', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  w.agents = null
  for (const description of ['1', '2', '3', '4', '5']) {
    await $.agent.spawn(spawn(description))
  }
  expect(w.spawned).toHaveLength(5)
})

test('subagents: maxConcurrentAgents 0 turns the cap off; another value moves it', { options: { maxConcurrentAgents: 0 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const description of ['1', '2', '3', '4', '5']) {
    await $.agent.spawn(spawn(description))
  }
  expect(w.spawned).toHaveLength(5)
})

test('subagents: a cap of 1 holds one at a time', { options: { maxConcurrentAgents: 1 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  await $.agent.spawn(spawn('1'))
  expect('deny' in (await $.agent.spawn(spawn('2')))).toBe(true)
  expect(w.spawned).toHaveLength(1)
})

test('background jobs: past maxBackgroundJobs (3) a background Bash call is refused; foreground calls never are', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const n of [1, 2, 3]) {
    await $.tool.call(BG(`sleep ${n}00`))
  }
  const refused = await $.tool.call(BG('sleep 400'))
  expect(refused.deny).toContain('this background command was not started. 3 background jobs this session started are still running or starting, and the cap is 3 at once (maxBackgroundJobs)')
  expect(refused.deny).toContain('b1 (sleep 100); b2 (sleep 200); b3 (sleep 300)')
  expect(refused.deny).toContain('run this one in the foreground')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(w.ran).toEqual(['Bash: sleep 100', 'Bash: sleep 200', 'Bash: sleep 300', 'Bash: ls'])
})

test('background jobs: calls made together count each other', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  const results = await Promise.all([1, 2, 3, 4, 5].map(n => $.tool.call(BG(`sleep ${n}`))))
  expect(results.filter(result => result.deny !== undefined)).toHaveLength(2)
  expect(w.ran).toHaveLength(3)
})

const notification = (id: string, status = 'completed') =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`

const appendRow = (text: string, agentId?: string) =>
  ({ message: { type: 'user', role: 'user', content: [{ type: 'text', text }] }, door: 'prompt', origin: { kind: 'task-notification' }, uuid: `u-${text.length}-${agentId ?? 'main'}`, ...(agentId === undefined ? {} : { agentId }) }) as never

test('background jobs: a task notification, in any loop, frees its slot', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const n of [1, 2, 3]) {
    await $.tool.call(BG(`sleep ${n}`))
  }
  expect((await $.tool.call(BG('sleep 4'))).deny).toBeDefined()
  await $.session.append(appendRow(notification('b2'), 'sub-1'))
  await $.tool.call(BG('sleep 4'))
  expect(w.ran.at(-1)).toBe('Bash: sleep 4')
  // A row that only mentions an id, outside a notification, frees nothing.
  await $.session.append(appendRow('the job b1 is still going'))
  expect((await $.tool.call(BG('sleep 5'))).deny).toBeDefined()
})

test('background jobs: TaskStop and the Stop hook\'s in-flight list free slots', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const n of [1, 2, 3]) {
    await $.tool.call(BG(`sleep ${n}`))
  }
  await $.tool.call({ tool: 'TaskStop', task_id: 'b1' } as never)
  await $.tool.call(BG('sleep 4'))
  expect(w.ran.at(-1)).toBe('Bash: sleep 4')
  // The turn ends a minute later: only b4 is still in flight.
  await clock.advance(MINUTE)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b4', type: 'shell', status: 'running', description: 'sleep 4' }] } as never)
  for (const n of [5, 6]) {
    await $.tool.call(BG(`sleep ${n}`))
  }
  expect((await $.tool.call(BG('sleep 7'))).deny).toBeDefined()
  expect(w.ran.filter(line => line.startsWith('Bash: sleep'))).toHaveLength(6)
})

test('background jobs: the Stop prune keeps a job recorded just before it, which its in-flight list may predate', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  await $.tool.call(BG('sleep 1'))
  await clock.advance(MINUTE)
  await $.tool.call(BG('sleep 2'))
  await clock.advance(1000)
  // The turn's in-flight list was taken before b2 was recorded: b1 has ended, b2 is kept.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  for (const n of [3, 4]) {
    await $.tool.call(BG(`sleep ${n}`))
  }
  expect((await $.tool.call(BG('sleep 5'))).deny).toContain('b2 (sleep 2)')
  expect(w.ran.filter(line => line.startsWith('Bash: sleep'))).toHaveLength(4)
})

test('background jobs: a finish never seen stops counting after the expiry, so the cap fails open', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const n of [1, 2, 3]) {
    await $.tool.call(BG(`sleep ${n}`))
  }
  await clock.advance(29 * MINUTE)
  expect((await $.tool.call(BG('sleep 4'))).deny).toContain('after 30 minutes')
  await clock.advance(MINUTE)
  await $.tool.call(BG('sleep 4'))
  expect(w.ran.at(-1)).toBe('Bash: sleep 4')
})

test('background jobs: a command moved to the background by itself counts too', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const n of [1, 2, 3]) {
    await $.tool.call({ tool: 'Bash', command: `slow ${n}` })
  }
  expect((await $.tool.call(BG('sleep 4'))).deny).toBeDefined()
  expect(w.ran).toHaveLength(3)
})

test('background jobs: maxBackgroundJobs 0 turns the cap off', { options: { maxBackgroundJobs: 0, backgroundJobExpiryMinutes: 5 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  for (const n of [1, 2, 3, 4, 5]) {
    await $.tool.call(BG(`sleep ${n}`))
  }
  expect(w.ran).toHaveLength(5)
})

test('the memory gate refuses first; a refused background call takes no slot', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.free = 12
  await $.session.start(START)
  await clock.advance(1000)
  expect((await $.tool.call(BG('make'))).deny).toContain('Memory is low')
  w.free = 60
  await clock.advance(MINUTE)
  for (const n of [1, 2, 3]) {
    await $.tool.call(BG(`sleep ${n}`))
  }
  expect(w.ran).toHaveLength(3)
})

/** The shared store as session A left it at its cap: all another session of this config directory can see of A. */
let storeOfA: Map<string, unknown> | null = null

test('the cap is per session (1/2): session A at its cap keeps none of it in the store the sessions share', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  await $.session.start(START)
  await clock.advance(1000)
  for (const n of [1, 2, 3, 4]) {
    await $.agent.spawn(spawn(`${n}`))
  }
  for (const n of [1, 2, 3]) {
    await $.tool.call(BG(`sleep ${n}`))
  }
  expect('deny' in (await $.agent.spawn(spawn('5')))).toBe(true)
  expect((await $.tool.call(BG('sleep 4'))).deny).toBeDefined()
  expect([...w.store.keys()]).toEqual(['reading'])
  storeOfA = new Map(w.store)
})

test('the cap is per session (2/2): session B, sharing A\'s store, starts its own full quota', async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on, clock)
  expect(storeOfA).not.toBeNull()
  w.store = new Map(storeOfA)
  await $.session.start(START)
  await clock.advance(1000)
  for (const n of [1, 2, 3, 4]) {
    expect('deny' in (await $.agent.spawn(spawn(`b${n}`)))).toBe(false)
  }
  for (const n of [1, 2, 3]) {
    expect((await $.tool.call(BG(`sleep ${n}`))).deny).toBeUndefined()
  }
  expect(w.spawned).toHaveLength(4)
})

/** `/proc/meminfo` on a 16 GB Linux machine: `availableGb` of it available, `swapUsedGb` of 8 GB swap in use. */
const meminfo = (availableGb: number, swapUsedGb: number): string => {
  const kb = (gb: number) => Math.round(gb * 1024 * 1024)

  return [`MemTotal: ${kb(16)} kB`, `MemFree: ${kb(1)} kB`, `MemAvailable: ${kb(availableGb)} kB`, `SwapTotal: ${kb(8)} kB`, `SwapFree: ${kb(8 - swapUsedGb)} kB`].join('\n')
}

test('Linux: reads /proc/meminfo, shows the figures and alerts on low free memory', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.os = 'linux'
  w.meminfo = meminfo(8, 1)
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.statuses.at(-1)).toBe('mem free 50% · swap 1G')
  expect(w.logs).toEqual([])

  w.meminfo = meminfo(2, 1)
  await clock.advance(MINUTE)
  expect(w.statuses.at(-1)).toBe('! mem free 13% · swap 1G')
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('free at least 28%, swap at most 16G')
  // Once Linux has answered, the macOS commands are not tried again.
  const before = w.argv0.length
  await clock.advance(MINUTE)
  expect(w.argv0.slice(before).filter(word => word === 'sysctl' || word === 'memory_pressure')).toEqual([])
})

test('Linux: the automatic swap limit is the RAM size, and the gate refuses past it', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.os = 'linux'
  w.meminfo = meminfo(12, 4)
  await $.session.start(START)
  await clock.advance(1000)
  // 4 of 8 GB swap on a 16 GB machine: under the limit.
  await $.tool.call(DOCKER)
  expect(w.ran).toHaveLength(1)
  w.meminfo = [`MemTotal: ${16 * 1024 * 1024} kB`, `MemAvailable: ${12 * 1024 * 1024} kB`, `SwapTotal: ${32 * 1024 * 1024} kB`, `SwapFree: ${15 * 1024 * 1024} kB`].join('\n')
  await clock.advance(MINUTE)
  expect(w.statuses.at(-1)).toBe('! mem free 75% · swap 17G')
  const refused = await $.tool.call(DOCKER)
  expect(refused.deny).toContain('swap at most 16G')
})

test('an explicit maxSwapGb overrides the RAM-sized default', { options: { maxSwapGb: 4 } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.swap = '5.00G'
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.statuses.at(-1)).toBe('! mem free 60% · swap 5G')
  expect(w.prompts[0]).toContain('swap at most 4G')
})

test('macOS: the automatic swap limit follows hw.memsize, which is read only once', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.ramBytes = 8 * 1024 ** 3
  w.swap = '9.00G'
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.statuses.at(-1)).toBe('! mem free 60% · swap 9G')
  expect(w.prompts[0]).toContain('swap at most 8G')
  await clock.advance(3 * MINUTE)
  expect(w.argv0.filter(word => word === 'sysctl')).toHaveLength(4 + 1)
})

test('neither macOS nor Linux: says so once in the transcript, and the agent cap still applies', { options: { maxConcurrentAgents: 1 } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.os = 'other'
  w.agents = [agent('busy')]
  await $.session.start(START)
  await clock.advance(5 * MINUTE)
  expect(w.statuses.every(text => text === undefined)).toBe(true)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toContain('no memory reading on this machine')
  expect(w.logs[0]).toContain('caps apply either way')
  const spawn = await $.agent.spawn({ prompt: 'p', description: 'd', subagent_type: 'general-purpose' } as never)
  expect('deny' in spawn ? spawn.deny : '').not.toBe('')
  expect(w.spawned).toEqual([])
})
