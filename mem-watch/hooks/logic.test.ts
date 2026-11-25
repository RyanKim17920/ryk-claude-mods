import { expect, test } from 'claude-code/testing'

import {
  alertPrompt,
  alertToast,
  culpritLines,
  parseDockerStats,
  asAlert,
  asStoredReading,
  decide,
  INITIAL_ALERT,
  owesToast,
  parseFreePercent,
  parseSwapUsedGb,
  parseTopProcesses,
  statusLine,
} from './logic'
import type { Limits } from './logic'

const LIMITS: Limits = { minFreePercent: 28, maxSwapGb: 28, cooldownMs: 30 * 60_000 }
const FINE = { freePercent: 60, swapGb: 5 }
const LOW = { freePercent: 12, swapGb: 5 }
const SWAPPING = { freePercent: 60, swapGb: 31 }

test('swap usage parses in M, G and K', () => {
  const line = 'total = 6144.00M  used = 5123.25M  free = 1020.75M  (encrypted)'
  expect(parseSwapUsedGb(line)).toBe(5123.25 / 1024)
  expect(parseSwapUsedGb('total = 43.00G  used = 41.75G  free = 1.25G')).toBe(41.75)
  expect(parseSwapUsedGb('total = 0.00K  used = 1048576.00K  free = 0.00K')).toBe(1)
  expect(parseSwapUsedGb('used = 0.00M')).toBe(0)
})

test('malformed swap output parses to null', () => {
  expect(parseSwapUsedGb('')).toBeNull()
  expect(parseSwapUsedGb('sysctl: unknown oid')).toBeNull()
  expect(parseSwapUsedGb('total = 1.00M  used = lots')).toBeNull()
  expect(parseSwapUsedGb('used = 12.00T')).toBeNull()
})

test('free percentage parses, and its absence is null', () => {
  const out = 'Pageouts: 11008364 \n\nSystem-wide memory free percentage: 34%\n'
  expect(parseFreePercent(out)).toBe(34)
  expect(parseFreePercent('System-wide memory free percentage: 7%')).toBe(7)
  expect(parseFreePercent('The system has 25769803776 bytes')).toBeNull()
  expect(parseFreePercent('')).toBeNull()
})

test('top processes are sorted by resident size and bad rows skipped', () => {
  const out = [
    '   RSS   PID COMM',
    ' 21376     1 /sbin/launchd',
    '9000000  4242 /usr/bin/python3 -m heavy job',
    '  6016   141 /usr/sbin/WirelessRadioManagerd',
    'garbage',
    '5000000  77 node',
  ].join('\n')
  const top = parseTopProcesses(out, 2)
  expect(top).toEqual([
    { rssKb: 9000000, pid: 4242, command: '/usr/bin/python3 -m heavy job' },
    { rssKb: 5000000, pid: 77, command: 'node' },
  ])
  expect(parseTopProcesses('', 5)).toEqual([])
})

test('an alert fires on crossing either limit', () => {
  expect(decide(INITIAL_ALERT, FINE, LIMITS, 0).shouldAlert).toBe(false)
  expect(decide(INITIAL_ALERT, LOW, LIMITS, 0).shouldAlert).toBe(true)
  expect(decide(INITIAL_ALERT, SWAPPING, LIMITS, 0).shouldAlert).toBe(true)
  expect(decide(INITIAL_ALERT, { freePercent: 28, swapGb: 28 }, LIMITS, 0).shouldAlert).toBe(false)
})

test('no second alert while pressure lasts, or inside the cooldown', () => {
  const first = decide(INITIAL_ALERT, LOW, LIMITS, 1000)
  expect(first.state).toEqual({ isArmed: false, lastAlertAt: 1000, claimedBy: null })
  // Still under pressure hours later: not re-armed, so silent.
  expect(decide(first.state, LOW, LIMITS, 1000 + 5 * LIMITS.cooldownMs).shouldAlert).toBe(false)
  // Recovered and crossed again inside the cooldown: armed, but silent.
  const recovered = decide(first.state, FINE, LIMITS, 2000)
  expect(recovered.state.isArmed).toBe(true)
  expect(decide(recovered.state, LOW, LIMITS, 3000).shouldAlert).toBe(false)
  // Once the cooldown has passed it fires again.
  const again = decide(recovered.state, LOW, LIMITS, 1000 + LIMITS.cooldownMs)
  expect(again.shouldAlert).toBe(true)
  expect(again.state.lastAlertAt).toBe(1000 + LIMITS.cooldownMs)
})

