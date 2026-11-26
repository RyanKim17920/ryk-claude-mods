import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const HEADLESS = { cwd: '/work', surface: null, isInteractive: false } as const
const alertOf = (w: World) => w.store.get('alert') as Alert | undefined
const MINUTE = 60_000
/** The default check interval. */
const TICK = 5 * MINUTE
const WAKE = { options: { wakeMainOnAlert: true } }
const GB = 1024 * 1024
const HEADER = 'Filesystem   1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on'
const GUARD = 'Nothing has been deleted; do not delete files unless the user asks.'

type Alert = {
  alertedTier: number | null
  tierAlertedAt: Record<string, number>
  lastTier: number | null
  lastAlertAt: number | null
  claimedBy: string | null
}

/** Another session's alert at `tier`, taken at `time`. */
const othersAlert = (tier: number, time: number): Alert => ({
  alertedTier: tier,
  tierAlertedAt: { [String(tier)]: time },
  lastTier: tier,
  lastAlertAt: time,
  claimedBy: 'session-B',
})

type World = {
  /** The plugin's store file, which every session of this config directory shares. */
  store: Map<string, unknown>
  /** Called after each write of the alert the session under test makes: where another session gets its word in. */
  afterSet: (() => void) | null
  isStoreBroken: boolean
  freeGb: number
  /** No `/System/Volumes/Data` (not macOS): df on it fails, and `/` is read instead. */
  isDataVolumeMissing: boolean
  isBroken: boolean
  isGarbage: boolean
  dfPaths: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  notices: string[]
  prompts: string[]
  /** Tool calls that got past the gate. */
  ran: string[]
  /** What `docker system df` prints; null when Docker is not running. */
  dockerDf: string | null
  /** KB per folder `du -sk` measures; a folder missing here prints nothing. */
  du: Record<string, number>
  /** Folders with files `du` cannot read: it still prints the total, but exits 1 with errors on stderr. */
  duDenied: string[]
  /** Every measuring command run (docker, du), by its first word. */
  measured: string[]
}

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'df: No such file or directory', isStdoutTruncated: false, isStderrTruncated: false },
})

