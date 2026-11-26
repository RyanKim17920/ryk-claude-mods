import { expect, test } from 'claude-code/testing'

import {
  alertPrompt,
  diskHeavyWork,
  alertText,
  CACHE_DIRS,
  parseDockerDf,
  parseDuKb,
  spaceCulpritLines,
  asAlert,
  asStoredReading,
  crossedTier,
  decide,
  DEFAULT_TIERS_GB,
  INITIAL_ALERT,
  isGated,
  owesToast,
  parseDf,
  parseGateGb,
  parseTiers,
  statusLine,
} from './logic'
import type { Limits } from './logic'
import type { AlertState } from '../types'

const GB = 1024 * 1024
const COOLDOWN = 60 * 60_000
const LIMITS: Limits = { tiersGb: DEFAULT_TIERS_GB, cooldownMs: COOLDOWN }
const at = (freeGb: number) => ({ freeGb, capacityPercent: 95 })

const HEADER = 'Filesystem   1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on'

/** Runs readings through `decide` one after another, starting at `now` and stepping `step` ms each. */
function run(frees: number[], start: AlertState = INITIAL_ALERT, now = 0, step = 60_000): { state: AlertState; alerts: number[] } {
  let state = start
  const alerts: number[] = []
  frees.forEach((free, i) => {
    const next = decide(state, at(free), LIMITS, now + i * step)
    if (next.shouldAlert && next.state.lastTier !== null) {
      alerts.push(next.state.lastTier)
    }
    state = next.state
  })

  return { state, alerts }
}

test('df output parses free GB and capacity from the data row, skipping the header', () => {
  const out = `${HEADER}\n/dev/disk3s5   482797652 432396004  10678716    98% 7056592 106787160    6%   /System/Volumes/Data\n`
  expect(parseDf(out)).toEqual({ freeGb: 10678716 / GB, capacityPercent: 98 })
})

test('df output without inode columns (Linux, -P) parses too', () => {
  const out = 'Filesystem     1K-blocks     Used Available Use% Mounted on\n/dev/sda1      102400000 58720256  43679744  58% /\n'
  expect(parseDf(out)).toEqual({ freeGb: 43679744 / GB, capacityPercent: 58 })
})

test('a filesystem name with spaces and a wrapped row still parse', () => {
  expect(parseDf(`${HEADER}\nmap auto_home          0         0         0   100%       0         0  100%   /System/Volumes/Data/home`)).toEqual({ freeGb: 0, capacityPercent: 100 })
  const wrapped = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/mapper/a-very-long-volume-name\n               2097152  1048576   1048576  50% /\n'
  expect(parseDf(wrapped)).toEqual({ freeGb: 1, capacityPercent: 50 })
})

test('with several rows the last one wins', () => {
  const out = [HEADER, '/dev/a  100 50 50 50% 0 0 0% /a', '/dev/b  4194304 2097152 2097152 50% 0 0 0% /b'].join('\n')
  expect(parseDf(out)?.freeGb).toBe(2)
})

test('garbage, a header alone and empty output parse to null', () => {
  expect(parseDf('')).toBeNull()
  expect(parseDf(HEADER)).toBeNull()
  expect(parseDf('df: /System/Volumes/Data: No such file or directory')).toBeNull()
  expect(parseDf('/dev/disk3s5 lots some none 98%')).toBeNull()
})

test('tiers parse, dedupe and sort descending', () => {
  expect(parseTiers('20,10,5,1')).toEqual([20, 10, 5, 1])
  expect(parseTiers('1, 5 ,20,10')).toEqual([20, 10, 5, 1])
  expect(parseTiers('5 50 0.5')).toEqual([50, 5, 0.5])
  expect(parseTiers('10,10,3')).toEqual([10, 3])
  expect(parseTiers('15')).toEqual([15])
  expect(parseTiers(15)).toEqual([15])
})

test('malformed tiers fall back to the default', () => {
  for (const bad of [undefined, null, '', ' , ', 'lots', '20,ten,5', '20,-5', '20,0', '1e3', 'Infinity', '20;10', 0, -3, Number.NaN, [20, 10], { a: 1 }]) {
    expect(parseTiers(bad)).toEqual([20, 10, 5, 1])
  }
})

test('the crossed tier is the deepest one free space is below', () => {
  expect(crossedTier(at(25), LIMITS)).toBeNull()
  expect(crossedTier(at(20), LIMITS)).toBeNull()
  expect(crossedTier(at(19.99), LIMITS)).toBe(20)
  expect(crossedTier(at(3), LIMITS)).toBe(5)
  expect(crossedTier(at(0.4), LIMITS)).toBe(1)
})