test('status line and alert prompt carry both figures', () => {
  expect(statusLine({ freePercent: 34, swapGb: 5.2 }, LIMITS)).toBe('mem free 34% · swap 5G')
  expect(statusLine(LOW, LIMITS)).toBe('! mem free 12% · swap 5G')
  const prompt = alertPrompt(LOW, LIMITS, culpritLines([{ rssKb: 9 * 1024 * 1024, pid: 4242, command: '/usr/bin/python3' }], []))
  expect(prompt).toContain('free 12% · swap 5G')
  expect(prompt).toContain('Largest memory users:\n- python3 (pid 4242) 9.0 GB')
  expect(prompt).toContain('Nothing has been killed.')
  expect(alertPrompt(LOW, LIMITS, [])).not.toContain('Largest')
})

test('docker stats parse; odd lines are skipped', () => {
  const out = 'web\t1.2GiB / 7.6GiB\ndb\t300MiB / 7.6GiB\nbig\t3GiB / 7.6GiB\n\ngarbage line\nx\t-- / --\n'
  expect(parseDockerStats(out, 2)).toEqual([
    { name: 'big', bytes: 3 * 1024 ** 3, usage: '3GiB' },
    { name: 'web', bytes: 1.2 * 1024 ** 3, usage: '1.2GiB' },
  ])
  expect(parseDockerStats('', 3)).toEqual([])
})

test('culprits: the top three processes by resident size, then the top three containers', () => {
  const procs = parseTopProcesses('  RSS   PID COMM\n9437184  4242 /usr/bin/python3\n2097152  77 Docker VM\n1048576 5 node\n524288 6 zsh\n', 5)
  const containers = parseDockerStats('web\t1.2GiB / 7GiB\n', 3)
  expect(culpritLines(procs, containers)).toEqual([
    'python3 (pid 4242) 9.0 GB',
    'Docker VM (pid 77) 2.0 GB',
    'node (pid 5) 1.0 GB',
    'container web 1.2GiB',
  ])
  expect(culpritLines([], [])).toEqual([])
  expect(alertToast(LOW, ['python3 (pid 4242) 9.0 GB'])).toBe('Memory under pressure: free 12% · swap 5G · top: python3 (pid 4242) 9.0 GB')
  expect(alertToast(LOW, [])).toBe('Memory under pressure: free 12% · swap 5G')
})


test('the shared state is read defensively', () => {
  expect(asAlert(undefined)).toEqual(INITIAL_ALERT)
  expect(asAlert('garbage')).toEqual(INITIAL_ALERT)
  expect(asAlert({ isArmed: false, lastAlertAt: 5, claimedBy: 's1' })).toEqual({ isArmed: false, lastAlertAt: 5, claimedBy: 's1' })
  expect(asAlert({ lastAlertAt: 'soon', claimedBy: 7 })).toEqual(INITIAL_ALERT)
})

test('a session owes one toast per shared alert, while pressure lasts and the alert is fresh', () => {
  const alerted = { isArmed: false, lastAlertAt: 1000, claimedBy: 'other' }
  expect(owesToast(alerted, null, LOW, LIMITS, 2000)).toBe(true)
  expect(owesToast(alerted, 1000, LOW, LIMITS, 2000)).toBe(false)
  expect(owesToast(alerted, null, FINE, LIMITS, 2000)).toBe(false)
  expect(owesToast(alerted, null, LOW, LIMITS, 1000 + LIMITS.cooldownMs)).toBe(false)
  expect(owesToast(INITIAL_ALERT, null, LOW, LIMITS, 2000)).toBe(false)
})

test('the stored reading is read defensively', () => {
  expect(asStoredReading({ freePercent: 12, swapGb: 3, at: 5 })).toEqual({ freePercent: 12, swapGb: 3, at: 5 })
  expect(asStoredReading({ freePercent: 12, swapGb: 3 })).toBeNull()
  expect(asStoredReading({ freePercent: '12', swapGb: 3, at: 5 })).toBeNull()
  expect(asStoredReading(undefined)).toBeNull()
})