// Stands for the host beneath the plugin: df, the display, the prompt queue.
function world(on: On): World {
  const w: World = { store: new Map(), afterSet: null, isStoreBroken: false, freeGb: 42, isDataVolumeMissing: false, isBroken: false, isGarbage: false, dfPaths: [], statuses: [], toasts: [], notices: [], prompts: [], ran: [], dockerDf: null, du: {}, duDenied: [], measured: [] }
  on('process.run', ($, e) => {
    if (e.argv[0] === 'docker' || e.argv[0] === 'du') {
      w.measured.push(e.argv[0])
      const path = e.argv[2] ?? ''
      const kb = w.du[path]
      if (e.argv[0] === 'docker') {
        return w.dockerDf === null ? ran('', 1) : ran(w.dockerDf)
      }

      if (kb !== undefined && w.duDenied.includes(path)) {
        const stderr = `du: cannot read directory '${path}/storage/overlay/3f2a/diff/root': Permission denied\n`

        return { value: { exitCode: 1, stdout: `${kb}\t${path}\n`, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
      }

      return kb === undefined ? ran('', 1) : ran(`${kb}\t${path}\n`)
    }
    if (w.isBroken) {
      throw new Error('spawn df ENOENT')
    }
    const path = e.argv[2] ?? ''
    w.dfPaths.push(path)
    if (w.isDataVolumeMissing && path === '/System/Volumes/Data') {
      return ran('', 1)
    }
    if (w.isGarbage) {
      return ran('df: unexpected output\n')
    }
    const avail = Math.round(w.freeGb * GB)

    return ran(`${HEADER}\n/dev/disk3s5   482797652 ${482797652 - avail}  ${avail}    95% 7056592 106787160    6%   ${path}\n`)
  })
  on('env.get', () => ({ value: '/Users/me' }))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)

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
  // The tools beneath the gate: a call that reaches here ran.
  on('tool.call', ($, e) => {
    w.ran.push(e.tool === 'Bash' ? `Bash: ${e.command}` : e.tool)

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
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

test('shows free space and stays quiet while there is plenty', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  // One second past each tick from here on: a claim's wait (under 600 ms) is over when a test looks.
  await clock.advance(1000)
  expect(w.statuses.at(-1)).toBe('storage 42G free')
  expect(w.dfPaths).toEqual(['/System/Volumes/Data'])
  await clock.advance(3 * TICK)
  expect(w.toasts).toHaveLength(0)
  expect(w.notices).toHaveLength(0)
  expect(w.prompts).toHaveLength(0)
})

test('by default an alert toasts, notifies and marks the status line, and never wakes the model', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(1000)

  w.freeGb = 10.5
  await clock.advance(TICK)
  expect(w.toasts).toEqual(['Disk below 20 GB free (10.5G)'])
  expect(w.notices).toEqual(['Disk below 20 GB free (10.5G)'])
  expect(w.statuses.at(-1)).toBe('! storage 10G free')
  expect(w.prompts).toHaveLength(0)
  await clock.advance(3 * TICK)
  expect(w.toasts).toHaveLength(1)
  expect(w.prompts).toHaveLength(0)
})

test('crossing each tier in order alerts once per tier, the 1 GB one urgent', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(1000)

  for (const free of [18, 15, 9, 8, 4.2, 0.6, 0.5]) {
    w.freeGb = free
    await clock.advance(TICK)
  }
  expect(w.toasts).toEqual([
    'Disk below 20 GB free (18.0G)',
    'Disk below 10 GB free (9.0G)',
    'Disk below 5 GB free (4.2G)',
    'URGENT: Disk below 1 GB free (0.6G)',
  ])
  expect(w.notices).toEqual(w.toasts)
  expect(w.prompts).toEqual(w.toasts.map(text => `${text} on this machine.\n${GUARD}`))
})

test('a jump straight from 25 to 3 GB is one alert, naming the 5 GB tier', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 25
  await $.session.start(START)
  await clock.advance(1000)

  w.freeGb = 3
  await clock.advance(TICK)
  expect(w.toasts).toEqual(['Disk below 5 GB free (3.0G)'])
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('Disk below 5 GB free')
  // Climbing back through the shallower tiers it skipped stays silent.
  for (const free of [8, 12, 19]) {
    w.freeGb = free
    await clock.advance(TICK)
  }
  expect(w.toasts).toHaveLength(1)
  expect(w.prompts).toHaveLength(1)
})

test('a deeper tier alerts inside the cooldown; the same tier inside it does not, even after a recovery', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(1000)

  w.freeGb = 18
  await clock.advance(TICK)
  // Five minutes later, well inside the hour's cooldown: deeper, so it alerts.
  w.freeGb = 9
  await clock.advance(TICK)
  expect(w.toasts).toEqual(['Disk below 20 GB free (18.0G)', 'Disk below 10 GB free (9.0G)'])

  // Recovers past 22 (re-arms), then falls through 20 and 10 again inside their cooldowns: silent.
  w.freeGb = 30
  await clock.advance(TICK)
  expect(alertOf(w)?.alertedTier).toBeNull()
  w.freeGb = 18
  await clock.advance(TICK)
  w.freeGb = 9
  await clock.advance(TICK)
  expect(w.toasts).toHaveLength(2)
  expect(w.prompts).toHaveLength(2)
  expect(w.statuses.at(-1)).toBe('! storage 9G free')

  // A tier not yet alerted still alerts.
  w.freeGb = 4
  await clock.advance(TICK)
  expect(w.toasts.at(-1)).toBe('Disk below 5 GB free (4.0G)')
  expect(w.prompts).toHaveLength(3)
})

test('recovery above 22 GB re-arms every tier, and past the cooldown they alert again', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(1000)

  w.freeGb = 18
  await clock.advance(TICK)
  expect(w.prompts).toHaveLength(1)

  // 21 is inside the hysteresis band: nothing re-arms.
  w.freeGb = 21
  await clock.advance(TICK)
  expect(alertOf(w)?.alertedTier).toBe(20)

  w.freeGb = 23
  await clock.advance(TICK)
  expect(alertOf(w)?.alertedTier).toBeNull()

  await clock.advance(60 * MINUTE)
  w.freeGb = 18
  await clock.advance(TICK)
  expect(w.prompts).toHaveLength(2)
  expect(w.toasts).toHaveLength(2)
})