test('crossing each tier in order alerts once per tier', () => {
  expect(run([25, 18, 15, 9, 8, 4.2, 4, 0.6, 0.5]).alerts).toEqual([20, 10, 5, 1])
})

test('a jump straight from 25 to 3 GB is one alert, for the 5 GB tier', () => {
  const { state, alerts } = run([25, 3])
  expect(alerts).toEqual([5])
  expect(state.alertedTier).toBe(5)
  // Shallower tiers it skipped do not alert on the way back up either.
  expect(run([12, 15, 19], state, 120_000).alerts).toEqual([])
})

test('a deeper tier alerts even inside the cooldown', () => {
  // 20 then 10 one minute apart, then 5 a minute later: all inside one cooldown.
  expect(run([18, 9, 4]).alerts).toEqual([20, 10, 5])
})

test('the same tier inside its cooldown does not alert again, even after a recovery', () => {
  const first = run([18])
  expect(first.alerts).toEqual([20])
  // Recovers past 22 (re-arms), drops below 20 again ten minutes later: silent.
  const again = run([30, 18], first.state, 5 * 60_000)
  expect(again.alerts).toEqual([])
  expect(again.state.alertedTier).toBe(20)
  // But the next tier down still alerts.
  expect(run([9], again.state, 20 * 60_000).alerts).toEqual([10])
})

test('recovery above 22 GB re-arms every tier; the 20-22 band does not', () => {
  const low = run([18, 9, 4]).state
  // Up to 21: still in the hysteresis band, nothing re-arms, so dropping again is silent.
  const band = run([21, 18, 9, 4], low, 2 * COOLDOWN)
  expect(band.alerts).toEqual([])
  expect(band.state.alertedTier).toBe(5)
  // Up to 22: re-armed. Past the cooldown every tier alerts again.
  const rearmed = decide(low, at(22), LIMITS, 2 * COOLDOWN)
  expect(rearmed.state.alertedTier).toBeNull()
  expect(rearmed.shouldAlert).toBe(false)
  expect(run([18, 9, 4, 0.5], rearmed.state, 2 * COOLDOWN).alerts).toEqual([20, 10, 5, 1])
})

test('a re-arm with nothing to re-arm returns the same state, so nothing is written', () => {
  expect(decide(INITIAL_ALERT, at(40), LIMITS, 0).state).toBe(INITIAL_ALERT)
  expect(decide(INITIAL_ALERT, at(21), LIMITS, 0).state).toBe(INITIAL_ALERT)
})

test('custom tiers re-arm at the top tier plus 10%', () => {
  const limits: Limits = { tiersGb: [50, 5], cooldownMs: COOLDOWN }
  const low = decide(INITIAL_ALERT, at(40), limits, 0).state
  expect(low.alertedTier).toBe(50)
  expect(decide(low, at(54), limits, 1).state.alertedTier).toBe(50)
  expect(decide(low, at(55), limits, 1).state.alertedTier).toBeNull()
})

test('status line marks space below the top tier, rounded down', () => {
  expect(statusLine(at(42), LIMITS)).toBe('storage 42G free')
  expect(statusLine(at(21), LIMITS)).toBe('storage 21G free')
  expect(statusLine(at(19.9), LIMITS)).toBe('! storage 19G free')
  expect(statusLine(at(4.2), LIMITS)).toBe('! storage 4G free')
})

test('alert text names the tier crossed, and the 1 GB tier is urgent', () => {
  expect(alertText(5, at(4.29))).toBe('Disk below 5 GB free (4.2G)')
  expect(alertText(20, at(19.99))).toBe('Disk below 20 GB free (19.9G)')
  expect(alertText(1, at(0.6))).toBe('URGENT: Disk below 1 GB free (0.6G)')
  expect(alertText(0.5, at(0.2))).toBe('URGENT: Disk below 0.5 GB free (0.2G)')
})

test('the alert prompt is short, states the tier and the guard, and does not push action', () => {
  const prompt = alertPrompt(5, at(4.2))
  expect(prompt).toBe('Disk below 5 GB free (4.2G) on this machine.\nNothing has been deleted; do not delete files unless the user asks.')
  expect(prompt.split('\n')).toHaveLength(2)
  for (const word of ['stop', 'kill', 'move', 'process', 'pid', 'job']) {
    expect(prompt.toLowerCase()).not.toContain(word)
  }
})