test('custom tiers and interval are honoured', { options: { tiersGb: '50, 30', intervalSeconds: 10, wakeMainOnAlert: true } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.prompts).toEqual([`Disk below 50 GB free (42.0G) on this machine.\n${GUARD}`])
  const before = w.statuses.length
  await clock.advance(30_000)
  expect(w.statuses.length - before).toBe(3)
})

test('malformed tiers fall back to 20, 10, 5, 1', { options: { tiersGb: 'twenty' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 7
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.toasts).toEqual(['Disk below 10 GB free (7.0G)'])
})

test('falls back to / when the data volume is absent', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.isDataVolumeMissing = true
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.dfPaths).toEqual(['/System/Volumes/Data', '/'])
  expect(w.statuses.at(-1)).toBe('storage 42G free')
})

test('a failing command shows nothing, does not throw, and the watch goes on', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.isBroken = true
  await expect($.session.start(START)).resolves.toEqual({ cwd: '/work' })
  await clock.advance(2 * TICK)
  expect(w.statuses.every(text => text === undefined)).toBe(true)
  expect(w.toasts).toHaveLength(0)

  w.isBroken = false
  await clock.advance(TICK)
  expect(w.statuses.at(-1)).toBe('storage 42G free')
})

test('output that does not parse is treated as no reading', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.isGarbage = true
  w.freeGb = 1
  await $.session.start(START)
  await clock.advance(TICK)
  expect(w.statuses.every(text => text === undefined)).toBe(true)
  expect(w.toasts).toHaveLength(0)
})

test('two sessions tick together: the one whose claim is overwritten toasts and does not notify or wake', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(1000)

  // Session B writes its claim just after ours, inside our wait: last writer wins.
  w.afterSet = () => {
    w.afterSet = null
    w.store.set('alert', { ...(alertOf(w) as Alert), claimedBy: 'session-B' })
  }
  w.freeGb = 12
  await clock.advance(TICK)
  expect(alertOf(w)?.claimedBy).toBe('session-B')
  expect(w.toasts).toHaveLength(1)
  expect(w.notices).toHaveLength(0)
  expect(w.prompts).toHaveLength(0)
  // And nothing more on later ticks: the episode is B's.
  await clock.advance(5 * TICK)
  expect(w.toasts).toHaveLength(1)
  expect(w.prompts).toHaveLength(0)
})

test('another session alerted already: this one toasts once, naming its tier, and submits nothing', WAKE, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on)
  w.store.set('alert', othersAlert(20, 98 * MINUTE))
  w.freeGb = 12
  await $.session.start(START)
  await clock.advance(10 * MINUTE)
  expect(w.toasts).toEqual(['Disk below 20 GB free (12.0G)'])
  expect(w.prompts).toHaveLength(0)
  expect(alertOf(w)).toEqual(othersAlert(20, 98 * MINUTE))
})

test('another session took the 20 GB tier: this session still takes the deeper 10 GB tier', WAKE, async ($, on) => {
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const w = world(on)
  w.store.set('alert', othersAlert(20, 98 * MINUTE))
  w.freeGb = 12
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.prompts).toHaveLength(0)

  w.freeGb = 8
  await clock.advance(TICK)
  expect(w.prompts).toEqual([`Disk below 10 GB free (8.0G) on this machine.\n${GUARD}`])
  expect(alertOf(w)).toMatchObject({ alertedTier: 10, claimedBy: 'session-A' })
  expect(alertOf(w)?.tierAlertedAt).toMatchObject({ '20': 98 * MINUTE })
})

test('a recovery either session sees re-arms both', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await $.session.start(START)
  await clock.advance(1000)

  // We take the first alert; it is on record for every session.
  w.freeGb = 12
  await clock.advance(TICK)
  expect(w.prompts).toHaveLength(1)
  expect(alertOf(w)).toMatchObject({ alertedTier: 20, claimedBy: 'session-A' })

  // We see the recovery and re-arm the shared state: B is armed by it too.
  w.freeGb = 42
  await clock.advance(TICK)
  expect(alertOf(w)?.alertedTier).toBeNull()

  // Past the cooldown B takes the next alert between our ticks: we toast for it and stay quiet.
  await clock.advance(60 * MINUTE)
  w.store.set('alert', othersAlert(20, clock.now()))
  w.freeGb = 15
  await clock.advance(TICK)
  expect(w.toasts).toHaveLength(2)
  expect(w.prompts).toHaveLength(1)

  // B sees the recovery this time; past the cooldown the next alert is ours.
  w.freeGb = 42
  w.store.set('alert', { ...(alertOf(w) as Alert), alertedTier: null })
  await clock.advance(61 * MINUTE)
  w.freeGb = 15
  await clock.advance(TICK)
  expect(w.prompts).toHaveLength(2)
  expect(alertOf(w)?.claimedBy).toBe('session-A')
})

test('a headless session toasts and notifies and never submits a prompt', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 4
  await $.session.start(HEADLESS)
  await clock.advance(5 * TICK)
  expect(w.toasts).toHaveLength(1)
  expect(w.notices).toHaveLength(1)
  expect(w.prompts).toHaveLength(0)
  expect(alertOf(w)?.claimedBy).toBe('session-A')
})

test('a store that cannot be read or written does not throw; the watch goes on', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.isStoreBroken = true
  w.freeGb = 4
  await expect($.session.start(START)).resolves.toEqual({ cwd: '/work' })
  await clock.advance(2 * TICK)
  expect(w.prompts).toHaveLength(0)
  w.isStoreBroken = false
  await clock.advance(2 * TICK)
  expect(w.prompts).toHaveLength(1)
})

// ---- The heavy-work gate ----

const DOCKER = { tool: 'Bash', command: 'docker pull big-image' } as const
const AGENT = { tool: 'Agent', description: 'x', prompt: 'do it', subagent_type: 'general-purpose' } as const

test('at or below 5 GB: heavy Bash and the Agent tool are refused; reads, cleanup and other tools run', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 5
  await $.session.start(START)
  await clock.advance(1000)
  const toastsBefore = w.toasts.length

  const refused = await $.tool.call(DOCKER)
  expect(refused.deny).toContain('this command was not run')
  expect(refused.deny).toContain('5.0G free')
  expect(refused.deny).toContain('at or below 5 GB free')
  expect(refused.deny).toContain('lifts by itself when free space is back above 5 GB')
  expect(w.toasts.length - toastsBefore).toBe(1)
  expect(w.toasts.at(-1)).toBe('paused docker pull: 5.0G free')

  expect((await $.tool.call(AGENT)).deny).toContain('this subagent was not started')
  await $.tool.call({ tool: 'Bash', command: 'du -sh ~/Library/Caches' })
  await $.tool.call({ tool: 'Bash', command: 'docker system prune -af' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build/' })
  await $.tool.call({ tool: 'Write', file_path: '/work/a.txt', content: 'x' })
  expect(w.ran).toEqual(['Bash: du -sh ~/Library/Caches', 'Bash: docker system prune -af', 'Bash: rm -rf build/', 'Write'])
})

test('below the alert tiers but above the gate tier nothing is gated', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 8
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call(DOCKER)
  await $.tool.call(AGENT)
  expect(w.ran).toEqual([`Bash: ${DOCKER.command}`, 'Agent'])
})

test('recovery above the gate tier lifts the gate on the next check', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 3
  await $.session.start(START)
  await clock.advance(1000)
  expect((await $.tool.call(DOCKER)).deny).toContain('was not run')
  w.freeGb = 6
  await clock.advance(TICK)
  await $.tool.call(DOCKER)
  expect(w.ran).toEqual([`Bash: ${DOCKER.command}`])
})