test('the shared state is read defensively', () => {
  expect(asAlert(undefined)).toEqual(INITIAL_ALERT)
  expect(asAlert('garbage')).toEqual(INITIAL_ALERT)
  const good = { alertedTier: 5, tierAlertedAt: { '20': 1, '5': 3 }, lastTier: 5, lastAlertAt: 3, claimedBy: 's1' }
  expect(asAlert(good)).toEqual(good)
  // The 0.1.0 single-threshold shape, or junk fields, read as the initial state.
  expect(asAlert({ isArmed: false, lastAlertAt: 'soon', claimedBy: 7 })).toEqual(INITIAL_ALERT)
  expect(asAlert({ alertedTier: -1, tierAlertedAt: { '5': 'x', '1': 2 }, lastTier: 'a' })).toEqual({ ...INITIAL_ALERT, tierAlertedAt: { '1': 2 } })
})

test('a session owes one toast per shared alert, while space is below its tier and the alert is fresh', () => {
  const alerted: AlertState = { alertedTier: 5, tierAlertedAt: { '5': 1000 }, lastTier: 5, lastAlertAt: 1000, claimedBy: 'other' }
  expect(owesToast(alerted, null, at(4), LIMITS, 2000)).toBe(true)
  expect(owesToast(alerted, 1000, at(4), LIMITS, 2000)).toBe(false)
  expect(owesToast(alerted, null, at(6), LIMITS, 2000)).toBe(false)
  expect(owesToast(alerted, null, at(4), LIMITS, 1000 + COOLDOWN)).toBe(false)
  expect(owesToast(INITIAL_ALERT, null, at(4), LIMITS, 2000)).toBe(false)
})

test('the gate holds at or below its tier, which defaults to 5 GB', () => {
  expect(isGated(at(5), 5)).toBe(true)
  expect(isGated(at(4.9), 5)).toBe(true)
  expect(isGated(at(5.01), 5)).toBe(false)
  expect(parseGateGb(undefined)).toBe(5)
  expect(parseGateGb(-1)).toBe(5)
  expect(parseGateGb('ten')).toBe(5)
  expect(parseGateGb(12)).toBe(12)
})

test('the stored reading is read defensively', () => {
  expect(asStoredReading({ freeGb: 2, capacityPercent: 99, at: 5 })).toEqual({ freeGb: 2, capacityPercent: 99, at: 5 })
  expect(asStoredReading({ freeGb: 2, capacityPercent: 99 })).toBeNull()
  expect(asStoredReading('x')).toBeNull()
})

test('the alert prompt names the biggest space users when known, and keeps its guard', () => {
  const prompt = alertPrompt(5, at(4.2), ['Docker images 40.2 GB', '~/.cache 16.1 GB'])
  expect(prompt).toBe('Disk below 5 GB free (4.2G) on this machine.\nLargest space users: Docker images 40.2 GB; ~/.cache 16.1 GB.\nNothing has been deleted; do not delete files unless the user asks.')
  expect(alertPrompt(5, at(4.2), [])).toBe(alertPrompt(5, at(4.2)))
})

test('docker system df rows parse with what pruning would give back; odd rows are skipped', () => {
  expect(parseDockerDf('Images\t40.2GB\t30.1GB (74%)\nBuild Cache\t0B\t0B\nnonsense\n\tx\t')).toEqual([
    { name: 'Docker images (reclaimable 30.1GB (74%))', bytes: 40.2e9 },
    { name: 'Docker build cache (reclaimable 0B)', bytes: 0 },
  ])
  expect(parseDockerDf('')).toEqual([])
})

test('du -sk reads as a folder under ~, in bytes', () => {
  expect(parseDuKb('1024\t/Users/me/.cache\n', '/Users/me')).toEqual({ name: '~/.cache', bytes: 1024 * 1024 })
  expect(parseDuKb('2048\t/opt/x\n', '/Users/me')).toEqual({ name: '/opt/x', bytes: 2048 * 1024 })
  expect(parseDuKb('du: /Users/me/.npm: No such file or directory\n', '/Users/me')).toBeNull()
  expect(parseDuKb('', '/Users/me')).toBeNull()
})

test('the space users: the three biggest, largest first, nothing under 0.1 GB', () => {
  const lines = spaceCulpritLines([
    { name: 'a', bytes: 1e9 },
    { name: 'b', bytes: 5e9 },
    { name: 'tiny', bytes: 5e7 },
    { name: 'c', bytes: 3e9 },
    { name: 'd', bytes: 2e9 },
  ])
  expect(lines).toEqual(['b 5.0 GB', 'c 3.0 GB', 'd 2.0 GB'])
  expect(spaceCulpritLines([{ name: 'tiny', bytes: 1 }])).toEqual([])
  expect(CACHE_DIRS.every(dir => !dir.startsWith('/') && !dir.startsWith('~'))).toBe(true)
})