test('a reading older than three intervals fails open', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 3
  await $.session.start(START)
  await clock.advance(1000)
  w.isGarbage = true
  await clock.advance(2 * TICK)
  expect((await $.tool.call(DOCKER)).deny).toContain('was not run')
  await clock.advance(TICK)
  await $.tool.call(DOCKER)
  expect(w.ran).toEqual([`Bash: ${DOCKER.command}`])
})

test('no reading at all leaves the gate open', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.isGarbage = true
  w.freeGb = 0.5
  await $.session.start(START)
  await clock.advance(TICK)
  await $.tool.call(DOCKER)
  expect(w.ran).toHaveLength(1)
})

test('another session\'s fresh reading gates this one; a stale one does not', async ($, on) => {
  mock.clock(on, { now: 100 * MINUTE })
  const w = world(on)
  w.store.set('reading', { freeGb: 2, capacityPercent: 99, at: 100 * MINUTE - MINUTE })
  expect((await $.tool.call(DOCKER)).deny).toContain('2.0G free')
  w.store.set('reading', { freeGb: 2, capacityPercent: 99, at: 80 * MINUTE })
  await $.tool.call(DOCKER)
  expect(w.ran).toHaveLength(1)
})

test('a headless (-p or SDK) session is gated too', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 1
  await $.session.start(HEADLESS)
  await clock.advance(1000)
  expect((await $.tool.call(DOCKER)).deny).toContain('was not run')
  expect(w.ran).toHaveLength(0)
})

test('custom gateBelowGb is honoured', { options: { gateBelowGb: 10 } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 8
  await $.session.start(START)
  await clock.advance(1000)
  expect((await $.tool.call(DOCKER)).deny).toContain('at or below 10 GB free')
})

test('gateHeavyWork off: nothing is refused', { options: { gateHeavyWork: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 1
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call(DOCKER)
  await $.tool.call(AGENT)
  expect(w.ran).toHaveLength(2)
})

test('a store that cannot be read fails the gate open', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 1
  await $.session.start(START)
  await clock.advance(1000)
  w.isStoreBroken = true
  await $.tool.call(DOCKER)
  expect(w.ran).toHaveLength(1)
})

test('all UI off: no status, toast or notification, and the gate still holds',
  { options: { showStatus: false, showToasts: false, systemNotifications: false, wakeMainOnAlert: true } }, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on)
    w.freeGb = 4
    await $.session.start(START)
    await clock.advance(1000)
    expect((await $.tool.call(DOCKER)).deny).toContain('was not run')
    expect(w.statuses).toHaveLength(0)
    expect(w.toasts).toHaveLength(0)
    expect(w.notices).toHaveLength(0)
    expect(w.prompts).toHaveLength(1)
  })

test('systemNotifications off silences only the notification', { options: { systemNotifications: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 4
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.notices).toHaveLength(0)
  expect(w.toasts).toHaveLength(1)
  expect(w.statuses.at(-1)).toBe('! storage 4G free')
})

test('showToasts off keeps the status line and notification', { options: { showToasts: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 4
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call(DOCKER)
  expect(w.toasts).toHaveLength(0)
  expect(w.notices).toHaveLength(1)
  expect(w.statuses.at(-1)).toBe('! storage 4G free')
})

// ---- allowlist mode at low disk, and the space users ----

const DOCKER_DF = 'Images\t40.2GB\t30.1GB (74%)\nContainers\t1.5GB\t0B (0%)\nLocal Volumes\t500MB\t500MB (100%)\nBuild Cache\t12GB\t12GB\n'

test('at or below 5 GB, cleanup that frees disk still runs; downloads, builds and anything unknown do not', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 4
  await $.session.start(START)
  await clock.advance(1000)
  const cleanup = ['cp notes.md notes.bak', 'rm -rf ~/Library/Caches/pip', 'docker system prune -af', 'docker image prune -a && docker builder prune -f', 'brew cleanup', 'npm cache clean --force', 'uv cache clean', 'git worktree remove ../wt', 'du -sh ~/.cache/* | sort -h', 'hf cache --help']
  for (const command of cleanup) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect(w.ran).toEqual(cleanup.map(command => `Bash: ${command}`))
  for (const command of ['curl -LO https://x/big.tar', 'git clone https://x/y', './fetch_data.sh', 'python -m download', 'cp -r a b']) {
    expect([command, (await $.tool.call({ tool: 'Bash', command })).deny]).toEqual([command, expect.stringContaining('Disk space is low')])
  }
})

test('gateLightSubcommands lets a tool\'s listed subcommands run while gated', { options: { gateLightSubcommands: 'mytool status ;; mytool list' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 4
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: 'mytool status' })
  await $.tool.call({ tool: 'Bash', command: 'mytool list mygroup' })
  expect((await $.tool.call({ tool: 'Bash', command: 'mytool run job-1' })).deny).toContain('(not on the light list: mytool run)')
  expect(w.ran).toEqual(['Bash: mytool status', 'Bash: mytool list mygroup'])
})

test('gateMode "patterns" brings back the old gate', { options: { gateMode: 'patterns' } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 4
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: './fetch_data.sh' })
  expect((await $.tool.call(DOCKER)).deny).toContain('(docker pull)')
  expect(w.ran).toEqual(['Bash: ./fetch_data.sh'])
})

test('while gated the refusal names the biggest space users: Docker and the cache folders', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.dockerDf = DOCKER_DF
  w.du = { '/Users/me/Library/Caches': 20 * GB, '/Users/me/.cache': 15 * GB, '/Users/me/.npm': 100 }
  w.freeGb = 4
  await $.session.start(START)
  await clock.advance(1000)
  const deny = (await $.tool.call(DOCKER)).deny ?? ''
  expect(deny).toContain('Largest users of disk space now: Docker images (reclaimable 30.1GB (74%)) 40.2 GB; ~/Library/Caches 21.5 GB; ~/.cache 16.1 GB. Nothing has been stopped')
})

test('an alert that wakes the model names them too; without Docker only the folders are named', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.du = { '/Users/me/.Trash': 8 * GB }
  w.freeGb = 15
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.prompts[0]).toContain('Largest space users: ~/.Trash 8.6 GB.')
  expect(w.prompts[0]).toContain('Nothing has been deleted; do not delete files unless the user asks.')
})

test('on Linux (no macOS data volume) it reads / and names the Linux cache folders', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.isDataVolumeMissing = true
  w.du = { '/Users/me/.local/share/Trash': 9 * GB, '/Users/me/.m2/repository': 3 * GB, '/Users/me/.local/share/containers': 6 * GB }
  w.freeGb = 15
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.dfPaths.slice(0, 2)).toEqual(['/System/Volumes/Data', '/'])
  expect(w.statuses.at(-1)).toContain('15')
  expect(w.prompts[0]).toContain('Largest space users: ~/.local/share/Trash 9.7 GB; ~/.local/share/containers 6.4 GB; ~/.m2/repository 3.2 GB.')
})

test('on Linux a du that hits unreadable files still names the folder; rootless Docker is not named twice', WAKE, async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.isDataVolumeMissing = true
  w.dockerDf = 'Images\t12GB\t2GB (16%)\n'
  w.du = { '/Users/me/.local/share/containers': 6 * GB, '/Users/me/.local/share/docker': 11 * GB, '/Users/me/.cache': 2 * GB }
  w.duDenied = ['/Users/me/.local/share/containers']
  w.freeGb = 15
  await $.session.start(START)
  await clock.advance(1000)
  expect(w.prompts[0]).toContain('Largest space users: Docker images (reclaimable 2GB (16%)) 12.0 GB; ~/.local/share/containers 6.4 GB; ~/.cache 2.1 GB.')
  expect(w.prompts[0]).not.toContain('~/.local/share/docker')
})

test('space users are measured only on an alert or while gated, and at most every 30 minutes', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  w.freeGb = 30
  await $.session.start(START)
  await clock.advance(3 * TICK)
  expect(w.measured).toEqual([])
  w.freeGb = 4
  await clock.advance(TICK)
  const once = w.measured.length
  expect(once).toBeGreaterThan(0)
  await clock.advance(5 * TICK)
  expect(w.measured.length).toBe(once)
  await clock.advance(TICK)
  expect(w.measured.length).toBe(2 * once)
})