test('the cache folders cover Linux too, and none is inside another so nothing is counted twice', () => {
  for (const dir of ['.cache', '.npm', '.local/share/Trash', '.local/share/containers', '.local/share/docker', '.m2/repository']) {
    expect(CACHE_DIRS).toContain(dir)
  }
  expect(new Set(CACHE_DIRS).size).toBe(CACHE_DIRS.length)
  for (const outer of CACHE_DIRS) {
    expect(CACHE_DIRS.filter(inner => inner.startsWith(`${outer}/`))).toEqual([])
  }
})

test('a tree copy fills a disk: refused by the disk gate in allowlist mode, however it is reached; a single-file copy is not', () => {
  const allowlist = { mode: 'allowlist', overrides: { extraBlock: [], extraAllow: [] } } as const
  const disk = (command: string) => diskHeavyWork({ tool: 'Bash', command }, allowlist)
  const TREE = 'not on the light list: a copy of a whole tree (cp -r, ditto)'
  for (const command of [
    'cp -r a b', 'cp -R a b', 'cp -a src/ dst/', 'cp -pR a b', 'ls && sudo cp -r a b', 'ditto a b', '/bin/cp -r a b',
    'cp --recursive a b', 'cp --archive a b', 'cp -v --recursive a b',
    "bash -c 'cp -r a b'", 'sh -c "ls && cp -a a b"', 'find . -name x -exec cp -r {} /dst \\;', 'echo $(cp -r a b)', 'ls | xargs -I{} cp -r {} /dst',
    'eval "cp -r a b"',
  ]) {
    expect([command, disk(command)]).toEqual([command, TREE])
  }
  for (const command of ['cp a b', 'cp -p a b', 'cp --preserve=mode a b', 'mv -f a b', 'echo cp -r a b', "echo 'cp -r a b'"]) {
    expect([command, disk(command)]).toEqual([command, null])
  }
  expect(disk('make')).toBe('not on the light list: make')
  expect(diskHeavyWork({ tool: 'Agent' }, allowlist)).toBe('spawning a subagent')
  expect(diskHeavyWork({ tool: 'Bash', command: 'cp -r a b' }, { ...allowlist, mode: 'patterns' })).toBeNull()
})

test('a download to a file is refused at low disk, by option or by redirect; one to stdout or /dev/null is not', () => {
  const allowlist = { mode: 'allowlist', overrides: { extraBlock: [], extraAllow: [] } } as const
  const disk = (command: string) => diskHeavyWork({ tool: 'Bash', command }, allowlist)
  for (const command of [
    'curl -LO https://x/big.tar', 'curl -o big.tar https://x', 'curl https://x/big.tar > big.tar', 'curl -s https://x >> f',
    'curl -s https://x >f', 'curl -s https://x 1>f', 'curl -s https://x &>f', 'curl -s https://x >| f', 'curl -s https://x > /dev/null > f', '>f curl https://x', "bash -c 'curl https://x > f'",
    'wget https://x/big.tar', 'wget -qO- https://x', 'wget -O f https://x',
  ]) {
    expect([command, disk(command)]).not.toEqual([command, null])
  }
  for (const command of [
    'curl -s https://x', 'curl -s https://x > /dev/null', 'curl -s https://x 2>/dev/null', 'curl -s https://x 2>err.log',
    'curl -sf http://localhost:8080/health >/dev/null 2>&1', 'curl -s https://x | jq .', 'curl -o /dev/null -w "%{http_code}" https://x',
    'wget --help', 'wget --version',
  ]) {
    expect([command, disk(command)]).toEqual([command, null])
  }
  expect(disk('curl https://x > f')).toBe('not on the light list: curl saving a file')
  // The user's allow patterns do not let a download or a tree copy past the disk gate.
  const userAllows = { mode: 'allowlist', overrides: { extraBlock: [], extraAllow: [/^curl\b/, /^cp\b/] } } as const
  expect(diskHeavyWork({ tool: 'Bash', command: 'curl https://x > f' }, userAllows)).toBe('not on the light list: curl saving a file')
  expect(diskHeavyWork({ tool: 'Bash', command: 'cp -r a b' }, userAllows)).toBe('not on the light list: a copy of a whole tree (cp -r, ditto)')
})